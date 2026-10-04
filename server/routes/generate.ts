import crypto from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { GenerateRequest } from "../../src/types";
import { getDb } from "../db";
import { authMiddleware, verifyToken } from "../middleware/auth";
import { maybeSendLowCreditEmail } from "../services/email";
import {
	ALL_RATIOS,
	type CatalogModel,
	DEFAULT_MODEL_ID,
	MATCH_INPUT,
	TIERS,
	type Tier,
	currentModelId,
	getCatalogModel,
	resolveTier,
	tierFromResolution,
} from "../services/model-catalog";
import {
	ContentFilteredError,
	GenerationCanceledError,
	type GenerationResult,
	GenerationTimeoutError,
	GpuBusyError,
	InvalidImageInputError,
	type RunTracker,
	TOOL_NAMES,
	type ToolName,
	enhancePrompt,
	generateImageDetailed,
	imageInputDimensions,
	isPerOutputPriced,
	resolveRequest,
	runTool,
	toolModelFor,
} from "../services/replicate";
import {
	CLIENT_REQUEST_ID,
	getStatus,
	setPhase,
	startStatus,
} from "../services/generation-status";
import { recordPlatformCost } from "../services/replicate-billing";
import { SAFE_IMAGE_FILENAME } from "../services/storage";
import {
	canUserGenerate,
	canUserUseModel,
	getAvailableCredits,
	getModelCreditCost,
	recordUsage,
	refundReservation,
	reserveCredits,
} from "../services/usage";
import { getUserApiKey } from "./user";

interface ExtendedGenerateRequest extends Omit<GenerateRequest, "prompt" | "tier"> {
	prompt?: string;
	imageInputs?: string[];
	aspectRatio?: string;
	/** Size tier ("draft" | "standard" | "max"); wins over `resolution`. */
	tier?: string;
	/** Legacy tier spelling: "1K" | "2K" | "4K" (also "1 MP"…). */
	resolution?: string;
	outputFormat?: string;
	seed?: number;
	threadId?: string;
	/** Ask the server to pick a variation model the user's tier allows (Vary buttons). */
	variation?: boolean;
	/** Client-generated UUID for GET /api/generate/status/:clientRequestId. */
	clientRequestId?: string;
}

/**
 * Machine-readable error codes returned as `code` in error JSON so the client
 * (paywall UI) can react without parsing messages.
 */
export type GenerateErrorCode =
	| "INVALID_REQUEST"
	| "INVALID_IMAGE_INPUT"
	| "MODEL_NOT_ALLOWED"
	| "INSUFFICIENT_CREDITS"
	| "MONTHLY_COST_LIMIT"
	| "API_KEY_UNREADABLE"
	| "THREAD_NOT_FOUND"
	| "GENERATION_TIMEOUT"
	| "GENERATION_CANCELED"
	| "GENERATION_NO_OUTPUT"
	| "GENERATION_FAILED"
	| "GPU_BUSY"
	| "CONTENT_FILTERED";

/** Outputs of a partly successful generation that the model's safety filter blocked. */
interface BlockedOutputs {
	count: number;
	reason: "content_filter";
	/** Credits refunded for them (0 on the user's own Replicate key). */
	creditsReturned: number;
}

const MAX_OUTPUTS = 4;
const MAX_PROMPT_LENGTH = 10_000;
const MAX_ENHANCE_PROMPT_LENGTH = 2_000;
const MAX_SEED = 2_147_483_647;

const ALLOWED_ASPECT_RATIOS = new Set([MATCH_INPUT, ...ALL_RATIOS]);
const ALLOWED_RESOLUTIONS = new Set(["1K", "2K", "4K", "1 MP", "2 MP", "4 MP"]);
// Normalized to the spelling Replicate models accept.
const OUTPUT_FORMATS: Record<string, string> = {
	png: "png",
	jpg: "jpg",
	jpeg: "jpg",
	webp: "webp",
};

// Vary: an approved model that takes the image as a reference. Best first; the
// server falls back to a cheaper one (and fewer outputs) so Free can always Vary.
const VARIATION_MODEL_PREFERENCE = [
	"black-forest-labs/flux-2-dev",
	"black-forest-labs/flux-2-klein-4b",
];
function variationPrompt(prompt: string): string {
	const base =
		"Create a new variation of the reference image. Keep the same subject, style, colors and mood, and vary the composition, pose and details.";
	const original = prompt.trim();
	return original ? `${base} The original image was described as: ${original}` : base;
}

const TOOL_TITLES: Record<ToolName, string> = {
	upscale: "Upscaled image",
	"remove-background": "Background removed",
};
function sendError(
	reply: FastifyReply,
	status: number,
	code: GenerateErrorCode,
	error: string,
	extra: Record<string, unknown> = {},
) {
	return reply.status(status).send({ status: "failed", code, error, ...extra });
}

/**
 * Load the user's BYO Replicate key. A key that exists but cannot be decrypted
 * (e.g. ENCRYPTION_KEY rotated) is reported as an error rather than silently
 * falling back to the platform key: falling back would start charging credits
 * to a user who believes they are paying Replicate directly.
 */
function loadUserApiKey(userId: string): { key: string | null; unreadable: boolean } {
	try {
		return { key: getUserApiKey(userId), unreadable: false };
	} catch (err) {
		console.error(
			`Failed to decrypt Replicate API key for user ${userId}:`,
			err instanceof Error ? err.message : err,
		);
		return { key: null, unreadable: true };
	}
}

const API_KEY_UNREADABLE_MESSAGE =
	"Your saved Replicate API key could not be read. Please remove it and add it again in Settings.";

function escapeLike(value: string): string {
	return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * Resolve user-supplied image references to files the requesting user owns.
 * Accepts "/uploads/<file>" / "/images/<file>" (optionally as absolute URLs, as
 * the dev frontend sends) and returns normalized "/kind/<file>" paths, or null
 * if any entry is malformed, not owned, or deleted.
 */
function resolveOwnedImageInputs(userId: string, inputs: unknown[]): string[] | null {
	const db = getDb();
	const normalized: string[] = [];

	for (const raw of inputs) {
		if (typeof raw !== "string" || raw.length === 0 || raw.length > 512) return null;

		let pathname = raw;
		if (/^https?:\/\//i.test(raw)) {
			try {
				pathname = new URL(raw).pathname;
			} catch {
				return null;
			}
		}
		const match = /^\/(uploads|images)\/([^/\\]+)$/.exec(pathname);
		if (!match) return null;
		const [, kind, filename] = match;
		if (!SAFE_IMAGE_FILENAME.test(filename)) return null;

		if (kind === "uploads") {
			const row = db
				.prepare("SELECT id FROM uploads WHERE user_id = ? AND filename = ? AND deleted_at IS NULL")
				.get(userId, filename);
			if (!row) return null;
		} else {
			const primary = db
				.prepare(
					`SELECT id FROM generations
					WHERE user_id = ? AND image_path = ? AND deleted_at IS NULL AND purged_at IS NULL`,
				)
				.get(userId, filename);
			if (!primary) {
				// Extra images of a 4-up grid live only in parameters.images[].path.
				const candidates = db
					.prepare(
						`SELECT parameters FROM generations
						WHERE user_id = ? AND deleted_at IS NULL AND purged_at IS NULL
						AND parameters LIKE ? ESCAPE '\\'`,
					)
					.all(userId, `%${escapeLike(filename)}%`) as { parameters: string | null }[];
				const owned = candidates.some((c) => {
					try {
						const params = JSON.parse(c.parameters ?? "{}") as { images?: { path?: unknown }[] };
						return (params.images ?? []).some((img) => img?.path === filename);
					} catch {
						return false;
					}
				});
				if (!owned) return null;
			}
		}
		normalized.push(`/${kind}/${filename}`);
	}

	return normalized;
}

/**
 * Pick the variation model for a Vary request: the best one the user's plan
 * allows that the balance covers at the requested outputs. When none covers
 * them, the cheapest allowed model with as many outputs as the balance buys
 * (at least 1), so Free can always Vary. Own-key users get the best allowed.
 */
function pickVariation(
	userId: string,
	tier: Tier | undefined,
	outputs: number,
	refs: number,
	balance: number | null,
): { model: CatalogModel; tier: Tier; outputs: number } | null {
	const candidates = VARIATION_MODEL_PREFERENCE.map((id) => getCatalogModel(id))
		.filter((m): m is CatalogModel => !!m)
		.map((m) => ({ model: m, tier: resolveTier(m, tier) }))
		.filter((c) => canUserUseModel(userId, c.model.id, c.tier));
	if (candidates.length === 0) return null;
	if (balance === null) return { ...candidates[0], outputs };
	const per = (c: (typeof candidates)[number]) => getModelCreditCost(c.model.id, c.tier, refs);
	const fits = candidates.find((c) => per(c) * outputs <= balance);
	if (fits) return { ...fits, outputs };
	const cheapest = candidates.reduce((a, b) => (per(b) < per(a) ? b : a));
	const affordable = Math.floor(balance / per(cheapest));
	return { ...cheapest, outputs: Math.max(1, Math.min(outputs, affordable)) };
}

/** Per-user key for route rate limits; falls back to IP for unauthenticated calls. */
function userRateLimitKey(request: FastifyRequest): string {
	const header = request.headers.authorization;
	if (header?.startsWith("Bearer ")) {
		const payload = verifyToken(header.slice(7));
		if (payload?.userId) return `user:${payload.userId}`;
	}
	return `ip:${request.ip}`;
}

// Generate a thread title from a prompt (first ~50 chars, cleaned up)
function generateThreadTitle(prompt: string | undefined, fallback = "Variation"): string {
	const cleaned = (prompt ?? "").trim().replace(/\s+/g, " ");
	if (cleaned.length === 0) return fallback;
	if (cleaned.length <= 50) return cleaned;
	// Cut at word boundary
	const truncated = cleaned.slice(0, 50);
	const lastSpace = truncated.lastIndexOf(" ");
	return lastSpace > 30 ? `${truncated.slice(0, lastSpace)}...` : `${truncated}...`;
}

/** Credit reservation with capped, idempotent-ish partial refunds. */
function makeReservation(userId: string, totalCredits: number) {
	let reservationId: string | null = null;
	let refunded = 0;
	return {
		reserve(reason: string): boolean {
			reservationId = reserveCredits(userId, totalCredits, reason);
			return reservationId !== null;
		},
		refund(amount: number, reason: string) {
			if (!reservationId) return;
			const capped = Math.min(amount, totalCredits - refunded);
			if (capped <= 0) return;
			refundReservation(userId, reservationId, capped, reason);
			refunded += capped;
		},
		get charged() {
			return reservationId ? totalCredits - refunded : 0;
		},
	};
}

/**
 * Refund reason for runs a safety filter blocked entirely. The admin Models
 * page counts filtered outputs from `failed: blocked by safety filter (N)`.
 */
const filteredRefundReason = (prefix: string, outputs: number) =>
	`${prefix}: blocked by safety filter (${outputs})`;

/** Map a failed Replicate run to the error response (after refunding). */
function sendRunError(reply: FastifyReply, error: unknown) {
	if (error instanceof ContentFilteredError) {
		return sendError(
			reply,
			422,
			"CONTENT_FILTERED",
			"The model's safety filter blocked this image. Your credits were returned. Try rewording the prompt.",
		);
	}
	if (error instanceof InvalidImageInputError) {
		return sendError(reply, 400, "INVALID_IMAGE_INPUT", error.message);
	}
	if (error instanceof GpuBusyError) {
		return sendError(
			reply,
			503,
			"GPU_BUSY",
			"Image generation is busy right now. Your credits were returned.",
		);
	}
	if (error instanceof GenerationTimeoutError) {
		return sendError(
			reply,
			504,
			"GENERATION_TIMEOUT",
			"Generation timed out. Your credits were refunded.",
		);
	}
	if (error instanceof GenerationCanceledError) {
		return sendError(
			reply,
			502,
			"GENERATION_CANCELED",
			"Generation was canceled. Your credits were refunded.",
		);
	}
	const message = error instanceof Error ? error.message : "Generation failed";
	return sendError(reply, 500, "GENERATION_FAILED", message);
}

// ---- Live status --------------------------------------------------------------

/** The status id each tracked request registered, so onResponse can close it. */
const trackedRequests = new WeakMap<FastifyRequest, string>();

/**
 * Register the request's clientRequestId (optional; older clients don't send
 * one). Returns an error response to send, or null to carry on.
 */
function beginTracking(
	request: FastifyRequest,
	reply: FastifyReply,
	userId: string,
	raw: unknown,
	model: string,
) {
	if (raw === undefined || raw === null) return null;
	if (typeof raw !== "string" || !CLIENT_REQUEST_ID.test(raw)) {
		return sendError(reply, 400, "INVALID_REQUEST", "Invalid clientRequestId");
	}
	const id = raw.toLowerCase();
	if (!startStatus(id, userId, model)) {
		return sendError(reply, 409, "INVALID_REQUEST", "This request is already running");
	}
	trackedRequests.set(request, id);
	return null;
}

function trackerFor(request: FastifyRequest): RunTracker | undefined {
	const id = trackedRequests.get(request);
	if (!id) return undefined;
	return {
		waitingGpu: () => setPhase(id, "waiting_gpu"),
		rendering: () => setPhase(id, "rendering"),
		saving: () => setPhase(id, "saving"),
	};
}

/** Route hook: the response went out, so the request is done (2xx) or failed. */
async function finishTracking(request: FastifyRequest, reply: FastifyReply) {
	const id = trackedRequests.get(request);
	if (id) setPhase(id, reply.statusCode < 400 ? "done" : "failed");
}

/** GPU wait and hedging, stored in generations.parameters for the admin Models page. */
function queueStats(results: GenerationResult[]) {
	return {
		queueWaitMs: results[0]?.queueWaitMs,
		predictionAttempts: results.reduce((n, r) => n + r.attempts, 0),
		winningAttempt: results[0]?.winningAttempt,
	};
}

interface SaveArgs {
	userId: string;
	model: string;
	prompt: string;
	results: GenerationResult[];
	threadId: string | undefined;
	threadTitle: string;
	parameters: Record<string, unknown>;
	usedOwnKey: boolean;
}

/** Record usage, the generation row (one row; extra outputs in parameters.images) and platform cost. */
function saveGeneration(args: SaveArgs, log: FastifyInstance["log"]): { threadId: string } {
	const db = getDb();
	const { results, userId, usedOwnKey } = args;
	const totalCost = results.reduce((sum, r) => sum + r.cost, 0);

	// Create the thread only once there is something to put in it.
	let threadId = args.threadId;
	if (threadId) {
		db.prepare("UPDATE threads SET updated_at = datetime('now') WHERE id = ?").run(threadId);
	} else {
		threadId = crypto.randomUUID();
		db.prepare(`
			INSERT INTO threads (id, user_id, title, created_at, updated_at)
			VALUES (?, ?, ?, datetime('now'), datetime('now'))
		`).run(threadId, userId, args.threadTitle);
	}

	recordUsage(userId, totalCost, usedOwnKey);

	const primary = results[0];
	const parameters = { ...args.parameters };
	if (results.length > 1) {
		parameters.images = results.map((r) => ({
			id: r.id,
			url: r.imageUrl,
			path: r.imagePath,
			width: r.width,
			height: r.height,
		}));
	}

	db.prepare(`
		INSERT INTO generations (id, prompt, model, image_path, width, height, parameters, user_id, cost, replicate_id, predict_time, thread_id)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`).run(
		primary.id,
		args.prompt,
		args.model,
		primary.imagePath,
		primary.width || null,
		primary.height || null,
		JSON.stringify(parameters),
		userId,
		totalCost,
		primary.replicateId,
		primary.predictTime,
		threadId,
	);

	// Platform cost (only when we paid Replicate). The official formula is the
	// cost of record, so per-output-priced models are reconciled immediately.
	if (!usedOwnKey) {
		try {
			recordPlatformCost(
				primary.id,
				primary.replicateId,
				args.model,
				totalCost,
				isPerOutputPriced(args.model) ? totalCost : undefined,
				primary.predictTime,
			);
		} catch (err) {
			log.error(err, "Failed to record platform cost");
		}
		// Low-balance email (throttled, fire-and-forget; never affects the response).
		try {
			void maybeSendLowCreditEmail(userId, getAvailableCredits(userId));
		} catch {}
	}

	return { threadId };
}

function parseTier(body: { tier?: unknown; resolution?: unknown }): Tier | undefined | null {
	if (body.tier !== undefined) {
		return typeof body.tier === "string" && (TIERS as string[]).includes(body.tier)
			? (body.tier as Tier)
			: null;
	}
	if (body.resolution !== undefined) {
		return typeof body.resolution === "string" && ALLOWED_RESOLUTIONS.has(body.resolution)
			? tierFromResolution(body.resolution)
			: null;
	}
	return undefined;
}

export async function generateRoutes(fastify: FastifyInstance): Promise<void> {
	/**
	 * Live phase of the caller's own in-flight request (owner-only; 404 for
	 * anyone else, and once the entry expired 10 minutes after finishing).
	 * Polled about once a second per request, so it has its own per-user limit.
	 */
	fastify.get<{ Params: { clientRequestId: string } }>(
		"/api/generate/status/:clientRequestId",
		{
			preHandler: authMiddleware,
			config: {
				rateLimit: { max: 600, timeWindow: "1 minute", keyGenerator: userRateLimitKey },
			},
		},
		async (request, reply) => {
			const userId = request.user?.userId;
			if (!userId) return reply.status(401).send({ error: "Unauthorized" });
			const id = request.params.clientRequestId.toLowerCase();
			const status = CLIENT_REQUEST_ID.test(id) ? getStatus(id, userId) : undefined;
			if (!status) return reply.status(404).send({ code: "NOT_FOUND", error: "Not found" });
			return status;
		},
	);

	fastify.post<{ Body: ExtendedGenerateRequest }>(
		"/api/generate",
		{ preHandler: authMiddleware, onResponse: finishTracking },
		async (request, reply) => {
			const userId = request.user?.userId;
			if (!userId) {
				return reply.status(401).send({ error: "Unauthorized" });
			}

			const body = (request.body ?? {}) as ExtendedGenerateRequest;
			const trackingError = beginTracking(
				request,
				reply,
				userId,
				body.clientRequestId,
				typeof body.model === "string" ? currentModelId(body.model) : DEFAULT_MODEL_ID,
			);
			if (trackingError) return trackingError;
			const { width, height, aspectRatio, seed, threadId } = body;
			let prompt = typeof body.prompt === "string" ? body.prompt : "";
			const rawInputs: unknown[] = body.imageInputs ?? [];
			const isVariation = body.variation === true;

			// ---- Validate the request shape ----------------------------------
			if (!Array.isArray(rawInputs)) {
				return sendError(reply, 400, "INVALID_REQUEST", "imageInputs must be an array");
			}
			if (prompt.length > MAX_PROMPT_LENGTH) {
				return sendError(
					reply,
					400,
					"INVALID_REQUEST",
					`Prompt must be at most ${MAX_PROMPT_LENGTH} characters`,
				);
			}
			if (body.model !== undefined && typeof body.model !== "string") {
				return sendError(reply, 400, "INVALID_REQUEST", "Unknown model");
			}
			const requestedTier = parseTier(body);
			if (requestedTier === null) {
				return sendError(reply, 400, "INVALID_REQUEST", "Unsupported size");
			}
			if (aspectRatio !== undefined && !ALLOWED_ASPECT_RATIOS.has(aspectRatio)) {
				return sendError(reply, 400, "INVALID_REQUEST", "Unsupported aspect ratio");
			}
			let outputFormat: string | undefined;
			if (body.outputFormat !== undefined) {
				outputFormat = OUTPUT_FORMATS[String(body.outputFormat).toLowerCase()];
				if (!outputFormat) {
					return sendError(reply, 400, "INVALID_REQUEST", "Unsupported output format");
				}
			}
			for (const [name, value] of [
				["width", width],
				["height", height],
			] as const) {
				if (value !== undefined && (!Number.isInteger(value) || value < 256 || value > 2048)) {
					return sendError(
						reply,
						400,
						"INVALID_REQUEST",
						`${name} must be an integer between 256 and 2048`,
					);
				}
			}
			if (seed !== undefined && (!Number.isInteger(seed) || seed < 0 || seed > MAX_SEED)) {
				return sendError(reply, 400, "INVALID_REQUEST", "Invalid seed");
			}
			if (threadId !== undefined && typeof threadId !== "string") {
				return sendError(reply, 400, "THREAD_NOT_FOUND", "Thread not found");
			}
			const requestedOutputs = Math.floor(Number(body.numOutputs ?? 1));
			let numOutputs = Number.isFinite(requestedOutputs)
				? Math.min(MAX_OUTPUTS, Math.max(1, requestedOutputs))
				: 1;

			// Dropped models are served by their replacement (old clients, saved pending prompts).
			let model: CatalogModel | undefined = getCatalogModel(
				currentModelId(body.model || DEFAULT_MODEL_ID),
			);
			if (!isVariation && (!model || model.hidden || model.kind !== "image")) {
				return sendError(reply, 400, "INVALID_REQUEST", "Unknown model");
			}

			// ---- Image inputs must be files this user owns (C1) ---------------
			const imageInputs = resolveOwnedImageInputs(userId, rawInputs);
			if (!imageInputs) {
				return sendError(
					reply,
					400,
					"INVALID_IMAGE_INPUT",
					"One or more input images were not found",
				);
			}

			// ---- Key ------------------------------------------------------------
			const { key: userApiKey, unreadable } = loadUserApiKey(userId);
			if (unreadable) {
				return sendError(reply, 400, "API_KEY_UNREADABLE", API_KEY_UNREADABLE_MESSAGE);
			}
			// Own-key generations are paid to Replicate by the user: no credits, no
			// platform cost-limit check (usage is still recorded).
			const usedOwnKey = !!userApiKey;

			// ---- Vary: the server picks the model, tier and affordable outputs ----
			let tier: Tier;
			if (isVariation) {
				if (imageInputs.length === 0) {
					return sendError(reply, 400, "INVALID_REQUEST", "Variations need an input image");
				}
				const picked = pickVariation(
					userId,
					requestedTier,
					numOutputs,
					Math.min(imageInputs.length, 1),
					usedOwnKey ? null : getAvailableCredits(userId),
				);
				if (!picked) {
					return sendError(
						reply,
						403,
						"MODEL_NOT_ALLOWED",
						"Variations are not available on your subscription tier. Please upgrade to access more models.",
						{ modelRestricted: true },
					);
				}
				model = picked.model;
				tier = picked.tier;
				numOutputs = picked.outputs;
				prompt = variationPrompt(prompt);
				imageInputs.splice(1);
			} else {
				tier = resolveTier(model as CatalogModel, requestedTier);
			}
			const m = model as CatalogModel;

			if (prompt.trim().length === 0) {
				return sendError(reply, 400, "INVALID_REQUEST", "Prompt is required");
			}
			if (imageInputs.length > m.refs.max) {
				return sendError(
					reply,
					400,
					"INVALID_IMAGE_INPUT",
					m.refs.max === 0
						? "This model does not accept image inputs"
						: `This model accepts at most ${m.refs.max} input image${m.refs.max === 1 ? "" : "s"}`,
				);
			}
			if (imageInputs.length < m.refs.min) {
				return sendError(
					reply,
					400,
					"INVALID_IMAGE_INPUT",
					"This model needs an image to work from",
				);
			}
			numOutputs = Math.min(numOutputs, m.maxOutputs);

			// ---- Tier gate ----------------------------------------------------
			if (!canUserUseModel(userId, m.id, tier)) {
				return sendError(
					reply,
					403,
					"MODEL_NOT_ALLOWED",
					"This model is not available on your subscription tier. Please upgrade to access more models.",
					{ modelRestricted: true },
				);
			}

			// What will actually run (snapped ratio, Match input resolved).
			let resolved: ReturnType<typeof resolveRequest>;
			try {
				const firstSize =
					imageInputs.length > 0 ? await imageInputDimensions(imageInputs[0]) : undefined;
				resolved = resolveRequest(
					m,
					{ tier, aspectRatio: aspectRatio ?? (isVariation ? MATCH_INPUT : undefined) },
					firstSize,
				);
			} catch (error) {
				if (error instanceof InvalidImageInputError) {
					return sendError(reply, 400, "INVALID_IMAGE_INPUT", error.message);
				}
				throw error;
			}

			const perImageCredits = getModelCreditCost(m.id, tier, imageInputs.length);
			const totalCredits = perImageCredits * numOutputs;
			const db = getDb();

			// Validate the thread before reserving anything.
			if (threadId) {
				const existingThread = db
					.prepare("SELECT id FROM threads WHERE id = ? AND user_id = ? AND deleted_at IS NULL")
					.get(threadId, userId);
				if (!existingThread) {
					return sendError(reply, 400, "THREAD_NOT_FOUND", "Thread not found");
				}
			}

			const reservation = makeReservation(userId, totalCredits);
			if (!usedOwnKey) {
				const limitCheck = canUserGenerate(userId, m.id, totalCredits);
				if (!limitCheck.allowed) {
					const code = limitCheck.code ?? "INSUFFICIENT_CREDITS";
					return sendError(
						reply,
						code === "INSUFFICIENT_CREDITS" ? 402 : 403,
						code,
						limitCheck.reason || "Generation limit reached",
						{
							limitReached: true,
							usage: limitCheck.usage,
							limits: limitCheck.limits,
							creditCost: totalCredits,
							availableCredits: limitCheck.availableCredits,
						},
					);
				}
				// Atomic check-and-deduct BEFORE the slow Replicate call (C2).
				if (!reservation.reserve(`Generation: ${m.id} ${tier} x${numOutputs}`)) {
					return sendError(
						reply,
						402,
						"INSUFFICIENT_CREDITS",
						"Not enough credits for this generation.",
						{
							limitReached: true,
							creditCost: totalCredits,
						},
					);
				}
			}

			let results: GenerationResult[];
			let filteredOutputs = 0;
			try {
				const outcome = await generateImageDetailed(prompt, m.id, {
					numOutputs,
					imageInputs,
					aspectRatio: resolved.ratio,
					tier,
					outputFormat,
					apiKey: userApiKey || undefined,
					seed,
					tracker: trackerFor(request),
				});
				results = outcome.results;
				filteredOutputs = outcome.failures.filter((f) => f === "content_filter").length;
			} catch (error) {
				reservation.refund(
					totalCredits,
					error instanceof ContentFilteredError
						? filteredRefundReason("Generation failed", numOutputs)
						: "Generation failed",
				);
				fastify.log.error(error);
				return sendRunError(reply, error);
			}

			if (results.length === 0) {
				reservation.refund(totalCredits, "Generation returned no images");
				return sendError(
					reply,
					502,
					"GENERATION_NO_OUTPUT",
					"The model returned no images. Your credits were refunded.",
				);
			}
			// Native multi-output models may return extras: keep only what was paid for.
			results = results.slice(0, numOutputs);
			const missing = numOutputs - results.length;
			// Outputs the model's safety filter blocked: refunded, and the user is told.
			const blockedCount = Math.min(filteredOutputs, missing);
			let blocked: BlockedOutputs | undefined;
			if (blockedCount > 0) {
				const before = reservation.charged;
				reservation.refund(
					blockedCount * perImageCredits,
					`Blocked by safety filter (${blockedCount} of ${numOutputs})`,
				);
				blocked = {
					count: blockedCount,
					reason: "content_filter",
					creditsReturned: before - reservation.charged,
				};
			}
			if (missing > blockedCount) {
				reservation.refund(
					(missing - blockedCount) * perImageCredits,
					"Generation returned fewer images",
				);
			}

			try {
				const creditsCharged = usedOwnKey ? 0 : reservation.charged;
				const { threadId: finalThreadId } = saveGeneration(
					{
						userId,
						model: m.id,
						// Store what the user asked for; the model saw the variation instruction.
						prompt: isVariation ? (body.prompt?.trim() || "Variation") : prompt.trim(),
						results,
						threadId,
						threadTitle: generateThreadTitle(isVariation ? "" : body.prompt),
						usedOwnKey,
						parameters: {
							numOutputs,
							imageInputs,
							aspectRatio:
								resolved.ratio === MATCH_INPUT ? (aspectRatio ?? MATCH_INPUT) : resolved.ratio,
							requestedAspectRatio: aspectRatio,
							tier,
							resolution: body.resolution,
							outputFormat,
							variation: isVariation || undefined,
							creditsCharged,
							blocked,
							...queueStats(results),
						},
					},
					fastify.log,
				);

				return {
					id: results[0].id,
					status: "succeeded",
					images: results.map((r) => ({
						id: r.id,
						url: r.imageUrl,
						path: r.imagePath,
						cost: r.cost,
						width: r.width,
						height: r.height,
					})),
					cost: results.reduce((sum, r) => sum + r.cost, 0),
					model: m.id,
					tier,
					aspectRatio: resolved.ratio,
					creditsCharged,
					...(blocked ? { blocked } : {}),
					usedOwnKey,
					threadId: finalThreadId,
				};
			} catch (error) {
				// Images exist on disk but we could not record them: refund what was charged.
				reservation.refund(totalCredits, "Failed to save generation");
				fastify.log.error(error);
				return sendError(reply, 500, "GENERATION_FAILED", "Failed to save generation");
			}
		},
	);

	/**
	 * Tools: run one tool on one image the user owns and save the result as a new
	 * generation in the same thread.
	 *
	 * POST /api/tools/:tool   tool = "upscale" | "remove-background"
	 * Body: { image: "/images/<file>" | "/uploads/<file>", threadId?: string }
	 * Thread: `threadId` if given, else the source generation's thread, else a new one.
	 * 200 -> same shape as /api/generate plus `tool`; errors use the same codes.
	 */
	fastify.post<{
		Params: { tool: string };
		Body: { image?: unknown; threadId?: unknown; clientRequestId?: unknown };
	}>(
		"/api/tools/:tool",
		{ preHandler: authMiddleware, onResponse: finishTracking },
		async (request, reply) => {
			const userId = request.user?.userId;
			if (!userId) {
				return reply.status(401).send({ error: "Unauthorized" });
			}
			const tool = request.params.tool as ToolName;
			if (!TOOL_NAMES.includes(tool)) {
				return sendError(reply, 400, "INVALID_REQUEST", "Unknown tool");
			}
			const body = request.body ?? {};
			const trackingError = beginTracking(
				request,
				reply,
				userId,
				body.clientRequestId,
				`tool:${tool}`,
			);
			if (trackingError) return trackingError;
			const threadIdInput = body.threadId;
			if (threadIdInput !== undefined && typeof threadIdInput !== "string") {
				return sendError(reply, 400, "THREAD_NOT_FOUND", "Thread not found");
			}
			const owned =
				typeof body.image === "string" ? resolveOwnedImageInputs(userId, [body.image]) : null;
			if (!owned) {
				return sendError(reply, 400, "INVALID_IMAGE_INPUT", "Image not found");
			}
			const image = owned[0];

			let model: CatalogModel;
			try {
				model = toolModelFor(tool, await imageInputDimensions(image));
			} catch (error) {
				if (error instanceof InvalidImageInputError) {
					return sendError(reply, 400, "INVALID_IMAGE_INPUT", error.message);
				}
				throw error;
			}

			const db = getDb();
			// The source generation (if the image is one of ours) gives the thread and the prompt.
			const filename = image.split("/").pop() as string;
			const source = image.startsWith("/images/")
				? (db
						.prepare(
							`SELECT prompt, thread_id FROM generations
							WHERE user_id = ? AND deleted_at IS NULL AND purged_at IS NULL
							AND (image_path = ? OR parameters LIKE ? ESCAPE '\\')
							ORDER BY created_at DESC LIMIT 1`,
						)
						.get(userId, filename, `%${escapeLike(filename)}%`) as
						| { prompt: string | null; thread_id: string | null }
						| undefined)
				: undefined;

			let threadId: string | undefined = threadIdInput ?? source?.thread_id ?? undefined;
			if (threadId) {
				const exists = db
					.prepare("SELECT id FROM threads WHERE id = ? AND user_id = ? AND deleted_at IS NULL")
					.get(threadId, userId);
				if (!exists) {
					if (threadIdInput) return sendError(reply, 400, "THREAD_NOT_FOUND", "Thread not found");
					threadId = undefined; // source thread was deleted: start a new one
				}
			}

			const { key: userApiKey, unreadable } = loadUserApiKey(userId);
			if (unreadable) {
				return sendError(reply, 400, "API_KEY_UNREADABLE", API_KEY_UNREADABLE_MESSAGE);
			}
			const usedOwnKey = !!userApiKey;
			const credits = getModelCreditCost(model.id);
			const reservation = makeReservation(userId, credits);
			if (!usedOwnKey) {
				const limitCheck = canUserGenerate(userId, model.id, credits);
				if (!limitCheck.allowed) {
					const code = limitCheck.code ?? "INSUFFICIENT_CREDITS";
					return sendError(
						reply,
						code === "INSUFFICIENT_CREDITS" ? 402 : 403,
						code,
						limitCheck.reason || "Limit reached",
						{
							limitReached: true,
							creditCost: credits,
							availableCredits: limitCheck.availableCredits,
						},
					);
				}
				if (!reservation.reserve(`Tool: ${tool} (${model.id})`)) {
					return sendError(reply, 402, "INSUFFICIENT_CREDITS", "Not enough credits.", {
						limitReached: true,
						creditCost: credits,
					});
				}
			}

			let result: GenerationResult;
			try {
				result = await runTool(tool, image, {
					apiKey: userApiKey || undefined,
					model,
					tracker: trackerFor(request),
				});
			} catch (error) {
				reservation.refund(
					credits,
					error instanceof ContentFilteredError
						? filteredRefundReason(`Tool ${tool} failed`, 1)
						: `Tool ${tool} failed`,
				);
				fastify.log.error(error);
				return sendRunError(reply, error);
			}

			try {
				const creditsCharged = usedOwnKey ? 0 : reservation.charged;
				const prompt = source?.prompt?.trim() || TOOL_TITLES[tool];
				const { threadId: finalThreadId } = saveGeneration(
					{
						userId,
						model: model.id,
						prompt,
						results: [result],
						threadId,
						threadTitle: TOOL_TITLES[tool],
						usedOwnKey,
						parameters: {
							tool,
							sourceImage: image,
							imageInputs: [image],
							numOutputs: 1,
							creditsCharged,
							...queueStats([result]),
						},
					},
					fastify.log,
				);
				return {
					id: result.id,
					status: "succeeded",
					tool,
					images: [
						{
							id: result.id,
							url: result.imageUrl,
							path: result.imagePath,
							cost: result.cost,
							width: result.width,
							height: result.height,
						},
					],
					cost: result.cost,
					model: model.id,
					creditsCharged,
					usedOwnKey,
					threadId: finalThreadId,
				};
			} catch (error) {
				reservation.refund(credits, "Failed to save tool result");
				fastify.log.error(error);
				return sendError(reply, 500, "GENERATION_FAILED", "Failed to save the result");
			}
		},
	);

	// Enhance prompt using Llama. Free to the user but costs the platform, so it
	// carries a per-user route rate limit on top of the global per-IP one.
	fastify.post<{ Body: { prompt: string; hasImages?: boolean } }>(
		"/api/enhance-prompt",
		{
			preHandler: authMiddleware,
			config: {
				rateLimit: {
					max: 10,
					timeWindow: "1 minute",
					keyGenerator: userRateLimitKey,
				},
			},
		},
		async (request, reply) => {
			const { prompt, hasImages } = request.body ?? {};
			const userId = request.user?.userId;

			if (!userId) {
				return reply.status(401).send({ error: "Unauthorized" });
			}

			if (!prompt || typeof prompt !== "string" || prompt.trim().length === 0) {
				return reply.status(400).send({ code: "INVALID_REQUEST", error: "Prompt is required" });
			}
			if (prompt.length > MAX_ENHANCE_PROMPT_LENGTH) {
				return reply.status(400).send({
					code: "INVALID_REQUEST",
					error: `Prompt must be at most ${MAX_ENHANCE_PROMPT_LENGTH} characters`,
				});
			}

			const { key: userApiKey, unreadable } = loadUserApiKey(userId);
			if (unreadable) {
				return reply
					.status(400)
					.send({ code: "API_KEY_UNREADABLE", error: API_KEY_UNREADABLE_MESSAGE });
			}
			const usedOwnKey = !!userApiKey;

			try {
				const result = await enhancePrompt(
					prompt.trim(),
					userApiKey || undefined,
					hasImages === true,
				);

				// Track enhancement cost
				recordUsage(userId, result.cost, usedOwnKey);

				return {
					enhanced: result.enhanced,
					cost: result.cost,
				};
			} catch (error) {
				fastify.log.error(error);
				const message = error instanceof Error ? error.message : "Enhancement failed";
				return reply.status(500).send({ code: "ENHANCE_FAILED", error: message });
			}
		},
	);
}
