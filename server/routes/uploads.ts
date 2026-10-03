import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { getDb } from "../db";
import { authMiddleware } from "../middleware/auth";
import { requireUserId } from "../services/request-user";
import { getUploadsDir, unlinkInside } from "../services/storage";

// Allowed image extensions and MIME types
const ALLOWED_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".avif"]);
const ALLOWED_MIME_TYPES = new Set([
	"image/jpeg",
	"image/png",
	"image/gif",
	"image/webp",
	"image/avif",
]);

// Magic bytes for image validation
const IMAGE_SIGNATURES: { [key: string]: number[] } = {
	jpeg: [0xff, 0xd8, 0xff],
	png: [0x89, 0x50, 0x4e, 0x47],
	gif: [0x47, 0x49, 0x46],
	webp: [0x52, 0x49, 0x46, 0x46], // RIFF header (WebP starts with RIFF)
};

function isValidImageContent(buffer: Buffer): boolean {
	if (buffer.length < 4) return false;

	for (const sig of Object.values(IMAGE_SIGNATURES)) {
		if (sig.every((byte, i) => buffer[i] === byte)) {
			return true;
		}
	}
	return false;
}

interface UploadRow {
	id: string;
	user_id: string;
	filename: string;
	original_name: string;
	created_at: string;
	deleted_at: string | null;
	archived_at: string | null;
}

interface UploadsQuery {
	trash?: string;
	archived?: string;
}

interface TrashBody {
	deleted: boolean;
}

interface ArchiveBody {
	archived: boolean;
}

export async function uploadsRoutes(fastify: FastifyInstance): Promise<void> {
	// Ensure uploads directory exists
	if (!fs.existsSync(getUploadsDir())) {
		fs.mkdirSync(getUploadsDir(), { recursive: true });
	}

	// Upload image (with strict validation)
	fastify.post("/api/uploads", { preHandler: authMiddleware }, async (request, reply) => {
		const data = await request.file();

		if (!data) {
			return reply.status(400).send({ error: "No file uploaded" });
		}

		// Validate MIME type
		if (!ALLOWED_MIME_TYPES.has(data.mimetype)) {
			return reply.status(400).send({
				error: "Invalid file type. Only JPEG, PNG, GIF, WebP, and AVIF images are allowed.",
			});
		}

		// Validate extension
		const ext = path.extname(data.filename).toLowerCase();
		if (!ALLOWED_EXTENSIONS.has(ext)) {
			return reply.status(400).send({
				error: "Invalid file extension. Only .jpg, .jpeg, .png, .gif, .webp, and .avif are allowed.",
			});
		}

		const buffer = await data.toBuffer();

		// Validate file content (magic bytes)
		if (!isValidImageContent(buffer)) {
			return reply.status(400).send({
				error: "Invalid file content. The file does not appear to be a valid image.",
			});
		}

		const id = crypto.randomUUID();
		// Use validated extension (normalized to lowercase)
		const filename = `${id}${ext}`;
		const filePath = path.join(getUploadsDir(), filename);

		fs.writeFileSync(filePath, buffer);

		const db = getDb();
		db.prepare(
			"INSERT INTO uploads (id, user_id, filename, original_name) VALUES (?, ?, ?, ?)",
		).run(id, requireUserId(request), filename, data.filename);

		return {
			id,
			filename,
			originalName: data.filename,
			imageUrl: `/uploads/${filename}`,
		};
	});

	// List user's uploads
	fastify.get<{ Querystring: UploadsQuery }>(
		"/api/uploads",
		{ preHandler: authMiddleware },
		async (request) => {
			const showTrash = request.query.trash === "true";
			const showArchived = request.query.archived === "true";

			let condition: string;
			if (showTrash) {
				condition = "deleted_at IS NOT NULL";
			} else if (showArchived) {
				condition = "archived_at IS NOT NULL AND deleted_at IS NULL";
			} else {
				condition = "deleted_at IS NULL AND archived_at IS NULL";
			}

			const db = getDb();
			const rows = db
				.prepare(
					`SELECT * FROM uploads WHERE user_id = ? AND ${condition} ORDER BY created_at DESC`,
				)
				.all(requireUserId(request)) as UploadRow[];

			return {
				uploads: rows.map((row) => ({
					id: row.id,
					filename: row.filename,
					originalName: row.original_name,
					imageUrl: `/uploads/${row.filename}`,
					createdAt: row.created_at,
					deletedAt: row.deleted_at || undefined,
					archivedAt: row.archived_at || undefined,
					isUpload: true,
				})),
			};
		},
	);

	// PATCH - Soft delete (move to trash) or restore
	fastify.patch<{ Params: { id: string }; Body: TrashBody }>(
		"/api/uploads/:id",
		{ preHandler: authMiddleware },
		async (request, reply) => {
			const { id } = request.params;
			const { deleted } = request.body;

			const db = getDb();
			const row = db
				.prepare("SELECT id FROM uploads WHERE id = ? AND user_id = ?")
				.get(id, requireUserId(request)) as { id: string } | undefined;

			if (!row) {
				return reply.status(404).send({ error: "Upload not found" });
			}

			if (deleted) {
				db.prepare("UPDATE uploads SET deleted_at = datetime('now') WHERE id = ?").run(id);
			} else {
				db.prepare("UPDATE uploads SET deleted_at = NULL WHERE id = ?").run(id);
			}

			return { success: true };
		},
	);

	// DELETE - Permanently delete upload
	fastify.delete<{ Params: { id: string } }>(
		"/api/uploads/:id",
		{ preHandler: authMiddleware },
		async (request, reply) => {
			const { id } = request.params;
			const db = getDb();

			const row = db
				.prepare("SELECT * FROM uploads WHERE id = ? AND user_id = ?")
				.get(id, requireUserId(request)) as UploadRow | undefined;

			if (!row) {
				return reply.status(404).send({ error: "Upload not found" });
			}

			// Delete file
			unlinkInside(getUploadsDir(), row.filename);

			// Delete record
			db.prepare("DELETE FROM uploads WHERE id = ?").run(id);

			return { success: true };
		},
	);
}
