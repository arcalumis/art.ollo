import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import type { FastifyInstance, FastifyReply } from "fastify";
import { getDb } from "../db";
import { authMiddleware, signToken } from "../middleware/auth";
import { TRASH_RETENTION_DAYS } from "../services/cleanup";
import { reserveEmailSend, sendEmailChangeEmail } from "../services/email";
import { requireUserId } from "../services/request-user";
import * as stripeService from "../services/stripe";
import { generateSecureToken, hashToken, invalidateUserTokens } from "../services/tokens";
import { hashPassword, normalizeEmail, unusablePasswordHash } from "./auth";

/**
 * Account settings for the signed-in user.
 *
 *   GET    /api/account                 profile: username, email, pending email, has password
 *   PATCH  /api/account/profile         { username }
 *   POST   /api/account/email           { email }  sends a confirmation link to the NEW address
 *   POST   /api/account/email/confirm   { token }  (no session needed: the link proves the inbox)
 *   PUT    /api/account/password        { currentPassword?, newPassword } -> fresh token
 *   GET    /api/account/export          JSON download of prompts + image URLs
 *   POST   /api/account/delete          { confirm: <username> }
 */

const APP_URL = (process.env.APP_URL || "http://localhost:5173").replace(/\/$/, "");
const EMAIL_CHANGE_EXPIRY_MINUTES = 60;

const strict = (max: number) => ({ config: { rateLimit: { max, timeWindow: "1 minute" } } });

interface AccountRow {
	id: string;
	username: string;
	email: string | null;
	password_hash: string | null;
	is_admin: number;
	wallet_address: string | null;
	created_at: string | null;
	token_version: number | null;
}

function loadAccount(userId: string): AccountRow | undefined {
	return getDb()
		.prepare(
			"SELECT id, username, email, password_hash, is_admin, wallet_address, created_at, token_version FROM users WHERE id = ?",
		)
		.get(userId) as AccountRow | undefined;
}

/** Real password hashes only: bcrypt or the legacy SHA-256 hex. Magic-link accounts have neither. */
function hasUsablePassword(hash: string | null): boolean {
	if (!hash) return false;
	return hash.startsWith("$2") || (hash.length === 64 && /^[a-f0-9]+$/.test(hash));
}

function checkPassword(password: string, hash: string | null): boolean {
	if (!hash || !hasUsablePassword(hash)) return false;
	if (!hash.startsWith("$2")) {
		const candidate = crypto.createHash("sha256").update(password).digest();
		return crypto.timingSafeEqual(candidate, Buffer.from(hash, "hex"));
	}
	try {
		return bcrypt.compareSync(password, hash);
	} catch {
		return false;
	}
}

/** Same rules as sign-up and reset, so a password that works there works here. */
function passwordProblem(password: unknown): string | null {
	if (typeof password !== "string" || password.length < 8) return "Use at least 8 characters.";
	if (password.length > 200) return "Use at most 200 characters.";
	if (!/[A-Z]/.test(password)) return "Add at least one uppercase letter.";
	if (!/[a-z]/.test(password)) return "Add at least one lowercase letter.";
	if (!/[0-9]/.test(password)) return "Add at least one number.";
	return null;
}

const RESERVED_USERNAMES = new Set(["admin", "ollo", "support", "root", "system"]);

function usernameProblem(username: unknown): string | null {
	if (typeof username !== "string") return "Enter a username.";
	if (username.length < 3 || username.length > 30) return "Use 3 to 30 characters.";
	if (!/^[A-Za-z0-9_.-]+$/.test(username))
		return "Use letters, numbers, dots, dashes or underscores.";
	const lower = username.toLowerCase();
	if (RESERVED_USERNAMES.has(lower) || lower.startsWith("deleted-"))
		return "That username isn't available.";
	return null;
}

function fail(reply: FastifyReply, status: number, code: string, error: string) {
	return reply.status(status).send({ error, code });
}

function pendingEmail(userId: string): string | null {
	const row = getDb()
		.prepare(
			`SELECT new_email FROM email_change_tokens
			WHERE user_id = ? AND used_at IS NULL AND expires_at > ?
			ORDER BY created_at DESC LIMIT 1`,
		)
		.get(userId, new Date().toISOString()) as { new_email: string } | undefined;
	return row?.new_email ?? null;
}

function imageUrlsFor(imagePath: string, parameters: string | null): string[] {
	const urls = new Set<string>([`${APP_URL}/images/${imagePath}`]);
	try {
		const params = parameters ? (JSON.parse(parameters) as { images?: { url?: unknown }[] }) : {};
		for (const img of params.images ?? []) {
			if (typeof img?.url === "string") urls.add(`${APP_URL}${img.url}`);
		}
	} catch {
		// Malformed parameters: the primary image is still listed.
	}
	return [...urls];
}

export async function accountRoutes(fastify: FastifyInstance): Promise<void> {
	const db = getDb();

	fastify.get("/api/account", { preHandler: authMiddleware }, async (request, reply) => {
		const user = loadAccount(requireUserId(request));
		if (!user) return fail(reply, 404, "NOT_FOUND", "Account not found");
		return {
			username: user.username,
			email: user.email,
			pendingEmail: pendingEmail(user.id),
			hasPassword: hasUsablePassword(user.password_hash),
			hasWallet: !!user.wallet_address,
			isAdmin: user.is_admin === 1,
			createdAt: user.created_at,
		};
	});

	fastify.patch<{ Body: { username?: unknown } }>(
		"/api/account/profile",
		{ preHandler: authMiddleware, ...strict(10) },
		async (request, reply) => {
			const userId = requireUserId(request);
			const username =
				typeof request.body?.username === "string" ? request.body.username.trim() : undefined;
			const problem = usernameProblem(username);
			if (problem || !username)
				return fail(reply, 400, "INVALID_USERNAME", problem ?? "Enter a username.");
			const taken = db
				.prepare("SELECT id FROM users WHERE username = ? COLLATE NOCASE AND id <> ?")
				.get(username, userId);
			if (taken) return fail(reply, 409, "USERNAME_TAKEN", "That username is taken.");
			db.prepare("UPDATE users SET username = ? WHERE id = ?").run(username, userId);
			return { success: true, username };
		},
	);

	// Change email, step 1: send a link to the new address. The response is the same whether or
	// not another account already uses that address, so this can't be used to probe for accounts.
	fastify.post<{ Body: { email?: unknown } }>(
		"/api/account/email",
		{ preHandler: authMiddleware, ...strict(5) },
		async (request, reply) => {
			const user = loadAccount(requireUserId(request));
			if (!user) return fail(reply, 404, "NOT_FOUND", "Account not found");
			const email = normalizeEmail(request.body?.email);
			if (!email) return fail(reply, 400, "INVALID_EMAIL", "Enter a valid email address.");
			if (email === user.email) return fail(reply, 400, "SAME_EMAIL", "That's already your email.");

			const sent = { success: true, pendingEmail: email };
			const taken = db
				.prepare("SELECT 1 FROM users WHERE email = ? AND id <> ?")
				.get(email, user.id);
			if (taken) return sent;
			if (!reserveEmailSend(email, "email_change", request.ip)) {
				return fail(
					reply,
					429,
					"EMAIL_CAP",
					"Too many emails to that address. Try again in an hour.",
				);
			}

			const token = generateSecureToken();
			db.transaction(() => {
				// Only the newest request counts.
				db.prepare(
					"UPDATE email_change_tokens SET used_at = datetime('now') WHERE user_id = ? AND used_at IS NULL",
				).run(user.id);
				db.prepare(
					"INSERT INTO email_change_tokens (id, user_id, new_email, token_hash, expires_at) VALUES (?, ?, ?, ?, ?)",
				).run(
					crypto.randomUUID(),
					user.id,
					email,
					hashToken(token),
					new Date(Date.now() + EMAIL_CHANGE_EXPIRY_MINUTES * 60 * 1000).toISOString(),
				);
			})();

			const result = await sendEmailChangeEmail(email, user.username, token);
			if (!result.success) {
				request.log.error({ err: result.error }, "Email change confirmation send failed");
				return fail(
					reply,
					503,
					"EMAIL_UNAVAILABLE",
					"We couldn't send email right now. Try again later.",
				);
			}
			return sent;
		},
	);

	// Change email, step 2: the link from the new inbox. No session needed.
	fastify.post<{ Body: { token?: unknown } }>(
		"/api/account/email/confirm",
		strict(10),
		async (request, reply) => {
			const token = request.body?.token;
			if (typeof token !== "string" || token.length < 16 || token.length > 200) {
				return fail(reply, 400, "INVALID_TOKEN", "This link is invalid or has expired.");
			}
			const outcome = db.transaction(() => {
				const row = db
					.prepare(
						`UPDATE email_change_tokens SET used_at = datetime('now')
						WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?
						RETURNING user_id, new_email`,
					)
					.get(hashToken(token), new Date().toISOString()) as {
					user_id: string;
					new_email: string;
				} | null;
				if (!row) return "invalid" as const;
				const owner = db
					.prepare(
						"SELECT id FROM users WHERE id = ? AND deleted_at IS NULL AND COALESCE(is_active, 1) = 1",
					)
					.get(row.user_id);
				if (!owner) return "invalid" as const;
				const taken = db
					.prepare("SELECT 1 FROM users WHERE email = ? AND id <> ?")
					.get(row.new_email, row.user_id);
				if (taken) return "taken" as const;
				db.prepare("UPDATE users SET email = ? WHERE id = ?").run(row.new_email, row.user_id);
				// Outstanding sign-in links went to the old address.
				invalidateUserTokens(row.user_id);
				return { email: row.new_email };
			})();
			if (outcome === "invalid")
				return fail(reply, 400, "INVALID_TOKEN", "This link is invalid or has expired.");
			if (outcome === "taken") {
				return fail(
					reply,
					409,
					"EMAIL_TAKEN",
					"Another account uses that email, so it can't be added here.",
				);
			}
			return { success: true, email: outcome.email };
		},
	);

	// Set (magic-link accounts) or change a password. Every other session is signed out; this one
	// gets a fresh token.
	fastify.put<{ Body: { currentPassword?: unknown; newPassword?: unknown } }>(
		"/api/account/password",
		{ preHandler: authMiddleware, ...strict(5) },
		async (request, reply) => {
			const user = loadAccount(requireUserId(request));
			if (!user) return fail(reply, 404, "NOT_FOUND", "Account not found");
			const { currentPassword, newPassword } = request.body ?? {};
			if (hasUsablePassword(user.password_hash)) {
				if (
					typeof currentPassword !== "string" ||
					!checkPassword(currentPassword, user.password_hash)
				) {
					return fail(reply, 403, "WRONG_PASSWORD", "Your current password doesn't match.");
				}
			}
			const problem = passwordProblem(newPassword);
			if (problem) return fail(reply, 400, "WEAK_PASSWORD", problem);

			const version = (user.token_version ?? 0) + 1;
			db.transaction(() => {
				db.prepare("UPDATE users SET password_hash = ?, token_version = ? WHERE id = ?").run(
					hashPassword(newPassword as string),
					version,
					user.id,
				);
				invalidateUserTokens(user.id, "password_reset");
			})();
			const token = signToken(
				{ userId: user.id, username: user.username, isAdmin: user.is_admin === 1, tv: version },
				true,
			);
			return { success: true, token };
		},
	);

	fastify.get(
		"/api/account/export",
		{ preHandler: authMiddleware, ...strict(3) },
		async (request, reply) => {
			const userId = requireUserId(request);
			const user = loadAccount(userId);
			if (!user) return fail(reply, 404, "NOT_FOUND", "Account not found");

			const generations = db
				.prepare(
					`SELECT g.id, g.prompt, g.model, g.image_path, g.width, g.height, g.parameters, g.created_at,
					g.archived_at, g.deleted_at, t.title AS thread_title
				FROM generations g LEFT JOIN threads t ON t.id = g.thread_id
				WHERE g.user_id = ? AND g.purged_at IS NULL
				ORDER BY g.created_at ASC`,
				)
				.all(userId) as Array<{
				id: string;
				prompt: string;
				model: string;
				image_path: string;
				width: number | null;
				height: number | null;
				parameters: string | null;
				created_at: string;
				archived_at: string | null;
				deleted_at: string | null;
				thread_title: string | null;
			}>;
			const uploads = db
				.prepare(
					"SELECT id, original_name, filename, created_at FROM uploads WHERE user_id = ? ORDER BY created_at ASC",
				)
				.all(userId) as Array<{
				id: string;
				original_name: string;
				filename: string;
				created_at: string;
			}>;
			const credits = db
				.prepare(
					"SELECT credit_type, amount, reason, created_at FROM user_credits WHERE user_id = ? ORDER BY created_at ASC",
				)
				.all(userId) as Array<{
				credit_type: string;
				amount: number;
				reason: string | null;
				created_at: string;
			}>;

			const body = {
				exportedAt: new Date().toISOString(),
				account: { username: user.username, email: user.email, createdAt: user.created_at },
				images: generations.map((g) => {
					let creditsCharged: number | undefined;
					let aspectRatio: string | undefined;
					try {
						const p = g.parameters ? (JSON.parse(g.parameters) as Record<string, unknown>) : {};
						if (typeof p.creditsCharged === "number") creditsCharged = p.creditsCharged;
						if (typeof p.aspectRatio === "string") aspectRatio = p.aspectRatio;
					} catch {
						// keep going without the extras
					}
					return {
						id: g.id,
						prompt: g.prompt,
						model: g.model,
						series: g.thread_title,
						createdAt: g.created_at,
						imageUrls: imageUrlsFor(g.image_path, g.parameters),
						width: g.width,
						height: g.height,
						aspectRatio,
						creditsCharged,
						status: g.deleted_at ? "trash" : g.archived_at ? "archived" : "active",
					};
				}),
				uploads: uploads.map((u) => ({
					id: u.id,
					name: u.original_name,
					url: `${APP_URL}/uploads/${u.filename}`,
					createdAt: u.created_at,
				})),
				credits: credits.map((c) => ({
					type: c.credit_type,
					amount: c.amount,
					reason: c.reason,
					at: c.created_at,
				})),
			};
			const stamp = new Date().toISOString().slice(0, 10);
			reply.header("Content-Disposition", `attachment; filename="ollo-export-${stamp}.json"`);
			reply.header("Cache-Control", "no-store");
			return reply.type("application/json; charset=utf-8").send(JSON.stringify(body, null, 2));
		},
	);

	// Delete the account: cancel any Stripe subscription first (refuse if that fails, so nobody is
	// billed for a deleted account), then soft-delete the user, end every session and queue the
	// images for the next purge run.
	fastify.post<{ Body: { confirm?: unknown } }>(
		"/api/account/delete",
		{ preHandler: authMiddleware, ...strict(3) },
		async (request, reply) => {
			const user = loadAccount(requireUserId(request));
			if (!user) return fail(reply, 404, "NOT_FOUND", "Account not found");
			if (user.is_admin === 1) {
				return fail(reply, 403, "ADMIN_ACCOUNT", "Admin accounts can't be deleted from settings.");
			}
			if (
				typeof request.body?.confirm !== "string" ||
				request.body.confirm.trim() !== user.username
			) {
				return fail(reply, 400, "CONFIRMATION_MISMATCH", "Type your username exactly to confirm.");
			}

			const liveSubs = db
				.prepare(
					`SELECT id, stripe_subscription_id FROM user_subscriptions
					WHERE user_id = ? AND stripe_subscription_id IS NOT NULL
					AND status IN ('active', 'trialing', 'past_due', 'unpaid', 'incomplete')`,
				)
				.all(user.id) as Array<{ id: string; stripe_subscription_id: string }>;
			for (const sub of liveSubs) {
				const canceled = await stripeService.cancelSubscription(sub.stripe_subscription_id);
				if (!canceled) {
					request.log.error({ userId: user.id }, "Account delete: Stripe cancellation failed");
					return fail(
						reply,
						502,
						"SUBSCRIPTION_CANCEL_FAILED",
						"We couldn't cancel your subscription, so your account wasn't deleted. Try again, or cancel it from Billing first.",
					);
				}
			}

			// Back-date deleted_at past the retention window so the next cleanup run purges the files.
			const purgeAt = `-${TRASH_RETENTION_DAYS + 1} days`;
			db.transaction(() => {
				db.prepare(
					`UPDATE users SET
						is_active = 0,
						deleted_at = datetime('now'),
						username = ?,
						email = NULL,
						wallet_address = NULL,
						password_hash = ?,
						token_version = COALESCE(token_version, 0) + 1
					WHERE id = ?`,
				).run(
					`deleted-${user.id.slice(0, 8)}-${crypto.randomBytes(2).toString("hex")}`,
					unusablePasswordHash(),
					user.id,
				);
				db.prepare(
					"UPDATE user_subscriptions SET status = 'canceled', ends_at = datetime('now') WHERE user_id = ? AND status <> 'canceled'",
				).run(user.id);
				db.prepare(
					"UPDATE generations SET deleted_at = datetime('now', ?) WHERE user_id = ? AND purged_at IS NULL",
				).run(purgeAt, user.id);
				db.prepare("UPDATE uploads SET deleted_at = datetime('now', ?) WHERE user_id = ?").run(
					purgeAt,
					user.id,
				);
				db.prepare(
					"UPDATE threads SET deleted_at = datetime('now') WHERE user_id = ? AND deleted_at IS NULL",
				).run(user.id);
				db.prepare(
					"UPDATE share_links SET revoked_at = datetime('now') WHERE user_id = ? AND revoked_at IS NULL",
				).run(user.id);
				db.prepare("DELETE FROM user_api_keys WHERE user_id = ?").run(user.id);
				db.prepare(
					"UPDATE email_change_tokens SET used_at = datetime('now') WHERE user_id = ? AND used_at IS NULL",
				).run(user.id);
				invalidateUserTokens(user.id);
			})();

			request.log.info(
				{ userId: user.id, canceledSubscriptions: liveSubs.length },
				"Account deleted by user",
			);
			return { success: true };
		},
	);
}
