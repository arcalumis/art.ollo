import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import bs58 from "bs58";
import type { FastifyInstance } from "fastify";
import nacl from "tweetnacl";
import { getDb } from "../db";
import { adminMiddleware, authMiddleware, signToken } from "../middleware/auth";
import { sendMagicLinkEmail, sendPasswordResetEmail } from "../services/email";
import { createEmailToken, markTokenUsed, validateToken } from "../services/tokens";
import { assignDefaultSubscription } from "../services/usage";
import { PublicKey } from "@solana/web3.js";

const isProduction = process.env.NODE_ENV === "production";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || (isProduction ? undefined : "admin");
if (!ADMIN_PASSWORD) {
	throw new Error("CRITICAL: ADMIN_PASSWORD environment variable is required in production.");
}

const MAGIC_LINK_EXPIRY_MINUTES = Number(process.env.MAGIC_LINK_EXPIRY_MINUTES) || 15;
const PASSWORD_RESET_EXPIRY_MINUTES = Number(process.env.PASSWORD_RESET_EXPIRY_MINUTES) || 60;
const BCRYPT_ROUNDS = 12;

// Secure password hashing using bcrypt
function hashPassword(password: string): string {
	return bcrypt.hashSync(password, BCRYPT_ROUNDS);
}

function verifyPassword(password: string, hash: string): boolean {
	// Support legacy SHA-256 hashes (64 char hex) for migration
	if (hash.length === 64 && /^[a-f0-9]+$/.test(hash)) {
		const sha256Hash = crypto.createHash("sha256").update(password).digest("hex");
		return sha256Hash === hash;
	}
	return bcrypt.compareSync(password, hash);
}

// Validate password strength
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

interface LoginBody {
	username: string;
	password: string;
}

interface EmailLoginBody {
	email: string;
	password: string;
	rememberMe?: boolean;
}

interface CheckEmailBody {
	email: string;
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

interface WalletChallengeRow {
	id: string;
	wallet_address: string;
	challenge: string;
	expires_at: string;
	used_at: string | null;
}

const WALLET_CHALLENGE_EXPIRY_MINUTES = 5;

// Verify Solana wallet signature
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

// Validate Solana wallet address format (base58, 32-44 chars)
function isValidWalletAddress(address: string): boolean {
	if (!address || address.length < 32 || address.length > 44) {
		return false;
	}
	try {
		new PublicKey(address);
		return true;
	} catch {
		return false;
	}
}

// Strict rate limit config for auth endpoints (5 attempts per minute)
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
		// Assign default subscription to admin
		assignDefaultSubscription(id);
		console.log("Created initial admin user: admin");
	}

	// Login (rate limited: 5 attempts per minute)
	fastify.post<{ Body: LoginBody }>("/api/login", authRateLimit, async (request, reply) => {
		const { username, password } = request.body;

		if (!username || !password) {
			return reply.status(400).send({ error: "Username and password required" });
		}

		const db = getDb();
		const user = db.prepare("SELECT * FROM users WHERE username = ?").get(username) as
			| UserRow
			| undefined;

		if (!user || !verifyPassword(password, user.password_hash)) {
			return reply.status(401).send({ error: "Invalid username or password" });
		}

		// Update last_login timestamp
		db.prepare("UPDATE users SET last_login = datetime('now') WHERE id = ?").run(user.id);

		const token = signToken({
			userId: user.id,
			username: user.username,
			isAdmin: user.is_admin === 1,
		});

		return {
			token,
			user: {
				id: user.id,
				username: user.username,
				isAdmin: user.is_admin === 1,
			},
		};
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

			// Check if username exists
			const existing = db.prepare("SELECT id FROM users WHERE username = ?").get(username);
			if (existing) {
				return reply.status(409).send({ error: "Username already exists" });
			}

			const id = crypto.randomUUID();
			db.prepare(
				"INSERT INTO users (id, username, password_hash, is_admin, is_active) VALUES (?, ?, ?, ?, 1)",
			).run(id, username, hashPassword(password), isAdmin ? 1 : 0);

			// Assign default subscription to new user
			assignDefaultSubscription(id);

			return {
				user: {
					id,
					username,
					isAdmin: !!isAdmin,
				},
			};
		},
	);

	// Get current user
	fastify.get("/api/me", { preHandler: authMiddleware }, async (request) => {
		return {
			user: request.user,
		};
	});

	// ==================== Email-First Auth Endpoints ====================

	// Check if email exists and has password (rate limited)
	fastify.post<{ Body: CheckEmailBody }>("/api/auth/check-email", authRateLimit, async (request, reply) => {
		const { email } = request.body;

		if (!email) {
			return reply.status(400).send({ error: "Email required" });
		}

		const db = getDb();
		const user = db
			.prepare("SELECT id, username, password_hash FROM users WHERE email = ?")
			.get(email) as Pick<UserRow, "id" | "username" | "password_hash"> | undefined;

		if (!user) {
			return { exists: false, hasPassword: false };
		}

		return {
			exists: true,
			hasPassword: !!user.password_hash,
			username: user.username,
		};
	});

	// Login with email and password (rate limited: 5 attempts per minute)
	fastify.post<{ Body: EmailLoginBody }>("/api/auth/login-email", authRateLimit, async (request, reply) => {
		const { email, password, rememberMe } = request.body;

		if (!email || !password) {
			return reply.status(400).send({ error: "Email and password required" });
		}

		const db = getDb();
		const user = db.prepare("SELECT * FROM users WHERE email = ?").get(email) as
			| UserRow
			| undefined;

		if (!user || !user.password_hash || !verifyPassword(password, user.password_hash)) {
			return reply.status(401).send({ error: "Invalid email or password" });
		}

		// Update last_login timestamp
		db.prepare("UPDATE users SET last_login = datetime('now') WHERE id = ?").run(user.id);

		const token = signToken(
			{
				userId: user.id,
				username: user.username,
				isAdmin: user.is_admin === 1,
			},
			rememberMe,
		);

		return {
			token,
			user: {
				id: user.id,
				username: user.username,
				isAdmin: user.is_admin === 1,
			},
		};
	});

	// Request magic link email (rate limited: 5 per minute to prevent spam)
	fastify.post<{ Body: MagicLinkBody }>("/api/auth/magic-link", authRateLimit, async (request, reply) => {
		const { email, rememberMe } = request.body;

		if (!email) {
			return reply.status(400).send({ error: "Email required" });
		}

		const db = getDb();
		const user = db.prepare("SELECT id, username, email FROM users WHERE email = ?").get(email) as
			| Pick<UserRow, "id" | "username" | "email">
			| undefined;

		if (!user) {
			// Return success even if user doesn't exist (prevent enumeration)
			return { success: true, message: "If an account exists, a magic link has been sent" };
		}

		// Create token
		const token = createEmailToken({
			userId: user.id,
			type: "magic_link",
			rememberMe: rememberMe || false,
			expiresInMinutes: MAGIC_LINK_EXPIRY_MINUTES,
		});

		// Send email
		await sendMagicLinkEmail(user.email || email, user.username, token, rememberMe || false);

		return { success: true, message: "Check your email for a login link" };
	});

	// Verify magic link token
	fastify.get<{ Querystring: { token: string } }>(
		"/api/auth/magic-link/verify",
		async (request, reply) => {
			const { token } = request.query;

			if (!token) {
				return reply.status(400).send({ error: "Token required" });
			}

			const validation = validateToken(token, "magic_link");

			if (!validation.valid) {
				return reply.status(401).send({ error: validation.error });
			}

			// Mark token as used
			markTokenUsed(token);

			// Get user info
			const db = getDb();
			const user = db
				.prepare("SELECT id, username, is_admin FROM users WHERE id = ?")
				.get(validation.userId) as Pick<UserRow, "id" | "username" | "is_admin"> | undefined;

			if (!user) {
				return reply.status(401).send({ error: "User not found" });
			}

			// Update last_login timestamp
			db.prepare("UPDATE users SET last_login = datetime('now') WHERE id = ?").run(user.id);

			// Generate JWT
			const jwtToken = signToken(
				{
					userId: user.id,
					username: user.username,
					isAdmin: user.is_admin === 1,
				},
				validation.rememberMe,
			);

			return {
				token: jwtToken,
				user: {
					id: user.id,
					username: user.username,
					isAdmin: user.is_admin === 1,
				},
			};
		},
	);

	// Request password reset (rate limited: 5 per minute to prevent spam)
	fastify.post<{ Body: ForgotPasswordBody }>("/api/auth/forgot-password", authRateLimit, async (request) => {
		const { email } = request.body;

		if (!email) {
			// Always return success to prevent enumeration
			return { success: true };
		}

		const db = getDb();
		const user = db.prepare("SELECT id, username, email FROM users WHERE email = ?").get(email) as
			| Pick<UserRow, "id" | "username" | "email">
			| undefined;

		if (user) {
			// Create token
			const token = createEmailToken({
				userId: user.id,
				type: "password_reset",
				expiresInMinutes: PASSWORD_RESET_EXPIRY_MINUTES,
			});

			// Send email
			await sendPasswordResetEmail(user.email || email, user.username, token);
		}

		// Always return success
		return { success: true };
	});

	// Verify password reset token (check validity before showing form)
	fastify.get<{ Querystring: { token: string } }>(
		"/api/auth/verify-reset-token",
		async (request, reply) => {
			const { token } = request.query;

			if (!token) {
				return reply.status(400).send({ error: "Token required", valid: false });
			}

			const validation = validateToken(token, "password_reset");

			if (!validation.valid) {
				return { valid: false, error: validation.error };
			}

			// Get user email for display
			const db = getDb();
			const user = db.prepare("SELECT email FROM users WHERE id = ?").get(validation.userId) as
				| { email: string }
				| undefined;

			return { valid: true, email: user?.email };
		},
	);

	// Reset password with token (rate limited)
	fastify.post<{ Body: ResetPasswordBody }>("/api/auth/reset-password", authRateLimit, async (request, reply) => {
		const { token, newPassword } = request.body;

		if (!token || !newPassword) {
			return reply.status(400).send({ error: "Token and new password required" });
		}

		const passwordCheck = validatePasswordStrength(newPassword);
		if (!passwordCheck.valid) {
			return reply.status(400).send({ error: passwordCheck.error });
		}

		const validation = validateToken(token, "password_reset");

		if (!validation.valid) {
			return reply.status(401).send({ error: validation.error });
		}

		// Update password
		const db = getDb();
		db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(
			hashPassword(newPassword),
			validation.userId,
		);

		// Mark token as used
		markTokenUsed(token);

		return { success: true };
	});

	// ==================== Wallet Auth Endpoints ====================

	// Request wallet challenge (rate limited: 5 per minute)
	fastify.post<{ Body: WalletChallengeBody }>("/api/auth/wallet/challenge", authRateLimit, async (request, reply) => {
		const { walletAddress } = request.body;

		if (!walletAddress) {
			return reply.status(400).send({ error: "Wallet address required" });
		}

		if (!isValidWalletAddress(walletAddress)) {
			return reply.status(400).send({ error: "Invalid wallet address format" });
		}

		const db = getDb();

		// Check if wallet is already registered
		const existingUser = db.prepare("SELECT id, username FROM users WHERE wallet_address = ?").get(walletAddress) as
			| Pick<UserRow, "id" | "username">
			| undefined;

		// Generate challenge nonce (32 bytes hex)
		const nonce = crypto.randomBytes(32).toString("hex");
		const timestamp = Date.now();
		const challenge = `${nonce}:${timestamp}`;
		const message = `Sign this message to authenticate with ollo.art\n\nNonce: ${nonce}\nTimestamp: ${timestamp}`;

		// Store challenge with expiry
		const challengeId = crypto.randomUUID();
		const expiresAt = new Date(Date.now() + WALLET_CHALLENGE_EXPIRY_MINUTES * 60 * 1000).toISOString();

		db.prepare(`
			INSERT INTO wallet_challenges (id, wallet_address, challenge, expires_at)
			VALUES (?, ?, ?, ?)
		`).run(challengeId, walletAddress, challenge, expiresAt);

		return {
			challenge,
			message,
			isRegistered: !!existingUser,
			username: existingUser?.username,
		};
	});

	// Verify wallet signature and login/register (rate limited: 5 per minute)
	fastify.post<{ Body: WalletVerifyBody }>("/api/auth/wallet/verify", authRateLimit, async (request, reply) => {
		const { walletAddress, challenge, signature, username } = request.body;

		if (!walletAddress || !challenge || !signature) {
			return reply.status(400).send({ error: "Wallet address, challenge, and signature required" });
		}

		if (!isValidWalletAddress(walletAddress)) {
			return reply.status(400).send({ error: "Invalid wallet address format" });
		}

		const db = getDb();

		// Find and validate challenge
		const challengeRow = db.prepare(`
			SELECT * FROM wallet_challenges
			WHERE challenge = ? AND wallet_address = ?
		`).get(challenge, walletAddress) as WalletChallengeRow | undefined;

		if (!challengeRow) {
			return reply.status(401).send({ error: "Invalid or expired challenge" });
		}

		// Check if challenge expired
		if (new Date(challengeRow.expires_at) < new Date()) {
			return reply.status(401).send({ error: "Challenge has expired" });
		}

		// Check if challenge was already used
		if (challengeRow.used_at) {
			return reply.status(401).send({ error: "Challenge has already been used" });
		}

		// Reconstruct message for verification
		const [nonce, timestamp] = challenge.split(":");
		const message = `Sign this message to authenticate with ollo.art\n\nNonce: ${nonce}\nTimestamp: ${timestamp}`;

		// Verify signature
		if (!verifyWalletSignature(walletAddress, message, signature)) {
			return reply.status(401).send({ error: "Invalid signature" });
		}

		// Mark challenge as used
		db.prepare("UPDATE wallet_challenges SET used_at = datetime('now') WHERE id = ?").run(challengeRow.id);

		// Check if wallet is registered
		const existingUser = db.prepare("SELECT * FROM users WHERE wallet_address = ?").get(walletAddress) as
			| UserRow
			| undefined;

		if (existingUser) {
			// Existing user - log them in
			db.prepare("UPDATE users SET last_login = datetime('now') WHERE id = ?").run(existingUser.id);

			const token = signToken({
				userId: existingUser.id,
				username: existingUser.username,
				isAdmin: existingUser.is_admin === 1,
			});

			return {
				token,
				user: {
					id: existingUser.id,
					username: existingUser.username,
					isAdmin: existingUser.is_admin === 1,
				},
			};
		}

		// New wallet - check if username provided
		if (!username) {
			return { needsUsername: true };
		}

		// Validate username
		if (username.length < 3 || username.length > 30) {
			return reply.status(400).send({ error: "Username must be between 3 and 30 characters" });
		}

		if (!/^[a-zA-Z0-9_-]+$/.test(username)) {
			return reply.status(400).send({ error: "Username can only contain letters, numbers, underscores, and hyphens" });
		}

		// Check if username is taken
		const usernameExists = db.prepare("SELECT id FROM users WHERE username = ?").get(username);
		if (usernameExists) {
			return reply.status(409).send({ error: "Username already taken" });
		}

		// Create new user with random unusable password hash
		const userId = crypto.randomUUID();
		const randomPasswordHash = hashPassword(crypto.randomBytes(32).toString("hex"));

		db.prepare(`
			INSERT INTO users (id, username, password_hash, wallet_address, is_admin, is_active, last_login)
			VALUES (?, ?, ?, ?, 0, 1, datetime('now'))
		`).run(userId, username, randomPasswordHash, walletAddress);

		// Assign default subscription
		assignDefaultSubscription(userId);

		const token = signToken({
			userId,
			username,
			isAdmin: false,
		});

		return {
			token,
			user: {
				id: userId,
				username,
				isAdmin: false,
			},
		};
	});
}
