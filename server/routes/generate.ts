import crypto from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { GenerateRequest } from "../../src/types";
import { getDb } from "../db";
import { authMiddleware, verifyToken } from "../middleware/auth";
import {
	enhancePrompt,
	GenerationCanceledError,
	GenerationTimeoutError,
	generateImage,
	InvalidImageInputError,
	isPerOutputPriced,
	MODELS,
	type GenerationResult,
} from "../services/replicate";
import { maybeSendLowCreditEmail } from "../services/email";
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

interface ExtendedGenerateRequest extends Omit<GenerateRequest, "prompt"> {
	prompt?: string;
	imageInputs?: string[];
	aspectRatio?: string;
	resolution?: string;
	outputFormat?: string;
	seed?: number;
	threadId?: string;
	/** Ask the server to pick the best variation model the user's tier allows. */
	variation?: boolean;
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
	| "GENERATION_FAILED";

const DEFAULT_MODEL = "black-forest-labs/flux-schnell";
const MAX_OUTPUTS = 4;
const MAX_PROMPT_LENGTH = 10_000;
const MAX_ENHANCE_PROMPT_LENGTH = 2_000;
// Hard ceiling on reference images regardless of model (largest model maxImages is 14).
const MAX_IMAGE_INPUTS = 14;
const MAX_SEED = 2_147_483_647;

// Union of every aspect ratio the frontend offers and the Redux/Kontext/FLUX 2 lists.
const ALLOWED_ASPECT_RATIOS = new Set([
	"match_input_image",
	"1:1",
	"16:9",
	"21:9",
	"3:2",
	"2:3",
	"4:5",
	"5:4",
	"3:4",
	"4:3",
	"9:16",
	"9:21",
]);
const ALLOWED_RESOLUTIONS = new Set(["1K", "2K", "4K", "1 MP", "2 MP", "4 MP"]);
// Normalized to the spelling Replicate models accept.
const OUTPUT_FORMATS: Record<string, string> = { png: "png", jpg: "jpg", jpeg: "jpg", webp: "webp" };

// Best first. Used when the client asks for `variation: true` (Vary buttons).
const VARIATION_MODEL_PREFERENCE = [
	"black-forest-labs/flux-redux-dev",
	"black-forest-labs/flux-redux-schnell",
	"black-forest-labs/flux-kontext-pro",
];
const KONTEXT_VARIATION_PROMPT = "Create a subtle variation of this image";

// Generate a thread title from a prompt (first ~50 chars, cleaned up)
function generateThreadTitle(prompt: string | undefined): string {
	const cleaned = (prompt ?? "").trim().replace(/\s+/g, " ");
	if (cleaned.length === 0) return "Variation";
	if (cleaned.length <= 50) return cleaned;
	// Cut at word boundary
	const truncated = cleaned.slice(0, 50);
	const lastSpace = truncated.lastIndexOf(" ");
	return lastSpace > 30 ? `${truncated.slice(0, lastSpace)}...` : `${truncated}...`;
}

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

/** Pick the best variation-capable model the user's tier allows. */
function pickVariationModel(userId: string, requested: string | undefined): string | null {
	if (requested && VARIATION_MODEL_PREFERENCE.includes(requested) && canUserUseModel(userId, requested)) {
		return requested;
	}
	return VARIATION_MODEL_PREFERENCE.find((m) => canUserUseModel(userId, m)) ?? null;
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

export async function generateRoutes(fastify: FastifyInstance): Promise<void> {
	fastify.post<{ Body: ExtendedGenerateRequest }>(
		"/api/generate",
		{ preHandler: authMiddleware },
		async (request, reply) => {
			const userId = request.user?.userId;
			if (!userId) {
				return reply.status(401).send({ error: "Unauthorized" });
			}

			const body = (request.body ?? {}) as ExtendedGenerateRequest;
			const { width, height, aspectRatio, resolution, seed, threadId } = body;
			let prompt = typeof body.prompt === "string" ? body.prompt : "";
			const rawInputs: unknown[] = body.imageInputs ?? [];

			// ---- Validate the request shape ----------------------------------
			if (!Array.isArray(rawInputs)) {
				return sendError(reply, 400, "INVALID_REQUEST", "imageInputs must be an array");
			}
			if (prompt.length > MAX_PROMPT_LENGTH) {
				return sendError(reply, 400, "INVALID_REQUEST", `Prompt must be at most ${MAX_PROMPT_LENGTH} characters`);
			}
			if (body.model !== undefined && typeof body.model !== "string") {
				return sendError(reply, 400, "INVALID_REQUEST", "Unknown model");
			}

			// Variation requests: the server picks the model the user's tier allows.
			let model = body.model || DEFAULT_MODEL;
			if (body.variation === true) {
				const picked = pickVariationModel(userId, body.model);
				if (!picked) {
					return sendError(
						reply,
						403,
						"MODEL_NOT_ALLOWED",
						"Variations are not available on your subscription tier. Please upgrade to access more models.",
						{ modelRestricted: true },
					);
				}
				model = picked;
			}

			const modelConfig = MODELS.find((m) => m.id === model);
			if (!modelConfig) {
				return sendError(reply, 400, "INVALID_REQUEST", "Unknown model");
			}
			const isVariationModel = modelConfig.isVariationModel === true;
			const hasImageInputs = rawInputs.length > 0;

			if (body.variation === true && !isVariationModel && prompt.trim().length === 0) {
				// Fallback model (Kontext) needs an instruction.
				prompt = KONTEXT_VARIATION_PROMPT;
			}

			// Variation models can work without a prompt (image-to-image)
			if (!isVariationModel && prompt.trim().length === 0) {
				return sendError(reply, 400, "INVALID_REQUEST", "Prompt is required");
			}
			// Variation models require image inputs
			if (isVariationModel && !hasImageInputs) {
				return sendError(reply, 400, "INVALID_REQUEST", "Variation models require an input image");
			}

			const maxInputs = modelConfig.supportsImageInput ? Math.min(modelConfig.maxImages ?? 1, MAX_IMAGE_INPUTS) : 0;
			if (rawInputs.length > maxInputs) {
				return sendError(
					reply,
					400,
					"INVALID_IMAGE_INPUT",
					maxInputs === 0
						? "This model does not accept image inputs"
						: `This model accepts at most ${maxInputs} input image${maxInputs === 1 ? "" : "s"}`,
				);
			}

			// numOutputs: clamp to 1..MAX_OUTPUTS; each output is charged.
			const requestedOutputs = Math.floor(Number(body.numOutputs ?? 1));
			const numOutputs = Number.isFinite(requestedOutputs)
				? Math.min(MAX_OUTPUTS, Math.max(1, requestedOutputs))
				: 1;

			if (aspectRatio !== undefined && !ALLOWED_ASPECT_RATIOS.has(aspectRatio)) {
				return sendError(reply, 400, "INVALID_REQUEST", "Unsupported aspect ratio");
			}
			if (resolution !== undefined && !ALLOWED_RESOLUTIONS.has(resolution)) {
				return sendError(reply, 400, "INVALID_REQUEST", "Unsupported resolution");
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
					return sendError(reply, 400, "INVALID_REQUEST", `${name} must be an integer between 256 and 2048`);
				}
			}
			if (seed !== undefined && (!Number.isInteger(seed) || seed < 0 || seed > MAX_SEED)) {
				return sendError(reply, 400, "INVALID_REQUEST", "Invalid seed");
			}
			if (threadId !== undefined && typeof threadId !== "string") {
				return sendError(reply, 400, "THREAD_NOT_FOUND", "Thread not found");
			}

			// ---- Image inputs must be files this user owns (C1) ---------------
			const imageInputs = resolveOwnedImageInputs(userId, rawInputs);
			if (!imageInputs) {
				return sendError(reply, 400, "INVALID_IMAGE_INPUT", "One or more input images were not found");
			}

			// ---- Tier gate ----------------------------------------------------
			if (!canUserUseModel(userId, model)) {
				return sendError(
					reply,
					403,
					"MODEL_NOT_ALLOWED",
					"This model is not available on your subscription tier. Please upgrade to access more models.",
					{ modelRestricted: true },
				);
			}

			// ---- Key + credits --------------------------------------------------
			const { key: userApiKey, unreadable } = loadUserApiKey(userId);
			if (unreadable) {
				return sendError(reply, 400, "API_KEY_UNREADABLE", API_KEY_UNREADABLE_MESSAGE);
			}
			// Own-key generations are paid to Replicate by the user: no credits, no
			// platform cost-limit check (usage is still recorded).
			const usedOwnKey = !!userApiKey;
			const perImageCredits = getModelCreditCost(model);
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

			let reservationId: string | null = null;
			let refunded = 0;
			const refund = (amount: number, reason: string) => {
				if (!reservationId) return;
				const capped = Math.min(amount, totalCredits - refunded);
				if (capped <= 0) return;
				refundReservation(userId, reservationId, capped, reason);
				refunded += capped;
			};

			if (!usedOwnKey) {
				const limitCheck = canUserGenerate(userId, model, totalCredits);
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
				reservationId = reserveCredits(userId, totalCredits, `Generation: ${model} x${numOutputs}`);
				if (!reservationId) {
					return sendError(reply, 402, "INSUFFICIENT_CREDITS", "Not enough credits for this generation.", {
						limitReached: true,
						creditCost: totalCredits,
					});
				}
			}

			let results: GenerationResult[];
			try {
				results = await generateImage(prompt, model, {
					width,
					height,
					numOutputs,
					imageInputs,
					aspectRatio,
					resolution,
					outputFormat,
					apiKey: userApiKey || undefined,
					seed,
				});
			} catch (error) {
				refund(totalCredits, "Generation failed");
				fastify.log.error(error);
				if (error instanceof InvalidImageInputError) {
					return sendError(reply, 400, "INVALID_IMAGE_INPUT", error.message);
				}
				if (error instanceof GenerationTimeoutError) {
					return sendError(reply, 504, "GENERATION_TIMEOUT", "Generation timed out. Your credits were refunded.");
				}
				if (error instanceof GenerationCanceledError) {
					return sendError(reply, 502, "GENERATION_CANCELED", "Generation was canceled. Your credits were refunded.");
				}
				const message = error instanceof Error ? error.message : "Generation failed";
				return sendError(reply, 500, "GENERATION_FAILED", message);
			}

			if (results.length === 0) {
				refund(totalCredits, "Generation returned no images");
				return sendError(
					reply,
					502,
					"GENERATION_NO_OUTPUT",
					"The model returned no images. Your credits were refunded.",
				);
			}
			if (results.length < numOutputs) {
				refund((numOutputs - results.length) * perImageCredits, "Generation returned fewer images");
			}

			try {
				const totalCost = results.reduce((sum, r) => sum + r.cost, 0);
				const storedPrompt = prompt.trim();

				// Create the thread only once there is something to put in it.
				let finalThreadId = threadId;
				if (threadId) {
					db.prepare("UPDATE threads SET updated_at = datetime('now') WHERE id = ?").run(threadId);
				} else {
					finalThreadId = crypto.randomUUID();
					db.prepare(`
						INSERT INTO threads (id, user_id, title, created_at, updated_at)
						VALUES (?, ?, ?, datetime('now'), datetime('now'))
					`).run(finalThreadId, userId, generateThreadTitle(body.prompt));
				}

				recordUsage(userId, totalCost, usedOwnKey);

				const images = results.map((result) => ({
					id: result.id,
					url: result.imageUrl,
					path: result.imagePath,
					cost: result.cost,
				}));

				// For multi-output generations, store as a single row with an images array (4-up grid)
				const isMultiOutput = results.length > 1;
				const primaryResult = results[0];
				const parameters: Record<string, unknown> = {
					numOutputs,
					imageInputs,
					aspectRatio,
					resolution,
					outputFormat,
					creditsCharged: usedOwnKey ? 0 : totalCredits - refunded,
				};
				if (isMultiOutput) {
					parameters.images = images.map((img) => ({ id: img.id, url: img.url, path: img.path }));
				}

				db.prepare(`
					INSERT INTO generations (id, prompt, model, image_path, width, height, parameters, user_id, cost, replicate_id, predict_time, thread_id)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				`).run(
					primaryResult.id,
					storedPrompt,
					model,
					primaryResult.imagePath,
					width || 1024,
					height || 1024,
					JSON.stringify(parameters),
					userId,
					totalCost,
					primaryResult.replicateId,
					primaryResult.predictTime,
					finalThreadId ?? null,
				);

				// Platform cost tracking (only when we paid Replicate). Per-output-priced
				// models are reconciled immediately: the estimate is the billed price.
				if (!usedOwnKey) {
					try {
						recordPlatformCost(
							primaryResult.id,
							primaryResult.replicateId,
							model,
							totalCost,
							isPerOutputPriced(model) ? totalCost : undefined,
							primaryResult.predictTime,
						);
					} catch (err) {
						fastify.log.error(err, "Failed to record platform cost");
					}
				}

				// Low-balance email (throttled, fire-and-forget; never affects the response).
				if (!usedOwnKey) {
					try {
						void maybeSendLowCreditEmail(userId, getAvailableCredits(userId));
					} catch {}
				}

				return {
					id: primaryResult.id,
					status: "succeeded",
					images,
					cost: totalCost,
					model,
					creditsCharged: usedOwnKey ? 0 : totalCredits - refunded,
					usedOwnKey,
					threadId: finalThreadId,
				};
			} catch (error) {
				// Images exist on disk but we could not record them: refund what was charged.
				refund(totalCredits, "Failed to save generation");
				fastify.log.error(error);
				return sendError(reply, 500, "GENERATION_FAILED", "Failed to save generation");
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
				return reply.status(400).send({ code: "API_KEY_UNREADABLE", error: API_KEY_UNREADABLE_MESSAGE });
			}
			const usedOwnKey = !!userApiKey;

			try {
				const result = await enhancePrompt(prompt.trim(), userApiKey || undefined, hasImages === true);

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
