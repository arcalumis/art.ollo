import type { FastifyInstance } from "fastify";
import { getDb } from "../db";
import { optionalAuthMiddleware } from "../middleware/auth";
import { getModels } from "../services/replicate";
import { getAllowedModelsForUser, getModelCreditCost } from "../services/usage";

const DEFAULT_MODEL = "black-forest-labs/flux-2-dev";

interface ModelStats {
	model: string;
	avg_time: number;
	sample_count: number;
}

export async function modelsRoutes(fastify: FastifyInstance): Promise<void> {
	fastify.get("/api/models", { preHandler: optionalAuthMiddleware }, async (request) => {
		const models = getModels();
		const db = getDb();

		// Filter models based on user's subscription tier
		let filteredModels = models;
		if (request.user) {
			const allowedModels = getAllowedModelsForUser(request.user.userId);
			if (allowedModels !== null) {
				filteredModels = models.filter((m) => allowedModels.includes(m.id));
			}
		}

		// Calculate average predict_time per model from recent generations
		const statsQuery = `
			SELECT
				model,
				AVG(predict_time) as avg_time,
				COUNT(*) as sample_count
			FROM generations
			WHERE predict_time IS NOT NULL AND deleted_at IS NULL
			GROUP BY model
		`;

		const stats = db.prepare(statsQuery).all() as ModelStats[];

		// Create lookup map
		const statsMap = new Map(stats.map((s) => [s.model, s]));

		// Merge stats into models
		const modelsWithStats = filteredModels.map((m) => ({
			...m,
			creditCost: getModelCreditCost(m.id),
			avgGenerationTime: statsMap.get(m.id)?.avg_time || null,
			sampleCount: statsMap.get(m.id)?.sample_count || 0,
		}));

		return { models: modelsWithStats };
	});

	// Per-image credit cost of every model (admin overrides applied), unfiltered by tier so the
	// public pricing page can translate credits into image counts.
	fastify.get("/api/models/credit-costs", async () => {
		const costs: Record<string, number> = {};
		for (const m of getModels()) costs[m.id] = getModelCreditCost(m.id);
		return { defaultModel: DEFAULT_MODEL, costs };
	});
}
