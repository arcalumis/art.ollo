import crypto from "node:crypto";
import { getDb } from "../db";

export type TokenType = "magic_link" | "password_reset";

interface CreateTokenOptions {
	userId: string;
	type: TokenType;
	rememberMe?: boolean;
	expiresInMinutes: number;
}

export interface TokenValidation {
	valid: boolean;
	userId?: string;
	rememberMe?: boolean;
	error?: string;
}

export function generateSecureToken(): string {
	return crypto.randomBytes(32).toString("hex");
}

/** Tokens are stored only as SHA-256 hashes; the raw value exists only in the emailed link. */
export function hashToken(token: string): string {
	return crypto.createHash("sha256").update(token).digest("hex");
}

function nowIso(): string {
	return new Date().toISOString();
}

export function createEmailToken(options: CreateTokenOptions): string {
	const db = getDb();
	const token = generateSecureToken();
	const tokenHash = hashToken(token);
	const expiresAt = new Date(Date.now() + options.expiresInMinutes * 60 * 1000);

	// The legacy `token` column is UNIQUE NOT NULL; it receives the hash too, never the raw token.
	db.prepare(`
		INSERT INTO email_tokens (id, user_id, token, token_hash, type, remember_me, expires_at)
		VALUES (?, ?, ?, ?, ?, ?, ?)
	`).run(
		crypto.randomUUID(),
		options.userId,
		tokenHash,
		tokenHash,
		options.type,
		options.rememberMe ? 1 : 0,
		expiresAt.toISOString(),
	);

	return token;
}

/** Non-consuming check (used to decide whether to show the reset-password form). */
export function peekToken(token: string, expectedType: TokenType): TokenValidation {
	const record = getDb()
		.prepare(`
			SELECT user_id, remember_me FROM email_tokens
			WHERE token_hash = ? AND type = ? AND used_at IS NULL AND expires_at > ?
		`)
		.get(hashToken(token), expectedType, nowIso()) as { user_id: string; remember_me: number } | undefined;

	if (!record) return { valid: false, error: "Invalid or expired link" };
	return { valid: true, userId: record.user_id, rememberMe: record.remember_me === 1 };
}

/**
 * Atomically consume a token: a single conditional UPDATE marks it used only if it is unused
 * and unexpired, so two concurrent requests can never both succeed.
 */
export function consumeToken(token: string, expectedType: TokenType): TokenValidation {
	const record = getDb()
		.prepare(`
			UPDATE email_tokens SET used_at = datetime('now')
			WHERE token_hash = ? AND type = ? AND used_at IS NULL AND expires_at > ?
			RETURNING user_id, remember_me
		`)
		.get(hashToken(token), expectedType, nowIso()) as { user_id: string; remember_me: number } | null;

	if (!record) return { valid: false, error: "Invalid or expired link" };
	return { valid: true, userId: record.user_id, rememberMe: record.remember_me === 1 };
}

export function invalidateUserTokens(userId: string, type?: TokenType): void {
	const db = getDb();
	if (type) {
		db.prepare(
			"UPDATE email_tokens SET used_at = datetime('now') WHERE user_id = ? AND type = ? AND used_at IS NULL",
		).run(userId, type);
	} else {
		db.prepare("UPDATE email_tokens SET used_at = datetime('now') WHERE user_id = ? AND used_at IS NULL").run(
			userId,
		);
	}
}

// ---- Sign-up tokens (email has no account yet) ----

export function createSignupToken(email: string, rememberMe: boolean, expiresInMinutes: number): string {
	const token = generateSecureToken();
	getDb()
		.prepare(`
			INSERT INTO signup_tokens (id, email, token_hash, remember_me, expires_at)
			VALUES (?, ?, ?, ?, ?)
		`)
		.run(
			crypto.randomUUID(),
			email,
			hashToken(token),
			rememberMe ? 1 : 0,
			new Date(Date.now() + expiresInMinutes * 60 * 1000).toISOString(),
		);
	return token;
}

export function consumeSignupToken(token: string): { email: string; rememberMe: boolean } | null {
	const record = getDb()
		.prepare(`
			UPDATE signup_tokens SET used_at = datetime('now')
			WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?
			RETURNING email, remember_me
		`)
		.get(hashToken(token), nowIso()) as { email: string; remember_me: number } | null;
	return record ? { email: record.email, rememberMe: record.remember_me === 1 } : null;
}

export function cleanupExpiredTokens(): number {
	const db = getDb();
	const now = nowIso();
	const a = db.prepare("DELETE FROM email_tokens WHERE expires_at < ?").run(now).changes;
	const b = db.prepare("DELETE FROM signup_tokens WHERE expires_at < ?").run(now).changes;
	return a + b;
}
