import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import { getDb } from "../db";
import { authMiddleware } from "../middleware/auth";
import { requireUserId } from "../services/request-user";
import { deleteGenerationFiles } from "../services/storage";

interface ProjectMetadata {
	aspectRatio?: string;
	purpose?: string;
	style?: string;
	referenceImages?: string[];
	mood?: string;
	olloEnabled?: boolean;
}

interface Thread {
	id: string;
	userId: string;
	title: string;
	createdAt: string;
	updatedAt: string;
	archivedAt?: string;
	generationCount?: number;
	lastGenerationAt?: string;
	/** Newest image in the series, for the series list. */
	coverImageUrl?: string;
	projectMetadata?: ProjectMetadata;
}

interface ThreadDbRow {
	id: string;
	user_id: string;
	title: string;
	created_at: string;
	updated_at: string;
	archived_at: string | null;
	deleted_at: string | null;
	generation_count?: number;
	last_generation_at?: string | null;
	cover_image_path?: string | null;
	project_metadata?: string | null;
}

interface CreateThreadBody {
	title?: string;
	projectMetadata?: ProjectMetadata;
}

interface UpdateThreadBody {
	title?: string;
	projectMetadata?: ProjectMetadata;
}

interface ThreadParams {
	id: string;
}

interface DeleteThreadQuery {
	deletePhotos?: string;
}

export async function threadRoutes(fastify: FastifyInstance): Promise<void> {
	// GET /api/threads - List all threads for current user
	fastify.get(
		"/api/threads",
		{ preHandler: authMiddleware },
		async (request) => {
			const db = getDb();
			const userId = requireUserId(request);

			const rows = db.prepare(`
				SELECT
					t.id,
					t.user_id,
					t.title,
					t.created_at,
					t.updated_at,
					t.archived_at,
					t.project_metadata,
					COUNT(g.id) as generation_count,
					MAX(g.created_at) as last_generation_at,
					(
						SELECT c.image_path FROM generations c
						WHERE c.thread_id = t.id AND c.deleted_at IS NULL AND c.purged_at IS NULL
						ORDER BY c.created_at DESC LIMIT 1
					) as cover_image_path
				FROM threads t
				LEFT JOIN generations g ON g.thread_id = t.id AND g.deleted_at IS NULL AND g.purged_at IS NULL
				WHERE t.user_id = ? AND t.deleted_at IS NULL
				GROUP BY t.id
				ORDER BY COALESCE(MAX(g.created_at), t.updated_at) DESC
			`).all(userId) as ThreadDbRow[];

			const threads: Thread[] = rows.map((row) => ({
				id: row.id,
				userId: row.user_id,
				title: row.title,
				createdAt: row.created_at,
				updatedAt: row.updated_at,
				archivedAt: row.archived_at || undefined,
				generationCount: row.generation_count || 0,
				lastGenerationAt: row.last_generation_at || undefined,
				coverImageUrl: row.cover_image_path ? `/images/${row.cover_image_path}` : undefined,
				projectMetadata: row.project_metadata ? JSON.parse(row.project_metadata) : undefined,
			}));

			return { threads };
		}
	);

	// POST /api/threads - Create a new thread
	fastify.post<{ Body: CreateThreadBody }>(
		"/api/threads",
		{ preHandler: authMiddleware },
		async (request) => {
			const db = getDb();
			const userId = requireUserId(request);
			const { title, projectMetadata } = request.body;

			const threadId = crypto.randomUUID();
			const threadTitle = title || "New Thread";
			const metadataJson = projectMetadata ? JSON.stringify(projectMetadata) : null;

			db.prepare(`
				INSERT INTO threads (id, user_id, title, project_metadata, created_at, updated_at)
				VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))
			`).run(threadId, userId, threadTitle, metadataJson);

			return {
				id: threadId,
				userId,
				title: threadTitle,
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				projectMetadata,
			};
		}
	);

	// GET /api/threads/:id - Get a specific thread with its generations
	fastify.get<{ Params: ThreadParams }>(
		"/api/threads/:id",
		{ preHandler: authMiddleware },
		async (request, reply) => {
			const db = getDb();
			const userId = requireUserId(request);
			const { id } = request.params;

			const thread = db.prepare(`
				SELECT id, user_id, title, created_at, updated_at, archived_at, project_metadata
				FROM threads
				WHERE id = ? AND user_id = ? AND deleted_at IS NULL
			`).get(id, userId) as ThreadDbRow | undefined;

			if (!thread) {
				return reply.status(404).send({ error: "Thread not found" });
			}

			// Get generations for this thread
			const generations = db.prepare(`
				SELECT
					id, prompt, model, model_version, image_path,
					width, height, parameters, created_at, replicate_id, cost
				FROM generations
				WHERE thread_id = ? AND deleted_at IS NULL AND purged_at IS NULL
				ORDER BY created_at DESC
			`).all(id) as Array<{
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
				cost: number | null;
			}>;

			return {
				id: thread.id,
				userId: thread.user_id,
				title: thread.title,
				createdAt: thread.created_at,
				updatedAt: thread.updated_at,
				archivedAt: thread.archived_at || undefined,
				projectMetadata: thread.project_metadata ? JSON.parse(thread.project_metadata) : undefined,
				generations: generations.map((g) => {
					const params = g.parameters ? JSON.parse(g.parameters) : undefined;
					const images = params?.images as { id: string; url: string }[] | undefined;
					return {
						id: g.id,
						prompt: g.prompt,
						model: g.model,
						modelVersion: g.model_version || undefined,
						imagePath: g.image_path,
						imageUrl: `/images/${g.image_path}`,
						width: g.width || undefined,
						height: g.height || undefined,
						parameters: params,
						createdAt: g.created_at,
						replicateId: g.replicate_id || undefined,
						cost: g.cost || 0,
						images,
					};
				}),
			};
		}
	);

	// PATCH /api/threads/:id - Update thread (rename and/or metadata)
	fastify.patch<{ Params: ThreadParams; Body: UpdateThreadBody }>(
		"/api/threads/:id",
		{ preHandler: authMiddleware },
		async (request, reply) => {
			const db = getDb();
			const userId = requireUserId(request);
			const { id } = request.params;
			const { title, projectMetadata } = request.body;

			// Verify ownership
			const thread = db.prepare(
				"SELECT id FROM threads WHERE id = ? AND user_id = ?"
			).get(id, userId);

			if (!thread) {
				return reply.status(404).send({ error: "Thread not found" });
			}

			// Build dynamic update based on what's provided
			const updates: string[] = ["updated_at = datetime('now')"];
			const values: (string | null)[] = [];

			if (title !== undefined) {
				updates.push("title = ?");
				values.push(title);
			}

			if (projectMetadata !== undefined) {
				updates.push("project_metadata = ?");
				values.push(JSON.stringify(projectMetadata));
			}

			values.push(id);

			db.prepare(`
				UPDATE threads SET ${updates.join(", ")}
				WHERE id = ?
			`).run(...values);

			return { success: true };
		}
	);

	// DELETE /api/threads/:id - Delete or archive thread
	// Query params:
	// - deletePhotos=true: Permanently delete thread and purge all photos
	// - deletePhotos=false (default): Archive thread, keep photos intact
	fastify.delete<{ Params: ThreadParams; Querystring: DeleteThreadQuery }>(
		"/api/threads/:id",
		{ preHandler: authMiddleware },
		async (request, reply) => {
			const db = getDb();
			const userId = requireUserId(request);
			const { id } = request.params;
			const { deletePhotos } = request.query;

			// Verify ownership
			const thread = db.prepare(
				"SELECT id, title FROM threads WHERE id = ? AND user_id = ? AND deleted_at IS NULL"
			).get(id, userId) as { id: string; title: string } | undefined;

			if (!thread) {
				return reply.status(404).send({ error: "Thread not found" });
			}

			if (deletePhotos === "true") {
				// Get all image paths from generations in this thread
				const generations = db.prepare(`
					SELECT id, image_path, parameters FROM generations
					WHERE thread_id = ? AND user_id = ? AND purged_at IS NULL
				`).all(id, userId) as { id: string; image_path: string | null; parameters: string | null }[];

				// Delete image files from disk (primary + grid images)
				for (const gen of generations) {
					deleteGenerationFiles(gen.image_path, gen.parameters);
				}

				// Purge all generations (mark as permanently deleted but keep record for cost tracking)
				db.prepare(`
					UPDATE generations SET purged_at = datetime('now'), deleted_at = datetime('now')
					WHERE thread_id = ? AND purged_at IS NULL
				`).run(id);

				// Soft delete the thread
				db.prepare(`
					UPDATE threads SET deleted_at = datetime('now')
					WHERE id = ?
				`).run(id);

				return { success: true, action: "deleted", photosDeleted: generations.length };
			}

			// Default: Archive thread (keep photos intact for continuity)
			db.prepare(`
				UPDATE threads SET archived_at = datetime('now'), updated_at = datetime('now')
				WHERE id = ?
			`).run(id);

			return { success: true, action: "archived" };
		}
	);

	// POST /api/threads/:id/archive - Archive thread
	fastify.post<{ Params: ThreadParams }>(
		"/api/threads/:id/archive",
		{ preHandler: authMiddleware },
		async (request, reply) => {
			const db = getDb();
			const userId = requireUserId(request);
			const { id } = request.params;

			const thread = db.prepare(
				"SELECT id FROM threads WHERE id = ? AND user_id = ?"
			).get(id, userId);

			if (!thread) {
				return reply.status(404).send({ error: "Thread not found" });
			}

			db.prepare(`
				UPDATE threads SET archived_at = datetime('now'), updated_at = datetime('now')
				WHERE id = ?
			`).run(id);

			return { success: true };
		}
	);

	// POST /api/threads/:id/unarchive - Unarchive thread
	fastify.post<{ Params: ThreadParams }>(
		"/api/threads/:id/unarchive",
		{ preHandler: authMiddleware },
		async (request, reply) => {
			const db = getDb();
			const userId = requireUserId(request);
			const { id } = request.params;

			const thread = db.prepare(
				"SELECT id FROM threads WHERE id = ? AND user_id = ?"
			).get(id, userId);

			if (!thread) {
				return reply.status(404).send({ error: "Thread not found" });
			}

			db.prepare(`
				UPDATE threads SET archived_at = NULL, updated_at = datetime('now')
				WHERE id = ?
			`).run(id);

			return { success: true };
		}
	);
}
