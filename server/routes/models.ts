import type { FastifyInstance } from "fastify";
import { getDb } from "../db";
import { optionalAuthMiddleware } from "../middleware/auth";
import {
	CATALOG,
	type CatalogModel,
	DEFAULT_MODEL_ID,
	TIER_LABELS,
	availableTiers,
	isTierAllowed,
	outputSize,
	ratioChoices,
	supportedRatios,
	toolModels,
	visibleModels,
} from "../services/model-catalog";
import { creditCostResolver, getAllowedModelsForUser } from "../services/usage";

interface ModelStats {
	model: string;
	avg_time: number;
	sample_count: number;
}

/** One catalog model as the client sees it: credits, never internal dollar prices. */
function toApiModel(
	m: CatalogModel,
	allowed: string[] | null,
	stats: ModelStats | undefined,
	getModelCreditCost: ReturnType<typeof creditCostResolver>,
) {
	const ratios = supportedRatios(m);
	const tiers = availableTiers(m).map((tier) => ({
		tier,
		label: TIER_LABELS[tier],
		hint: m.tiers[tier]?.hint ?? null,
		/** Credits per output, indexed by number of reference images (0..maxImages). */
		credits: Array.from({ length: m.refs.max + 1 }, (_, refs) =>
			getModelCreditCost(m.id, tier, refs),
		),
		allowed: isTierAllowed(allowed, m.id, tier),
		/**
		 * Expected output size per ratio the model renders: "1424x1424", or
		 * "~1424x1424" when the model picks its own size (show megapixels).
		 */
		sizes: Object.fromEntries(
			ratios.flatMap((r) => {
				const s = outputSize(m, r, tier);
				return s ? [[r, `${s.approx ? "~" : ""}${s.width}x${s.height}`]] : [];
			}),
		),
	}));
	return {
		id: m.id,
		name: m.name,
		description: m.description,
		group: m.group,
		bestFor: m.bestFor,
		kind: m.kind,
		hidden: m.hidden ?? false,
		replacedBy: m.replacedBy ?? null,
		supportsImageInput: m.refs.max > 0,
		maxImages: m.refs.max,
		minImages: m.refs.min,
		requiresImage: m.refs.min > 0,
		ratios,
		ratioChoices: ratioChoices(m),
		matchInput: m.refs.max > 0,
		tiers,
		defaultTier: m.defaultTier,
		maxOutputs: Math.min(4, m.maxOutputs),
		outputFormat: m.outputFormat,
		/** Per-output credits at the default tier with no reference images (admin overrides applied). */
		creditCost: getModelCreditCost(m.id, m.defaultTier, 0),
		/** The current user's plan includes this model (at its default tier). */
		allowed: isTierAllowed(allowed, m.id, m.defaultTier),
		avgGenerationTime: stats?.avg_time || null,
		sampleCount: stats?.sample_count || 0,
	};
}

export async function modelsRoutes(fastify: FastifyInstance): Promise<void> {
	/**
	 * The model catalog. Visible picker models (every model, locked ones flagged
	 * `allowed: false` so the picker can offer an upgrade), plus `tools`.
	 * `?all=1` (admins) also returns dropped models.
	 */
	fastify.get<{ Querystring: { all?: string } }>(
		"/api/models",
		{ preHandler: optionalAuthMiddleware },
		async (request) => {
			const db = getDb();
			const allowed = request.user ? getAllowedModelsForUser(request.user.userId) : null;
			const includeHidden = request.query?.all === "1" && request.user?.isAdmin === true;

			const stats = db
				.prepare(
					`SELECT model, AVG(predict_time) as avg_time, COUNT(*) as sample_count
					FROM generations
					WHERE predict_time IS NOT NULL AND deleted_at IS NULL
					GROUP BY model`,
				)
				.all() as ModelStats[];
			const statsMap = new Map(stats.map((s) => [s.model, s]));

			const cost = creditCostResolver();
			const list = includeHidden ? CATALOG.filter((m) => m.kind === "image") : visibleModels();
			return {
				models: list.map((m) => toApiModel(m, allowed, statsMap.get(m.id), cost)),
				tools: toolModels().map((m) => ({
					id: m.id,
					name: m.name,
					description: m.description,
					creditCost: cost(m.id),
				})),
				defaultModel: DEFAULT_MODEL_ID,
			};
		},
	);

	// Per-image credit cost of every picker model at its default tier (admin overrides
	// applied), unfiltered by plan, so the public pricing page can translate credits into
	// image counts and say "N of M models".
	fastify.get("/api/models/credit-costs", async () => {
		const costs: Record<string, number> = {};
		const cost = creditCostResolver();
		for (const m of visibleModels()) costs[m.id] = cost(m.id, m.defaultTier, 0);
		return { defaultModel: DEFAULT_MODEL_ID, costs };
	});
}
