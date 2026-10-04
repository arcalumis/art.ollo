/**
 * The model catalog: one source of truth for every model ollo has offered.
 *
 * Pure data + pure functions (no node imports) so the client imports it too:
 * the picker, ratio chips, size tiers and fallback credit costs all come from
 * here. The server builds each model's Replicate input from it and books the
 * official price as the cost of record.
 *
 * Prices are Replicate's official per-output / per-megapixel prices
 * (verified 2026-10-03). Credits per output = max(1, ceil(cost x 42)), the
 * owner-approved rule. Admin overrides in `model_credit_costs` still win
 * (see server/services/usage.ts).
 *
 * Input schemas were checked against GET /v1/models/{owner}/{name}
 * (latest_version.openapi_schema) on 2026-10-03.
 */

export type Tier = "draft" | "standard" | "max";
export const TIERS: Tier[] = ["draft", "standard", "max"];
export const TIER_LABELS: Record<Tier, string> = {
	draft: "Draft",
	standard: "Standard",
	max: "Max",
};

export type ModelGroup =
	| "Fast drafts"
	| "Best quality"
	| "Text and logos"
	| "Edit an image"
	| "Tools";
export const MODEL_GROUPS: ModelGroup[] = [
	"Fast drafts",
	"Best quality",
	"Text and logos",
	"Edit an image",
];

/** Credits per output = ceil(our Replicate cost per output x CREDIT_MULTIPLIER), minimum 1. */
export const CREDIT_MULTIPLIER = 42;

/** Pixels in one nominal megapixel ("1 MP" = 1024x1024). */
export const MP_PIXELS = 1024 * 1024;
/** Reference images sent to per-megapixel models are downscaled to at most this many pixels. */
export const REF_MAX_PIXELS = MP_PIXELS;
/** Billed megapixels of one reference image after that downscale (upper bound used for estimates). */
export const REF_BILLED_MP = REF_MAX_PIXELS / 1_000_000;

/** Book cost of one prompt enhancement (Llama 3 70B, ~250 input + ~300 output tokens). */
export const PROMPT_ENHANCEMENT_COST = 0.0012;

/** Official price of one output, in USD. Every field adds up; each output is one billed run. */
export interface PriceSpec {
	perImage?: number;
	/** Replaces perImage when reference images are attached (ideogram high). */
	perImageWithRefs?: number;
	perRun?: number;
	perOutputMp?: number;
	perInputMp?: number;
}

export interface TierSpec {
	/** Nominal output megapixels (1 = 1024x1024): drives sizing and per-MP pricing. */
	mp: number;
	price: PriceSpec;
	/** Runs a different Replicate model for this tier (Recraft Max -> recraft-v4.1-pro). */
	slug?: string;
	/** Needs an explicit `<model>:max` grant in a product's allowed_models (Starter excludes these). */
	premium?: boolean;
	/** Plain hint shown under the pill ("Higher detail", "4K"). */
	hint?: string;
}

export interface BuildContext {
	prompt: string;
	/** A ratio from this model's `ratios`, or "match_input_image" when `nativeMatch`. */
	ratio: string;
	tier: Tier;
	/** Reference images as data URIs. */
	refs: string[];
	/** Outputs requested from this one prediction (1 unless `nativeOutputs`). */
	outputs: number;
	seed?: number;
	outputFormat?: string;
}

export interface CatalogModel {
	/** Replicate slug and our model id. */
	id: string;
	name: string;
	group: ModelGroup;
	/** One plain line for the picker. */
	description: string;
	/** Short "good for" tags for the reference sheet. */
	bestFor: string[];
	/** Dropped from the picker; kept so history and old threads still show its name. */
	hidden?: boolean;
	/** Where requests for a hidden model go now. */
	replacedBy?: string;
	/** Tools (upscale, remove background) are run from the image viewer, not the picker. */
	kind: "image" | "tool";
	/** Preset aspect ratios the model renders natively. */
	ratios: string[];
	/** The model can copy an attached image's shape itself (match_input_image / auto / source). */
	nativeMatch?: boolean;
	/** Any ratio whose sides fit inside [min, max] renders exactly (custom width/height). */
	custom?: { min: number; max: number; multiple: number };
	tiers: Partial<Record<Tier, TierSpec>>;
	defaultTier: Tier;
	refs: { min: number; max: number };
	/** Max outputs per Generate (capped at 4 by the server). */
	maxOutputs: number;
	/** The model returns several outputs from one prediction (else parallel runs). */
	nativeOutputs?: boolean;
	seed?: boolean;
	/** File type the model returns ("svg" for vector models). */
	outputFormat: "png" | "jpg" | "webp" | "svg";
	build?: (ctx: BuildContext) => Record<string, unknown>;
	/**
	 * Expected output size for a ratio the model renders (already snapped) at a
	 * tier, from the model's own sizing rules. Without it, `outputSize` falls
	 * back to an approximate size from the tier's nominal megapixels.
	 */
	size?: (ratio: string, tier: Tier) => OutputSize;
}

/** Expected pixel size of one output. */
export interface OutputSize {
	width: number;
	height: number;
	/** The model picks its own size; width/height are a best guess, show megapixels instead. */
	approx?: boolean;
}

// ---- Ratios -------------------------------------------------------------------

export const SQUARE_RATIOS = ["1:1"];
export const PORTRAIT_RATIOS = ["4:5", "3:4", "2:3", "9:16"];
export const LANDSCAPE_RATIOS = ["5:4", "4:3", "3:2", "16:9", "21:9"];
/** Shown only for models that render them. */
export const EXTREME_PORTRAIT_RATIOS = ["1:2", "9:19.5", "9:20", "9:21", "1:4", "1:8"];
export const EXTREME_LANDSCAPE_RATIOS = ["2:1", "19.5:9", "20:9", "4:1", "8:1"];
export const ALL_RATIOS = [
	...SQUARE_RATIOS,
	...PORTRAIT_RATIOS,
	...LANDSCAPE_RATIOS,
	...EXTREME_PORTRAIT_RATIOS,
	...EXTREME_LANDSCAPE_RATIOS,
];
export const MATCH_INPUT = "match_input_image";

/** "16:9" -> 1.777…; NaN when malformed. */
export function ratioValue(ratio: string): number {
	const [w, h] = ratio.split(":").map(Number);
	if (!w || !h || !Number.isFinite(w) || !Number.isFinite(h)) return Number.NaN;
	return w / h;
}

export function orientationOf(ratio: string): "square" | "portrait" | "landscape" {
	const v = ratioValue(ratio);
	if (!Number.isFinite(v) || Math.abs(Math.log(v)) < 0.01) return "square";
	return v < 1 ? "portrait" : "landscape";
}

/** Every ratio the model renders exactly (custom-size models: any listed ratio that fits). */
export function supportedRatios(model: CatalogModel): string[] {
	if (!model.custom) return model.ratios;
	const limit = model.custom.max / model.custom.min;
	return ALL_RATIOS.filter((r) => {
		const v = ratioValue(r);
		return Math.max(v, 1 / v) <= limit;
	});
}

export interface SnapResult {
	/** The ratio the model will render. */
	ratio: string;
	snapped: boolean;
	/** Relative difference between requested and rendered ratio (0.1 = 10%). */
	off: number;
}

/** Snap a ratio to the nearest one the model renders, by |log(ratio)|. */
export function snapRatio(model: CatalogModel, ratio: string): SnapResult {
	const supported = supportedRatios(model);
	if (supported.includes(ratio)) return { ratio, snapped: false, off: 0 };
	const target = ratioValue(ratio);
	if (!Number.isFinite(target) || supported.length === 0) {
		return { ratio: supported[0] ?? "1:1", snapped: true, off: 0 };
	}
	let best = supported[0];
	let bestDist = Number.POSITIVE_INFINITY;
	for (const r of supported) {
		const d = Math.abs(Math.log(ratioValue(r) / target));
		if (d < bestDist) {
			best = r;
			bestDist = d;
		}
	}
	return { ratio: best, snapped: true, off: Math.exp(bestDist) - 1 };
}

/** Snap measured pixel dimensions (an input image) to the model's nearest ratio. */
export function snapDimensions(model: CatalogModel, width: number, height: number): string {
	if (!width || !height) return model.ratios[0] ?? "1:1";
	return snapRatio(model, `${width}:${height}`).ratio;
}

/** Width x height for a ratio at a nominal megapixel target, inside the model's limits. */
export function customDimensions(
	ratio: string,
	mp: number,
	limits: { min: number; max: number; multiple: number },
): { width: number; height: number } {
	const r = ratioValue(ratio) || 1;
	const pixels = mp * MP_PIXELS;
	let w = Math.sqrt(pixels * r);
	let h = w / r;
	const scale = Math.min(1, limits.max / w, limits.max / h);
	w *= scale;
	h *= scale;
	const snap = (v: number) =>
		Math.min(limits.max, Math.max(limits.min, Math.floor(v / limits.multiple) * limits.multiple));
	return { width: snap(w), height: snap(h) };
}

/**
 * Width x height for a ratio at `mp` megapixels (1 MP = 1,000,000 pixels here,
 * as BFL's `output_megapixels` / `resolution` presets count them), each side
 * rounded to `multiple` with `mode`.
 */
export function megapixelDimensions(
	ratio: string,
	mp: number,
	multiple: number,
	mode: "round" | "ceil" = "round",
): { width: number; height: number } {
	const r = ratioValue(ratio) || 1;
	const w = Math.sqrt(mp * 1_000_000 * r);
	const h = w / r;
	// The epsilon keeps float noise (1000.0000001) from rounding a whole multiple up.
	const snap = (v: number) =>
		Math.max(multiple, (mode === "ceil" ? Math.ceil(v / multiple - 1e-9) : Math.round(v / multiple)) * multiple);
	return { width: snap(w), height: snap(h) };
}

/** Parse a "WxH" size. */
function parseSize(size: string): { width: number; height: number } {
	const [width, height] = size.split("x").map(Number);
	return { width, height };
}

/** Pick the "WxH" size from a fixed list whose shape is closest to the ratio. */
export function nearestSize(sizes: string[], ratio: string): string {
	const target = ratioValue(ratio) || 1;
	let best = sizes[0];
	let bestDist = Number.POSITIVE_INFINITY;
	for (const s of sizes) {
		const [w, h] = s.split("x").map(Number);
		const d = Math.abs(Math.log(w / h / target));
		if (d < bestDist) {
			best = s;
			bestDist = d;
		}
	}
	return best;
}

/** Ratios ("W:H" reduced) for a list of fixed "WxH" sizes, so the picker can offer them. */
function sizesToRatios(sizes: string[]): string[] {
	// Map each size onto the closest named ratio; fixed-size models then snap through those.
	const out = new Set<string>();
	for (const s of sizes) {
		const [w, h] = s.split("x").map(Number);
		let best = "1:1";
		let bestDist = Number.POSITIVE_INFINITY;
		for (const r of ALL_RATIOS) {
			const d = Math.abs(Math.log(ratioValue(r) / (w / h)));
			if (d < bestDist) {
				best = r;
				bestDist = d;
			}
		}
		if (bestDist < 0.06) out.add(best);
	}
	return ALL_RATIOS.filter((r) => out.has(r));
}

// ---- Tier resolution ------------------------------------------------------------

export function availableTiers(model: CatalogModel): Tier[] {
	return TIERS.filter((t) => model.tiers[t]);
}

/** The requested tier if the model has it, else the nearest one it has (preferring smaller). */
export function resolveTier(model: CatalogModel, requested: Tier | undefined): Tier {
	if (requested && model.tiers[requested]) return requested;
	if (!requested) return model.defaultTier;
	const order: Record<Tier, Tier[]> = {
		draft: ["draft", "standard", "max"],
		standard: ["standard", "draft", "max"],
		max: ["max", "standard", "draft"],
	};
	return order[requested].find((t) => model.tiers[t]) ?? model.defaultTier;
}

/** Legacy `resolution` values the client still sends map onto tiers. */
export function tierFromResolution(resolution: string | undefined): Tier | undefined {
	switch ((resolution ?? "").toUpperCase().replace(/\s+/g, "")) {
		case "1K":
		case "1MP":
		case "DRAFT":
			return "draft";
		case "2K":
		case "2MP":
		case "STANDARD":
			return "standard";
		case "4K":
		case "4MP":
		case "MAX":
			return "max";
		default:
			return undefined;
	}
}

/** The resolution string the client sends for a tier. */
export const TIER_RESOLUTION: Record<Tier, string> = { draft: "1K", standard: "2K", max: "4K" };

// ---- Pricing ----------------------------------------------------------------------

export interface PriceInput {
	/** Billed output megapixels (pixels / 1e6). Defaults to the tier's nominal size. */
	outputMp?: number;
	/** Billed megapixels of each reference image. */
	inputMps?: number[];
	/** Number of reference images (used when inputMps is not known; each assumed REF_BILLED_MP). */
	refs?: number;
}

/** Official Replicate cost of ONE output in USD. */
export function priceOfOutput(model: CatalogModel, tier: Tier, input: PriceInput = {}): number {
	const spec = model.tiers[resolveTier(model, tier)];
	if (!spec) return 0;
	const p = spec.price;
	const inputMps = input.inputMps ?? Array.from({ length: input.refs ?? 0 }, () => REF_BILLED_MP);
	const hasRefs = inputMps.length > 0;
	const outputMp = input.outputMp ?? (spec.mp * MP_PIXELS) / 1_000_000;
	const inputMp = inputMps.reduce((a, b) => a + b, 0);
	let cost = 0;
	cost += hasRefs && p.perImageWithRefs !== undefined ? p.perImageWithRefs : (p.perImage ?? 0);
	cost += p.perRun ?? 0;
	cost += (p.perOutputMp ?? 0) * outputMp;
	cost += (p.perInputMp ?? 0) * inputMp;
	return cost;
}

/** Credits for ONE output under the approved rule. */
export function creditsForCost(costUsd: number): number {
	// Round away float noise (0.25 * 42 = 10.5, 0.024 * 42 = 1.008…) before the ceiling.
	const raw = Math.round(costUsd * CREDIT_MULTIPLIER * 1e6) / 1e6;
	return Math.max(1, Math.ceil(raw));
}

/** Formula credits for one output at a tier with `refs` reference images (no admin override). */
export function catalogCredits(model: CatalogModel, tier: Tier, refs = 0): number {
	return creditsForCost(priceOfOutput(model, tier, { refs }));
}

/** Formula credits per output for 0..refs.max reference images, per available tier. */
export function creditTable(model: CatalogModel): Partial<Record<Tier, number[]>> {
	const table: Partial<Record<Tier, number[]>> = {};
	for (const t of availableTiers(model)) {
		table[t] = Array.from({ length: model.refs.max + 1 }, (_, n) => catalogCredits(model, t, n));
	}
	return table;
}

// ---- Shared input builders ------------------------------------------------------

const withSeed = (input: Record<string, unknown>, seed?: number) => {
	if (seed !== undefined) input.seed = seed;
	return input;
};
const fmt = (wanted: string | undefined, allowed: string[], fallback: string, jpegName = "jpg") => {
	const f = wanted === "jpeg" ? "jpg" : wanted;
	if (f && allowed.includes(f === "jpg" ? jpegName : f)) return f === "jpg" ? jpegName : f;
	return fallback;
};

/**
 * Owner-approved policy setting (2026-10-03): FLUX 2 Pro's `safety_tolerance`
 * (integer 1-5, default 2; 1 is most strict, 5 most permissive). Of the
 * catalog's schemas (checked 2026-10-03) it is the only numeric moderation
 * scale; GPT Image's `moderation` ("auto" | "low") is not a matching scale and
 * stays at its default. `disable_safety_checker` (FLUX 2 Dev, Klein, Quick
 * Edit, large-image upscale) is never sent.
 */
export const SAFETY_TOLERANCE = 4;

const FLUX2_PRESETS = ["1:1", "16:9", "3:2", "2:3", "4:5", "5:4", "9:16", "3:4", "4:3"];
const BANANA_RATIOS = [
	"1:1",
	"1:4",
	"1:8",
	"2:3",
	"3:2",
	"3:4",
	"4:1",
	"4:3",
	"4:5",
	"5:4",
	"8:1",
	"9:16",
	"16:9",
	"21:9",
];
const GPT_RATIOS = ["1:1", "3:2", "2:3", "4:3", "3:4", "16:9", "9:16"];
const GPT_MAX_SIZES: Record<string, string> = {
	"1:1": "2048x2048",
	"16:9": "3840x2160",
	"9:16": "2160x3840",
	"4:3": "1536x1152",
	"3:4": "1152x1536",
	"3:2": "1536x1024",
	"2:3": "1024x1536",
};
const IDEOGRAM_SIZES = [
	"1024x1024",
	"1280x896",
	"896x1280",
	"1344x768",
	"768x1344",
	"1536x640",
	"640x1536",
];
const RECRAFT_SIZES = [
	"1024x1024",
	"1536x768",
	"768x1536",
	"1280x832",
	"832x1280",
	"1216x896",
	"896x1216",
	"1152x896",
	"896x1152",
	"832x1344",
	"1280x896",
	"896x1280",
	"1344x768",
	"768x1344",
];
const RECRAFT_PRO_SIZES = [
	"2048x2048",
	"3072x1536",
	"1536x3072",
	"2560x1664",
	"1664x2560",
	"2432x1792",
	"1792x2432",
	"2304x1792",
	"1792x2304",
	"1664x2688",
	"2560x1792",
	"1792x2560",
	"2688x1536",
	"1536x2688",
];
const RECRAFT_RATIOS = sizesToRatios(RECRAFT_SIZES);
const IDEOGRAM_RATIOS = sizesToRatios(IDEOGRAM_SIZES);

// ---- Output sizes -------------------------------------------------------------------

/** Nominal megapixels of a tier (1 = 1024x1024). */
const tierMp = (tier: Tier) => (tier === "draft" ? 1 : tier === "standard" ? 2 : 4);

/** A best-guess size for models that choose their own: `mp` nominal megapixels at the ratio. */
function approxSize(ratio: string, mp: number): OutputSize {
	const r = ratioValue(ratio) || 1;
	const w = Math.sqrt(mp * MP_PIXELS * r);
	return { width: Math.round(w), height: Math.round(w / r), approx: true };
}

/** Google's published 1K sizes for Gemini image models; 2K and 4K are exact multiples. */
const BANANA_1K: Record<string, string> = {
	"1:1": "1024x1024",
	"2:3": "848x1264",
	"3:2": "1264x848",
	"3:4": "896x1200",
	"4:3": "1200x896",
	"4:5": "928x1152",
	"5:4": "1152x928",
	"9:16": "768x1376",
	"16:9": "1376x768",
	"21:9": "1584x672",
};
const BANANA_SCALE: Record<string, number> = { "1K": 1, "2K": 2, "4K": 4 };
function bananaSize(ratio: string, resolution: "1K" | "2K" | "4K"): OutputSize {
	const base = BANANA_1K[ratio];
	const k = BANANA_SCALE[resolution];
	// The very wide and tall shapes (1:4, 8:1, …) aren't in the published table.
	if (!base) return approxSize(ratio, k * k);
	const { width, height } = parseSize(base);
	return { width: width * k, height: height * k };
}

/**
 * ByteDance's recommended Seedream sizes. The model may adjust them, so these
 * are marked approximate.
 */
const SEEDREAM_2K: Record<string, string> = {
	"1:1": "2048x2048",
	"4:3": "2304x1728",
	"3:4": "1728x2304",
	"16:9": "2560x1440",
	"9:16": "1440x2560",
	"3:2": "2496x1664",
	"2:3": "1664x2496",
	"21:9": "3024x1296",
};
function seedreamSize(ratio: string, tier: Tier): OutputSize {
	const base = SEEDREAM_2K[ratio];
	if (!base) return approxSize(ratio, tier === "draft" ? 1 : 4);
	const { width, height } = parseSize(base);
	const k = tier === "draft" ? 2 : 1;
	return { width: width / k, height: height / k, approx: true };
}

const FLUX2_DEV_LIMITS = { min: 256, max: 1440, multiple: 32 };
const FLUX2_PRO_LIMITS = { min: 256, max: 2048, multiple: 32 };

/**
 * Output size of `model` at `tier` for `ratio` (snapped to a ratio it renders
 * first). Null for tools. For "Match input" the shape follows the image, so
 * the size is the model's 1:1 size marked approximate (shown as megapixels).
 */
export function outputSize(model: CatalogModel, ratio: string, tier: Tier): OutputSize | null {
	if (model.kind !== "image") return null;
	const t = resolveTier(model, tier);
	const spec = model.tiers[t];
	if (!spec) return null;
	if (ratio === MATCH_INPUT) {
		const square = outputSize(model, "1:1", t);
		return square && { ...square, approx: true };
	}
	const snapped = snapRatio(model, ratio).ratio;
	return model.size ? model.size(snapped, t) : approxSize(snapped, spec.mp);
}

/** Megapixels to show for a size: one decimal under 10 ("1.5 MP"), whole above. */
export function megapixelsLabel(size: { width: number; height: number }): string {
	const mp = (size.width * size.height) / MP_PIXELS;
	const rounded = mp < 10 ? Math.round(mp * 10) / 10 : Math.round(mp);
	return `${rounded} MP`;
}

/** "1424 × 1424", or "≈ 2 MP" when the model picks its own size. */
export function sizeLabel(size: OutputSize): string {
	return size.approx ? `≈ ${megapixelsLabel(size)}` : `${size.width} × ${size.height}`;
}

/** Expected output of a tool on an input of this size. */
export function toolOutputSize(
	model: CatalogModel,
	input: { width: number; height: number },
): OutputSize | null {
	const { width, height } = input;
	if (!width || !height) return null;
	switch (model.id) {
		case "recraft-ai/recraft-crisp-upscale": {
			// Four times larger, with the long side capped at 4096.
			const long = Math.max(width, height);
			const scale = Math.min(4, 4096 / long);
			return {
				width: Math.round(width * scale),
				height: Math.round(height * scale),
				approx: long * 4 < 4096 || undefined,
			};
		}
		case "prunaai/p-image-upscale": {
			const scale = Math.sqrt((16 * 1_000_000) / (width * height));
			return { width: Math.round(width * scale), height: Math.round(height * scale), approx: true };
		}
		case "recraft-ai/recraft-remove-background":
			return { width, height };
		default:
			return null;
	}
}

const GPT_QUALITY: Record<Tier, string> = { draft: "medium", standard: "high", max: "xhigh" };
const gptTiers = (): Partial<Record<Tier, TierSpec>> => ({
	draft: { mp: 1, price: { perImage: 0.047 }, hint: "Medium detail" },
	standard: { mp: 1.5, price: { perImage: 0.128 }, hint: "High detail" },
	max: { mp: 4, price: { perImage: 0.25 }, premium: true, hint: "Highest detail, up to 4K" },
});
const gptBuild = (ctx: BuildContext) => {
	const input: Record<string, unknown> = {
		prompt: ctx.prompt,
		quality: GPT_QUALITY[ctx.tier],
		aspect_ratio: ctx.tier === "max" ? (GPT_MAX_SIZES[ctx.ratio] ?? ctx.ratio) : ctx.ratio,
		number_of_images: ctx.outputs,
		output_format: fmt(ctx.outputFormat, ["png", "jpeg", "webp"], "png", "jpeg"),
	};
	if (ctx.refs.length > 0) input.input_images = ctx.refs;
	return input;
};

/** Max sends an exact size; the lower tiers send a ratio and the model picks the size. */
const gptSize = (ratio: string, tier: Tier): OutputSize =>
	tier === "max" && GPT_MAX_SIZES[ratio]
		? parseSize(GPT_MAX_SIZES[ratio])
		: approxSize(ratio, tier === "draft" ? 1 : 1.5);

const recraftSizes = (tier: Tier) => (tier === "max" ? RECRAFT_PRO_SIZES : RECRAFT_SIZES);
const recraftSize = (ratio: string, tier: Tier): OutputSize =>
	parseSize(nearestSize(recraftSizes(tier), ratio));

const recraftBuild = (ctx: BuildContext) => ({
	prompt: ctx.prompt,
	size: nearestSize(recraftSizes(ctx.tier), ctx.ratio),
});

// ---- The catalog ------------------------------------------------------------------

export const CATALOG: CatalogModel[] = [
	// === Fast drafts ===
	{
		id: "black-forest-labs/flux-2-klein-4b",
		name: "FLUX 2 Klein",
		group: "Fast drafts",
		description: "The quickest way to try an idea. Good for sketching many options.",
		bestFor: ["Trying ideas fast", "Many options", "Rough layouts"],
		kind: "image",
		ratios: ["1:1", "16:9", "9:16", "3:2", "2:3", "4:3", "3:4", "5:4", "4:5", "21:9", "9:21"],
		nativeMatch: true,
		tiers: {
			draft: { mp: 1, price: { perOutputMp: 0.001, perInputMp: 0.001 } },
			standard: { mp: 2, price: { perOutputMp: 0.001, perInputMp: 0.001 } },
			max: { mp: 4, price: { perOutputMp: 0.001, perInputMp: 0.001 }, hint: "4 megapixels" },
		},
		defaultTier: "standard",
		refs: { min: 0, max: 4 },
		maxOutputs: 4,
		seed: true,
		outputFormat: "png",
		build: (ctx) => {
			const input: Record<string, unknown> = {
				prompt: ctx.prompt,
				aspect_ratio: ctx.ratio,
				output_megapixels: String(ctx.tier === "draft" ? 1 : ctx.tier === "standard" ? 2 : 4),
				output_format: fmt(ctx.outputFormat, ["webp", "jpg", "png"], "png"),
			};
			if (ctx.refs.length > 0) input.images = ctx.refs;
			return withSeed(input, ctx.seed);
		},
		// Sides round to multiples of 64 (4:5 draft rendered 896x1088).
		size: (ratio, tier) => megapixelDimensions(ratio, tierMp(tier), 64),
	},
	{
		id: "black-forest-labs/flux-2-dev",
		name: "FLUX 2 Dev",
		group: "Fast drafts",
		description: "Fast, detailed images. Follows up to 5 reference images.",
		bestFor: ["Everyday images", "Working from references", "Style matching"],
		kind: "image",
		ratios: FLUX2_PRESETS,
		custom: { min: 256, max: 1440, multiple: 32 },
		tiers: {
			draft: { mp: 1, price: { perOutputMp: 0.012, perInputMp: 0.012 } },
			standard: { mp: 2, price: { perOutputMp: 0.012, perInputMp: 0.012 } },
		},
		defaultTier: "standard",
		refs: { min: 0, max: 5 },
		maxOutputs: 4,
		seed: true,
		outputFormat: "png",
		build: (ctx) => {
			const { width, height } = customDimensions(ctx.ratio, tierMp(ctx.tier), FLUX2_DEV_LIMITS);
			const input: Record<string, unknown> = {
				prompt: ctx.prompt,
				aspect_ratio: "custom",
				width,
				height,
				go_fast: true,
				output_format: fmt(ctx.outputFormat, ["webp", "jpg", "png"], "png"),
			};
			if (ctx.refs.length > 0) input.input_images = ctx.refs;
			return withSeed(input, ctx.seed);
		},
		size: (ratio, tier) => customDimensions(ratio, tierMp(tier), FLUX2_DEV_LIMITS),
	},
	{
		id: "google/nano-banana-2-lite",
		name: "Nano Banana 2 Lite",
		group: "Fast drafts",
		description: "Google's quick model. Handles very wide and very tall shapes.",
		bestFor: ["Banners and strips", "Quick edits", "Everyday images"],
		kind: "image",
		ratios: BANANA_RATIOS,
		nativeMatch: true,
		tiers: { standard: { mp: 1, price: { perImage: 0.034 } } },
		defaultTier: "standard",
		refs: { min: 0, max: 14 },
		maxOutputs: 4,
		outputFormat: "png",
		build: (ctx) => ({
			prompt: ctx.prompt,
			aspect_ratio: ctx.ratio,
			image_input: ctx.refs,
			output_format: fmt(ctx.outputFormat, ["jpg", "png"], "png"),
		}),
		size: (ratio) => bananaSize(ratio, "1K"),
	},

	// === Best quality ===
	{
		id: "xai/grok-imagine-image-2",
		name: "Grok Imagine",
		group: "Best quality",
		description: "Striking, photographic images with bold light and color.",
		bestFor: ["Photo looks", "Dramatic scenes", "Wide screens"],
		kind: "image",
		ratios: [
			"1:1",
			"16:9",
			"9:16",
			"4:3",
			"3:4",
			"3:2",
			"2:3",
			"2:1",
			"1:2",
			"19.5:9",
			"9:19.5",
			"20:9",
			"9:20",
		],
		nativeMatch: true,
		tiers: {
			draft: { mp: 1, price: { perImage: 0.04, perInputMp: 0.01 } },
			standard: { mp: 4, price: { perImage: 0.04, perInputMp: 0.01 } },
		},
		defaultTier: "standard",
		refs: { min: 0, max: 1 },
		maxOutputs: 4,
		outputFormat: "jpg",
		build: (ctx) => {
			const input: Record<string, unknown> = {
				prompt: ctx.prompt,
				aspect_ratio: ctx.ratio === MATCH_INPUT ? "auto" : ctx.ratio,
				resolution: ctx.tier === "draft" ? "1k" : "2k",
				quality: "medium",
			};
			if (ctx.refs.length > 0) input.image = ctx.refs[0];
			return input;
		},
		// xAI picks the exact size for each shape.
		size: (ratio, tier) => approxSize(ratio, tier === "draft" ? 1 : 4),
	},
	{
		id: "openai/gpt-image-2.5-flare",
		name: "GPT Image",
		group: "Best quality",
		description: "Follows long, detailed prompts closely, including text in the image.",
		bestFor: ["Complex scenes", "Exact instructions", "Posters with text"],
		kind: "image",
		ratios: GPT_RATIOS,
		tiers: gptTiers(),
		defaultTier: "draft",
		refs: { min: 0, max: 10 },
		maxOutputs: 4,
		nativeOutputs: true,
		outputFormat: "png",
		build: gptBuild,
		size: gptSize,
	},
	{
		id: "bytedance/seedream-5-pro",
		name: "Seedream 5 Pro",
		group: "Best quality",
		description: "Rich, polished images and careful edits. Takes a little longer.",
		bestFor: ["Polished finals", "Product shots", "Editing with references"],
		kind: "image",
		ratios: ["1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3", "21:9"],
		nativeMatch: true,
		tiers: {
			draft: { mp: 1, price: { perImage: 0.045 } },
			standard: { mp: 4, price: { perImage: 0.09 } },
		},
		defaultTier: "draft",
		refs: { min: 0, max: 10 },
		maxOutputs: 4,
		outputFormat: "png",
		build: (ctx) => ({
			prompt: ctx.prompt,
			aspect_ratio: ctx.ratio,
			size: ctx.tier === "draft" ? "1K" : "2K",
			image_input: ctx.refs,
			output_format: fmt(ctx.outputFormat, ["png", "jpeg"], "png", "jpeg"),
		}),
		size: seedreamSize,
	},
	{
		id: "google/nano-banana-2",
		name: "Nano Banana 2",
		group: "Best quality",
		description: "Google's best model. Up to 4K, and up to 14 reference images.",
		bestFor: ["4K images", "Many references", "Consistent characters"],
		kind: "image",
		ratios: BANANA_RATIOS,
		nativeMatch: true,
		tiers: {
			draft: { mp: 1, price: { perImage: 0.067 } },
			standard: { mp: 4, price: { perImage: 0.101 } },
			max: { mp: 16, price: { perImage: 0.151 }, premium: true, hint: "4K" },
		},
		defaultTier: "draft",
		refs: { min: 0, max: 14 },
		maxOutputs: 4,
		outputFormat: "png",
		build: (ctx) => ({
			prompt: ctx.prompt,
			aspect_ratio: ctx.ratio,
			resolution: ctx.tier === "draft" ? "1K" : ctx.tier === "standard" ? "2K" : "4K",
			image_input: ctx.refs,
			output_format: fmt(ctx.outputFormat, ["jpg", "png"], "png"),
		}),
		size: (ratio, tier) => bananaSize(ratio, tier === "draft" ? "1K" : tier === "standard" ? "2K" : "4K"),
	},
	{
		id: "black-forest-labs/flux-2-pro",
		name: "FLUX 2 Pro",
		group: "Best quality",
		description: "Precise control over size and shape, with up to 8 reference images.",
		bestFor: ["Exact sizes", "Multi-reference scenes", "Print"],
		kind: "image",
		ratios: FLUX2_PRESETS,
		custom: { min: 256, max: 2048, multiple: 32 },
		tiers: {
			draft: { mp: 1, price: { perRun: 0.015, perOutputMp: 0.015, perInputMp: 0.015 } },
			standard: { mp: 2, price: { perRun: 0.015, perOutputMp: 0.015, perInputMp: 0.015 } },
			max: {
				mp: 4,
				price: { perRun: 0.015, perOutputMp: 0.015, perInputMp: 0.015 },
				hint: "4 megapixels",
			},
		},
		defaultTier: "standard",
		refs: { min: 0, max: 8 },
		maxOutputs: 4,
		seed: true,
		outputFormat: "png",
		build: (ctx) => {
			const mp = tierMp(ctx.tier);
			const input: Record<string, unknown> = {
				prompt: ctx.prompt,
				safety_tolerance: SAFETY_TOLERANCE,
				output_format: fmt(ctx.outputFormat, ["webp", "jpg", "png"], "png"),
			};
			if (FLUX2_PRESETS.includes(ctx.ratio)) {
				input.aspect_ratio = ctx.ratio;
				input.resolution = `${mp} MP`;
			} else {
				const { width, height } = customDimensions(ctx.ratio, mp, FLUX2_PRO_LIMITS);
				input.aspect_ratio = "custom";
				input.width = width;
				input.height = height;
			}
			if (ctx.refs.length > 0) input.input_images = ctx.refs;
			return withSeed(input, ctx.seed);
		},
		// Presets: sides round up to multiples of 16 at 1 MP = 1,000,000 px (1:1 standard
		// rendered 1424x1424). Other shapes send an exact custom size.
		size: (ratio, tier) =>
			FLUX2_PRESETS.includes(ratio)
				? megapixelDimensions(ratio, tierMp(tier), 16, "ceil")
				: customDimensions(ratio, tierMp(tier), FLUX2_PRO_LIMITS),
	},

	// === Text and logos ===
	{
		id: "ideogram-ai/ideogram-4-5",
		name: "Ideogram 4.5",
		group: "Text and logos",
		description: "Clean, correctly spelled text. Posters, covers and logos.",
		bestFor: ["Readable text", "Posters", "Logos"],
		kind: "image",
		ratios: IDEOGRAM_RATIOS,
		nativeMatch: true,
		tiers: {
			draft: { mp: 1, price: { perImage: 0.03 }, hint: "Quick" },
			standard: { mp: 1, price: { perImage: 0.06 } },
			max: { mp: 1, price: { perImage: 0.1, perImageWithRefs: 0.22 }, hint: "Finest detail" },
		},
		defaultTier: "standard",
		refs: { min: 0, max: 4 },
		maxOutputs: 4,
		nativeOutputs: true,
		seed: true,
		outputFormat: "png",
		build: (ctx) => {
			const input: Record<string, unknown> = {
				prompt: ctx.prompt,
				quality: ctx.tier === "draft" ? "low" : ctx.tier === "standard" ? "medium" : "high",
				size: ctx.ratio === MATCH_INPUT ? "source" : nearestSize(IDEOGRAM_SIZES, ctx.ratio),
				num_images: ctx.outputs,
			};
			if (ctx.refs.length > 0) input.images = ctx.refs;
			return withSeed(input, ctx.seed);
		},
		size: (ratio) => parseSize(nearestSize(IDEOGRAM_SIZES, ratio)),
	},
	{
		id: "recraft-ai/recraft-v4.1",
		name: "Recraft",
		group: "Text and logos",
		description: "Design-ready graphics, illustrations and brand images.",
		bestFor: ["Illustrations", "Brand images", "Icons"],
		kind: "image",
		ratios: RECRAFT_RATIOS,
		tiers: {
			standard: { mp: 1, price: { perImage: 0.04 } },
			max: {
				mp: 4,
				price: { perImage: 0.25 },
				slug: "recraft-ai/recraft-v4.1-pro",
				premium: true,
				hint: "Pro model, 2048 px",
			},
		},
		defaultTier: "standard",
		refs: { min: 0, max: 0 },
		maxOutputs: 4,
		outputFormat: "png",
		build: recraftBuild,
		size: recraftSize,
	},
	{
		id: "recraft-ai/recraft-v4.1-svg",
		name: "Recraft Vector",
		group: "Text and logos",
		description: "Logos and icons as SVG files that scale to any size.",
		bestFor: ["Logos", "Icons", "Scalable graphics"],
		kind: "image",
		ratios: RECRAFT_RATIOS,
		tiers: { standard: { mp: 1, price: { perImage: 0.04 } } },
		defaultTier: "standard",
		refs: { min: 0, max: 0 },
		maxOutputs: 4,
		outputFormat: "svg",
		build: recraftBuild,
		size: recraftSize,
	},

	// === Edit an image ===
	{
		id: "openai/gpt-image-2.5-sunburst",
		name: "GPT Image Edit",
		group: "Edit an image",
		description: "Describe a change and it edits your image, keeping the rest.",
		bestFor: ["Precise edits", "Adding or removing things", "Changing text"],
		kind: "image",
		ratios: GPT_RATIOS,
		tiers: gptTiers(),
		defaultTier: "draft",
		refs: { min: 1, max: 10 },
		maxOutputs: 4,
		nativeOutputs: true,
		outputFormat: "png",
		build: gptBuild,
		size: gptSize,
	},
	{
		id: "prunaai/p-image-edit",
		name: "Quick Edit",
		group: "Edit an image",
		description: "Fast edits in about a second. Change colors, objects or style.",
		bestFor: ["Quick changes", "Restyling", "Relighting"],
		kind: "image",
		ratios: ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"],
		nativeMatch: true,
		tiers: { standard: { mp: 1, price: { perImage: 0.01 } } },
		defaultTier: "standard",
		refs: { min: 1, max: 5 },
		maxOutputs: 4,
		seed: true,
		outputFormat: "png",
		build: (ctx) =>
			withSeed(
				{ prompt: ctx.prompt, images: ctx.refs, aspect_ratio: ctx.ratio, turbo: true },
				ctx.seed,
			),
	},

	// === Tools (run from the image viewer) ===
	{
		id: "recraft-ai/recraft-crisp-upscale",
		name: "Upscale",
		group: "Tools",
		description: "Makes an image larger and sharper.",
		bestFor: ["Printing", "Wallpapers"],
		kind: "tool",
		ratios: [],
		tiers: { standard: { mp: 4, price: { perImage: 0.006 } } },
		defaultTier: "standard",
		refs: { min: 1, max: 1 },
		maxOutputs: 1,
		outputFormat: "png",
		build: (ctx) => ({ image: ctx.refs[0] }),
	},
	{
		id: "prunaai/p-image-upscale",
		name: "Upscale (large images)",
		group: "Tools",
		description: "Upscales images that are already large.",
		bestFor: ["Large images"],
		kind: "tool",
		ratios: [],
		// Priced at the 8-16 MP band: inputs above 4 MP are doubled, capped at 16 MP.
		tiers: { standard: { mp: 16, price: { perImage: 0.02 } } },
		defaultTier: "standard",
		refs: { min: 1, max: 1 },
		maxOutputs: 1,
		outputFormat: "png",
		build: (ctx) => ({
			image: ctx.refs[0],
			upscale_mode: "target",
			target: 16,
			output_format: "png",
		}),
	},
	{
		id: "recraft-ai/recraft-remove-background",
		name: "Remove background",
		group: "Tools",
		description: "Cuts out the subject and leaves a transparent background.",
		bestFor: ["Product shots", "Stickers"],
		kind: "tool",
		ratios: [],
		tiers: { standard: { mp: 1, price: { perImage: 0.01 } } },
		defaultTier: "standard",
		refs: { min: 1, max: 1 },
		maxOutputs: 1,
		outputFormat: "png",
		build: (ctx) => ({ image: ctx.refs[0] }),
	},

	// === Dropped (hidden): kept so history shows their names; requests are redirected ===
	legacy(
		"black-forest-labs/flux-schnell",
		"FLUX.1 Schnell",
		"black-forest-labs/flux-2-klein-4b",
		0.003,
	),
	legacy("black-forest-labs/flux-dev", "FLUX.1 Dev", "black-forest-labs/flux-2-dev", 0.025),
	legacy("black-forest-labs/flux-1.1-pro", "FLUX 1.1 Pro", "black-forest-labs/flux-2-pro", 0.04),
	legacy(
		"black-forest-labs/flux-1.1-pro-ultra",
		"FLUX 1.1 Pro Ultra",
		"black-forest-labs/flux-2-pro",
		0.06,
	),
	legacy(
		"black-forest-labs/flux-redux-schnell",
		"FLUX Redux Schnell",
		"black-forest-labs/flux-2-dev",
		0.003,
	),
	legacy(
		"black-forest-labs/flux-redux-dev",
		"FLUX Redux Dev",
		"black-forest-labs/flux-2-dev",
		0.025,
	),
	legacy("black-forest-labs/flux-kontext-pro", "FLUX Kontext Pro", "prunaai/p-image-edit", 0.04),
	{
		...legacy("google/nano-banana-pro", "Nano Banana Pro", "google/nano-banana-2", 0.15),
		tiers: {
			draft: { mp: 1, price: { perImage: 0.15 } },
			standard: { mp: 4, price: { perImage: 0.15 } },
			max: { mp: 16, price: { perImage: 0.3 } },
		},
	},
];

function legacy(id: string, name: string, replacedBy: string, perImage: number): CatalogModel {
	return {
		id,
		name,
		group: "Fast drafts",
		description: "No longer offered.",
		bestFor: [],
		hidden: true,
		replacedBy,
		kind: "image",
		ratios: [],
		tiers: { standard: { mp: 1, price: { perImage } } },
		defaultTier: "standard",
		refs: { min: 0, max: 0 },
		maxOutputs: 1,
		outputFormat: "png",
	};
}

// ---- Lookups --------------------------------------------------------------------

const BY_ID = new Map(CATALOG.map((m) => [m.id, m]));

export function getCatalogModel(id: string): CatalogModel | undefined {
	return BY_ID.get(id);
}

/** Models offered in the picker (no hidden legacy models, no tools). */
export function visibleModels(): CatalogModel[] {
	return CATALOG.filter((m) => !m.hidden && m.kind === "image");
}

export function toolModels(): CatalogModel[] {
	return CATALOG.filter((m) => m.kind === "tool");
}

/** Follow `replacedBy` from a dropped model id to the model that serves it now. */
export function currentModelId(id: string): string {
	let m = BY_ID.get(id);
	for (let i = 0; m?.hidden && m.replacedBy && i < 4; i++) m = BY_ID.get(m.replacedBy);
	return m?.id ?? id;
}

/** Display name for any id, including dropped models and unknown ids. */
export function modelDisplayName(id: string): string {
	return BY_ID.get(id)?.name ?? id.split("/").pop() ?? id;
}

export const DEFAULT_MODEL_ID = "black-forest-labs/flux-2-dev";

/** The Replicate slug that runs `model` at `tier`. */
export function slugFor(model: CatalogModel, tier: Tier): string {
	return model.tiers[tier]?.slug ?? model.id;
}

/** True when `allowed` (a product's allowed_models; null = all) lets a user run this model at this tier. */
export function isTierAllowed(allowed: string[] | null, modelId: string, tier: Tier): boolean {
	if (allowed === null) return true;
	const model = BY_ID.get(modelId);
	if (model?.kind === "tool") return true;
	if (!allowed.includes(modelId)) return false;
	if (model?.tiers[tier]?.premium) return allowed.includes(`${modelId}:max`);
	return true;
}

/** Ratios to offer for a model, grouped by orientation (extremes only where native). */
export function ratioChoices(
	model: CatalogModel,
): Record<"square" | "portrait" | "landscape", string[]> {
	const native = new Set(supportedRatios(model));
	return {
		square: SQUARE_RATIOS,
		portrait: [...PORTRAIT_RATIOS, ...EXTREME_PORTRAIT_RATIOS.filter((r) => native.has(r))],
		landscape: [...LANDSCAPE_RATIOS, ...EXTREME_LANDSCAPE_RATIOS.filter((r) => native.has(r))],
	};
}
