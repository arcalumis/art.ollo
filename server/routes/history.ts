import type { FastifyInstance } from "fastify";
import type { Generation } from "../../src/types";
import { getDb } from "../db";
import { authMiddleware } from "../middleware/auth";
import { requireUserId } from "../services/request-user";
import { deleteGenerationFiles } from "../services/storage";

interface HistoryQuery {
	page?: string;
	limit?: string;
	trash?: string;
	archived?: string;
	/** Case-insensitive substring of the prompt. */
	q?: string;
	/** Exact model id. */
	model?: string;
}

/** Escape LIKE wildcards so a search for "100%" means the text, not a pattern. */
function likePattern(text: string): string {
	return `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

interface HistoryParams {
	id: string;
}

interface DbRow {
	id: string;
	prompt: string;
	model: string;
	model_version: string | null;
	image_path: string;
	width: number | null;
	height: number | null;
	parameters: string | null;
	created_at: string;
	replicate_id: string | null;
	user_id: string | null;
	cost: number | null;
	deleted_at: string | null;
	archived_at: string | null;
	purged_at: string | null;
}

interface TrashBody {
	deleted: boolean;
}

interface ArchiveBody {
	archived: boolean;
}

export async function historyRoutes(fastify: FastifyInstance): Promise<void> {
	fastify.get<{ Querystring: HistoryQuery }>(
		"/api/history",
		{ preHandler: authMiddleware },
		async (request) => {
			const page = Math.max(1, Number.parseInt(request.query.page || "1", 10));
			const limit = Math.min(100, Math.max(1, Number.parseInt(request.query.limit || "20", 10)));
			const offset = (page - 1) * limit;
			const showTrash = request.query.trash === "true";
			const showArchived = request.query.archived === "true";

			const db = getDb();

			// Filter by current user, trash status, and archive status
			// Always exclude purged records (no image file, kept only for cost tracking)
			let condition: string;
			if (showTrash) {
				condition = "deleted_at IS NOT NULL AND purged_at IS NULL AND moderated_at IS NULL";
			} else if (showArchived) {
				condition = "archived_at IS NOT NULL AND deleted_at IS NULL AND purged_at IS NULL AND moderated_at IS NULL";
			} else {
				condition = "deleted_at IS NULL AND archived_at IS NULL AND purged_at IS NULL AND moderated_at IS NULL";
			}

			const userId = requireUserId(request);
			// Optional search + model filter (the gallery's search box and model menu).
			const filters: string[] = [];
			const filterArgs: string[] = [];
			const q = typeof request.query.q === "string" ? request.query.q.trim().slice(0, 200) : "";
			if (q) {
				filters.push("prompt LIKE ? ESCAPE '\\'");
				filterArgs.push(likePattern(q));
			}
			const model = typeof request.query.model === "string" ? request.query.model.trim() : "";
			if (model) {
				filters.push("model = ?");
				filterArgs.push(model);
			}
			const where = [condition, ...filters].join(" AND ");

			const countResult = db
				.prepare(`SELECT COUNT(*) as count FROM generations WHERE user_id = ? AND ${where}`)
				.get(userId, ...filterArgs) as { count: number };
			const total = countResult.count;

			const rows = db
				.prepare(
					`
				SELECT * FROM generations
				WHERE user_id = ? AND ${where}
				ORDER BY created_at DESC
				LIMIT ? OFFSET ?
			`,
				)
				.all(userId, ...filterArgs, limit, offset) as DbRow[];

			// Models this view contains (for the filter menu), whatever the current filter.
			const models = (
				db
					.prepare(`SELECT DISTINCT model FROM generations WHERE user_id = ? AND ${condition} ORDER BY model`)
					.all(userId) as { model: string }[]
			).map((r) => r.model);

			const generations: (Generation & {
				cost?: number;
				deletedAt?: string;
				archivedAt?: string;
			})[] = rows.map((row) => {
				const params = row.parameters ? JSON.parse(row.parameters) : undefined;
				// Extract images array from parameters for 4-up grid variations
				const images = params?.images as { id: string; url: string; path?: string }[] | undefined;

				return {
					id: row.id,
					prompt: row.prompt,
					model: row.model,
					modelVersion: row.model_version || undefined,
					imagePath: row.image_path,
					imageUrl: `/images/${row.image_path}`,
					width: row.width || undefined,
					height: row.height || undefined,
					parameters: params,
					createdAt: row.created_at,
					replicateId: row.replicate_id || undefined,
					cost: row.cost || 0,
					deletedAt: row.deleted_at || undefined,
					archivedAt: row.archived_at || undefined,
					images: images,
				};
			});

			// Calculate total cost (includes ALL generations including purged for accurate tracking)
			const totalCostResult = db
				.prepare("SELECT SUM(cost) as total FROM generations WHERE user_id = ?")
				.get(userId) as { total: number | null };

			return {
				generations,
				models,
				total,
				page,
				limit,
				totalCost: totalCostResult.total || 0,
			};
		},
	);

	// PATCH - Soft delete (move to trash) or restore
	fastify.patch<{ Params: HistoryParams; Body: TrashBody }>(
		"/api/history/:id",
		{ preHandler: authMiddleware },
		async (request, reply) => {
			const { id } = request.params;
			const { deleted } = request.body;

			const db = getDb();
			// Verify ownership
			const row = db
				.prepare("SELECT id, moderated_at FROM generations WHERE id = ? AND user_id = ?")
				.get(id, requireUserId(request)) as { id: string; moderated_at: string | null } | undefined;

			if (!row) {
				return reply.status(404).send({ error: "Generation not found" });
			}

			// Images removed by moderation stay removed; only an admin can reverse that.
			if (!deleted && row.moderated_at) {
				return reply
					.status(403)
					.send({ code: "MODERATED", error: "This image was removed for breaking the content rules." });
			}

			if (deleted) {
				// Move to trash
				db.prepare("UPDATE generations SET deleted_at = datetime('now') WHERE id = ?").run(id);
			} else {
				// Restore from trash
				db.prepare("UPDATE generations SET deleted_at = NULL WHERE id = ?").run(id);
			}

			return { success: true };
		},
	);

	// PATCH - Archive or unarchive a generation
	fastify.patch<{ Params: HistoryParams; Body: ArchiveBody }>(
		"/api/history/:id/archive",
		{ preHandler: authMiddleware },
		async (request, reply) => {
			const { id } = request.params;
			const { archived } = request.body;

			const db = getDb();
			// Verify ownership
			const row = db
				.prepare("SELECT id FROM generations WHERE id = ? AND user_id = ?")
				.get(id, requireUserId(request)) as { id: string } | undefined;

			if (!row) {
				return reply.status(404).send({ error: "Generation not found" });
			}

			if (archived) {
				db.prepare("UPDATE generations SET archived_at = datetime('now') WHERE id = ?").run(id);
			} else {
				db.prepare("UPDATE generations SET archived_at = NULL WHERE id = ?").run(id);
			}

			return { success: true };
		},
	);

	// PATCH - Archive or unarchive an upload
	fastify.patch<{ Params: HistoryParams; Body: ArchiveBody }>(
		"/api/uploads/:id/archive",
		{ preHandler: authMiddleware },
		async (request, reply) => {
			const { id } = request.params;
			const { archived } = request.body;

			const db = getDb();
			// Verify ownership
			const row = db
				.prepare("SELECT id FROM uploads WHERE id = ? AND user_id = ?")
				.get(id, requireUserId(request)) as { id: string } | undefined;

			if (!row) {
				return reply.status(404).send({ error: "Upload not found" });
			}

			if (archived) {
				db.prepare("UPDATE uploads SET archived_at = datetime('now') WHERE id = ?").run(id);
			} else {
				db.prepare("UPDATE uploads SET archived_at = NULL WHERE id = ?").run(id);
			}

			return { success: true };
		},
	);

	// DELETE - Permanently delete (for trash items)
	// Note: We keep the database record for cost tracking, only delete the file
	fastify.delete<{ Params: HistoryParams }>(
		"/api/history/:id",
		{ preHandler: authMiddleware },
		async (request, reply) => {
			const { id } = request.params;

			const db = getDb();
			// Only allow deleting own images
			const row = db
				.prepare("SELECT image_path, parameters FROM generations WHERE id = ? AND user_id = ?")
				.get(id, requireUserId(request)) as { image_path: string | null; parameters: string | null } | undefined;

			if (!row) {
				return reply.status(404).send({ error: "Generation not found" });
			}

			// Delete the image files (primary + any grid images)
			deleteGenerationFiles(row.image_path, row.parameters);

			// Mark as purged (keeps record for cost tracking)
			db.prepare("UPDATE generations SET purged_at = datetime('now') WHERE id = ?").run(id);

			return { success: true };
		},
	);
}
