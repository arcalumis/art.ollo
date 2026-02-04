import { useCallback, useEffect, useRef, useState } from "react";
import { API_BASE } from "../config";
import { isVariationModel, modelRequiresImage } from "../config/models";
import type { Model } from "../types";
import { blobToFile, convertHeicToPng, findClosestAspectRatio, getImageDimensions, isHeicFile, resizeImageIfNeeded } from "../utils/imageResize";
import { ImagePicker } from "./ImagePicker";
import { ImageRequiredTooltip, ModelInfoTooltip } from "./ModelInfoTooltip";

// Aspect ratio options
const ASPECT_RATIOS = [
	{ value: "match_input_image", label: "Match Input" },
	{ value: "1:1", label: "1:1" },
	{ value: "4:3", label: "4:3" },
	{ value: "3:4", label: "3:4" },
	{ value: "16:9", label: "16:9" },
	{ value: "9:16", label: "9:16" },
];

const RESOLUTIONS = [
	{ value: "2K", label: "2K" },
	{ value: "1K", label: "1K" },
	{ value: "4K", label: "4K" },
];

export interface CreationOptions {
	aspectRatio: string;
	resolution: string;
	outputFormat: string;
}

interface CreationPanelProps {
	// Model
	models: Model[];
	selectedModel: string;
	onSelectModel: (id: string) => void;
	supportsImageInput: boolean;

	// Images
	token: string;
	imageInputs: string[];
	onImagesChange: (urls: string[]) => void;
	maxImages: number;

	// Options
	options: CreationOptions;
	onOptionsChange: (opts: CreationOptions) => void;

	// Actions
	onGenerate: (prompt: string) => void;
	onEnhance: (prompt: string, hasImages?: boolean) => Promise<string>;

	// State
	loading: boolean;
	queueCount: number;

	// Subscription
	allowedModels?: string[] | null;
}

export function CreationPanel({
	models,
	selectedModel,
	onSelectModel,
	supportsImageInput,
	token,
	imageInputs,
	onImagesChange,
	maxImages,
	options,
	onOptionsChange,
	onGenerate,
	onEnhance,
	loading,
	queueCount,
	allowedModels,
}: CreationPanelProps) {
	// Check if a model is available on the user's plan
	const isModelAvailable = (modelId: string) => {
		if (allowedModels === null || allowedModels === undefined) return true;
		return allowedModels.includes(modelId);
	};
	const [prompt, setPrompt] = useState("");
	const [enhancing, setEnhancing] = useState(false);
	const [uploading, setUploading] = useState(false);
	const [converting, setConverting] = useState(false);
	const [uploadError, setUploadError] = useState<string | null>(null);
	const [showPicker, setShowPicker] = useState(false);
	const [sparkling, setSparkling] = useState(false);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const cameraInputRef = useRef<HTMLInputElement>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);

	// Check if current model requires an image
	const requiresImage = modelRequiresImage(selectedModel);
	const needsImageHighlight = requiresImage && imageInputs.length === 0;

	// Check if current model is a variation model (doesn't use prompts)
	const isVariation = isVariationModel(selectedModel);

	// Auto-resize textarea
	useEffect(() => {
		if (textareaRef.current) {
			textareaRef.current.style.height = "auto";
			const scrollHeight = textareaRef.current.scrollHeight;
			textareaRef.current.style.height = `${Math.min(Math.max(scrollHeight, 120), 300)}px`;
		}
	}, [prompt]);

	const handleSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		// For variation models, don't require a prompt - just need an image
		if (isVariation) {
			if (imageInputs.length > 0 && !loading && !enhancing) {
				onGenerate(""); // Empty prompt for variations
			}
			return;
		}
		if (prompt.trim() && !loading && !enhancing) {
			onGenerate(prompt.trim());
			setPrompt("");
		}
	};

	const handleEnhance = async () => {
		if (!prompt.trim() || enhancing) return;
		// Trigger sparkle animation
		setSparkling(true);
		setTimeout(() => setSparkling(false), 400);

		setEnhancing(true);
		try {
			const enhanced = await onEnhance(prompt.trim(), imageInputs.length > 0);
			if (enhanced?.trim()) {
				setPrompt(enhanced);
			}
		} catch (err) {
			console.error("Enhancement failed:", err);
		} finally {
			setEnhancing(false);
		}
	};

	const handleKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			handleSubmit(e);
		}
	};

	// File upload handler
	const uploadFile = useCallback(
		async (file: File) => {
			let fileToUpload = file;
			try {
				const result = await resizeImageIfNeeded(file);
				if (result.resized) {
					fileToUpload = blobToFile(result.blob, file);
				}
			} catch (err) {
				console.error("Resize failed:", err);
			}

			const formData = new FormData();
			formData.append("file", fileToUpload);

			const response = await fetch(`${API_BASE}/api/uploads`, {
				method: "POST",
				headers: { Authorization: `Bearer ${token}` },
				body: formData,
			});

			if (!response.ok) throw new Error("Upload failed");
			return (await response.json()) as { imageUrl: string };
		},
		[token],
	);

	const handleFileInput = async (e: React.ChangeEvent<HTMLInputElement>) => {
		const files = e.target.files;
		if (!files?.length) return;

		setUploading(true);
		setUploadError(null);
		try {
			const newUrls: string[] = [];
			const errors: string[] = [];
			let firstImageDimensions: { width: number; height: number } | null = null;

			for (let file of Array.from(files)) {
				// Check if file is an image (including HEIC)
				const isImage = file.type.startsWith("image/") || isHeicFile(file);
				if (!isImage) continue;
				if (imageInputs.length + newUrls.length >= maxImages) break;

				// Convert HEIC to PNG if needed
				if (isHeicFile(file)) {
					setConverting(true);
					try {
						file = await convertHeicToPng(file);
					} catch (err) {
						console.error("HEIC conversion failed:", err);
						errors.push(`Failed to convert ${file.name}`);
						continue;
					} finally {
						setConverting(false);
					}
				}

				// Detect dimensions of first image to auto-set aspect ratio
				if (imageInputs.length === 0 && newUrls.length === 0 && !firstImageDimensions) {
					try {
						firstImageDimensions = await getImageDimensions(file);
					} catch (err) {
						console.error("Failed to get image dimensions:", err);
					}
				}

				try {
					const upload = await uploadFile(file);
					newUrls.push(upload.imageUrl);
				} catch (err) {
					console.error("Upload failed:", err);
					errors.push(`Failed to upload ${file.name}`);
				}
			}

			// Auto-set aspect ratio to match first uploaded image
			if (firstImageDimensions && newUrls.length > 0) {
				const availableRatios = ASPECT_RATIOS.map((r) => r.value);
				const closestRatio = findClosestAspectRatio(
					firstImageDimensions.width,
					firstImageDimensions.height,
					availableRatios,
				);
				if (closestRatio !== options.aspectRatio) {
					onOptionsChange({ ...options, aspectRatio: closestRatio });
				}
			}

			onImagesChange([...imageInputs, ...newUrls]);
			if (errors.length > 0) {
				setUploadError(errors.join(", "));
				setTimeout(() => setUploadError(null), 5000);
			}
		} catch (err) {
			console.error("Upload failed:", err);
			setUploadError("Upload failed");
			setTimeout(() => setUploadError(null), 5000);
		} finally {
			setUploading(false);
			setConverting(false);
			e.target.value = "";
		}
	};

	const handleLibrarySelect = (urls: string[]) => {
		const newUrls = urls.filter((url) => !imageInputs.includes(url));
		onImagesChange([...imageInputs, ...newUrls]);
	};

	const removeImage = (url: string) => {
		onImagesChange(imageInputs.filter((u) => u !== url));
	};

	const isGenerating = queueCount > 0 || loading;

	return (
		<div className="border-t border-[var(--border)] py-4 px-4 bg-[var(--bg-secondary)]">
			<form onSubmit={handleSubmit} className="max-w-4xl mx-auto">
				{/* Desktop: 3-column layout | Mobile: vertical */}
				<div className="flex flex-col md:flex-row gap-2 md:items-stretch">
					{/* Column 1: Options (3 rows) */}
					<div className="order-2 md:order-1 flex-shrink-0 flex flex-col gap-2">
						{/* Row 1: Model Selector with Info */}
						<div className="flex items-center gap-1.5">
							<ModelInfoTooltip modelId={selectedModel} />
							<select
								value={selectedModel}
								onChange={(e) => onSelectModel(e.target.value)}
								className="cyber-input flex-1 w-full min-w-40 px-2 rounded text-xs text-[var(--text-primary)] flex items-center"
							>
								{models.map((m) => {
									const available = isModelAvailable(m.id);
									return (
										<option
											key={m.id}
											value={m.id}
											disabled={!available}
											className={!available ? "text-gray-500" : ""}
										>
											{m.name}{!available ? " 🔒" : ""}
										</option>
									);
								})}
							</select>
						</div>

						{/* Row 2: Aspect Ratio & Resolution (shown for all models) */}
						<div className="flex-1 flex gap-2">
							<select
								value={options.aspectRatio}
								onChange={(e) => onOptionsChange({ ...options, aspectRatio: e.target.value })}
								className="cyber-input flex-1 px-2 rounded text-xs text-[var(--text-primary)]"
								title="Aspect Ratio"
							>
								{(supportsImageInput ? ASPECT_RATIOS : ASPECT_RATIOS.filter(r => r.value !== "match_input_image")).map((r) => (
									<option key={r.value} value={r.value}>
										{r.label}
									</option>
								))}
							</select>
							<select
								value={options.resolution}
								onChange={(e) => onOptionsChange({ ...options, resolution: e.target.value })}
								className="cyber-input flex-1 px-2 rounded text-xs text-[var(--text-primary)]"
								title="Resolution"
							>
								{RESOLUTIONS.map((r) => (
									<option key={r.value} value={r.value}>
										{r.label}
									</option>
								))}
							</select>
						</div>

						{/* Row 3: Upload Buttons */}
						{supportsImageInput && (
							<div className="flex-1 flex gap-2">
								{/* Camera button - opens camera directly on mobile */}
								<button
									type="button"
									onClick={() => cameraInputRef.current?.click()}
									disabled={uploading || converting || imageInputs.length >= maxImages}
									className={`cyber-input hover:border-[var(--accent)] px-2 rounded text-xs cursor-pointer transition-all flex items-center justify-center ${
										needsImageHighlight ? "border-[var(--accent)] sacred-glow" : ""
									}`}
									title="Take photo"
								>
									<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
										<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
										<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
									</svg>
								</button>
								<input
									ref={cameraInputRef}
									type="file"
									accept="image/*"
									capture="environment"
									onChange={handleFileInput}
									className="hidden"
								/>
								{/* Upload button - opens file picker */}
								<label className={`flex-1 cyber-input hover:border-[var(--accent)] px-2 rounded text-xs cursor-pointer transition-all flex items-center justify-center ${
									needsImageHighlight ? "border-[var(--accent)] sacred-glow" : ""
								}`}>
									<input
										ref={fileInputRef}
										type="file"
										accept="image/*,.heic,.heif"
										multiple
										onChange={handleFileInput}
										className="hidden"
										disabled={uploading || converting || imageInputs.length >= maxImages}
									/>
									{converting ? "Converting..." : uploading ? "Uploading..." : "+ Upload"}
								</label>
								<button
									type="button"
									onClick={() => setShowPicker(true)}
									className={`flex-1 cyber-input hover:border-[var(--accent)] px-2 rounded text-xs transition-all flex items-center justify-center ${
										needsImageHighlight ? "border-[var(--accent)] sacred-glow" : ""
									}`}
								>
									Library
								</button>
							</div>
						)}
					</div>

					{/* Column 2: Prompt or Image Required notice */}
					<div className="order-1 md:order-2 flex-1 flex flex-col">
						{/* Image Required Tooltip */}
						<ImageRequiredTooltip modelId={selectedModel} show={needsImageHighlight} />
						{!isVariation && (
							<textarea
								ref={textareaRef}
								value={prompt}
								onChange={(e) => setPrompt(e.target.value)}
								onKeyDown={handleKeyDown}
								placeholder="Describe your vision..."
								disabled={enhancing}
								className="cyber-input w-full h-full px-4 py-3 rounded-lg text-sm resize-none"
								style={{ minHeight: "120px" }}
							/>
						)}
					</div>

					{/* Column 3: Action Buttons (2 rows) */}
					<div className="order-3 flex md:flex-col gap-2">
						{!isVariation && (
							<button
								type="button"
								onClick={handleEnhance}
								disabled={!prompt.trim() || enhancing || loading}
								className={`enhance-btn flex-1 w-11 rounded-lg flex items-center justify-center ${sparkling ? "sparkling" : ""}`}
								title="Enhance prompt with AI"
							>
								{enhancing ? (
									<svg className="animate-spin w-5 h-5" viewBox="0 0 24 24">
										<circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
										<path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
									</svg>
								) : (
									<svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
										<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z" />
									</svg>
								)}
							</button>
						)}
						<button
							type="submit"
							disabled={isVariation ? imageInputs.length === 0 || loading : !prompt.trim() || loading || enhancing}
							className="submit-btn flex-1 w-11 rounded-lg flex items-center justify-center"
							title={isVariation ? "Generate 4 variations" : "Generate"}
						>
							{isGenerating ? (
								<span className="flex items-center gap-1">
									<svg className="animate-spin w-5 h-5" viewBox="0 0 24 24">
										<circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
										<path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
									</svg>
									{queueCount > 0 && <span className="text-xs">{queueCount}</span>}
								</span>
							) : (
								<svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
									<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 5l7 7m0 0l-7 7m7-7H3" />
								</svg>
							)}
						</button>
					</div>
				</div>

				{/* Upload Error Message */}
				{uploadError && (
					<div className="mt-2 px-3 py-2 bg-red-500/20 border border-red-500/50 rounded text-red-400 text-xs">
						{uploadError}
					</div>
				)}

				{/* Selected Images Thumbnails - Below the main layout */}
				{imageInputs.length > 0 && (
					<div className="flex flex-wrap items-center gap-2 mt-3">
						{imageInputs.map((url) => {
							const imgSrc = url.startsWith("http") ? url : `${API_BASE}${url}`;
							return (
								<div
									key={url}
									onClick={() => removeImage(url)}
									onKeyDown={(e) => e.key === "Enter" && removeImage(url)}
									role="button"
									tabIndex={0}
									className="w-10 h-10 rounded overflow-hidden hover:opacity-70 transition-opacity cursor-pointer bg-[var(--bg-tertiary)]"
									style={{ minWidth: "40px", minHeight: "40px" }}
									title="Click to remove"
								>
									<img
										src={imgSrc}
										alt="Input"
										className="w-full h-full object-cover"
									/>
								</div>
							);
						})}
						<span className="text-xs text-[var(--text-secondary)] ml-1">
							{imageInputs.length}/{maxImages}
						</span>
					</div>
				)}
			</form>

			{/* Image Picker Modal */}
			<ImagePicker
				token={token}
				isOpen={showPicker}
				onClose={() => setShowPicker(false)}
				onSelect={handleLibrarySelect}
				selectedUrls={imageInputs}
				maxImages={maxImages}
			/>
		</div>
	);
}
