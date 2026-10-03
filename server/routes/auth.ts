import crypto from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import bcrypt from "bcryptjs";
import bs58 from "bs58";
import type { FastifyInstance, FastifyReply } from "fastify";
import nacl from "tweetnacl";
import { getDb } from "../db";
import { adminMiddleware, authMiddleware, signToken } from "../middleware/auth";
import {
	reserveEmailSend,
	sendMagicLinkEmail,
	sendPasswordResetEmail,
	sendSignupLinkEmail,
} from "../services/email";
import {
	consumeSignupToken,
	consumeToken,
	createEmailToken,
	createSignupToken,
	invalidateUserTokens,
	peekToken,
} from "../services/tokens";
import { assignDefaultSubscription } from "../services/usage";

const isProduction = process.env.NODE_ENV === "production";
const ADMIN_PASSWORD: string =
	process.env.ADMIN_PASSWORD ||
	(isProduction
		? (() => {
				throw new Error("CRITICAL: ADMIN_PASSWORD environment variable is required in production.");
			})()
		: "admin");

const MAGIC_LINK_EXPIRY_MINUTES = Number(process.env.MAGIC_LINK_EXPIRY_MINUTES) || 15;
const PASSWORD_RESET_EXPIRY_MINUTES = Number(process.env.PASSWORD_RESET_EXPIRY_MINUTES) || 60;
const BCRYPT_ROUNDS = 12;

// ==================== Password hashing ====================

export function hashPassword(password: string): string {
	return bcrypt.hashSync(password, BCRYPT_ROUNDS);
}

function isLegacySha256(hash: string): boolean {
	return hash.length === 64 && /^[a-f0-9]+$/.test(hash);
}

/** A value that can never verify: not a bcrypt hash and not 64-char hex. */
export function unusablePasswordHash(): string {
	return `!unusable:${crypto.randomBytes(24).toString("hex")}`;
}

// Used to keep "unknown user" login attempts as slow as real ones.
const DUMMY_BCRYPT_HASH = bcrypt.hashSync(crypto.randomBytes(16).toString("hex"), BCRYPT_ROUNDS);

/**
 * Verify a password. Legacy unsalted SHA-256 hashes are compared in constant time and, on
 * success, transparently upgraded to bcrypt.
 */
function verifyPassword(password: string, hash: string | null | undefined, userId?: string): boolean {
	if (!hash) {
		bcrypt.compareSync(password, DUMMY_BCRYPT_HASH);
		return false;
	}
	if (isLegacySha256(hash)) {
		const candidate = crypto.createHash("sha256").update(password).digest();
		const ok = crypto.timingSafeEqual(candidate, Buffer.from(hash, "hex"));
		if (ok && userId) {
			getDb().prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hashPassword(password), userId);
		}
		return ok;
	}
	if (!hash.startsWith("$2")) {
		bcrypt.compareSync(password, DUMMY_BCRYPT_HASH);
		return false;
	}
	try {
		return bcrypt.compareSync(password, hash);
	} catch {
		return false;
	}
}

function validatePasswordStrength(password: string): { valid: boolean; error?: string } {
	if (password.length < 8) {
		return { valid: false, error: "Password must be at least 8 characters" };
	}
	if (!/[A-Z]/.test(password)) {
		return { valid: false, error: "Password must contain at least one uppercase letter" };
	}
	if (!/[a-z]/.test(password)) {
		return { valid: false, error: "Password must contain at least one lowercase letter" };
	}
	if (!/[0-9]/.test(password)) {
		return { valid: false, error: "Password must contain at least one number" };
	}
	return { valid: true };
}

// ==================== Email helpers ====================

export function normalizeEmail(email: unknown): string | null {
	if (typeof email !== "string") return null;
	const e = email.trim().toLowerCase();
	if (e.length < 3 || e.length > 254) return null;
	if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return null;
	return e;
}

/** Derive a unique username from an email's local part, e.g. "Jane.Doe+x@ex.com" -> "janedoex". */
function deriveUsername(email: string): string {
	const db = getDb();
	let base = email
		.split("@")[0]
		.toLowerCase()
		.replace(/[^a-z0-9_-]/g, "")
		.slice(0, 20);
	if (base.length < 3) base = `user${base}`;
	if (base === "admin" || base === "ollo") base = `${base}user`;

	const taken = db.prepare("SELECT 1 FROM users WHERE username = ? COLLATE NOCASE");
	if (!taken.get(base)) return base;
	for (let i = 2; i < 1000; i++) {
		const candidate = `${base}${i}`;
		if (!taken.get(candidate)) return candidate;
	}
	return `${base}-${crypto.randomBytes(3).toString("hex")}`;
}

const GENERIC_LINK_RESPONSE = {
	success: true,
	message: "Check your email for a sign-in link",
} as const;

const EMAIL_UNAVAILABLE = { error: "We couldn't send email right now. Please try again later." } as const;

function sendEmailUnavailable(reply: FastifyReply) {
	return reply.status(503).send(EMAIL_UNAVAILABLE);
}

// ==================== Types ====================

interface LoginBody {
	username: string;
	password: string;
	rememberMe?: boolean;
}

interface EmailLoginBody {
	email: string;
	password: string;
	rememberMe?: boolean;
}

interface MagicLinkBody {
	email: string;
	rememberMe?: boolean;
}

interface ForgotPasswordBody {
	email: string;
}

interface ResetPasswordBody {
	token: string;
	newPassword: string;
}

interface RegisterBody {
	username: string;
	password: string;
	isAdmin?: boolean;
}

interface UserRow {
	id: string;
	username: string;
	email: string | null;
	password_hash: string;
	is_admin: number;
	is_active: number | null;
	token_version: number | null;
	wallet_address: string | null;
}

interface WalletChallengeBody {
	walletAddress: string;
}

interface WalletVerifyBody {
	walletAddress: string;
	challenge: string;
	signature: string;
	username?: string;
}

const WALLET_CHALLENGE_EXPIRY_MINUTES = 5;

function walletMessage(nonce: string, timestamp: string | number): string {
	return `Sign this message to authenticate with ollo.art\n\nNonce: ${nonce}\nTimestamp: ${timestamp}`;
}

function verifyWalletSignature(address: string, message: string, signature: string): boolean {
	try {
		const pubkey = new PublicKey(address);
		const msgBytes = new TextEncoder().encode(message);
		const sigBytes = bs58.decode(signature);
		return nacl.sign.detached.verify(msgBytes, sigBytes, pubkey.toBytes());
	} catch {
		return false;
	}
}

function isValidWalletAddress(address: string): boolean {
	if (!address || typeof address !== "string" || address.length < 32 || address.length > 44) {
		return false;
	}
	try {
		new PublicKey(address);
		return true;
	} catch {
		return false;
	}
}

/**
 * Check a signed wallet challenge (from /api/auth/wallet/challenge) and consume it atomically,
 * so each challenge proves control of the wallet exactly once.
 */
export function verifyAndConsumeWalletChallenge(walletAddress: string, challenge: unknown, signature: unknown): boolean {
	if (typeof challenge !== "string" || typeof signature !== "string" || !isValidWalletAddress(walletAddress)) return false;
	const [nonce, timestamp] = challenge.split(":");
	if (!nonce || !timestamp || !verifyWalletSignature(walletAddress, walletMessage(nonce, timestamp), signature)) {
		return false;
	}
	const consumed = getDb()
		.prepare(`
			UPDATE wallet_challenges SET used_at = datetime('now')
			WHERE challenge = ? AND wallet_address = ? AND used_at IS NULL AND expires_at > ?
		`)
		.run(challenge, walletAddress, new Date().toISOString());
	return consumed.changes === 1;
}

function isActive(user: Pick<UserRow, "is_active">): boolean {
	return user.is_active !== 0;
}

/** Issue a session for a user row and update last_login. */
function issueSession(user: Pick<UserRow, "id" | "username" | "is_admin" | "token_version">, rememberMe = false) {
	getDb().prepare("UPDATE users SET last_login = datetime('now') WHERE id = ?").run(user.id);
	const token = signToken(
		{
			userId: user.id,
			username: user.username,
			isAdmin: user.is_admin === 1,
			tv: user.token_version ?? 0,
		},
		rememberMe,
	);
	return {
		token,
		user: { id: user.id, username: user.username, isAdmin: user.is_admin === 1 },
	};
}

const DEACTIVATED = { error: "This account has been deactivated" } as const;

// Strict per-IP rate limit for auth endpoints (meaningful now that trustProxy resolves real client IPs)
const authRateLimit = {
	config: {
		rateLimit: {
			max: 5,
			timeWindow: "1 minute",
		},
	},
};

export async function authRoutes(fastify: FastifyInstance): Promise<void> {
	// Create initial admin user if none exists
	const db = getDb();
	const adminExists = db.prepare("SELECT id FROM users WHERE is_admin = 1").get();
	if (!adminExists) {
		const id = crypto.randomUUID();
		db.prepare(
			"INSERT INTO users (id, username, password_hash, is_admin, is_active) VALUES (?, ?, ?, 1, 1)",
		).run(id, "admin", hashPassword(ADMIN_PASSWORD));
		assignDefaultSubscription(id);
		console.log("Created initial admin user: admin");
	}

	// Login with username + password (legacy)
	fastify.post<{ Body: LoginBody }>("/api/login", authRateLimit, async (request, reply) => {
		const { username, password, rememberMe } = request.body ?? ({} as LoginBody);

		if (!username || !password || typeof username !== "string" || typeof password !== "string") {
			return reply.status(400).send({ error: "Username and password required" });
		}

		const user = getDb().prepare("SELECT * FROM users WHERE username = ?").get(username) as UserRow | undefined;

		if (!verifyPassword(password, user?.password_hash, user?.id) || !user) {
			return reply.status(401).send({ error: "Invalid username or password" });
		}
		if (!isActive(user)) {
			return reply.status(401).send(DEACTIVATED);
		}

		return issueSession(user, !!rememberMe);
	});

	// Register (admin only)
	fastify.post<{ Body: RegisterBody }>(
		"/api/register",
		{ preHandler: adminMiddleware },
		async (request, reply) => {
			const { username, password, isAdmin } = request.body;

			if (!username || !password) {
				return reply.status(400).send({ error: "Username and password required" });
			}

			const passwordCheck = validatePasswordStrength(password);
			if (!passwordCheck.valid) {
				return reply.status(400).send({ error: passwordCheck.error });
			}

			const db = getDb();
			const existing = db.prepare("SELECT id FROM users WHERE username = ?").get(username);
			if (existing) {
				return reply.status(409).send({ error: "Username already exists" });
			}

			const id = crypto.randomUUID();
			db.prepare(
				"INSERT INTO users (id, username, password_hash, is_admin, is_active) VALUES (?, ?, ?, ?, 1)",
			).run(id, username, hashPassword(password), isAdmin ? 1 : 0);

			assignDefaultSubscription(id);

			return { user: { id, username, isAdmin: !!isAdmin } };
		},
	);

	// Get current user
	fastify.get("/api/me", { preHandler: authMiddleware }, async (request) => {
		const userId = request.user?.userId ?? "";
		const row = getDb().prepare("SELECT tutorial_completed_at FROM users WHERE id = ?").get(userId) as
			| { tutorial_completed_at: string | null }
			| undefined;

		return {
			user: {
				...request.user,
				tutorialCompleted: !!row?.tutorial_completed_at,
			},
		};
	});

	// Sign out this and every other session: bumping token_version revokes all issued tokens.
	fastify.post("/api/auth/logout", { preHandler: authMiddleware }, async (request) => {
		const userId = request.user?.userId ?? "";
		const db = getDb();
		db.transaction(() => {
			db.prepare("UPDATE users SET token_version = COALESCE(token_version, 0) + 1 WHERE id = ?").run(userId);
			db.prepare(
				"UPDATE account_reauth_tokens SET used_at = datetime('now') WHERE user_id = ? AND used_at IS NULL",
			).run(userId);
		})();
		return { success: true };
	});

	// ==================== Email auth ====================
	// /api/auth/check-email was removed: it disclosed whether an email had an account.

	// Login with email and password
	fastify.post<{ Body: EmailLoginBody }>("/api/auth/login-email", authRateLimit, async (request, reply) => {
		const { password, rememberMe } = request.body ?? ({} as EmailLoginBody);
		const email = normalizeEmail(request.body?.email);

		if (!email || !password || typeof password !== "string") {
			return reply.status(400).send({ error: "Email and password required" });
		}

		const user = getDb().prepare("SELECT * FROM users WHERE email = ?").get(email) as UserRow | undefined;

		if (!verifyPassword(password, user?.password_hash, user?.id) || !user) {
			return reply.status(401).send({ error: "Invalid email or password" });
		}
		if (!isActive(user)) {
			return reply.status(401).send(DEACTIVATED);
		}

		return issueSession(user, !!rememberMe);
	});

	/**
	 * Request a magic link. This is also the sign-up path: an unknown email receives a
	 * "create your account" link. The response is identical in every case (known, unknown,
	 * deactivated, over the send cap) so it reveals nothing about the address.
	 */
	fastify.post<{ Body: MagicLinkBody }>("/api/auth/magic-link", authRateLimit, async (request, reply) => {
		const email = normalizeEmail(request.body?.email);
		const rememberMe = request.body?.rememberMe === true;

		if (!email) {
			return reply.status(400).send({ error: "A valid email address is required" });
		}

		const user = getDb()
			.prepare("SELECT id, username, email, is_active FROM users WHERE email = ?")
			.get(email) as Pick<UserRow, "id" | "username" | "email" | "is_active"> | undefined;

		if (user && !isActive(user)) {
			return GENERIC_LINK_RESPONSE;
		}

		const kind = user ? "magic_link" : "signup";
		if (!reserveEmailSend(email, kind, request.ip)) {
			return GENERIC_LINK_RESPONSE;
		}

		const result = user
			? await sendMagicLinkEmail(
					email,
					user.username,
					createEmailToken({
						userId: user.id,
						type: "magic_link",
						rememberMe,
						expiresInMinutes: MAGIC_LINK_EXPIRY_MINUTES,
					}),
					rememberMe,
				)
			: await sendSignupLinkEmail(email, createSignupToken(email, rememberMe, MAGIC_LINK_EXPIRY_MINUTES), rememberMe);

		if (!result.success) {
			request.log.error({ kind, err: result.error }, "Auth email send failed");
			return sendEmailUnavailable(reply);
		}

		return GENERIC_LINK_RESPONSE;
	});

	// Verify a magic link (sign-in) or sign-up link
	fastify.get<{ Querystring: { token: string } }>("/api/auth/magic-link/verify", async (request, reply) => {
		const { token } = request.query;

		if (!token || typeof token !== "string") {
			return reply.status(400).send({ error: "Token required" });
		}

		const db = getDb();

		// Existing account sign-in link
		const signIn = consumeToken(token, "magic_link");
		if (signIn.valid && signIn.userId) {
			const user = db.prepare("SELECT * FROM users WHERE id = ?").get(signIn.userId) as UserRow | undefined;
			if (!user) return reply.status(401).send({ error: "Invalid or expired link" });
			if (!isActive(user)) return reply.status(401).send(DEACTIVATED);
			return issueSession(user, signIn.rememberMe);
		}

		// Sign-up link: create the account on first click
		const signup = consumeSignupToken(token);
		if (!signup) {
			return reply.status(401).send({ error: "Invalid or expired link" });
		}

		const outcome = db.transaction(() => {
			const existing = db.prepare("SELECT * FROM users WHERE email = ?").get(signup.email) as UserRow | undefined;
			if (existing) return { user: existing, isNewUser: false };

			const id = crypto.randomUUID();
			db.prepare(`
				INSERT INTO users (id, username, password_hash, email, is_admin, is_active)
				VALUES (?, ?, ?, ?, 0, 1)
			`).run(id, deriveUsername(signup.email), unusablePasswordHash(), signup.email);
			// Free subscription + INITIAL_CREDITS (credit_type 'initial')
			assignDefaultSubscription(id);
			return { user: db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow, isNewUser: true };
		})();

		if (!isActive(outcome.user)) return reply.status(401).send(DEACTIVATED);
		if (outcome.isNewUser) request.log.info({ userId: outcome.user.id }, "New account created via sign-up link");

		return { ...issueSession(outcome.user, signup.rememberMe), isNewUser: outcome.isNewUser };
	});

	// Request password reset. Unknown emails get a sign-up link instead, so the request costs
	// one email either way and the response (including a 503 when email is down) never reveals
	// whether the account exists.
	fastify.post<{ Body: ForgotPasswordBody }>("/api/auth/forgot-password", authRateLimit, async (request, reply) => {
		const email = normalizeEmail(request.body?.email);
		if (!email) {
			return { success: true };
		}

		const user = getDb()
			.prepare("SELECT id, username, email, is_active FROM users WHERE email = ?")
			.get(email) as Pick<UserRow, "id" | "username" | "email" | "is_active"> | undefined;

		if (user && !isActive(user)) {
			return { success: true };
		}

		const kind = user ? "password_reset" : "signup";
		if (!reserveEmailSend(email, kind, request.ip)) {
			return { success: true };
		}

		const result = user
			? await sendPasswordResetEmail(
					email,
					user.username,
					createEmailToken({
						userId: user.id,
						type: "password_reset",
						expiresInMinutes: PASSWORD_RESET_EXPIRY_MINUTES,
					}),
				)
			: await sendSignupLinkEmail(email, createSignupToken(email, false, MAGIC_LINK_EXPIRY_MINUTES), false);

		if (!result.success) {
			request.log.error({ kind, err: result.error }, "Auth email send failed");
			return sendEmailUnavailable(reply);
		}

		return { success: true };
	});

	// Check a reset token before showing the form (does not consume it)
	fastify.get<{ Querystring: { token: string } }>("/api/auth/verify-reset-token", async (request, reply) => {
		const { token } = request.query;

		if (!token) {
			return reply.status(400).send({ error: "Token required", valid: false });
		}

		const validation = peekToken(token, "password_reset");
		if (!validation.valid || !validation.userId) {
			return { valid: false, error: validation.error };
		}

		const user = getDb().prepare("SELECT email FROM users WHERE id = ?").get(validation.userId) as
			| { email: string | null }
			| undefined;

		return { valid: true, email: user?.email ?? undefined };
	});

	// Reset password with token
	fastify.post<{ Body: ResetPasswordBody }>("/api/auth/reset-password", authRateLimit, async (request, reply) => {
		const { token, newPassword } = request.body ?? ({} as ResetPasswordBody);

		if (!token || !newPassword) {
			return reply.status(400).send({ error: "Token and new password required" });
		}

		// Validate strength first so a weak attempt doesn't burn the link
		const passwordCheck = validatePasswordStrength(newPassword);
		if (!passwordCheck.valid) {
			return reply.status(400).send({ error: passwordCheck.error });
		}

		const newHash = hashPassword(newPassword);
		const db = getDb();
		const userId = db.transaction(() => {
			const validation = consumeToken(token, "password_reset");
			if (!validation.valid || !validation.userId) return null;
			// New password, revoke every existing session and every other outstanding link
			db.prepare(
				"UPDATE users SET password_hash = ?, token_version = COALESCE(token_version, 0) + 1 WHERE id = ?",
			).run(newHash, validation.userId);
			invalidateUserTokens(validation.userId);
			return validation.userId;
		})();

		if (!userId) {
			return reply.status(401).send({ error: "Invalid or expired link" });
		}

		return { success: true };
	});

	// ==================== Wallet auth ====================

	fastify.post<{ Body: WalletChallengeBody }>("/api/auth/wallet/challenge", authRateLimit, async (request, reply) => {
		const { walletAddress } = request.body ?? ({} as WalletChallengeBody);

		if (!walletAddress) {
			return reply.status(400).send({ error: "Wallet address required" });
		}
		if (!isValidWalletAddress(walletAddress)) {
			return reply.status(400).send({ error: "Invalid wallet address format" });
		}

		const nonce = crypto.randomBytes(32).toString("hex");
		const timestamp = Date.now();
		const challenge = `${nonce}:${timestamp}`;
		const expiresAt = new Date(Date.now() + WALLET_CHALLENGE_EXPIRY_MINUTES * 60 * 1000).toISOString();

		getDb()
			.prepare("INSERT INTO wallet_challenges (id, wallet_address, challenge, expires_at) VALUES (?, ?, ?, ?)")
			.run(crypto.randomUUID(), walletAddress, challenge, expiresAt);

		// No account information here: whether the wallet is registered (and its username) is
		// only revealed after the signature proves ownership.
		return { challenge, message: walletMessage(nonce, timestamp) };
	});

	fastify.post<{ Body: WalletVerifyBody }>("/api/auth/wallet/verify", authRateLimit, async (request, reply) => {
		const { walletAddress, challenge, signature, username } = request.body ?? ({} as WalletVerifyBody);

		if (!walletAddress || !challenge || !signature || typeof challenge !== "string") {
			return reply.status(400).send({ error: "Wallet address, challenge, and signature required" });
		}
		if (!isValidWalletAddress(walletAddress)) {
			return reply.status(400).send({ error: "Invalid wallet address format" });
		}

		const [nonce, timestamp] = challenge.split(":");
		if (!nonce || !timestamp || !verifyWalletSignature(walletAddress, walletMessage(nonce, timestamp), signature)) {
			return reply.status(401).send({ error: "Invalid signature" });
		}

		const db = getDb();

		// Atomic single-use consumption of the challenge
		const consumed = db
			.prepare(`
				UPDATE wallet_challenges SET used_at = datetime('now')
				WHERE challenge = ? AND wallet_address = ? AND used_at IS NULL AND expires_at > ?
			`)
			.run(challenge, walletAddress, new Date().toISOString());
		if (consumed.changes !== 1) {
			return reply.status(401).send({ error: "Invalid or expired challenge" });
		}

		const existingUser = db.prepare("SELECT * FROM users WHERE wallet_address = ?").get(walletAddress) as
			| UserRow
			| undefined;

		if (existingUser) {
			if (!isActive(existingUser)) return reply.status(401).send(DEACTIVATED);
			return issueSession(existingUser);
		}

		if (!username) {
			return { needsUsername: true };
		}
		if (username.length < 3 || username.length > 30) {
			return reply.status(400).send({ error: "Username must be between 3 and 30 characters" });
		}
		if (!/^[a-zA-Z0-9_-]+$/.test(username)) {
			return reply.status(400).send({ error: "Username can only contain letters, numbers, underscores, and hyphens" });
		}
		if (db.prepare("SELECT id FROM users WHERE username = ? COLLATE NOCASE").get(username)) {
			return reply.status(409).send({ error: "Username already taken" });
		}

		const userId = crypto.randomUUID();
		db.transaction(() => {
			db.prepare(`
				INSERT INTO users (id, username, password_hash, wallet_address, is_admin, is_active)
				VALUES (?, ?, ?, ?, 0, 1)
			`).run(userId, username, unusablePasswordHash(), walletAddress);
			assignDefaultSubscription(userId);
		})();

		return issueSession({ id: userId, username, is_admin: 0, token_version: 0 });
	});
}
