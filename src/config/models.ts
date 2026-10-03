/**
 * Centralized model configuration
 * All model information is stored here for consistency across components
 */

export interface ModelConfig {
	id: string;
	name: string;
	shortName: string;
	description: string;
	detailedDescription: string;
	category: "fast" | "quality" | "ultra" | "variation" | "edit" | "external";
	capabilities: {
		supportsImageInput: boolean;
		maxImages: number;
		supportsNumOutputs: boolean;
		supportsSeed: boolean;
		requiresImageInput: boolean;
	};
	pricing: {
		type: "per_image" | "per_megapixel";
		baseCost: number;
		displayCost: string;
		/**
		 * Fallback only. The server is the source of truth for credit costs (admin
		 * overrides apply): use `creditCost` from /api/models or
		 * /api/models/credit-costs, and `fallbackCreditCost()` while those load.
		 */
		creditCost: number;
	};
	bestFor: string[];
	similarTo?: string[];
	differentiators?: string;
}

export const MODEL_CATEGORIES = {
	fast: {
		label: "Fast",
		description: "Quick iterations, lower cost, great for exploring ideas",
		color: "#22c55e", // green
	},
	quality: {
		label: "Quality",
		description: "High-quality outputs with excellent prompt adherence",
		color: "#3b82f6", // blue
	},
	ultra: {
		label: "Ultra",
		description: "Maximum resolution and quality for final renders",
		color: "#a855f7", // purple
	},
	variation: {
		label: "Variation",
		description: "Create variations of existing images",
		color: "#f59e0b", // amber
	},
	edit: {
		label: "Edit",
		description: "Edit images using natural language descriptions",
		color: "#ec4899", // pink
	},
	external: {
		label: "External",
		description: "Third-party models with unique capabilities",
		color: "#06b6d4", // cyan
	},
} as const;

export const MODELS_CONFIG: ModelConfig[] = [
	// === FAST MODELS ===
	{
		id: "black-forest-labs/flux-schnell",
		name: "FLUX.1 Schnell",
		shortName: "Schnell",
		description: "Fastest FLUX model, great for quick iterations",
		detailedDescription:
			"FLUX.1 Schnell is optimized for speed, completing generations in just 4 inference steps. Perfect for rapid prototyping and exploring different prompt variations before committing to a higher-quality render.",
		category: "fast",
		capabilities: {
			supportsImageInput: false,
			maxImages: 0,
			supportsNumOutputs: true,
			supportsSeed: true,
			requiresImageInput: false,
		},
		pricing: {
			type: "per_image",
			baseCost: 0.003,
			displayCost: "$0.003",
			creditCost: 1,
		},
		bestFor: ["Quick sketches", "Prompt exploration", "Rapid iterations"],
		similarTo: ["FLUX 2 Dev"],
		differentiators: "Cheapest and fastest option. Use this for initial ideas before refining with quality models.",
	},
	{
		id: "black-forest-labs/flux-2-dev",
		name: "FLUX 2 Dev",
		shortName: "FLUX 2 Dev",
		description: "Fast FLUX 2 with up to 5 reference images",
		detailedDescription:
			"FLUX 2 Dev combines speed with the ability to use reference images. It supports up to 5 input images to guide the generation, making it ideal for style transfer and reference-based creation.",
		category: "fast",
		capabilities: {
			supportsImageInput: true,
			maxImages: 5,
			supportsNumOutputs: false,
			supportsSeed: true,
			requiresImageInput: false,
		},
		pricing: {
			type: "per_megapixel",
			baseCost: 0.012,
			displayCost: "~$0.024/2MP",
			creditCost: 2,
		},
		bestFor: ["Reference-guided generation", "Style matching", "Quick iterations with images"],
		similarTo: ["FLUX.1 Schnell"],
		differentiators: "Unlike Schnell, supports reference images. Faster than FLUX 2 Pro but slightly lower quality.",
	},

	// === QUALITY MODELS ===
	{
		id: "black-forest-labs/flux-dev",
		name: "FLUX.1 Dev",
		shortName: "FLUX Dev",
		description: "Development model with excellent quality",
		detailedDescription:
			"FLUX.1 Dev uses 28 inference steps for significantly higher quality than Schnell. It offers a great balance between generation time and output quality, making it suitable for most production work.",
		category: "quality",
		capabilities: {
			supportsImageInput: false,
			maxImages: 0,
			supportsNumOutputs: true,
			supportsSeed: true,
			requiresImageInput: false,
		},
		pricing: {
			type: "per_image",
			baseCost: 0.025,
			displayCost: "$0.025",
			creditCost: 2,
		},
		bestFor: ["Production-quality images", "Detailed artwork", "Multi-output generation"],
		similarTo: ["FLUX 1.1 Pro"],
		differentiators: "Supports generating 1-4 images per call. Good quality at moderate cost.",
	},
	{
		id: "black-forest-labs/flux-1.1-pro",
		name: "FLUX 1.1 Pro",
		shortName: "1.1 Pro",
		description: "High quality with excellent prompt adherence",
		detailedDescription:
			"FLUX 1.1 Pro is the professional-grade model with superior prompt understanding. It excels at following complex instructions and producing consistent, high-quality results.",
		category: "quality",
		capabilities: {
			supportsImageInput: false,
			maxImages: 0,
			supportsNumOutputs: false,
			supportsSeed: true,
			requiresImageInput: false,
		},
		pricing: {
			type: "per_image",
			baseCost: 0.04,
			displayCost: "$0.04",
			creditCost: 3,
		},
		bestFor: ["Complex prompts", "Professional work", "Consistent quality"],
		similarTo: ["FLUX.1 Dev", "FLUX 2 Pro"],
		differentiators: "Better prompt adherence than Dev. Single output only, but higher consistency.",
	},
	{
		id: "black-forest-labs/flux-2-pro",
		name: "FLUX 2 Pro",
		shortName: "FLUX 2 Pro",
		description: "Latest high-quality model with up to 8 reference images",
		detailedDescription:
			"FLUX 2 Pro is the flagship quality model supporting up to 8 reference images and 4MP output resolution. It combines the best prompt adherence with powerful reference-based generation.",
		category: "quality",
		capabilities: {
			supportsImageInput: true,
			maxImages: 8,
			supportsNumOutputs: false,
			supportsSeed: true,
			requiresImageInput: false,
		},
		pricing: {
			type: "per_megapixel",
			baseCost: 0.015,
			displayCost: "~$0.03/2MP",
			creditCost: 3,
		},
		bestFor: ["Reference-guided quality work", "Multi-reference composition", "High-resolution output"],
		similarTo: ["FLUX 1.1 Pro"],
		differentiators: "Supports 8 reference images vs 0 for 1.1 Pro. Megapixel pricing scales with resolution.",
	},

	// === ULTRA MODELS ===
	{
		id: "black-forest-labs/flux-1.1-pro-ultra",
		name: "FLUX 1.1 Pro Ultra",
		shortName: "1.1 Ultra",
		description: "Up to 4MP images with raw mode for natural look",
		detailedDescription:
			"FLUX 1.1 Pro Ultra produces the highest resolution images at up to 4 megapixels. The 'raw' mode option creates more natural, less processed-looking results ideal for photorealistic work.",
		category: "ultra",
		capabilities: {
			supportsImageInput: true,
			maxImages: 1,
			supportsNumOutputs: false,
			supportsSeed: true,
			requiresImageInput: false,
		},
		pricing: {
			type: "per_image",
			baseCost: 0.06,
			displayCost: "$0.06",
			creditCost: 4,
		},
		bestFor: ["Maximum resolution", "Print-ready images", "Photorealistic renders"],
		similarTo: ["FLUX 2 Pro"],
		differentiators: "Highest resolution available. Raw mode for natural aesthetics. Single reference image for style blending.",
	},

	// === VARIATION MODELS ===
	{
		id: "black-forest-labs/flux-redux-schnell",
		name: "FLUX Redux Schnell",
		shortName: "Redux Fast",
		description: "Fast image variations from a reference",
		detailedDescription:
			"FLUX Redux Schnell creates quick variations of your images. Upload a reference image and it will generate similar images with different compositions or details while maintaining the core visual identity.",
		category: "variation",
		capabilities: {
			supportsImageInput: true,
			maxImages: 1,
			supportsNumOutputs: true,
			supportsSeed: true,
			requiresImageInput: true,
		},
		pricing: {
			type: "per_image",
			baseCost: 0.025,
			displayCost: "$0.025",
			creditCost: 2,
		},
		bestFor: ["Quick variations", "Exploring alternatives", "Iterating on concepts"],
		similarTo: ["FLUX Redux Dev"],
		differentiators: "Faster and cheaper than Redux Dev. Great for exploring variations before refining.",
	},
	{
		id: "black-forest-labs/flux-redux-dev",
		name: "FLUX Redux Dev",
		shortName: "Redux Quality",
		description: "High-quality image variations with more control",
		detailedDescription:
			"FLUX Redux Dev produces higher-quality variations with more faithful reproduction of the original image's style and content. Use the guidance parameter to control how closely variations match the source.",
		category: "variation",
		capabilities: {
			supportsImageInput: true,
			maxImages: 1,
			supportsNumOutputs: true,
			supportsSeed: true,
			requiresImageInput: true,
		},
		pricing: {
			type: "per_image",
			baseCost: 0.1,
			displayCost: "$0.10",
			creditCost: 5,
		},
		bestFor: ["High-quality variations", "Controlled iteration", "Final variation renders"],
		similarTo: ["FLUX Redux Schnell"],
		differentiators: "Higher quality output with adjustable guidance. 4x more expensive but significantly better results.",
	},

	// === EDIT MODELS ===
	{
		id: "black-forest-labs/flux-kontext-pro",
		name: "FLUX Kontext Pro",
		shortName: "Kontext",
		description: "Edit images using natural language",
		detailedDescription:
			"FLUX Kontext Pro lets you edit images by describing changes in plain English. Upload an image and describe what you want to change - add objects, remove elements, change colors, or transform the scene.",
		category: "edit",
		capabilities: {
			supportsImageInput: true,
			maxImages: 1,
			supportsNumOutputs: false,
			supportsSeed: true,
			requiresImageInput: true,
		},
		pricing: {
			type: "per_image",
			baseCost: 0.04,
			displayCost: "$0.04",
			creditCost: 3,
		},
		bestFor: ["Image editing", "Adding/removing elements", "Style changes", "Scene modifications"],
		differentiators: "Only model that edits existing images based on text instructions. Describe what to change, not what to create.",
	},

	// === EXTERNAL MODELS ===
	{
		id: "google/nano-banana-pro",
		name: "Nano Banana Pro",
		shortName: "Nano Banana",
		description: "Google's model with up to 14 input images",
		detailedDescription:
			"Nano Banana Pro is a powerful external model supporting up to 14 reference images. It excels at understanding context and can incorporate real-time information into generations.",
		category: "external",
		capabilities: {
			supportsImageInput: true,
			maxImages: 14,
			supportsNumOutputs: false,
			supportsSeed: false,
			requiresImageInput: false,
		},
		pricing: {
			type: "per_image",
			baseCost: 0.2,
			displayCost: "~$0.20",
			creditCost: 10,
		},
		bestFor: ["Multi-reference composition", "Context-aware generation", "Complex scene building"],
		differentiators: "Supports the most reference images (14). Different generation style from FLUX models.",
	},
];

/**
 * Get a model config by ID
 */
export function getModelConfig(modelId: string): ModelConfig | undefined {
	return MODELS_CONFIG.find((m) => m.id === modelId);
}

/**
 * Per-image credit cost to show before the server's number has loaded. Mirrors
 * the server default (2) for unknown models.
 */
export function fallbackCreditCost(modelId: string): number {
	return getModelConfig(modelId)?.pricing.creditCost ?? 2;
}

/**
 * Get models by category
 */
export function getModelsByCategory(category: ModelConfig["category"]): ModelConfig[] {
	return MODELS_CONFIG.filter((m) => m.category === category);
}

/**
 * Check if a model requires image input
 */
export function modelRequiresImage(modelId: string): boolean {
	const config = getModelConfig(modelId);
	return config?.capabilities.requiresImageInput ?? false;
}

/**
 * Check if a model supports image input
 */
export function modelSupportsImage(modelId: string): boolean {
	const config = getModelConfig(modelId);
	return config?.capabilities.supportsImageInput ?? false;
}

/**
 * Get the category info for a model
 */
export function getModelCategory(modelId: string) {
	const config = getModelConfig(modelId);
	if (!config) return null;
	return MODEL_CATEGORIES[config.category];
}

/**
 * Check if a model is a variation/Redux model (doesn't use prompts)
 */
export function isVariationModel(modelId: string): boolean {
	const config = getModelConfig(modelId);
	return config?.category === "variation";
}
