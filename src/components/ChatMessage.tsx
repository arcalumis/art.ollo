import { useState } from "react";
import { API_BASE } from "../config";
import type { Generation, GenerationImage, QueuedGeneration } from "../types";
import { GenerationErrorNotice } from "./billing/GenerationErrorNotice";
import { GenerationProgressBar } from "./GenerationProgressBar";
import { IconDownload, IconRemix, IconRotate, IconTrash, IconUpscale, IconVariations, IconZoom } from "./Icons";
import { Lightbox } from "./Lightbox";

interface ChatMessageProps {
	generation: Generation | QueuedGeneration;
	onVariations?: (gen: Generation) => void;
	onVaryImage?: (imageUrl: string, prompt: string) => void;
	onUpscale?: (gen: Generation) => void;
	onRemix?: (gen: Generation) => void;
	onTrash?: (id: string) => void;
	onImageClick?: (gen: Generation) => void;
}

// 4-up grid component for variation results
function ImageGrid({
	images,
	prompt,
	onImageClick,
	onVaryImage,
	onZoom,
}: {
	images: GenerationImage[];
	prompt: string;
	onImageClick?: (url: string) => void;
	onVaryImage?: (imageUrl: string) => void;
	onZoom?: (imageUrl: string) => void;
}) {
	return (
		<div className="grid grid-cols-2 gap-2 max-w-md">
			{images.map((img, index) => (
				<div key={img.id} className="relative group aspect-square">
					<button
						type="button"
						onClick={() => onZoom?.(img.url)}
						className="block w-full h-full rounded-lg overflow-hidden cyber-card hover:neon-border transition-all cursor-pointer"
					>
						<img
							src={`${API_BASE}${img.url}`}
							alt={`${prompt} - variation ${index + 1}`}
							className="w-full h-full object-cover"
							loading="lazy"
						/>
					</button>
					{/* Hover overlay with actions */}
					<div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity rounded-lg flex items-center justify-center gap-2 pointer-events-none">
						{onVaryImage && (
							<button
								type="button"
								onClick={(e) => {
									e.stopPropagation();
									onVaryImage(img.url);
								}}
								className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-black rounded-lg transition-colors pointer-events-auto"
								title="Create variations of this image"
							>
								<IconVariations className="w-4 h-4" />
								<span>Vary</span>
							</button>
						)}
						{onImageClick && (
							<button
								type="button"
								onClick={(e) => {
									e.stopPropagation();
									onImageClick(img.url);
								}}
								className="flex items-center gap-1.5 px-3 py-1.5 text-xs cyber-card hover:neon-border rounded-lg transition-all pointer-events-auto"
								title="Add to selected images"
							>
								<span>+ Select</span>
							</button>
						)}
					</div>
				</div>
			))}
		</div>
	);
}

function isQueuedGeneration(gen: Generation | QueuedGeneration): gen is QueuedGeneration {
	return "status" in gen;
}

function formatTime(dateString: string): string {
	const date = new Date(dateString);
	return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export function ChatMessage({
	generation,
	onVariations,
	onVaryImage,
	onUpscale,
	onRemix,
	onTrash,
	onImageClick,
}: ChatMessageProps) {
	const isQueued = isQueuedGeneration(generation);
	const isGenerating = isQueued && generation.status === "generating";
	const isFailed = isQueued && generation.status === "failed";
	const isComplete = !isQueued || generation.status === "completed";

	const imageUrl = isQueued ? generation.result?.imageUrl : generation.imageUrl;

	// Check for multi-image variations (4-up grid)
	const images = !isQueued ? (generation as Generation).images : undefined;
	const hasMultipleImages = images && images.length > 1;

	// Lightbox state
	const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);

	// Rotation state (0, 90, 180, 270 degrees)
	const [rotation, setRotation] = useState(0);

	const handleRotate = () => {
		setRotation((prev) => (prev + 90) % 360);
	};

	return (
		<div className="py-4">
			{/* Timestamp */}
			<div className="text-[10px] text-[var(--text-secondary)] mb-2 mono">
				{formatTime(generation.createdAt)}
			</div>

			{/* Prompt bubble */}
			<div className="cyber-card rounded-lg p-3 mb-3 max-w-lg border-l-2 border-l-[var(--accent)]">
				<p className="text-sm text-[var(--text-primary)]">{generation.prompt}</p>
			</div>

			{/* Image or status */}
			{isGenerating ? (
				<div className="cyber-card rounded-lg p-4 max-w-md aspect-square flex items-center justify-center">
					<div className="flex flex-col items-center w-full px-4">
						{generation.startedAt ? (
							<>
								<div className="w-8 h-8 mb-3 border-2 border-[var(--accent)] border-t-transparent rounded-full animate-spin" />
								<span className="text-xs text-[var(--accent)] mb-3 mono">generating</span>
								<GenerationProgressBar
									startedAt={generation.startedAt}
									estimatedDuration={generation.estimatedDuration || 30}
									status={generation.status}
								/>
							</>
						) : (
							<div className="text-sm text-[var(--text-secondary)] mono">
								Queued<span className="cursor-blink">_</span>
							</div>
						)}
					</div>
				</div>
			) : isFailed ? (
				<GenerationErrorNotice item={generation} className="max-w-md" />
			) : hasMultipleImages ? (
				// 4-up grid for variations
				<div className="max-w-md">
					<ImageGrid
						images={images}
						prompt={generation.prompt}
						onImageClick={(url) => {
							// Add image to selected inputs
							if (onImageClick && !isQueued) {
								const gen = generation as Generation;
								onImageClick({ ...gen, imageUrl: url });
							}
						}}
						onVaryImage={onVaryImage ? (url) => onVaryImage(url, generation.prompt) : undefined}
						onZoom={(url) => setLightboxUrl(`${API_BASE}${url}`)}
					/>

					{/* Action buttons for grid */}
					{isComplete && !isQueued && (
						<div className="flex items-center gap-1 mt-3">
							{onVariations && (
								<button
									type="button"
									onClick={() => onVariations(generation as Generation)}
									className="flex items-center gap-1.5 px-3 py-1.5 text-xs cyber-card hover:neon-border rounded-lg transition-all"
									title="Generate more variations"
								>
									<IconVariations className="w-4 h-4" />
									<span className="hidden sm:inline">Vary Again</span>
								</button>
							)}
							{onTrash && (
								<button
									type="button"
									onClick={() => onTrash(generation.id)}
									className="flex items-center gap-1.5 px-3 py-1.5 text-xs cyber-card hover:bg-[var(--accent-alt)]/20 rounded-lg transition-all ml-auto"
									title="Move to trash"
								>
									<IconTrash className="w-4 h-4" />
								</button>
							)}
						</div>
					)}
				</div>
			) : imageUrl ? (
				// Single image display
				<div className="max-w-md">
					<button
						type="button"
						onClick={() => onImageClick && !isQueued && onImageClick(generation as Generation)}
						className="block w-full rounded-lg overflow-hidden cyber-card hover:neon-border transition-all cursor-pointer"
					>
						<img
							src={`${API_BASE}${imageUrl}`}
							alt={generation.prompt}
							className="w-full h-auto transition-transform duration-200"
							style={{ transform: rotation ? `rotate(${rotation}deg)` : undefined }}
							loading="lazy"
						/>
					</button>

					{/* Action buttons for single image */}
					{isComplete && !isQueued && (
						<div className="flex items-center gap-1 mt-3">
							{onVariations && (
								<button
									type="button"
									onClick={() => onVariations(generation as Generation)}
									className="flex items-center gap-1.5 px-3 py-1.5 text-xs cyber-card hover:neon-border rounded-lg transition-all"
									title="Generate variations"
								>
									<IconVariations className="w-4 h-4" />
									<span className="hidden sm:inline">Vary</span>
								</button>
							)}
							{onUpscale && (
								<button
									type="button"
									onClick={() => onUpscale(generation as Generation)}
									className="flex items-center gap-1.5 px-3 py-1.5 text-xs cyber-card hover:neon-border rounded-lg transition-all"
									title="Upscale to higher resolution"
								>
									<IconUpscale className="w-4 h-4" />
									<span className="hidden sm:inline">Upscale</span>
								</button>
							)}
							{onRemix && (
								<button
									type="button"
									onClick={() => onRemix(generation as Generation)}
									className="flex items-center gap-1.5 px-3 py-1.5 text-xs cyber-card hover:neon-border rounded-lg transition-all"
									title="Use as input for new generation"
								>
									<IconRemix className="w-4 h-4" />
									<span className="hidden sm:inline">Remix</span>
								</button>
							)}
							<a
								href={`${API_BASE}${imageUrl}`}
								download
								className="flex items-center gap-1.5 px-3 py-1.5 text-xs cyber-card hover:neon-border rounded-lg transition-all"
								title="Download image"
							>
								<IconDownload className="w-4 h-4" />
							</a>
							<button
								type="button"
								onClick={() => setLightboxUrl(`${API_BASE}${imageUrl}`)}
								className="flex items-center gap-1.5 px-3 py-1.5 text-xs cyber-card hover:neon-border rounded-lg transition-all"
								title="View full size"
							>
								<IconZoom className="w-4 h-4" />
							</button>
							<button
								type="button"
								onClick={handleRotate}
								className="flex items-center gap-1.5 px-3 py-1.5 text-xs cyber-card hover:neon-border rounded-lg transition-all"
								title="Rotate image"
							>
								<IconRotate className="w-4 h-4" />
							</button>
							{onTrash && (
								<button
									type="button"
									onClick={() => onTrash(generation.id)}
									className="flex items-center gap-1.5 px-3 py-1.5 text-xs cyber-card hover:bg-[var(--accent-alt)]/20 rounded-lg transition-all ml-auto"
									title="Move to trash"
								>
									<IconTrash className="w-4 h-4" />
								</button>
							)}
						</div>
					)}
				</div>
			) : null}

			{/* Lightbox */}
			{lightboxUrl && (
				<Lightbox
					imageUrl={lightboxUrl}
					alt={generation.prompt}
					onClose={() => setLightboxUrl(null)}
					rotation={rotation}
				/>
			)}
		</div>
	);
}
