/**
 * Client view of the model catalog (server/services/model-catalog.ts is the
 * single source of truth). The server's /api/models is authoritative for
 * credit costs (admin overrides apply); the catalog formula is the fallback
 * while that loads.
 */
import {
	CATALOG,
	type CatalogModel,
	MODEL_GROUPS,
	type ModelGroup,
	type Tier,
	catalogCredits,
	currentModelId,
	MATCH_INPUT,
	type OutputSize,
	getCatalogModel,
	outputSize,
	resolveTier,
	sizeLabel,
	snapRatio,
} from "../../server/services/model-catalog";
import type { Model } from "../types";

export {
	availableTiers,
	CATALOG,
	type CatalogModel,
	catalogCredits,
	DEFAULT_MODEL_ID,
	isTierAllowed,
	MATCH_INPUT,
	MODEL_GROUPS,
	type ModelGroup,
	modelDisplayName,
	orientationOf,
	ratioChoices,
	outputSize,
	resolveTier,
	sizeLabel,
	snapRatio,
	supportedRatios,
	TIER_LABELS,
	TIER_RESOLUTION,
	TIERS,
	type Tier,
	tierFromResolution,
	visibleModels,
} from "../../server/services/model-catalog";

export interface ModelConfig {
	id: string;
	name: string;
	shortName: string;
	description: string;
	group: ModelGroup;
	/** Same as `group` (older callers read `category`). */
	category: ModelGroup;
	hidden: boolean;
	capabilities: {
		supportsImageInput: boolean;
		maxImages: number;
		supportsNumOutputs: boolean;
		supportsSeed: boolean;
		requiresImageInput: boolean;
	};
	pricing: {
		/**
		 * Fallback only: per-output credits at the default tier with no reference
		 * images (for a dropped model, its replacement's). The server's
		 * `creditCost` from /api/models wins.
		 */
		creditCost: number;
	};
	bestFor: string[];
}

export const MODEL_CATEGORIES: Record<ModelGroup, { label: string; description: string }> = {
	"Fast drafts": {
		label: "Fast drafts",
		description: "Quick and inexpensive. Good for trying ideas.",
	},
	"Best quality": { label: "Best quality", description: "The most detailed, polished images." },
	"Text and logos": {
		label: "Text and logos",
		description: "Readable text, posters, logos and icons.",
	},
	"Edit an image": { label: "Edit an image", description: "Change an image you already have." },
	Tools: { label: "Tools", description: "Upscale or remove the background." },
};

function toConfig(m: CatalogModel): ModelConfig {
	const serving = getCatalogModel(currentModelId(m.id)) ?? m;
	return {
		id: m.id,
		name: m.name,
		shortName: m.name,
		description: m.description,
		group: m.group,
		category: m.group,
		hidden: m.hidden ?? false,
		capabilities: {
			supportsImageInput: m.refs.max > 0,
			maxImages: m.refs.max,
			supportsNumOutputs: m.maxOutputs > 1,
			supportsSeed: m.seed ?? false,
			requiresImageInput: m.refs.min > 0,
		},
		pricing: { creditCost: catalogCredits(serving, serving.defaultTier, 0) },
		bestFor: m.bestFor,
	};
}

/** Every model, including dropped ones (so history can show their names). */
export const MODELS_CONFIG: ModelConfig[] = CATALOG.filter((m) => m.kind === "image").map(toConfig);

export function getModelConfig(modelId: string): ModelConfig | undefined {
	return MODELS_CONFIG.find((m) => m.id === modelId);
}

/** Per-output credit cost to show before the server's number has loaded (default 2 for unknown ids). */
export function fallbackCreditCost(modelId: string): number {
	return getModelConfig(modelId)?.pricing.creditCost ?? 2;
}

export function getModelsByCategory(category: ModelGroup): ModelConfig[] {
	return MODELS_CONFIG.filter((m) => m.category === category && !m.hidden);
}

export function modelRequiresImage(modelId: string): boolean {
	return getModelConfig(modelId)?.capabilities.requiresImageInput ?? false;
}

export function modelSupportsImage(modelId: string): boolean {
	return getModelConfig(modelId)?.capabilities.supportsImageInput ?? false;
}

export function getModelCategory(modelId: string) {
	const config = getModelConfig(modelId);
	return config ? MODEL_CATEGORIES[config.category] : null;
}

/**
 * True for models that make variations without a prompt. None remain in the
 * lineup: Vary goes through `variation: true` on /api/generate.
 */
export function isVariationModel(_modelId: string): boolean {
	return false;
}

/**
 * Per-output credits for a model at a tier with `refs` reference images:
 * the server's table when loaded (admin overrides applied), else the formula.
 */
export function creditsPerOutput(
	modelId: string,
	tier: Tier,
	refs: number,
	serverModel?: Model,
): number {
	const catalog = getCatalogModel(modelId);
	const resolved = catalog ? resolveTier(catalog, tier) : tier;
	const row = serverModel?.tiers?.find((t) => t.tier === resolved);
	if (row && row.credits.length > 0) return row.credits[Math.min(refs, row.credits.length - 1)];
	if (catalog) return catalogCredits(catalog, resolved, refs);
	return serverModel?.creditCost ?? 2;
}

/** Group a list of models in picker order. */
export function groupModels<T extends { group?: string }>(
	models: T[],
): { group: ModelGroup; models: T[] }[] {
	return MODEL_GROUPS.map((group) => ({
		group,
		models: models.filter((m) => m.group === group),
	})).filter((g) => g.models.length > 0);
}

/** Parse an /api/models size ("1424x1424", "~1424x1424" when approximate). */
function parseApiSize(value: string | undefined): OutputSize | null {
	const m = value ? /^(~?)(\d+)x(\d+)$/.exec(value) : null;
	if (!m) return null;
	return { width: Number(m[2]), height: Number(m[3]), approx: m[1] === "~" || undefined };
}

/**
 * The expected output size of a model at a tier and ratio, as a label
 * ("1424 × 1424", or "≈ 2 MP" when the model picks its own size). The
 * server's table wins; the catalog computes the same while it loads.
 */
export function outputSizeLabel(
	catalog: CatalogModel,
	tier: Tier,
	ratio: string,
	serverModel?: Model,
): string | null {
	const resolved = resolveTier(catalog, tier);
	if (ratio !== MATCH_INPUT) {
		const rendered = snapRatio(catalog, ratio).ratio;
		const row = serverModel?.tiers?.find((t) => t.tier === resolved);
		const fromServer = parseApiSize(row?.sizes?.[rendered]);
		if (fromServer) return sizeLabel(fromServer);
	}
	const size = outputSize(catalog, ratio, resolved);
	return size ? sizeLabel(size) : null;
}
