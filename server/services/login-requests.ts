import crypto from "node:crypto";
import { getDb } from "../db";
import { hashToken } from "./tokens";

/**
 * Cross-device sign-in. Requesting a magic link on device A creates a login request; the
 * emailed link, opened on device B, can approve it, and A (polling with a secret only it holds)
 * then receives a session exactly once.
 *
 * Status moves: pending -> approved -> consumed, or pending -> denied | expired | consumed
 * (consumed straight from pending when the link is used on the same device).
 */

export type LoginRequestStatus = "pending" | "approved" | "consumed" | "expired" | "denied";
export type LoginTokenKind = "magic_link" | "signup";
/** Why a request was denied: "denied" from the email, or "elsewhere" (signed in on B instead). */
export type DeniedReason = "denied" | "elsewhere";

export interface LoginRequestRow {
	id: string;
	email: string;
	code: string;
	poll_secret_hash: string;
	token_hash: string | null;
	token_kind: LoginTokenKind | null;
	status: LoginRequestStatus;
	denied_reason: DeniedReason | null;
	user_agent_summary: string;
	user_id: string | null;
	remember_me: number;
	is_new_user: number;
	expires_at: string;
}

/** A session for an approved request may still be collected this long after the link expired. */
const DELIVERY_GRACE_MS = 5 * 60 * 1000;

function sha256(value: string): Buffer {
	return crypto.createHash("sha256").update(value).digest();
}

function nowIso(): string {
	return new Date().toISOString();
}

/** A request id plus its poll secret and display code, minted before the email token exists. */
export interface NewLoginRequest {
	requestId: string;
	pollSecret: string;
	code: string;
}

export function mintLoginRequest(): NewLoginRequest {
	return {
		requestId: crypto.randomUUID(),
		pollSecret: crypto.randomBytes(32).toString("base64url"),
		code: crypto.randomInt(0, 10000).toString().padStart(4, "0"),
	};
}

export function saveLoginRequest(
	req: NewLoginRequest,
	opts: {
		email: string;
		/** Raw email token; null when no link was sent, so the request can never be approved. */
		token: string | null;
		tokenKind: LoginTokenKind | null;
		userAgent: string | undefined;
		rememberMe: boolean;
		expiresInMinutes: number;
	},
): void {
	getDb()
		.prepare(`
			INSERT INTO login_requests
				(id, email, code, poll_secret_hash, token_hash, token_kind, user_agent_summary, remember_me, expires_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		`)
		.run(
			req.requestId,
			opts.email,
			req.code,
			sha256(req.pollSecret).toString("hex"),
			opts.token ? hashToken(opts.token) : null,
			opts.token ? opts.tokenKind : null,
			summarizeUserAgent(opts.userAgent),
			opts.rememberMe ? 1 : 0,
			new Date(Date.now() + opts.expiresInMinutes * 60 * 1000).toISOString(),
		);
}

/**
 * Look up a request by id and poll secret. The secret is compared in constant time, and an
 * unknown id costs the same comparison, so neither reveals which part was wrong.
 */
export function findRequestForPoller(
	requestId: unknown,
	pollSecret: unknown,
): LoginRequestRow | null {
	if (
		typeof requestId !== "string" ||
		typeof pollSecret !== "string" ||
		requestId.length > 64 ||
		pollSecret.length > 128
	) {
		return null;
	}
	const row = getDb()
		.prepare("SELECT * FROM login_requests WHERE id = ?")
		.get(requestId) as LoginRequestRow | null;
	const expected = row ? Buffer.from(row.poll_secret_hash, "hex") : crypto.randomBytes(32);
	const ok = crypto.timingSafeEqual(sha256(pollSecret), expected);
	return row && ok ? row : null;
}

/**
 * Look up a request for the holder of its emailed link. Matches only a pending, unexpired
 * request whose token hash equals the presented token's. Read-only.
 */
export function findPendingRequestForLink(
	requestId: unknown,
	token: unknown,
): LoginRequestRow | null {
	if (typeof requestId !== "string" || typeof token !== "string" || !token || requestId.length > 64)
		return null;
	const row = getDb()
		.prepare(`
			SELECT * FROM login_requests
			WHERE id = ? AND token_hash IS NOT NULL AND token_hash = ? AND status = 'pending' AND expires_at > ?
		`)
		.get(requestId, hashToken(token), nowIso()) as LoginRequestRow | null;
	return row ?? null;
}

/** Mark a pending request expired if its time is up. Returns the current status. */
export function refreshExpiry(row: LoginRequestRow): LoginRequestStatus {
	if (row.status !== "pending" || row.expires_at > nowIso()) return row.status;
	getDb()
		.prepare("UPDATE login_requests SET status = 'expired' WHERE id = ? AND status = 'pending'")
		.run(row.id);
	return "expired";
}

/** pending -> approved, recording who will be signed in on A. False when it was no longer pending. */
export function markApproved(
	requestId: string,
	userId: string,
	isNewUser: boolean,
	rememberMe: boolean,
): boolean {
	return (
		getDb()
			.prepare(`
				UPDATE login_requests
				SET status = 'approved', approved_at = datetime('now'), user_id = ?, is_new_user = ?, remember_me = ?
				WHERE id = ? AND status = 'pending' AND expires_at > ?
			`)
			.run(userId, isNewUser ? 1 : 0, rememberMe ? 1 : 0, requestId, nowIso()).changes === 1
	);
}

/** pending -> denied. False when it was no longer pending. */
export function markDenied(requestId: string, reason: DeniedReason): boolean {
	return (
		getDb()
			.prepare(
				"UPDATE login_requests SET status = 'denied', denied_reason = ? WHERE id = ? AND status = 'pending'",
			)
			.run(reason, requestId).changes === 1
	);
}

/**
 * approved -> consumed, atomically. Returns what A needs to sign in, exactly once: a second
 * caller (or a replay) gets null.
 */
export function takeApproval(
	requestId: string,
): { userId: string; rememberMe: boolean; isNewUser: boolean } | null {
	const graceCutoff = new Date(Date.now() - DELIVERY_GRACE_MS).toISOString();
	const row = getDb()
		.prepare(`
			UPDATE login_requests SET status = 'consumed', consumed_at = datetime('now')
			WHERE id = ? AND status = 'approved' AND user_id IS NOT NULL AND expires_at > ?
			RETURNING user_id, remember_me, is_new_user
		`)
		.get(requestId, graceCutoff) as {
		user_id: string;
		remember_me: number;
		is_new_user: number;
	} | null;
	if (!row) return null;
	return {
		userId: row.user_id,
		rememberMe: row.remember_me === 1,
		isNewUser: row.is_new_user === 1,
	};
}

/** The link was used on the device that asked: the request is done, nothing to deliver. */
export function markConsumedByToken(token: string): void {
	getDb()
		.prepare(
			"UPDATE login_requests SET status = 'consumed', consumed_at = datetime('now') WHERE token_hash = ? AND status = 'pending'",
		)
		.run(hashToken(token));
}

/** "Send another link": the old request stops (A starts polling the new one). */
export function supersedeRequest(requestId: unknown, pollSecret: unknown): void {
	const row = findRequestForPoller(requestId, pollSecret);
	if (!row) return;
	getDb()
		.prepare(
			"UPDATE login_requests SET status = 'expired' WHERE id = ? AND status IN ('pending', 'approved')",
		)
		.run(row.id);
}

/** Old rows hold nothing useful once they are a day past expiry. */
export function cleanupLoginRequests(): number {
	return getDb()
		.prepare("DELETE FROM login_requests WHERE expires_at < datetime('now', '-1 day')")
		.run().changes;
}

// ---- User-agent summary ----

/**
 * "Safari on iPhone", "Chrome on Windows". Only this summary is stored and shown; the raw
 * user agent never is.
 */
export function summarizeUserAgent(ua: string | undefined): string {
	if (!ua) return "Unknown browser";
	const s = ua.slice(0, 512);

	let os: string | null = null;
	if (/iPhone/.test(s)) os = "iPhone";
	else if (/iPad/.test(s)) os = "iPad";
	else if (/Android/.test(s)) os = "Android";
	else if (/CrOS/.test(s)) os = "ChromeOS";
	else if (/Windows/.test(s)) os = "Windows";
	else if (/Macintosh|Mac OS X/.test(s)) os = "Mac";
	else if (/Linux/.test(s)) os = "Linux";

	let browser: string | null = null;
	if (/Edg(e|A|iOS)?\//.test(s)) browser = "Edge";
	else if (/OPR\/|Opera/.test(s)) browser = "Opera";
	else if (/SamsungBrowser\//.test(s)) browser = "Samsung Internet";
	else if (/Firefox\/|FxiOS\//.test(s)) browser = "Firefox";
	else if (/Chrome\/|CriOS\//.test(s)) browser = "Chrome";
	else if (/Safari\//.test(s) && /Version\//.test(s)) browser = "Safari";

	if (browser && os) return `${browser} on ${os}`;
	if (browser) return browser;
	if (os) return `A browser on ${os}`;
	return "Unknown browser";
}
