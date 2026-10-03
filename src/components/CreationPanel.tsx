import { CameraIcon, ChevronDownIcon, ImagesIcon, SparklesIcon, UploadIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { API_BASE } from "../config";
import { getModelConfig, isVariationModel, modelRequiresImage } from "../config/models";
import type { Model } from "../types";
import {
	blobToFile,
	convertHeicToPng,
	findClosestAspectRatio,
	getImageDimensions,
	isHeicFile,
	resizeImageIfNeeded,
} from "../utils/imageResize";
import { ImagePicker } from "./ImagePicker";

// Aspect ratio options
const ASPECT_RATIOS = [
	{ value: "match_input_image", label: "Match input" },
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
	/** Replaces the prompt text whenever `nonce` changes (starter prompts, example picks). */
	promptRequest?: { text: string; nonce: number } | null;
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

	// Credits
	/** Per-image credit cost of the selected model (server value, fallback while loading). */
	creditCost?: number;
	/** Images one Generate produces (variation models make 4). */
	numOutputs?: number;
	/** Current balance; null while loading. */
	balance?: number | null;
	/** Generations run on the user's own Replicate key and cost no credits. */
	usesOwnKey?: boolean;
	/** The balance can't cover this generation: open the upgrade sheet. */
	onNeedCredits?: (needed: number) => void;
	/** A model outside the user's plan was picked: open the upgrade sheet. */
	onLockedModel?: (modelId: string) => void;
}

function PillSelect({
	label,
	value,
	onChange,
	children,
	className,
}: {
	label: string;
	value: string;
	onChange: (value: string) => void;
	children: React.ReactNode;
	className?: string;
}) {
	return (
		<label className={cn("relative inline-flex shrink-0 items-center", className)}>
			<span className="sr-only">{label}</span>
			<select
				value={value}
				onChange={(e) => onChange(e.target.value)}
				className="h-9 w-full cursor-pointer appearance-none truncate rounded-full border border-border bg-muted py-0 pr-8 pl-3 text-[0.82rem] font-medium text-foreground outline-none hover:border-foreground/30 focus-visible:ring-3 focus-visible:ring-ring/50"
			>
				{children}
			</select>
			<ChevronDownIcon className="pointer-events-none absolute right-2.5 size-3.5 text-muted-foreground" aria-hidden />
		</label>
	);
}

const iconPill =
	"inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-full border border-border bg-muted px-3 text-[0.82rem] font-medium text-foreground outline-none hover:border-foreground/30 focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50";

export function CreationPanel({
	promptRequest,
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
	creditCost,
	numOutputs = 1,
	balance = null,
	usesOwnKey = false,
	onNeedCredits,
	onLockedModel,
}: CreationPanelProps) {
	// Check if a model is available on the user's plan
	const isModelAvailable = (modelId: string) => {
		if (allowedModels === null || allowedModels === undefined) return true;
		return allowedModels.includes(modelId);
	};
	const [prompt, setPrompt] = useState("");
	useEffect(() => {
		if (promptRequest) setPrompt(promptRequest.text);
	}, [promptRequest]);
	const [enhancing, setEnhancing] = useState(false);
	const [uploading, setUploading] = useState(false);
	const [converting, setConverting] = useState(false);
	const [uploadError, setUploadError] = useState<string | null>(null);
	const [showPicker, setShowPicker] = useState(false);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const cameraInputRef = useRef<HTMLInputElement>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);
	const reasonId = useId();

	// Check if current model requires an image
	const requiresImage = modelRequiresImage(selectedModel);
	const needsImage = requiresImage && imageInputs.length === 0;

	// Check if current model is a variation model (doesn't use prompts)
	const isVariation = isVariationModel(selectedModel);

	// Cost at the point of action.
	const perImage = creditCost ?? getModelConfig(selectedModel)?.pricing.creditCost ?? 2;
	const totalCost = perImage * numOutputs;
	const cantAfford = !usesOwnKey && balance !== null && balance < totalCost;
	const lowBalance = !usesOwnKey && !cantAfford && balance !== null && balance < totalCost * 2;
	const costLabel = usesOwnKey ? "your Replicate key" : `${totalCost} ${totalCost === 1 ? "credit" : "credits"}`;

	// Auto-resize textarea
	useEffect(() => {
		if (textareaRef.current) {
			textareaRef.current.style.height = "auto";
			const scrollHeight = textareaRef.current.scrollHeight;
			textareaRef.current.style.height = `${Math.min(Math.max(scrollHeight, 72), 240)}px`;
		}
	}, [prompt]);

	const canSubmit = isVariation ? imageInputs.length > 0 && !loading : !!prompt.trim() && !loading && !enhancing;

	const handleSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		if (!canSubmit) return;
		// Not enough credits: show the upgrade sheet over the work instead of a failed request.
		if (cantAfford) {
			onNeedCredits?.(totalCost);
			return;
		}
		if (isVariation) {
			onGenerate(""); // Variation models take no prompt
			return;
		}
		onGenerate(prompt.trim());
		setPrompt("");
	};

	const handleEnhance = async () => {
		if (!prompt.trim() || enhancing) return;
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

	const handleModelChange = (id: string) => {
		if (!isModelAvailable(id)) {
			onLockedModel?.(id);
			return;
		}
		onSelectModel(id);
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
						errors.push(`${file.name} couldn't be converted`);
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
					errors.push(`${file.name} didn't upload`);
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
				setUploadError(`${errors.join(", ")}. Try again.`);
				setTimeout(() => setUploadError(null), 5000);
			}
		} catch (err) {
			console.error("Upload failed:", err);
			setUploadError("The upload didn't finish. Try again.");
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

	const atImageLimit = imageInputs.length >= maxImages;
	const imageControlsDisabled = uploading || converting || atImageLimit;
	const imageCopy = getModelConfig(selectedModel)?.category === "edit" ? "Add the image you want to edit." : "Add a reference image to vary.";

	return (
		<div className="border-t border-border bg-card px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
			<form onSubmit={handleSubmit} className="mx-auto flex max-w-3xl flex-col gap-2.5">
				{/* Selected reference images */}
				{imageInputs.length > 0 && (
					<div className="flex flex-wrap items-center gap-2">
						{imageInputs.map((url) => {
							const imgSrc = url.startsWith("http") ? url : `${API_BASE}${url}`;
							return (
								<button
									key={url}
									type="button"
									onClick={() => removeImage(url)}
									className="group relative size-11 overflow-hidden rounded-lg bg-muted outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
									aria-label="Remove reference image"
								>
									<img src={imgSrc} alt="" className="size-full object-cover" />
									<span className="absolute inset-0 hidden place-items-center bg-background/70 group-hover:grid group-focus-visible:grid">
										<XIcon className="size-4 text-foreground" />
									</span>
								</button>
							);
						})}
						<span className="text-xs text-muted-foreground tabular-nums">
							{imageInputs.length}/{maxImages}
						</span>
					</div>
				)}

				{needsImage && <p className="text-sm text-muted-foreground">{imageCopy}</p>}

				{!isVariation && (
					<label className="block">
						<span className="sr-only">Prompt</span>
						<textarea
							ref={textareaRef}
							value={prompt}
							onChange={(e) => setPrompt(e.target.value)}
							onKeyDown={handleKeyDown}
							placeholder="Describe the image you want"
							disabled={enhancing}
							rows={2}
							className="block w-full resize-none rounded-xl border border-border bg-muted px-4 py-3 text-[0.95rem] text-foreground outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30 disabled:opacity-60"
						/>
					</label>
				)}

				{/* Settings as pills; scrolls inside itself on narrow screens, never the page. */}
				<div className="-mx-4 flex items-center gap-2 overflow-x-auto px-4 pb-0.5 [scrollbar-width:none]">
					<PillSelect label="Model" value={selectedModel} onChange={handleModelChange} className="max-w-[13rem]">
						{models.map((m) => (
							<option key={m.id} value={m.id}>
								{m.name}
								{isModelAvailable(m.id) ? "" : " (upgrade)"}
							</option>
						))}
					</PillSelect>
					<PillSelect
						label="Aspect ratio"
						value={options.aspectRatio}
						onChange={(v) => onOptionsChange({ ...options, aspectRatio: v })}
					>
						{(supportsImageInput ? ASPECT_RATIOS : ASPECT_RATIOS.filter((r) => r.value !== "match_input_image")).map(
							(r) => (
								<option key={r.value} value={r.value}>
									{r.label}
								</option>
							),
						)}
					</PillSelect>
					<PillSelect
						label="Resolution"
						value={options.resolution}
						onChange={(v) => onOptionsChange({ ...options, resolution: v })}
					>
						{RESOLUTIONS.map((r) => (
							<option key={r.value} value={r.value}>
								{r.label}
							</option>
						))}
					</PillSelect>

					{supportsImageInput && (
						<>
							<button
								type="button"
								onClick={() => cameraInputRef.current?.click()}
								disabled={imageControlsDisabled}
								className={cn(iconPill, "w-9 px-0 md:hidden")}
								aria-label="Take a photo"
							>
								<CameraIcon className="size-4" />
							</button>
							<input
								ref={cameraInputRef}
								type="file"
								accept="image/*"
								capture="environment"
								onChange={handleFileInput}
								className="hidden"
							/>
							<button
								type="button"
								onClick={() => fileInputRef.current?.click()}
								disabled={imageControlsDisabled}
								className={cn(iconPill, needsImage && "border-verdigris")}
							>
								<UploadIcon className="size-3.5" />
								{converting ? "Converting…" : uploading ? "Uploading…" : "Upload"}
							</button>
							<input
								ref={fileInputRef}
								type="file"
								accept="image/*,.heic,.heif"
								multiple
								onChange={handleFileInput}
								className="hidden"
							/>
							<button
								type="button"
								onClick={() => setShowPicker(true)}
								disabled={atImageLimit}
								className={cn(iconPill, needsImage && "border-verdigris")}
							>
								<ImagesIcon className="size-3.5" />
								Library
							</button>
						</>
					)}
				</div>

				{uploadError && (
					<p className="text-sm text-destructive" role="alert">
						{uploadError}
					</p>
				)}

				<div className="flex items-center gap-2">
					<div className="min-w-0 flex-1 text-[0.82rem] text-muted-foreground" id={reasonId} aria-live="polite">
						{cantAfford ? (
							<span>
								This needs {totalCost} credits and you have {balance}.{" "}
								<button
									type="button"
									onClick={() => onNeedCredits?.(totalCost)}
									className="font-medium text-foreground underline underline-offset-4 hover:text-verdigris"
								>
									Top up
								</button>
							</span>
						) : lowBalance ? (
							<span>
								{balance} {balance === 1 ? "credit" : "credits"} left ·{" "}
								<button
									type="button"
									onClick={() => onNeedCredits?.(totalCost)}
									className="font-medium text-foreground underline underline-offset-4 hover:text-verdigris"
								>
									Top up
								</button>
							</span>
						) : queueCount > 0 ? (
							<span>{queueCount === 1 ? "1 image in progress" : `${queueCount} images in progress`}</span>
						) : null}
					</div>

					{!isVariation && (
						<Button
							type="button"
							variant="ghost"
							size="icon"
							onClick={handleEnhance}
							disabled={!prompt.trim() || enhancing || loading}
							aria-label={enhancing ? "Improving prompt" : "Improve prompt"}
							title="Improve prompt"
						>
							<SparklesIcon className={cn(enhancing && "opacity-50")} />
						</Button>
					)}
					<Button
						type="submit"
						disabled={!canSubmit}
						aria-disabled={cantAfford || undefined}
						aria-describedby={cantAfford ? reasonId : undefined}
						className={cn("px-5", cantAfford && "opacity-60")}
					>
						{isVariation ? "Make 4 variations" : "Generate"}
						<span className="font-normal opacity-80">· {costLabel}</span>
					</Button>
				</div>
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
