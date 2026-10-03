import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Replicate from "replicate";
import sharp from "sharp";
import type { Model } from "../../src/types";
import {
	CATALOG,
	type CatalogModel,
	MATCH_INPUT,
	PROMPT_ENHANCEMENT_COST,
	REF_MAX_PIXELS,
	type Tier,
	getCatalogModel,
	priceOfOutput,
	resolveTier,
	slugFor,
	snapDimensions,
	snapRatio,
	tierFromResolution,
} from "./model-catalog";
import { getImagesDir, getUploadsDir, resolveInside } from "./storage";

// Maximum file size for Replicate inputs (5MB)
const MAX_IMAGE_SIZE = 5 * 1024 * 1024;
// Maximum dimension for resized images
const MAX_DIMENSION = 2048;
// Maximum size of a single downloaded output image (guards memory)
const MAX_OUTPUT_BYTES = 50 * 1024 * 1024;
// Inputs above this many megapixels go to the large-image upscaler.
const CRISP_UPSCALE_MAX_MP = 4;

// Default Replicate client uses REPLICATE_API_TOKEN from env
const defaultReplicate = new Replicate();

/** Thrown when a prediction does not finish within the overall deadline. */
export class GenerationTimeoutError extends Error {
	constructor(message = "Generation timed out") {
		super(message);
		this.name = "GenerationTimeoutError";
	}
}

/**
 * Thrown when no attempt of a prediction got a GPU before the no-GPU cap. Every
 * attempt was canceled before it started, so Replicate bills none of them.
 */
export class GpuBusyError extends Error {
	constructor(message = "No GPU became available") {
		super(message);
		this.name = "GpuBusyError";
	}
}

/** Thrown when Replicate reports the prediction as canceled/aborted. */
export class GenerationCanceledError extends Error {
	constructor(message = "Generation was canceled") {
		super(message);
		this.name = "GenerationCanceledError";
	}
}

/** Thrown when an image input is not a safe, existing file in uploads/ or generated-images/. */
export class InvalidImageInputError extends Error {
	constructor(message = "Invalid image input") {
		super(message);
		this.name = "InvalidImageInputError";
	}
}

// ---- Test seams -------------------------------------------------------------
// Tests replace the Replicate client and the output-download fetch so no test
// ever reaches the network. Production never calls these.
type ClientFactory = (apiKey?: string) => Replicate;
const settings = {
	clientFactory: null as ClientFactory | null,
	fetchImpl: null as typeof fetch | null,
	pollIntervalMs: 1000,
	/** Render deadline, counted from the moment a GPU picks the prediction up. */
	timeoutMs: Number(process.env.GENERATION_TIMEOUT_MS) || 120_000,
	/**
	 * While nothing has started, submit an identical copy of the prediction at
	 * each of these times (so at most 1 + length attempts are in flight).
	 */
	hedgeAtMs: [5_000, 10_000, 15_000],
	/** Give up (cancel everything, refund) when no attempt has started by then. */
	gpuCapMs: 45_000,
	now: () => Date.now(),
};

export const __testing = {
	setClientFactory(factory: ClientFactory | null): void {
		settings.clientFactory = factory;
	},
	setFetch(fetchImpl: typeof fetch | null): void {
		settings.fetchImpl = fetchImpl;
	},
	setTiming(opts: {
		pollIntervalMs?: number;
		timeoutMs?: number;
		hedgeAtMs?: number[];
		gpuCapMs?: number;
	}): void {
		if (opts.pollIntervalMs !== undefined) settings.pollIntervalMs = opts.pollIntervalMs;
		if (opts.timeoutMs !== undefined) settings.timeoutMs = opts.timeoutMs;
		if (opts.hedgeAtMs !== undefined) settings.hedgeAtMs = opts.hedgeAtMs;
		if (opts.gpuCapMs !== undefined) settings.gpuCapMs = opts.gpuCapMs;
	},
};

/**
 * Create a Replicate client with a custom API key or use default
 */
function getReplicateClient(apiKey?: string): Replicate {
	if (settings.clientFactory) return settings.clientFactory(apiKey);
	if (apiKey) {
		return new Replicate({ auth: apiKey });
	}
	return defaultReplicate;
}

// ---- Catalog views for older consumers (admin) -------------------------------------

export interface ExtendedModel extends Model {
	supportsImageInput: boolean;
	maxImages?: number;
	category?: string;
	hidden?: boolean;
	kind?: "image" | "tool";
}

function toExtendedModel(m: CatalogModel): ExtendedModel {
	return {
		id: m.id,
		name: m.name,
		description: m.description,
		supportsImageInput: m.refs.max > 0,
		maxImages: m.refs.max,
		category: m.group,
		hidden: m.hidden,
		kind: m.kind,
	};
}

/** Every model ollo runs now (picker models and tools; no dropped models). */
export const MODELS: ExtendedModel[] = CATALOG.filter((m) => !m.hidden).map(toExtendedModel);

export function getModels(): ExtendedModel[] {
	return MODELS;
}

/**
 * Official cost of a generation (all outputs). Kept for the admin cost
 * recalculation: `resolution` maps onto a tier, width/height give the output
 * megapixels for per-MP models.
 */
export function calculateGenerationCost(
	model: string,
	options: {
		numOutputs?: number;
		resolution?: string;
		tier?: Tier;
		width?: number;
		height?: number;
		inputImageCount?: number;
		hasImageInput?: boolean;
	} = {},
): number {
	const m = getCatalogModel(model);
	if (!m) return 0.025 * (options.numOutputs || 1);
	const tier = resolveTier(m, options.tier ?? tierFromResolution(options.resolution));
	const outputMp =
		options.width && options.height ? (options.width * options.height) / 1_000_000 : undefined;
	const refs = options.inputImageCount ?? (options.hasImageInput ? 1 : 0);
	return priceOfOutput(m, tier, { outputMp, refs }) * (options.numOutputs || 1);
}

/**
 * True when Replicate bills this model per output / per megapixel (every
 * catalog model is an official model), so the formula IS the billed cost and
 * predict_time-based reconciliation must not be used for it.
 */
export function isPerOutputPriced(model: string): boolean {
	return getCatalogModel(model) !== undefined;
}

// ---- Image inputs -------------------------------------------------------------

interface PreparedImage {
	uri: string;
	width: number;
	height: number;
}

const MIME_TYPES: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".avif": "image/avif",
};

/**
 * Read a local image as a data URI. SVGs are rasterized to PNG; images over
 * `maxPixels` (per-megapixel models bill input pixels) or over 5MB are scaled
 * down. Returns the dimensions actually sent.
 */
async function fileToDataUri(filePath: string, maxPixels?: number): Promise<PreparedImage> {
	let buffer: Buffer = fs.readFileSync(filePath);
	const ext = path.extname(filePath).toLowerCase();
	const meta = await sharp(buffer).metadata();
	let width = meta.width ?? 0;
	let height = meta.height ?? 0;
	let mime = MIME_TYPES[ext] || "image/png";

	if (ext === ".svg") {
		buffer = await sharp(buffer).png().toBuffer();
		mime = "image/png";
	}

	if (maxPixels && width * height > maxPixels) {
		const scale = Math.sqrt(maxPixels / (width * height));
		width = Math.max(1, Math.floor(width * scale));
		height = Math.max(1, Math.floor(height * scale));
		buffer = await sharp(buffer).resize(width, height, { fit: "fill" }).png().toBuffer();
		mime = "image/png";
	}

	if (buffer.length > MAX_IMAGE_SIZE) {
		const ratio = Math.min(1, MAX_DIMENSION / width, MAX_DIMENSION / height);
		const newWidth = Math.round(width * ratio);
		const newHeight = Math.round(height * ratio);
		let quality = 85;
		while (quality >= 50) {
			buffer = await sharp(buffer)
				.resize(newWidth, newHeight, { fit: "inside", withoutEnlargement: true })
				.jpeg({ quality })
				.toBuffer();
			if (buffer.length <= MAX_IMAGE_SIZE) break;
			quality -= 10;
		}
		width = newWidth;
		height = newHeight;
		mime = "image/jpeg";
	}

	return { uri: `data:${mime};base64,${buffer.toString("base64")}`, width, height };
}

/**
 * Map an image input reference ("/uploads/<file>" or "/images/<file>", optionally
 * as an absolute URL) to a file path inside the corresponding directory.
 *
 * Defense in depth: the route already restricts inputs to rows the user owns,
 * but this function must never be able to read outside those two directories.
 */
export function resolveImageInputPath(input: string): string {
	let pathname = input;
	if (/^https?:\/\//i.test(input)) {
		try {
			pathname = new URL(input).pathname;
		} catch {
			throw new InvalidImageInputError();
		}
	}
	const match = /^\/(uploads|images)\/([^/\\]+)$/.exec(pathname);
	if (!match) throw new InvalidImageInputError();
	const dir = match[1] === "uploads" ? getUploadsDir() : getImagesDir();
	const full = resolveInside(dir, match[2]);
	if (!full) throw new InvalidImageInputError();
	return full;
}

// Convert image input paths to data URIs. Any invalid or missing input aborts
// the generation rather than silently generating without the reference image
// the user paid for.
async function prepareImageInputs(
	imageInputs: string[],
	maxPixels?: number,
): Promise<PreparedImage[]> {
	const results: PreparedImage[] = [];
	for (const inputPath of imageInputs) {
		const fullPath = resolveImageInputPath(inputPath);
		if (!fs.existsSync(fullPath)) {
			throw new InvalidImageInputError("Input image not found");
		}
		try {
			results.push(await fileToDataUri(fullPath, maxPixels));
		} catch (err) {
			if (err instanceof InvalidImageInputError) throw err;
			throw new InvalidImageInputError("Input image could not be read");
		}
	}
	return results;
}

/** Pixel size of an owned image reference (for tool routing and Match input). */
export async function imageInputDimensions(
	input: string,
): Promise<{ width: number; height: number }> {
	const fullPath = resolveImageInputPath(input);
	if (!fs.existsSync(fullPath)) throw new InvalidImageInputError("Input image not found");
	try {
		const meta = await sharp(fullPath).metadata();
		return { width: meta.width ?? 0, height: meta.height ?? 0 };
	} catch {
		throw new InvalidImageInputError("Input image could not be read");
	}
}

// ---- Predictions ----------------------------------------------------------------

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Phase callbacks for the live status channel. Called from every parallel
 * prediction of a generation, so implementations must be idempotent.
 */
export interface RunTracker {
	/** Submitted; no GPU has picked it up yet. */
	waitingGpu?(): void;
	/** A GPU picked up an attempt: the render is running. */
	rendering?(): void;
	/** The render finished; outputs are being downloaded and saved. */
	saving?(): void;
}

type Prediction = Awaited<ReturnType<Replicate["predictions"]["get"]>>;

interface Attempt {
	/** 1 = the original submission, 2.. = identical hedges. */
	n: number;
	id: string;
	/** Our clock when the create call returned. */
	submittedAt: number;
	latest: Prediction;
	/** Our clock when we first saw it started. */
	seenStartedAt?: number;
}

/** What one hedged prediction produced, plus how long it waited for a GPU. */
interface PredictionRun {
	output: unknown;
	predictTime: number;
	replicateId: string;
	/** started_at - created_at of the winning attempt (Replicate's timestamps when present). */
	queueWaitMs: number;
	/** Attempts submitted (1 = no hedges). */
	attempts: number;
	/** Which attempt won (1 = the original). */
	winningAttempt: number;
}

const isTerminal = (status: string) =>
	status === "succeeded" || status === "failed" || status === "canceled" || status === "aborted";

/** A GPU has picked the prediction up (or it already finished between polls). */
const hasStarted = (p: Prediction) =>
	p.status === "processing" || p.status === "succeeded" || !!p.started_at;

const timeOf = (iso: string | undefined | null) => {
	const t = iso ? Date.parse(iso) : Number.NaN;
	return Number.isFinite(t) ? t : undefined;
};

/**
 * Run one prediction with same-model hedging and return its output.
 *
 * While the prediction is still waiting for a GPU, identical copies (same
 * model, same input object, so the same seed) are submitted at
 * `settings.hedgeAtMs`. The first attempt to start wins and every other one is
 * canceled at once; canceled-before-start predictions aren't billed. If nothing
 * starts by `settings.gpuCapMs`, everything is canceled and GpuBusyError is
 * thrown. Once an attempt is rendering it gets `settings.timeoutMs` to finish.
 */
async function runSinglePrediction(
	replicate: Replicate,
	model: string,
	input: Record<string, unknown>,
	tracker?: RunTracker,
): Promise<PredictionRun> {
	const now = settings.now;
	const t0 = now();
	const attempts: Attempt[] = [];
	const cancel = async (a: Attempt, why: string) => {
		try {
			await replicate.predictions.cancel(a.id);
		} catch (err) {
			console.error(`Failed to cancel ${why} prediction ${a.id}:`, err);
		}
	};
	const submit = async () => {
		const n = attempts.length + 1;
		const p = await replicate.predictions.create({
			model: model as `${string}/${string}`,
			input,
		});
		const a: Attempt = { n, id: p.id, submittedAt: now(), latest: p };
		if (hasStarted(p)) a.seenStartedAt = now();
		attempts.push(a);
	};

	// The original submission: if this throws, nothing was created.
	await submit();
	tracker?.waitingGpu?.();

	// ---- Wait for a GPU, hedging with identical copies ------------------------
	let hedgesPlanned = 0;
	let winner = attempts.find((a) => a.seenStartedAt !== undefined);
	while (!winner) {
		const elapsed = now() - t0;
		if (elapsed >= settings.gpuCapMs) {
			await Promise.all(
				attempts.filter((a) => !isTerminal(a.latest.status)).map((a) => cancel(a, "GPU-starved")),
			);
			throw new GpuBusyError();
		}
		const due = settings.hedgeAtMs.filter((t) => elapsed >= t).length;
		while (hedgesPlanned < due) {
			hedgesPlanned++;
			try {
				await submit();
			} catch (err) {
				// A failed hedge is not fatal: the original is still queued.
				console.error(`Failed to submit hedge for ${model}:`, err);
			}
		}

		const nextHedge = settings.hedgeAtMs.find((t) => t > elapsed) ?? Number.POSITIVE_INFINITY;
		const wait = Math.min(settings.pollIntervalMs, settings.gpuCapMs - elapsed, nextHedge - elapsed);
		await sleep(Math.max(0, wait));

		const live = attempts.filter((a) => !isTerminal(a.latest.status));
		await Promise.all(
			live.map(async (a) => {
				try {
					a.latest = await replicate.predictions.get(a.id);
				} catch (err) {
					console.error(`Failed to poll prediction ${a.id}:`, err);
					return;
				}
				if (a.seenStartedAt === undefined && hasStarted(a.latest)) a.seenStartedAt = now();
			}),
		);

		// First to start wins: by Replicate's started_at when it gives one, else attempt order.
		const started = attempts.filter((a) => a.seenStartedAt !== undefined);
		if (started.length > 0) {
			winner = started.reduce((best, a) => {
				const ta = timeOf(a.latest.started_at) ?? a.seenStartedAt ?? 0;
				const tb = timeOf(best.latest.started_at) ?? best.seenStartedAt ?? 0;
				return ta < tb || (ta === tb && a.n < best.n) ? a : best;
			});
			break;
		}

		// Every attempt ended without starting (failed or canceled upstream).
		if (attempts.every((a) => isTerminal(a.latest.status))) {
			const failed = attempts.find((a) => a.latest.status === "failed");
			if (failed) {
				throw new Error(
					failed.latest.error ? String(failed.latest.error) : "Generation failed",
				);
			}
			throw new GenerationCanceledError();
		}
	}

	// ---- Cancel the losers right away -------------------------------------------
	const losers = attempts.filter((a) => a !== winner);
	await Promise.all(
		losers
			.filter((a) => !isTerminal(a.latest.status))
			.map((a) => cancel(a, "hedge-loser")),
	);
	for (const a of losers) {
		if (a.seenStartedAt !== undefined) {
			// Replicate may bill a prediction that started before we canceled it. Logged so we can
			// see whether hedging ever costs money; only the winner's cost is recorded.
			console.warn(
				`[hedge] loser ${a.id} (attempt ${a.n}) of ${model} had already started when ${winner.id} (attempt ${winner.n}) won`,
			);
		}
	}

	const created = timeOf(winner.latest.created_at);
	const startedAt = timeOf(winner.latest.started_at);
	const queueWaitMs =
		created !== undefined && startedAt !== undefined
			? Math.max(0, startedAt - created)
			: Math.max(0, (winner.seenStartedAt ?? winner.submittedAt) - winner.submittedAt);

	// ---- Render ---------------------------------------------------------------------
	tracker?.rendering?.();
	const deadline = now() + settings.timeoutMs;
	let finalPrediction = winner.latest;
	while (!isTerminal(finalPrediction.status)) {
		if (now() >= deadline) {
			await cancel(winner, "timed-out");
			throw new GenerationTimeoutError();
		}
		await sleep(Math.min(settings.pollIntervalMs, Math.max(0, deadline - now())));
		finalPrediction = await replicate.predictions.get(winner.id);
	}

	if (finalPrediction.status === "failed") {
		throw new Error(finalPrediction.error ? String(finalPrediction.error) : "Generation failed");
	}
	if (finalPrediction.status !== "succeeded") {
		throw new GenerationCanceledError();
	}

	return {
		output: finalPrediction.output,
		predictTime: finalPrediction.metrics?.predict_time || 0,
		replicateId: winner.id,
		queueWaitMs,
		attempts: attempts.length,
		winningAttempt: winner.n,
	};
}

const CONTENT_TYPE_EXT: Record<string, string> = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/jpg": "jpg",
	"image/webp": "webp",
	"image/gif": "gif",
	"image/avif": "avif",
	"image/svg+xml": "svg",
};

/** Pick the file extension from the response content type, then the URL, then the requested format. */
function pickExtension(
	contentType: string | null,
	imageUrl: string,
	requestedFormat?: string,
): string {
	const ct = (contentType || "").split(";")[0].trim().toLowerCase();
	if (CONTENT_TYPE_EXT[ct]) return CONTENT_TYPE_EXT[ct];
	try {
		const urlExt = path.extname(new URL(imageUrl).pathname).slice(1).toLowerCase();
		if (urlExt === "jpeg") return "jpg";
		if (["png", "jpg", "webp", "gif", "avif", "svg"].includes(urlExt)) return urlExt;
	} catch {
		// fall through to the requested format
	}
	const fmt = (requestedFormat || "").toLowerCase();
	if (fmt === "jpeg" || fmt === "jpg") return "jpg";
	if (fmt === "png" || fmt === "webp" || fmt === "svg") return fmt;
	return "png";
}

/**
 * SVGs are served from our own origin, so anything that could run script is
 * refused outright (Recraft never emits these; a hit means something is wrong).
 */
const UNSAFE_SVG =
	/<\s*(script|foreignObject|iframe|embed|object|use)\b|\son\w+\s*=|javascript:|data:text\/html|<!ENTITY/i;

/** Drawing elements a vector illustration needs. Anything else (a, image, use, style, ...) is refused. */
const SVG_ELEMENTS = new Set([
	"svg",
	"g",
	"path",
	"rect",
	"circle",
	"ellipse",
	"line",
	"polyline",
	"polygon",
	"defs",
	"lineargradient",
	"radialgradient",
	"stop",
	"clippath",
	"mask",
	"pattern",
	"title",
	"desc",
	"metadata",
	"text",
	"tspan",
	"filter",
	"fegaussianblur",
	"feoffset",
	"feblend",
	"fecolormatrix",
	"feflood",
	"fecomposite",
	"femerge",
	"femergenode",
]);

/** Decode numeric and the few named entities that can spell out a URL scheme. */
function decodeEntities(value: string): string {
	return value
		.replace(/&#x([0-9a-f]+);?/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16) || 0))
		.replace(/&#(\d+);?/g, (_, dec: string) => String.fromCodePoint(Number(dec) || 0))
		.replace(/&colon;/gi, ":")
		.replace(/&(tab|newline);/gi, "");
}

/**
 * Is this SVG safe to serve from our own origin? Allowlist-style: strict UTF-8 without a BOM
 * (UTF-16 and BOM-prefixed files can slip markup past text checks), only known drawing
 * elements, no event handlers, only in-document (#id) references, and no script-capable URL
 * schemes even when spelled with entities or whitespace.
 */
export function isSafeSvg(buffer: Buffer): boolean {
	if (buffer.length >= 2 && ((buffer[0] === 0xff && buffer[1] === 0xfe) || (buffer[0] === 0xfe && buffer[1] === 0xff)))
		return false;
	if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) return false;
	if (buffer.includes(0)) return false; // UTF-16 without a BOM, or binary
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
	} catch {
		return false;
	}
	if (UNSAFE_SVG.test(text)) return false;
	if (/<!DOCTYPE|<\?xml-stylesheet|<!\[CDATA\[/i.test(text)) return false;

	const normalized = decodeEntities(text)
		// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
		.replace(/[\s\u0000-\u001f]+/g, "")
		.toLowerCase();
	if (/javascript:|vbscript:|data:text\/html|data:image\/svg/.test(normalized)) return false;
	if (/\son\w+\s*=/i.test(decodeEntities(text))) return false;

	for (const match of text.matchAll(/<\s*([a-zA-Z][\w:.-]*)/g)) {
		const name = match[1].toLowerCase();
		const local = name.includes(":") ? name.slice(name.indexOf(":") + 1) : name;
		if (!SVG_ELEMENTS.has(local)) return false;
	}
	// References must stay inside the document: href="#id", url(#id).
	for (const match of text.matchAll(/(?:xlink:)?href\s*=\s*(["'])(.*?)\1/gi)) {
		if (!decodeEntities(match[2]).trim().startsWith("#")) return false;
	}
	for (const match of text.matchAll(/url\(\s*(["']?)(.*?)\1\s*\)/gi)) {
		if (!decodeEntities(match[2]).trim().startsWith("#")) return false;
	}
	return true;
}

/** One saved output with its official cost and real pixel size. */
export interface GenerationResult {
	id: string;
	replicateId: string;
	imagePath: string;
	imageUrl: string;
	/** Official cost of record for this output (USD). */
	cost: number;
	predictTime: number;
	width: number;
	height: number;
	/** How long the winning attempt waited for a GPU (started_at - created_at). */
	queueWaitMs: number;
	/** Attempts submitted for this output's prediction (1 = no hedges). */
	attempts: number;
	/** Which attempt produced it (1 = the original). */
	winningAttempt: number;
}

interface SavedImage {
	id: string;
	imagePath: string;
	imageUrl: string;
	width: number;
	height: number;
}

// Download an output and save it locally, recording its real dimensions.
async function downloadAndSaveImage(
	imageUrl: string,
	requestedFormat?: string,
): Promise<SavedImage | null> {
	if (!imageUrl || !/^https?:\/\//i.test(imageUrl)) {
		console.log("Skipping invalid URL:", imageUrl);
		return null;
	}

	const doFetch = settings.fetchImpl ?? fetch;
	const response = await doFetch(imageUrl);
	if (!response.ok) {
		throw new Error(`Failed to download generated image (HTTP ${response.status})`);
	}
	const buffer = Buffer.from(await response.arrayBuffer());
	if (buffer.length === 0) {
		throw new Error("Downloaded generated image is empty");
	}
	if (buffer.length > MAX_OUTPUT_BYTES) {
		throw new Error("Downloaded generated image is too large");
	}

	const ext = pickExtension(response.headers.get("content-type"), imageUrl, requestedFormat);
	if (ext === "svg" && !isSafeSvg(buffer)) {
		throw new Error("Generated SVG contained unsafe content");
	}

	let width = 0;
	let height = 0;
	try {
		const meta = await sharp(buffer).metadata();
		width = meta.width ?? 0;
		height = meta.height ?? 0;
	} catch {
		throw new Error("Downloaded generated image could not be read");
	}

	const id = crypto.randomUUID();
	const filename = `${id}.${ext}`;
	const dir = getImagesDir();
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, filename), buffer);

	return { id, imagePath: filename, imageUrl: `/images/${filename}`, width, height };
}

/** Normalize a prediction's output (string, array, null, FileOutput) to a list of URL strings. */
function outputToUrls(output: unknown): string[] {
	if (output === null || output === undefined) return [];
	const items = Array.isArray(output) ? output : [output];
	return items.filter((item) => item !== null && item !== undefined).map((item) => String(item));
}

export interface GenerateOptions {
	numOutputs?: number;
	imageInputs?: string[]; // "/uploads/<file>" or "/images/<file>" references
	aspectRatio?: string;
	/** Size tier; wins over `resolution`. */
	tier?: Tier;
	/** Legacy: "1K"/"2K"/"4K" (or "1 MP"…) map onto draft/standard/max. */
	resolution?: string;
	outputFormat?: string;
	apiKey?: string; // Optional BYO API key
	seed?: number; // Random seed for reproducibility/variation
	/** Phase callbacks for the live status channel. */
	tracker?: RunTracker;
}

/** What the server will actually run for a request: used for both pricing and the call. */
export interface ResolvedRequest {
	model: CatalogModel;
	tier: Tier;
	/** Ratio sent to the model (may be "match_input_image" for models that match natively). */
	ratio: string;
	/** The requested ratio, when it was snapped to a different one. */
	snappedFrom?: string;
	slug: string;
}

/**
 * Resolve tier and ratio for a model. `firstInputSize` is the first reference
 * image's size, used for "Match input" on models that can't match natively.
 */
export function resolveRequest(
	model: CatalogModel,
	opts: { tier?: Tier; resolution?: string; aspectRatio?: string },
	firstInputSize?: { width: number; height: number },
): ResolvedRequest {
	const tier = resolveTier(model, opts.tier ?? tierFromResolution(opts.resolution));
	const requested = opts.aspectRatio || "1:1";
	let ratio: string;
	let snappedFrom: string | undefined;
	if (requested === MATCH_INPUT) {
		if (firstInputSize && model.nativeMatch && !model.custom) ratio = MATCH_INPUT;
		else if (firstInputSize)
			ratio = snapDimensions(model, firstInputSize.width, firstInputSize.height);
		else ratio = snapRatio(model, "1:1").ratio;
	} else {
		const snap = snapRatio(model, requested);
		ratio = snap.ratio;
		if (snap.snapped) snappedFrom = requested;
	}
	return { model, tier, ratio, snappedFrom, slug: slugFor(model, tier) };
}

/** Megapixels billed for the given pixel size. */
const billedMp = (w: number, h: number) => (w * h) / 1_000_000;

/**
 * Run a generation and download its outputs.
 *
 * May return fewer images than requested (including zero) when Replicate
 * returns fewer outputs or some parallel calls fail; the caller refunds the
 * difference. Throws only when nothing could be produced because of an error.
 */
export async function generateImage(
	prompt: string,
	modelId: string,
	options: GenerateOptions = {},
): Promise<GenerationResult[]> {
	const model = getCatalogModel(modelId);
	if (!model?.build || model.hidden) throw new Error(`Unknown model: ${modelId}`);
	const { numOutputs = 1, apiKey, imageInputs = [] } = options;
	const replicate = getReplicateClient(apiKey);

	const firstSize = imageInputs.length > 0 ? await imageInputDimensions(imageInputs[0]) : undefined;
	const resolved = resolveRequest(model, options, firstSize);
	const tierSpec = model.tiers[resolved.tier];
	// Per-megapixel models bill input pixels: send references at no more than ~1 MP.
	const maxRefPixels = tierSpec?.price.perInputMp ? REF_MAX_PIXELS : undefined;
	const refs = imageInputs.length > 0 ? await prepareImageInputs(imageInputs, maxRefPixels) : [];
	const inputMps = refs.map((r) => billedMp(r.width, r.height));
	const build = model.build;

	const runAndDownload = async (outputs: number, seed?: number): Promise<GenerationResult[]> => {
		const input = build({
			prompt,
			ratio: resolved.ratio,
			tier: resolved.tier,
			refs: refs.map((r) => r.uri),
			outputs,
			seed,
			outputFormat: options.outputFormat,
		});
		const run = await runSinglePrediction(replicate, resolved.slug, input, options.tracker);
		const { output, predictTime, replicateId, queueWaitMs, attempts, winningAttempt } = run;
		options.tracker?.saving?.();
		const out: GenerationResult[] = [];
		for (const url of outputToUrls(output)) {
			const saved = await downloadAndSaveImage(url, options.outputFormat ?? model.outputFormat);
			if (!saved) continue;
			const outputMp =
				saved.width && saved.height ? billedMp(saved.width, saved.height) : undefined;
			out.push({
				...saved,
				replicateId,
				predictTime,
				queueWaitMs,
				attempts,
				winningAttempt,
				cost: priceOfOutput(model, resolved.tier, { outputMp, inputMps }),
			});
		}
		return out;
	};

	// One prediction when the model returns several outputs itself (or only one is wanted).
	if (model.nativeOutputs || numOutputs === 1) {
		return runAndDownload(numOutputs, options.seed);
	}

	// Otherwise parallel predictions. Partial success is kept; the caller refunds missing outputs.
	const baseSeed = model.seed
		? (options.seed ?? Math.floor(Math.random() * 2147483000))
		: undefined;
	const settled = await Promise.allSettled(
		Array.from({ length: numOutputs }, (_, i) =>
			runAndDownload(1, baseSeed !== undefined ? baseSeed + i : undefined),
		),
	);

	const results = settled.flatMap((s) => (s.status === "fulfilled" ? s.value : []));
	if (results.length === 0) {
		const firstError = settled.find((s): s is PromiseRejectedResult => s.status === "rejected");
		if (firstError) throw firstError.reason;
	}
	return results;
}

// ---- Tools ------------------------------------------------------------------------

export type ToolName = "upscale" | "remove-background";
export const TOOL_NAMES: ToolName[] = ["upscale", "remove-background"];

/** The catalog model that runs a tool on an input of this size. */
export function toolModelFor(
	tool: ToolName,
	input: { width: number; height: number },
): CatalogModel {
	const id =
		tool === "remove-background"
			? "recraft-ai/recraft-remove-background"
			: billedMp(input.width, input.height) > CRISP_UPSCALE_MAX_MP
				? "prunaai/p-image-upscale"
				: "recraft-ai/recraft-crisp-upscale";
	const model = getCatalogModel(id);
	if (!model) throw new Error(`Tool model missing from catalog: ${id}`);
	return model;
}

/** Run a tool on one owned image; returns the saved output (or throws). */
export async function runTool(
	tool: ToolName,
	imageInput: string,
	opts: { apiKey?: string; model?: CatalogModel; tracker?: RunTracker } = {},
): Promise<GenerationResult> {
	const model = opts.model ?? toolModelFor(tool, await imageInputDimensions(imageInput));
	const [result] = await generateImage("", model.id, {
		imageInputs: [imageInput],
		apiKey: opts.apiKey,
		tracker: opts.tracker,
	});
	if (!result) throw new Error("The tool returned no image");
	return result;
}

// ---- Prompt enhancement -----------------------------------------------------------

export interface EnhancePromptResult {
	enhanced: string;
	cost: number;
}

/**
 * Enhance a prompt using Llama to make it more detailed and interesting
 * Returns both the enhanced prompt and the estimated cost
 */
export async function enhancePrompt(
	prompt: string,
	apiKey?: string,
	hasImages?: boolean,
): Promise<EnhancePromptResult> {
	const replicate = getReplicateClient(apiKey);

	const systemPrompt = hasImages
		? `You are an expert image prompt engineer. Your job is to take a basic image description and transform it into a rich, detailed prompt for AI image generation.

IMPORTANT: The user has reference images attached. Do NOT invent or specify physical characteristics of people, animals, or objects that the user refers to (e.g., "the girl", "the dog", "the car"). These subjects already exist in the reference images. Instead:
- Keep subject references generic (e.g., keep "the girl" as "the girl", not "a blonde girl with blue eyes")
- Focus on: lighting, atmosphere, artistic style, composition, camera angle, color palette, mood, setting/environment, and actions
- Add environmental and stylistic details, not subject-specific physical traits

Output ONLY the enhanced prompt - no explanations, no quotes, no prefixes. Keep it under 150 words.`
		: "You are an expert image prompt engineer. Your job is to take a basic image description and transform it into a rich, detailed prompt for AI image generation. Add specific visual details, lighting, color palette, artistic style, composition, and atmosphere. Output ONLY the enhanced prompt - no explanations, no quotes, no prefixes. Keep it under 150 words.";

	const userPrompt = `Enhance this image prompt: ${prompt}`;

	// Use Meta Llama which works reliably on Replicate
	const chunks: string[] = [];

	for await (const event of replicate.stream("meta/meta-llama-3-70b-instruct", {
		input: {
			prompt: `<|begin_of_text|><|start_header_id|>system<|end_header_id|>\n\n${systemPrompt}<|eot_id|><|start_header_id|>user<|end_header_id|>\n\n${userPrompt}<|eot_id|><|start_header_id|>assistant<|end_header_id|>\n\n`,
			max_tokens: 300,
			temperature: 0.8,
		},
	})) {
		chunks.push(String(event));
	}

	const result = chunks.join("");
	return {
		enhanced: result.trim(),
		cost: PROMPT_ENHANCEMENT_COST,
	};
}
