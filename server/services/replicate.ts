import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Replicate from "replicate";
import sharp from "sharp";
import type { Model } from "../../src/types";

// Maximum file size for Replicate inputs (5MB)
const MAX_IMAGE_SIZE = 5 * 1024 * 1024;
// Maximum dimension for resized images
const MAX_DIMENSION = 2048;

// Default Replicate client uses REPLICATE_API_TOKEN from env
const defaultReplicate = new Replicate();

/**
 * Create a Replicate client with a custom API key or use default
 */
function getReplicateClient(apiKey?: string): Replicate {
	if (apiKey) {
		return new Replicate({ auth: apiKey });
	}
	return defaultReplicate;
}

export interface ExtendedModel extends Model {
	supportsImageInput: boolean;
	maxImages?: number;
	supportsNumOutputs?: boolean; // Can generate multiple images in one call
	supportsSeed?: boolean; // Supports seed parameter for reproducibility
	isVariationModel?: boolean; // Model designed for image variations (Redux)
	isEditModel?: boolean; // Model designed for image editing (Kontext)
	category?: "fast" | "quality" | "ultra" | "variation" | "edit" | "external";
}

/**
 * Model pricing configuration based on actual Replicate/BFL pricing (Jan 2025)
 * Sources:
 * - https://replicate.com/pricing
 * - https://docs.bfl.ml/quick_start/pricing
 *
 * Pricing types:
 * - "per_image": Fixed cost per image generated
 * - "per_megapixel": Cost scales with output resolution (FLUX 2 models)
 */
interface ModelPricing {
	type: "per_image" | "per_megapixel";
	baseCost: number; // Cost per image or per megapixel
	inputMpCost?: number; // Additional cost per input megapixel (for image editing)
}

const MODEL_PRICING: Record<string, ModelPricing> = {
	// FLUX.1 Series - Fixed per-image pricing
	"black-forest-labs/flux-schnell": { type: "per_image", baseCost: 0.003 },
	"black-forest-labs/flux-dev": { type: "per_image", baseCost: 0.025 },

	// FLUX 1.1 Series - Fixed per-image pricing
	"black-forest-labs/flux-1.1-pro": { type: "per_image", baseCost: 0.04 },
	"black-forest-labs/flux-1.1-pro-ultra": { type: "per_image", baseCost: 0.06 },

	// FLUX 2 Series - Megapixel-based pricing
	// FLUX.2 [pro]: $0.015 + $0.015 per input/output megapixel
	"black-forest-labs/flux-2-pro": { type: "per_megapixel", baseCost: 0.015, inputMpCost: 0.015 },
	// FLUX.2 [dev]: $0.012 per megapixel
	"black-forest-labs/flux-2-dev": { type: "per_megapixel", baseCost: 0.012, inputMpCost: 0.012 },

	// FLUX Redux - Actual costs from Replicate billing
	"black-forest-labs/flux-redux-schnell": { type: "per_image", baseCost: 0.025 },
	"black-forest-labs/flux-redux-dev": { type: "per_image", baseCost: 0.10 },

	// FLUX Kontext - Fixed per-image pricing
	"black-forest-labs/flux-kontext-pro": { type: "per_image", baseCost: 0.04 },

	// External models - Actual costs from Replicate billing
	// Nano Banana Pro: $0.15-$0.30 depending on resolution, using $0.20 as average
	"google/nano-banana-pro": { type: "per_image", baseCost: 0.20 },

	// LLM models for prompt enhancement
	"meta/meta-llama-3-70b-instruct": { type: "per_image", baseCost: 0.01 },
};

// Default fallback pricing (uses time-based estimate if model not configured)
const DEFAULT_PRICING: ModelPricing = { type: "per_image", baseCost: 0.025 };

/**
 * Convert aspect ratio and resolution to width/height dimensions
 * Used for models that don't support aspect_ratio parameter directly
 */
function aspectRatioToWidthHeight(aspectRatio: string, resolution: string): { width: number; height: number } {
	// Parse aspect ratio (e.g., "16:9", "4:3", "1:1")
	const [wRatio, hRatio] = aspectRatio.split(":").map(Number);
	if (!wRatio || !hRatio) {
		return { width: 1024, height: 1024 }; // Default fallback
	}

	// Base dimensions for each resolution
	// 1K ≈ 1MP, 2K ≈ 2MP, 4K ≈ 8MP
	let targetPixels: number;
	switch (resolution) {
		case "4K":
			targetPixels = 8_000_000; // ~8MP
			break;
		case "2K":
			targetPixels = 2_000_000; // ~2MP
			break;
		case "1K":
		default:
			targetPixels = 1_000_000; // ~1MP
			break;
	}

	// Calculate dimensions maintaining aspect ratio
	// width * height = targetPixels
	// width / height = wRatio / hRatio
	// Therefore: width = sqrt(targetPixels * wRatio / hRatio)
	const width = Math.round(Math.sqrt(targetPixels * wRatio / hRatio));
	const height = Math.round(width * hRatio / wRatio);

	// Round to nearest 8 (some models require this)
	const roundedWidth = Math.round(width / 8) * 8;
	const roundedHeight = Math.round(height / 8) * 8;

	return { width: roundedWidth, height: roundedHeight };
}

/**
 * Calculate megapixels from resolution string or dimensions
 */
function calculateMegapixels(resolution?: string, width?: number, height?: number): number {
	// Parse resolution strings like "1 MP", "2 MP", "4 MP", "1K", "2K", "4K"
	if (resolution) {
		const mpMatch = resolution.match(/(\d+)\s*MP/i);
		if (mpMatch) return Number.parseFloat(mpMatch[1]);

		const kMatch = resolution.match(/(\d+)K/i);
		if (kMatch) {
			// Approximate: 1K ≈ 1MP, 2K ≈ 2MP, 4K ≈ 8MP
			const k = Number.parseInt(kMatch[1]);
			if (k === 1) return 1;
			if (k === 2) return 2;
			if (k === 4) return 8;
		}
	}

	// Calculate from dimensions
	if (width && height) {
		return (width * height) / 1_000_000;
	}

	// Default to 1 megapixel (1024x1024)
	return 1;
}

/**
 * Calculate the cost for a generation based on model and parameters
 */
export function calculateGenerationCost(
	model: string,
	options: {
		numOutputs?: number;
		resolution?: string;
		width?: number;
		height?: number;
		hasImageInput?: boolean;
		inputImageCount?: number;
	} = {},
): number {
	const pricing = MODEL_PRICING[model] || DEFAULT_PRICING;
	const numOutputs = options.numOutputs || 1;

	if (pricing.type === "per_image") {
		return pricing.baseCost * numOutputs;
	}

	// Megapixel-based pricing (FLUX 2 models)
	const outputMp = calculateMegapixels(options.resolution, options.width, options.height);
	let cost = pricing.baseCost * outputMp * numOutputs;

	// Add input megapixel cost if applicable
	if (options.hasImageInput && pricing.inputMpCost) {
		const inputCount = options.inputImageCount || 1;
		// Assume input images are ~1MP average
		cost += pricing.inputMpCost * inputCount;
	}

	return cost;
}

export const MODELS: ExtendedModel[] = [
	// === FLUX.1 Series (Fast) ===
	{
		id: "black-forest-labs/flux-schnell",
		name: "FLUX.1 Schnell",
		description: "Fastest FLUX model, great for quick iterations (4 steps)",
		defaultParams: { num_inference_steps: 4 },
		supportsImageInput: false,
		supportsNumOutputs: true, // 1-4 outputs per call
		supportsSeed: true,
		category: "fast",
	},
	{
		id: "black-forest-labs/flux-dev",
		name: "FLUX.1 Dev",
		description: "Development model with excellent quality (28 steps)",
		defaultParams: { num_inference_steps: 28 },
		supportsImageInput: false,
		supportsNumOutputs: true, // 1-4 outputs per call
		supportsSeed: true,
		category: "quality",
	},

	// === FLUX 1.1 Series (Quality) ===
	{
		id: "black-forest-labs/flux-1.1-pro",
		name: "FLUX 1.1 Pro",
		description: "High quality FLUX model with excellent prompt adherence",
		defaultParams: {},
		supportsImageInput: false,
		supportsNumOutputs: false,
		supportsSeed: true,
		category: "quality",
	},
	{
		id: "black-forest-labs/flux-1.1-pro-ultra",
		name: "FLUX 1.1 Pro Ultra",
		description: "Up to 4MP images with raw mode for natural look",
		defaultParams: { raw: false },
		supportsImageInput: true, // Supports image_prompt for Redux-style blending
		maxImages: 1,
		supportsNumOutputs: false,
		supportsSeed: true,
		category: "ultra",
	},

	// === FLUX 2 Series (Latest) ===
	{
		id: "black-forest-labs/flux-2-pro",
		name: "FLUX 2 Pro",
		description: "Latest high-quality model with up to 8 reference images, 4MP output",
		defaultParams: { resolution: "2 MP" },
		supportsImageInput: true,
		maxImages: 8,
		supportsNumOutputs: false,
		supportsSeed: true,
		category: "quality",
	},
	{
		id: "black-forest-labs/flux-2-dev",
		name: "FLUX 2 Dev",
		description: "Fast FLUX 2 with up to 5 reference images",
		defaultParams: { go_fast: true },
		supportsImageInput: true,
		maxImages: 5,
		supportsNumOutputs: false,
		supportsSeed: true,
		category: "fast",
	},

	// === FLUX Redux (Variations) ===
	{
		id: "black-forest-labs/flux-redux-schnell",
		name: "FLUX Redux Schnell",
		description: "Fast image variations - generates similar images from a reference",
		defaultParams: { num_inference_steps: 4 },
		supportsImageInput: true, // Required: redux_image
		maxImages: 1,
		supportsNumOutputs: true, // 1-4 outputs per call
		supportsSeed: true,
		isVariationModel: true,
		category: "variation",
	},
	{
		id: "black-forest-labs/flux-redux-dev",
		name: "FLUX Redux Dev",
		description: "High-quality image variations with more control",
		defaultParams: { num_inference_steps: 28, guidance: 3 },
		supportsImageInput: true, // Required: redux_image
		maxImages: 1,
		supportsNumOutputs: true, // 1-4 outputs per call
		supportsSeed: true,
		isVariationModel: true,
		category: "variation",
	},

	// === FLUX Kontext (Editing) ===
	{
		id: "black-forest-labs/flux-kontext-pro",
		name: "FLUX Kontext Pro",
		description: "Text-based image editing - describe changes in natural language",
		defaultParams: {},
		supportsImageInput: true, // input_image for editing
		maxImages: 1,
		supportsNumOutputs: false,
		supportsSeed: true,
		isEditModel: true,
		category: "edit",
	},

	// === External Models ===
	{
		id: "google/nano-banana-pro",
		name: "Nano Banana Pro",
		description: "Google's image gen/edit with text, real-time info, up to 14 input images",
		defaultParams: {
			resolution: "2K",
			aspect_ratio: "4:3",
			output_format: "png",
			safety_filter_level: "block_only_high",
		},
		supportsImageInput: true,
		maxImages: 14,
		supportsNumOutputs: false,
		supportsSeed: false,
		category: "external",
	},
];

export interface GenerationResult {
	id: string;
	replicateId: string;
	imagePath: string;
	imageUrl: string;
	cost: number;
	predictTime: number;
}

export interface GenerateOptions {
	width?: number;
	height?: number;
	numOutputs?: number;
	imageInputs?: string[]; // Local file paths for image inputs
	aspectRatio?: string;
	resolution?: string;
	outputFormat?: string;
	apiKey?: string; // Optional BYO API key
	seed?: number; // Random seed for reproducibility/variation
}

// Convert local file to base64 data URI, resizing if needed
async function fileToDataUri(filePath: string): Promise<string> {
	let buffer = fs.readFileSync(filePath);
	const originalSize = buffer.length;

	// Check if resize is needed
	if (buffer.length > MAX_IMAGE_SIZE) {
		console.log(`Resizing image: ${filePath} (${(originalSize / 1024 / 1024).toFixed(2)}MB)`);

		// Get image metadata
		const metadata = await sharp(buffer).metadata();
		const { width = 0, height = 0 } = metadata;

		// Calculate new dimensions
		let newWidth = width;
		let newHeight = height;
		if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
			const ratio = Math.min(MAX_DIMENSION / width, MAX_DIMENSION / height);
			newWidth = Math.round(width * ratio);
			newHeight = Math.round(height * ratio);
		}

		// Resize and compress
		let quality = 85;
		while (quality >= 50) {
			buffer = await sharp(buffer)
				.resize(newWidth, newHeight, { fit: "inside", withoutEnlargement: true })
				.jpeg({ quality })
				.toBuffer();

			if (buffer.length <= MAX_IMAGE_SIZE) break;
			quality -= 10;
		}

		console.log(
			`Resized: ${newWidth}x${newHeight}, ${(buffer.length / 1024 / 1024).toFixed(2)}MB (was ${(originalSize / 1024 / 1024).toFixed(2)}MB)`,
		);
	}

	// Determine mime type from original or use jpeg if resized
	const ext = path.extname(filePath).toLowerCase();
	const mimeTypes: Record<string, string> = {
		".png": "image/png",
		".jpg": "image/jpeg",
		".jpeg": "image/jpeg",
		".gif": "image/gif",
		".webp": "image/webp",
	};
	const mimeType = buffer.length !== originalSize ? "image/jpeg" : (mimeTypes[ext] || "image/png");
	return `data:${mimeType};base64,${buffer.toString("base64")}`;
}

// Helper to convert image input paths to data URIs (with resize if needed)
async function convertImageInputsToDataUris(imageInputs: string[]): Promise<string[]> {
	const results: string[] = [];

	for (const inputPath of imageInputs) {
		let fullPath: string;

		// Handle /uploads/xxx.png paths
		if (inputPath.includes("/uploads/")) {
			const filename = inputPath.split("/uploads/").pop();
			if (!filename) continue;
			fullPath = path.join(process.cwd(), "uploads", filename);
		}
		// Handle /images/xxx.png paths (generated images)
		else if (inputPath.includes("/images/")) {
			const filename = inputPath.split("/images/").pop();
			if (!filename) continue;
			fullPath = path.join(process.cwd(), "generated-images", filename);
		} else {
			console.log("Unknown image path format:", inputPath);
			continue;
		}

		if (!fs.existsSync(fullPath)) {
			console.log("File not found:", fullPath);
			continue;
		}

		try {
			const dataUri = await fileToDataUri(fullPath);
			results.push(dataUri);
		} catch (err) {
			console.error("Error processing image:", fullPath, err);
		}
	}

	return results;
}

// Build input object for a specific model
async function buildModelInput(
	model: string,
	prompt: string,
	options: GenerateOptions,
	seed?: number,
): Promise<Record<string, unknown>> {
	const { width = 1024, height = 1024, numOutputs = 1, imageInputs = [] } = options;
	const modelInfo = MODELS.find((m) => m.id === model);
	const imageDataUris = imageInputs.length > 0 ? await convertImageInputsToDataUris(imageInputs) : [];

	// === Google Nano Banana Pro ===
	if (model === "google/nano-banana-pro") {
		return {
			prompt,
			image_input: imageDataUris,
			resolution: options.resolution || "2K",
			aspect_ratio: options.aspectRatio || "4:3",
			output_format: options.outputFormat || "png",
			safety_filter_level: "block_only_high",
		};
	}

	// === FLUX Redux Models (Variation) ===
	if (model.includes("flux-redux")) {
		if (imageDataUris.length === 0) {
			throw new Error("FLUX Redux requires an input image (redux_image)");
		}
		// Redux only supports specific aspect ratios, not "match_input_image"
		const validReduxAspectRatios = ["1:1", "16:9", "21:9", "3:2", "2:3", "4:5", "5:4", "3:4", "4:3", "9:16", "9:21"];
		const reduxAspectRatio = validReduxAspectRatios.includes(options.aspectRatio || "")
			? options.aspectRatio
			: "1:1";
		const input: Record<string, unknown> = {
			redux_image: imageDataUris[0], // Single image required
			aspect_ratio: reduxAspectRatio,
			output_format: options.outputFormat || "webp",
			megapixels: "1",
		};
		if (modelInfo?.supportsNumOutputs) {
			input.num_outputs = numOutputs;
		}
		if (model.includes("schnell")) {
			input.num_inference_steps = 4;
		} else {
			input.num_inference_steps = 28;
			input.guidance = 3;
		}
		if (seed !== undefined) {
			input.seed = seed;
		}
		return input;
	}

	// === FLUX Kontext Models (Editing) ===
	if (model.includes("flux-kontext")) {
		const input: Record<string, unknown> = {
			prompt,
			output_format: options.outputFormat || "png",
		};
		if (imageDataUris.length > 0) {
			input.input_image = imageDataUris[0];
			input.aspect_ratio = options.aspectRatio || "match_input_image";
		} else {
			input.aspect_ratio = options.aspectRatio || "1:1";
		}
		if (seed !== undefined) {
			input.seed = seed;
		}
		return input;
	}

	// === FLUX 2 Series ===
	if (model.includes("flux-2")) {
		// Map resolution from K format to MP format for flux-2
		const resolutionMap: Record<string, string> = {
			"1K": "1 MP",
			"2K": "2 MP",
			"4K": "4 MP",
		};
		const input: Record<string, unknown> = {
			prompt,
			aspect_ratio: options.aspectRatio || "1:1",
			output_format: options.outputFormat || "webp",
		};
		if (imageDataUris.length > 0) {
			input.input_images = imageDataUris; // Array of images
		}
		if (model.includes("flux-2-pro")) {
			input.resolution = resolutionMap[options.resolution || ""] || options.resolution || "2 MP";
		}
		if (model.includes("flux-2-dev")) {
			input.go_fast = true;
		}
		if (seed !== undefined) {
			input.seed = seed;
		}
		return input;
	}

	// === FLUX 1.1 Pro Ultra ===
	if (model === "black-forest-labs/flux-1.1-pro-ultra") {
		const input: Record<string, unknown> = {
			prompt,
			aspect_ratio: options.aspectRatio || "1:1",
			output_format: options.outputFormat || "jpg",
			raw: false, // Set to true for more natural look
		};
		if (imageDataUris.length > 0) {
			input.image_prompt = imageDataUris[0]; // For Redux-style blending
			input.image_prompt_strength = 0.1;
		}
		if (seed !== undefined) {
			input.seed = seed;
		}
		return input;
	}

	// === FLUX 1.1 Pro ===
	if (model === "black-forest-labs/flux-1.1-pro") {
		const input: Record<string, unknown> = {
			prompt,
			aspect_ratio: options.aspectRatio || "1:1",
			output_format: options.outputFormat || "webp",
		};
		if (seed !== undefined) {
			input.seed = seed;
		}
		return input;
	}

	// === FLUX 1.x Schnell/Dev (original models) ===
	const input: Record<string, unknown> = {
		prompt,
	};

	// These models support width/height instead of aspect_ratio
	if (model.includes("flux-schnell") || model === "black-forest-labs/flux-dev") {
		// Convert aspect ratio and resolution to width/height
		if (options.aspectRatio && options.aspectRatio !== "match_input_image") {
			const dims = aspectRatioToWidthHeight(options.aspectRatio, options.resolution || "1K");
			input.width = dims.width;
			input.height = dims.height;
		} else {
			input.width = width || 1024;
			input.height = height || 1024;
		}
	} else {
		input.aspect_ratio = options.aspectRatio || "1:1";
	}

	// Only add num_outputs for models that support it
	if (modelInfo?.supportsNumOutputs) {
		input.num_outputs = numOutputs;
	}

	// Add seed for models that support it
	if (modelInfo?.supportsSeed && seed !== undefined) {
		input.seed = seed;
	}

	return input;
}

// Run a single prediction and return results
async function runSinglePrediction(
	replicate: Replicate,
	model: string,
	input: Record<string, unknown>,
): Promise<{ output: unknown; predictTime: number; replicateId: string }> {
	const prediction = await replicate.predictions.create({
		model: model as `${string}/${string}`,
		input,
	});

	// Poll for completion
	let finalPrediction = prediction;
	while (finalPrediction.status !== "succeeded" && finalPrediction.status !== "failed") {
		await new Promise((resolve) => setTimeout(resolve, 1000));
		finalPrediction = await replicate.predictions.get(prediction.id);
	}

	if (finalPrediction.status === "failed") {
		throw new Error(finalPrediction.error || "Generation failed");
	}

	return {
		output: finalPrediction.output,
		predictTime: finalPrediction.metrics?.predict_time || 0,
		replicateId: prediction.id,
	};
}

// Download image and save locally
async function downloadAndSaveImage(
	imageUrl: string,
	replicateId: string,
	cost: number,
	predictTime: number,
): Promise<GenerationResult | null> {
	if (!imageUrl || !imageUrl.startsWith("http")) {
		console.log("Skipping invalid URL:", imageUrl);
		return null;
	}

	const id = crypto.randomUUID();
	const ext = imageUrl.includes(".png") ? "png" : "webp";
	const filename = `${id}.${ext}`;
	const filePath = path.join(process.cwd(), "generated-images", filename);

	const response = await fetch(imageUrl);
	const buffer = Buffer.from(await response.arrayBuffer());
	fs.writeFileSync(filePath, buffer);

	return {
		id,
		replicateId,
		imagePath: filename,
		imageUrl: `/images/${filename}`,
		cost,
		predictTime,
	};
}

export async function generateImage(
	prompt: string,
	model = "black-forest-labs/flux-schnell",
	options: GenerateOptions = {},
): Promise<GenerationResult[]> {
	const { numOutputs = 1, apiKey } = options;
	const replicate = getReplicateClient(apiKey);
	const modelInfo = MODELS.find((m) => m.id === model);

	// Check if model supports num_outputs natively
	const supportsNumOutputs = modelInfo?.supportsNumOutputs ?? false;
	const supportsSeed = modelInfo?.supportsSeed ?? false;

	// For models that support num_outputs, make a single call
	if (supportsNumOutputs || numOutputs === 1) {
		const input = await buildModelInput(model, prompt, options, options.seed);
		const { output, predictTime, replicateId } = await runSinglePrediction(replicate, model, input);

		console.log("Replicate output:", output);

		const outputArray = Array.isArray(output) ? output : [output];
		// Calculate cost per image using actual model pricing
		const costPerImage = calculateGenerationCost(model, {
			numOutputs: 1,
			resolution: options.resolution,
			width: options.width,
			height: options.height,
			hasImageInput: (options.imageInputs?.length || 0) > 0,
			inputImageCount: options.imageInputs?.length,
		});
		const results: GenerationResult[] = [];

		for (const item of outputArray) {
			const result = await downloadAndSaveImage(String(item), replicateId, costPerImage, predictTime);
			if (result) results.push(result);
		}

		return results;
	}

	// For models that don't support num_outputs, make parallel API calls
	console.log(`Model ${model} doesn't support num_outputs, making ${numOutputs} parallel calls`);

	// Pre-calculate cost per image for this model
	const costPerImage = calculateGenerationCost(model, {
		numOutputs: 1,
		resolution: options.resolution,
		width: options.width,
		height: options.height,
		hasImageInput: (options.imageInputs?.length || 0) > 0,
		inputImageCount: options.imageInputs?.length,
	});

	const predictions = await Promise.all(
		Array.from({ length: numOutputs }, async (_, i) => {
			// Generate different seeds for each call if model supports seeds
			const seed = supportsSeed ? (options.seed ?? Math.floor(Math.random() * 2147483647)) + i : undefined;
			const input = await buildModelInput(model, prompt, { ...options, numOutputs: 1 }, seed);
			return runSinglePrediction(replicate, model, input);
		}),
	);

	const results: GenerationResult[] = [];

	for (const { output, predictTime, replicateId } of predictions) {
		console.log("Replicate output:", output);

		const outputArray = Array.isArray(output) ? output : [output];
		for (const item of outputArray) {
			const result = await downloadAndSaveImage(String(item), replicateId, costPerImage, predictTime);
			if (result) results.push(result);
		}
	}

	return results;
}

export function getModels(): ExtendedModel[] {
	return MODELS;
}

export interface EnhancePromptResult {
	enhanced: string;
	cost: number;
}

// Cost for Llama prompt enhancement (~$0.005 per call based on typical 2-4 sec runtime)
const PROMPT_ENHANCEMENT_COST = 0.005;

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

	console.log("Enhancing prompt:", prompt, "hasImages:", hasImages);

	const systemPrompt = hasImages
		? `You are an expert image prompt engineer. Your job is to take a basic image description and transform it into a rich, detailed prompt for AI image generation.

IMPORTANT: The user has reference images attached. Do NOT invent or specify physical characteristics of people, animals, or objects that the user refers to (e.g., "the girl", "the dog", "the car"). These subjects already exist in the reference images. Instead:
- Keep subject references generic (e.g., keep "the girl" as "the girl", not "a blonde girl with blue eyes")
- Focus on: lighting, atmosphere, artistic style, composition, camera angle, color palette, mood, setting/environment, and actions
- Add environmental and stylistic details, not subject-specific physical traits

Output ONLY the enhanced prompt - no explanations, no quotes, no prefixes. Keep it under 150 words.`
		: `You are an expert image prompt engineer. Your job is to take a basic image description and transform it into a rich, detailed prompt for AI image generation. Add specific visual details, lighting, color palette, artistic style, composition, and atmosphere. Output ONLY the enhanced prompt - no explanations, no quotes, no prefixes. Keep it under 150 words.`;

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
	console.log("Llama streamed result:", result);
	return {
		enhanced: result.trim(),
		cost: PROMPT_ENHANCEMENT_COST,
	};
}
