import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import Replicate from "replicate";
import { getDb } from "../db";
import { authMiddleware } from "../middleware/auth";
import { decrypt, encrypt, isValidReplicateKeyFormat, maskApiKey } from "../services/encryption";
import {
	canUserGenerate,
	getAvailableCredits,
	getCurrentYearMonth,
	getDailyUsage,
	getMonthlyUsage,
	getUserSubscription,
} from "../services/usage";

interface ApiKeyRow {
	id: string;
	provider: string;
	api_key_encrypted: string;
	is_active: number;
	created_at: string;
}

interface CreditHistoryRow {
	id: string;
	credit_type: string;
	amount: number;
	reason: string | null;
	created_at: string;
}

export async function userRoutes(fastify: FastifyInstance): Promise<void> {
	// Apply auth middleware to all user routes
	fastify.addHook("preHandler", authMiddleware);

	// GET /api/user/subscription - Get current subscription & limits
	fastify.get("/api/user/subscription", async (request) => {
		const userId = request.user?.userId;
		if (!userId) {
			return { subscription: null, limits: null };
		}

		const { product } = getUserSubscription(userId);

		if (!product) {
			return {
				subscription: null,
				limits: null,
			};
		}

		return {
			subscription: {
				id: product.id,
				name: product.name,
				description: product.description,
				price: product.price,
				allowedModels: product.allowed_models ? JSON.parse(product.allowed_models) : null,
			},
			limits: {
				monthlyImageLimit: product.monthly_image_limit,
				monthlyCostLimit: product.monthly_cost_limit,
			},
		};
	});

	// GET /api/user/usage - Get current month's usage
	fastify.get("/api/user/usage", async (request) => {
		const userId = request.user?.userId;
		if (!userId) {
			return { usage: null };
		}

		const usage = getMonthlyUsage(userId);
		const dailyUsage = getDailyUsage(userId);
		const result = canUserGenerate(userId);

		return {
			yearMonth: getCurrentYearMonth(),
			usage: usage
				? {
						imageCount: usage.image_count,
						totalCost: usage.total_cost,
						usedOwnKey: usage.used_own_key,
					}
				: {
						imageCount: 0,
						totalCost: 0,
						usedOwnKey: 0,
					},
			dailyUsage: {
				imageCount: dailyUsage?.image_count ?? 0,
			},
			canGenerate: result.allowed,
			limitReason: result.reason,
			limits: result.limits,
		};
	});

	// GET /api/user/credits - Get available credits
	fastify.get("/api/user/credits", async (request) => {
		const userId = request.user?.userId;
		if (!userId) {
			return { credits: 0, history: [] };
		}

		const db = getDb();
		const credits = getAvailableCredits(userId);

		const history = db
			.prepare("SELECT * FROM user_credits WHERE user_id = ? ORDER BY created_at DESC LIMIT 20")
			.all(userId) as CreditHistoryRow[];

		return {
			credits,
			history: history.map((h) => ({
				id: h.id,
				type: h.credit_type,
				amount: h.amount,
				reason: h.reason,
				createdAt: h.created_at,
			})),
		};
	});

	// GET /api/user/api-key - Check if API key exists
	fastify.get("/api/user/api-key", async (request) => {
		const userId = request.user?.userId;
		if (!userId) {
			return { hasKey: false };
		}

		const db = getDb();
		const apiKey = db
			.prepare(
				"SELECT * FROM user_api_keys WHERE user_id = ? AND provider = 'replicate' AND is_active = 1",
			)
			.get(userId) as ApiKeyRow | undefined;

		if (!apiKey) {
			return { hasKey: false };
		}

		// Decrypt and mask for display
		const decryptedKey = decrypt(apiKey.api_key_encrypted);
		const maskedKey = maskApiKey(decryptedKey);

		return {
			hasKey: true,
			maskedKey,
			createdAt: apiKey.created_at,
		};
	});

	// POST /api/user/api-key - Add/update Replicate API key
	fastify.post<{ Body: { apiKey: string } }>("/api/user/api-key", async (request, reply) => {
		const userId = request.user?.userId;
		if (!userId) {
			return reply.status(401).send({ error: "Unauthorized" });
		}

		const { apiKey } = request.body;

		if (!apiKey) {
			return reply.status(400).send({ error: "API key is required" });
		}

		// Validate key format
		if (!isValidReplicateKeyFormat(apiKey)) {
			return reply
				.status(400)
				.send({ error: "Invalid Replicate API key format. Keys should start with 'r8_'" });
		}

		// Test the API key by making a simple request
		try {
			const testClient = new Replicate({ auth: apiKey });
			// Just check if we can access the account - this validates the key
			await testClient.models.get("black-forest-labs", "flux-schnell");
		} catch (err) {
			console.error("API key validation failed:", err);
			return reply.status(400).send({ error: "Invalid API key. Please check and try again." });
		}

		const db = getDb();
		const encryptedKey = encrypt(apiKey);

		// Check if user already has a key
		const existing = db
			.prepare("SELECT id FROM user_api_keys WHERE user_id = ? AND provider = 'replicate'")
			.get(userId) as { id: string } | undefined;

		if (existing) {
			// Update existing
			db.prepare("UPDATE user_api_keys SET api_key_encrypted = ?, is_active = 1 WHERE id = ?").run(
				encryptedKey,
				existing.id,
			);
		} else {
			// Create new
			const id = crypto.randomUUID();
			db.prepare(
				"INSERT INTO user_api_keys (id, user_id, provider, api_key_encrypted) VALUES (?, ?, 'replicate', ?)",
			).run(id, userId, encryptedKey);
		}

		return {
			success: true,
			maskedKey: maskApiKey(apiKey),
		};
	});

	// DELETE /api/user/api-key - Remove API key
	fastify.delete("/api/user/api-key", async (request, reply) => {
		const userId = request.user?.userId;
		if (!userId) {
			return reply.status(401).send({ error: "Unauthorized" });
		}

		const db = getDb();

		// Soft delete by deactivating
		db.prepare(
			"UPDATE user_api_keys SET is_active = 0 WHERE user_id = ? AND provider = 'replicate'",
		).run(userId);

		return { success: true };
	});

	// GET /api/user/can-generate - Check if user can generate (for UI)
	fastify.get("/api/user/can-generate", async (request) => {
		const userId = request.user?.userId;
		if (!userId) {
			return { allowed: false, reason: "Not authenticated" };
		}

		return canUserGenerate(userId);
	});
}

/**
 * Helper function to get user's decrypted API key (for use in generate route)
 */
export function getUserApiKey(userId: string): string | null {
	const db = getDb();
	const apiKey = db
		.prepare(
			"SELECT api_key_encrypted FROM user_api_keys WHERE user_id = ? AND provider = 'replicate' AND is_active = 1",
		)
		.get(userId) as { api_key_encrypted: string } | undefined;

	if (!apiKey) {
		return null;
	}

	return decrypt(apiKey.api_key_encrypted);
}
