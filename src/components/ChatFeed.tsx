import { Button } from "@/components/ui/button";
import { useAuth } from "@/contexts/AuthContext";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Generation, QueuedGeneration } from "../types";
import { CompletedStep, FailedStep, PendingStep } from "./series/SeriesStep";
import { ImageViewer } from "./viewer/ImageViewer";
import {
	type ImageActionCosts,
	type ImageTool,
	type ViewerImage,
	asGeneration,
	copyShareLink,
	downloadImage,
	imagesOf,
	trashWithUndo,
} from "./viewer/media";

export interface ChatFeedProps {
	/** The series' generations, newest first (as /api/threads/:id returns them). */
	generations: Generation[];
	/** In-flight and failed steps for this series, newest first. */
	queuedItems: QueuedGeneration[];
	onVariations: (gen: Generation) => void;
	/** Vary one image of a set. */
	onVaryImage?: (imageUrl: string, prompt: string) => void;
	onUpscale: (gen: Generation) => void;
	/** Legacy "remix": used for "Use as reference" only when onImageClick isn't given. */
	onRemix: (gen: Generation) => void;
	onTrash: (id: string) => unknown;
	/** "Use as reference": adds `gen.imageUrl` to the prompt bar's inputs. Clicking an image now opens the viewer. */
	onImageClick: (gen: Generation) => void;
	onLoadMore: () => void;
	hasMore: boolean;
	loading: boolean;

	// ---- Phase 4 (all optional) ----
	/** Undo for "Moved to Trash". */
	onRestore?: (id: string) => unknown;
	/** Upscale / remove background. Falls back to onUpscale for "upscale". */
	onTool?: (image: ViewerImage, tool: ImageTool) => void;
	/** Put a prompt back in the prompt bar. */
	onReusePrompt?: (prompt: string) => void;
	/** Fallbacks when a failed queue item doesn't carry its own onRetry/onDismiss. */
	onRetry?: (item: QueuedGeneration) => void;
	onDismiss?: (id: string) => void;
	/** Told when the selected step changes (the latest step is selected by default). */
	onSelectStep?: (gen: Generation | null) => void;
	/** The prompt bar's current reference images, to mark them in the series. */
	selectedInputUrls?: string[];
	/** Credit cost of each action, shown on the buttons. */
	actionCosts?: ImageActionCosts;
	/** Aspect ratio for in-progress steps that don't carry their own. */
	pendingAspectRatio?: string;
}

/**
 * A thread as a series: each step shows its image (or set of four) and the instruction that
 * produced it, oldest first. The latest step is selected (verdigris outline) unless you pick
 * another; clicking an image opens the viewer.
 */
export function ChatFeed({
	generations,
	queuedItems,
	onVariations,
	onVaryImage,
	onUpscale,
	onRemix,
	onTrash,
	onImageClick,
	onLoadMore,
	hasMore,
	loading,
	onRestore,
	onTool,
	onReusePrompt,
	onRetry,
	onDismiss,
	onSelectStep,
	selectedInputUrls = [],
	actionCosts,
	pendingAspectRatio,
}: ChatFeedProps) {
	const { token } = useAuth();
	const steps = useMemo(() => [...generations].reverse(), [generations]);
	const pending = useMemo(() => [...queuedItems].reverse(), [queuedItems]);
	const viewerImages = useMemo(() => steps.flatMap(imagesOf), [steps]);
	const [viewerIndex, setViewerIndex] = useState<number | null>(null);

	// The latest finished step is selected until the user picks another.
	const latestId = steps[steps.length - 1]?.id ?? null;
	const [selectedId, setSelectedId] = useState<string | null>(latestId);
	const selectStepRef = useRef(onSelectStep);
	selectStepRef.current = onSelectStep;
	useEffect(() => {
		setSelectedId(latestId);
	}, [latestId]);
	const selected = steps.find((g) => g.id === selectedId) ?? null;
	useEffect(() => {
		selectStepRef.current?.(selected);
	}, [selected]);

	// Bring new work into view: once on first load, then whenever a step is added.
	const endRef = useRef<HTMLDivElement>(null);
	const seenInitial = useRef(false);
	const total = steps.length + pending.length;
	const prevTotal = useRef(total);
	useEffect(() => {
		if (!seenInitial.current && total > 0) {
			seenInitial.current = true;
			endRef.current?.scrollIntoView({ block: "end" });
		} else if (total > prevTotal.current) {
			endRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
		}
		prevTotal.current = total;
	}, [total]);

	const useAsReference = (image: ViewerImage) => {
		const gen = asGeneration(image);
		if (!gen) return;
		if (onImageClick) onImageClick(gen);
		else onRemix(gen);
	};
	const vary = (image: ViewerImage) => {
		const gen = asGeneration(image);
		if (!gen) return;
		if (image.setSize && onVaryImage) onVaryImage(image.url, gen.prompt);
		else onVariations(gen);
	};
	const tool =
		onTool ??
		((image: ViewerImage, which: ImageTool) => {
			const gen = asGeneration(image);
			if (gen && which === "upscale") onUpscale(gen);
		});
	const trash = (id: string) => void trashWithUndo(id, onTrash, onRestore);
	const share = token ? (id: string) => void copyShareLink(token, id) : undefined;
	const open = (image: ViewerImage) => {
		const i = viewerImages.findIndex((v) => v.key === image.key);
		setViewerIndex(i >= 0 ? i : null);
	};

	if (total === 0 && !loading) {
		return (
			<div className="flex min-h-[50vh] flex-col items-center justify-center px-4 text-center">
				<p className="text-base font-medium text-foreground">This series is empty</p>
				<p className="mt-1 max-w-xs text-sm text-muted-foreground">
					Describe an image below. Each change you ask for becomes the next step.
				</p>
			</div>
		);
	}

	let number = 0;
	return (
		<div className="@container pb-4">
			{hasMore && (
				<div className="flex justify-center pb-6">
					<Button variant="outline" onClick={onLoadMore} disabled={loading}>
						{loading ? "Loading…" : "Show earlier steps"}
					</Button>
				</div>
			)}

			<ol
				className="m-0 grid list-none grid-cols-2 gap-x-3 gap-y-7 p-0 @xl:grid-cols-3 @xl:gap-x-4"
				aria-label="Steps in this series"
			>
				{steps.map((gen) => {
					number++;
					return (
						<li key={gen.id} className="min-w-0">
							<CompletedStep
								generation={gen}
								images={imagesOf(gen)}
								number={number}
								selected={gen.id === selectedId}
								referenceUrls={selectedInputUrls}
								onSelect={() => setSelectedId(gen.id)}
								onOpen={open}
								onUseAsReference={useAsReference}
								onVary={vary}
								onUpscale={(image) => tool(image, "upscale")}
								onReusePrompt={onReusePrompt}
								onDownload={(image) => void downloadImage(image)}
								onShare={share}
								onTrash={trash}
								costs={actionCosts}
							/>
						</li>
					);
				})}
				{pending.map((item) =>
					item.status === "failed" ? (
						<li key={item.id} className="col-span-full">
							<FailedStep item={item} onRetry={onRetry} onDismiss={onDismiss} />
						</li>
					) : (
						<li key={item.id} className="min-w-0">
							<PendingStep item={item} number={++number} fallbackAspect={pendingAspectRatio} />
						</li>
					),
				)}
			</ol>
			<div ref={endRef} />

			<ImageViewer
				images={viewerImages}
				index={viewerIndex}
				onIndexChange={setViewerIndex}
				onVary={vary}
				onTool={tool}
				onUseAsReference={useAsReference}
				referenceUrls={selectedInputUrls}
				onReusePrompt={onReusePrompt ? (prompt) => onReusePrompt(prompt) : undefined}
				onTrash={(image) => image.generation && trash(image.generation.id)}
				costs={actionCosts}
			/>
		</div>
	);
}

/** The same component under the name the design uses. */
export const SeriesView = ChatFeed;
