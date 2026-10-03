import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { getDb } from "../db";
import { authMiddleware } from "../middleware/auth";
import { requireUserId } from "../services/request-user";

/**
 * Public share links.
 *
 *   POST   /api/share/:generationId  owner only: create (or return) the live slug
 *   DELETE /api/share/:generationId  owner only: revoke it
 *   GET    /api/share/:slug          public: image URL, prompt, model, date. Nothing about the owner.
 *   GET    /s/:slug                  the SPA's index.html with Open Graph tags for the image
 */

const APP_URL = (process.env.APP_URL || "http://localhost:5173").replace(/\/$/, "");

/** 128 random bits, URL-safe: 22 characters. */
export function newShareSlug(): string {
	return crypto.randomBytes(16).toString("base64url");
}

const SLUG_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

interface SharedRow {
	slug: string;
	prompt: string;
	model: string;
	image_path: string;
	width: number | null;
	height: number | null;
	parameters: string | null;
	created_at: string;
}

export interface PublicShare {
	slug: string;
	imageUrl: string;
	images?: { url: string }[];
	prompt: string;
	model: string;
	width?: number;
	height?: number;
	aspectRatio?: string;
	createdAt: string;
}

/** A live share: not revoked, image not trashed or purged, owner account still active. */
function findLiveShare(slug: string): PublicShare | null {
	if (!SLUG_PATTERN.test(slug)) return null;
	const row = getDb()
		.prepare(`
			SELECT s.slug, g.prompt, g.model, g.image_path, g.width, g.height, g.parameters, g.created_at
			FROM share_links s
			JOIN generations g ON g.id = s.generation_id
			JOIN users u ON u.id = s.user_id
			WHERE s.slug = ? AND s.revoked_at IS NULL
			AND g.user_id = s.user_id AND g.deleted_at IS NULL AND g.purged_at IS NULL
			AND COALESCE(u.is_active, 1) = 1 AND u.deleted_at IS NULL
		`)
		.get(slug) as SharedRow | undefined;
	if (!row) return null;

	// Only these parameters are public. imageInputs (the owner's reference uploads) never are.
	let images: { url: string }[] | undefined;
	let aspectRatio: string | undefined;
	try {
		const params = row.parameters ? (JSON.parse(row.parameters) as Record<string, unknown>) : {};
		if (Array.isArray(params.images) && params.images.length > 1) {
			images = (params.images as { url?: unknown }[])
				.filter((img) => typeof img?.url === "string")
				.map((img) => ({ url: img.url as string }));
		}
		if (typeof params.aspectRatio === "string") aspectRatio = params.aspectRatio;
	} catch {
		// Malformed parameters: share the primary image only.
	}

	return {
		slug: row.slug,
		imageUrl: `/images/${row.image_path}`,
		images,
		prompt: row.prompt,
		model: row.model,
		width: row.width ?? undefined,
		height: row.height ?? undefined,
		aspectRatio,
		createdAt: row.created_at,
	};
}

function escapeHtml(value: string): string {
	return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function truncate(value: string, max: number): string {
	const clean = value.replace(/\s+/g, " ").trim();
	return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}

/** Put share-specific title + Open Graph/Twitter tags into the SPA shell. Exported for tests. */
export function injectShareMeta(html: string, share: PublicShare | null, slug: string): string {
	const title = share ? `${truncate(share.prompt, 70)} | ollo` : "Shared image | ollo";
	const description = share
		? `Made with ollo: ${truncate(share.prompt, 180)}`
		: "This share link has been turned off or doesn't exist.";
	const pageUrl = `${APP_URL}/s/${encodeURIComponent(slug)}`;
	const tags = [
		`<meta property="og:type" content="website" />`,
		`<meta property="og:site_name" content="ollo" />`,
		`<meta property="og:title" content="${escapeHtml(title)}" />`,
		`<meta property="og:description" content="${escapeHtml(description)}" />`,
		`<meta property="og:url" content="${escapeHtml(pageUrl)}" />`,
		`<meta name="description" content="${escapeHtml(description)}" />`,
	];
	if (share) {
		tags.push(
			`<meta property="og:image" content="${escapeHtml(`${APP_URL}${share.imageUrl}`)}" />`,
			`<meta property="og:image:alt" content="${escapeHtml(truncate(share.prompt, 300))}" />`,
			`<meta name="twitter:card" content="summary_large_image" />`,
			`<meta name="twitter:image" content="${escapeHtml(`${APP_URL}${share.imageUrl}`)}" />`,
		);
		if (share.width && share.height) {
			tags.push(
				`<meta property="og:image:width" content="${share.width}" />`,
				`<meta property="og:image:height" content="${share.height}" />`,
			);
		}
	} else {
		tags.push(`<meta name="robots" content="noindex" />`);
	}
	tags.push(`<meta name="twitter:title" content="${escapeHtml(title)}" />`);

	// Drop the shell's generic description/OG tags so crawlers see only these.
	let out = html
		.replace(/<meta\s+(?:property|name)="(?:og:[^"]+|twitter:[^"]+|description)"[^>]*>\s*/gi, "")
		.replace(/<link\s+rel="canonical"[^>]*>\s*/gi, "")
		.replace(/<title>[\s\S]*?<\/title>/i, `<title>${escapeHtml(title)}</title>`);
	if (share) tags.push(`<link rel="canonical" href="${escapeHtml(pageUrl)}" />`);
	if (!/<title>/i.test(out))
		out = out.replace(/<\/head>/i, `<title>${escapeHtml(title)}</title></head>`);
	return out.replace(/<\/head>/i, `${tags.join("\n    ")}\n  </head>`);
}

function indexHtmlPath(): string {
	return path.join(process.cwd(), "dist", "index.html");
}

export async function shareRoutes(fastify: FastifyInstance): Promise<void> {
	const db = getDb();

	// Create or return the live share link for one of your generations.
	fastify.post<{ Params: { id: string } }>(
		"/api/share/:id",
		{ preHandler: authMiddleware, config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
		async (request, reply) => {
			const userId = requireUserId(request);
			const gen = db
				.prepare("SELECT id, deleted_at, purged_at FROM generations WHERE id = ? AND user_id = ?")
				.get(request.params.id, userId) as
				| { id: string; deleted_at: string | null; purged_at: string | null }
				| undefined;
			// Someone else's generation looks exactly like a missing one.
			if (!gen || gen.purged_at)
				return reply.status(404).send({ error: "Image not found", code: "NOT_FOUND" });
			if (gen.deleted_at) {
				return reply
					.status(409)
					.send({ error: "Restore this image from Trash before sharing it", code: "IN_TRASH" });
			}

			const slug = db.transaction(() => {
				const existing = db
					.prepare("SELECT slug FROM share_links WHERE generation_id = ? AND revoked_at IS NULL")
					.get(gen.id) as { slug: string } | undefined;
				if (existing) return existing.slug;
				const fresh = newShareSlug();
				db.prepare("INSERT INTO share_links (slug, generation_id, user_id) VALUES (?, ?, ?)").run(
					fresh,
					gen.id,
					userId,
				);
				return fresh;
			})();

			return { slug, url: `${APP_URL}/s/${slug}`, path: `/s/${slug}` };
		},
	);

	// Turn a share link off. Idempotent.
	fastify.delete<{ Params: { id: string } }>(
		"/api/share/:id",
		{ preHandler: authMiddleware },
		async (request, reply) => {
			const userId = requireUserId(request);
			const gen = db
				.prepare("SELECT id FROM generations WHERE id = ? AND user_id = ?")
				.get(request.params.id, userId);
			if (!gen) return reply.status(404).send({ error: "Image not found", code: "NOT_FOUND" });
			const result = db
				.prepare(
					"UPDATE share_links SET revoked_at = datetime('now') WHERE generation_id = ? AND user_id = ? AND revoked_at IS NULL",
				)
				.run(request.params.id, userId);
			return { success: true, revoked: result.changes > 0 };
		},
	);

	// Public: what a share link shows.
	fastify.get<{ Params: { slug: string } }>("/api/share/:slug", async (request, reply) => {
		const share = findLiveShare(request.params.slug);
		if (!share)
			return reply
				.status(404)
				.send({ error: "This link has been turned off", code: "SHARE_NOT_FOUND" });
		reply.header("Cache-Control", "public, max-age=60");
		return share;
	});

	// The share page itself, with Open Graph tags crawlers can read (the SPA can't set them).
	fastify.get<{ Params: { slug: string } }>("/s/:slug", async (request, reply) => {
		const indexPath = indexHtmlPath();
		if (!fs.existsSync(indexPath)) {
			// Dev without a build: Vite serves /s/:slug itself.
			return reply.status(404).send({ error: "Not found" });
		}
		const share = findLiveShare(request.params.slug);
		const html = injectShareMeta(fs.readFileSync(indexPath, "utf8"), share, request.params.slug);
		reply.header("Cache-Control", "public, max-age=60");
		return reply
			.status(share ? 200 : 404)
			.type("text/html; charset=utf-8")
			.send(html);
	});
}
