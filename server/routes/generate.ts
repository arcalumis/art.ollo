import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { GenerateRequest } from "../../src/types";
import { getDb } from "../db";
import { authMiddleware } from "../middleware/auth";
import { enhancePrompt, generateImage, MODELS } from "../services/replicate";
import { canUserGenerate, canUserUseModel, deductCredit, recordUsage } from "../services/usage";
import { getUserApiKey } from "./user";

interface ExtendedGenerateRequest extends GenerateRequest {
	imageInputs?: string[];
	aspectRatio?: string;
	resolution?: string;
	outputFormat?: string;
	seed?: number;
	threadId?: string;
}

// Generate a thread title from a prompt (first ~50 chars, cleaned up)
function generateThreadTitle(prompt: string): string {
	const cleaned = prompt.trim().replace(/\s+/g, " ");
	if (cleaned.length <= 50) return cleaned;
	// Cut at word boundary
	const truncated = cleaned.slice(0, 50);
	const lastSpace = truncated.lastIndexOf(" ");
	return lastSpace > 30 ? `${truncated.slice(0, lastSpace)}...` : `${truncated}...`;
}

export async function generateRoutes(fastify: FastifyInstance): Promise<void> {
	fastify.post<{ Body: ExtendedGenerateRequest }>(
		"/api/generate",
		{ preHandler: authMiddleware },
		async (request, reply) => {
			const {
				prompt,
				model,
				width,
				height,
				numOutputs,
				imageInputs,
				aspectRatio,
				resolution,
				outputFormat,
				seed,
				threadId,
			} = request.body;

			const userId = request.user?.userId;
			if (!userId) {
				return reply.status(401).send({ error: "Unauthorized" });
			}

			// Check if this is a variation model (doesn't require prompt)
			const modelConfig = MODELS.find((m) => m.id === model);
			const isVariationModel = modelConfig?.isVariationModel === true;
			const hasImageInputs = imageInputs && imageInputs.length > 0;

			// Variation models can work without a prompt (image-to-image)
			if (!isVariationModel && (!prompt || typeof prompt !== "string" || prompt.trim().length === 0)) {
				return reply.status(400).send({ error: "Prompt is required" });
			}

			// Variation models require image inputs
			if (isVariationModel && !hasImageInputs) {
				return reply.status(400).send({ error: "Variation models require an input image" });
			}

			// Check if user's subscription tier allows this model
			if (!canUserUseModel(userId, model)) {
				return reply.status(403).send({
					error: "This model is not available on your subscription tier. Please upgrade to access more models.",
					modelRestricted: true,
				});
			}

			// Check if user can generate based on subscription limits
			const limitCheck = canUserGenerate(userId);
			if (!limitCheck.allowed) {
				return reply.status(403).send({
					error: limitCheck.reason || "Generation limit reached",
					limitReached: true,
					usage: limitCheck.usage,
					limits: limitCheck.limits,
				});
			}

			// Check if user needs to use credits (over limit but has credits)
			const needsCredit =
				limitCheck.subscription?.monthly_image_limit !== null &&
				limitCheck.usage &&
				limitCheck.usage.imageCount >= (limitCheck.subscription?.monthly_image_limit || 0);

			// Get user's API key if they have one
			const userApiKey = getUserApiKey(userId);
			const usedOwnKey = !!userApiKey;

			const db = getDb();

			// Handle thread assignment
			let finalThreadId = threadId;

			if (threadId) {
				// Verify the thread belongs to this user
				const existingThread = db
					.prepare("SELECT id FROM threads WHERE id = ? AND user_id = ? AND deleted_at IS NULL")
					.get(threadId, userId);

				if (!existingThread) {
					return reply.status(400).send({ error: "Thread not found" });
				}

				// Update thread's updated_at timestamp
				db.prepare("UPDATE threads SET updated_at = datetime('now') WHERE id = ?").run(threadId);
			} else {
				// Create a new thread with auto-generated title
				const newThreadId = crypto.randomUUID();
				const threadTitle = generateThreadTitle(prompt);

				db.prepare(`
					INSERT INTO threads (id, user_id, title, created_at, updated_at)
					VALUES (?, ?, ?, datetime('now'), datetime('now'))
				`).run(newThreadId, userId, threadTitle);

				finalThreadId = newThreadId;
			}

			try {
				const results = await generateImage(prompt, model, {
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

				const totalCost = results.reduce((sum, r) => sum + r.cost, 0);

				// Record usage
				recordUsage(userId, totalCost, usedOwnKey);

				// Deduct credit if needed
				if (needsCredit) {
					deductCredit(userId, "Used bonus credit for generation");
				}

				const insertStmt = db.prepare(`
					INSERT INTO generations (id, prompt, model, image_path, width, height, parameters, user_id, cost, replicate_id, predict_time, thread_id)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				`);

				const images = results.map((result) => ({
					id: result.id,
					url: result.imageUrl,
					path: result.imagePath,
					cost: result.cost,
				}));

				// For multi-output variations, store as single generation with images array
				const isMultiOutput = results.length > 1;
				const primaryResult = results[0];

				if (isMultiOutput) {
					// Store all images in parameters for 4-up grid display
					insertStmt.run(
						primaryResult.id,
						prompt.trim(),
						model || "black-forest-labs/flux-schnell",
						primaryResult.imagePath,
						width || 1024,
						height || 1024,
						JSON.stringify({
							numOutputs,
							imageInputs,
							aspectRatio,
							resolution,
							outputFormat,
							images: images.map((img) => ({ id: img.id, url: img.url, path: img.path })),
						}),
						userId,
						totalCost,
						primaryResult.replicateId,
						primaryResult.predictTime,
						finalThreadId,
					);
				} else {
					// Single image - store normally
					insertStmt.run(
						primaryResult.id,
						prompt.trim(),
						model || "black-forest-labs/flux-schnell",
						primaryResult.imagePath,
						width || 1024,
						height || 1024,
						JSON.stringify({ numOutputs, imageInputs, aspectRatio, resolution, outputFormat }),
						userId,
						primaryResult.cost,
						primaryResult.replicateId,
						primaryResult.predictTime,
						finalThreadId,
					);
				}

				return {
					id: primaryResult.id,
					status: "succeeded",
					images,
					cost: totalCost,
					usedOwnKey,
					threadId: finalThreadId,
				};
			} catch (error) {
				fastify.log.error(error);
				const message = error instanceof Error ? error.message : "Generation failed";
				return reply.status(500).send({
					status: "failed",
					error: message,
				});
			}
		},
	);

	// Enhance prompt using Llama
	fastify.post<{ Body: { prompt: string; hasImages?: boolean } }>(
		"/api/enhance-prompt",
		{ preHandler: authMiddleware },
		async (request, reply) => {
			const { prompt, hasImages } = request.body;
			const userId = request.user?.userId;

			if (!userId) {
				return reply.status(401).send({ error: "Unauthorized" });
			}

			if (!prompt || typeof prompt !== "string" || prompt.trim().length === 0) {
				return reply.status(400).send({ error: "Prompt is required" });
			}

			// Get user's API key if they have one
			const userApiKey = getUserApiKey(userId);
			const usedOwnKey = !!userApiKey;

			try {
				const result = await enhancePrompt(prompt.trim(), userApiKey || undefined, hasImages);

				// Track enhancement cost
				recordUsage(userId, result.cost, usedOwnKey);

				return {
					enhanced: result.enhanced,
					cost: result.cost,
				};
			} catch (error) {
				fastify.log.error(error);
				const message = error instanceof Error ? error.message : "Enhancement failed";
				return reply.status(500).send({ error: message });
			}
		},
	);
}
