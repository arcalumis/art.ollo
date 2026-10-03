import { GenerationErrorNotice } from "@/components/billing/GenerationErrorNotice";
import { modelName } from "@/components/billing/plans";
import { Laurel } from "@/components/brand/Laurel";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import type { Generation, QueuedGeneration } from "@/types";
import { ImagePlusIcon, MoreHorizontalIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { type ImageActionCosts, type ViewerImage, absoluteUrl, cssAspect } from "../viewer/media";

/** Live progress for an in-flight generation, capped at 95% until the server answers. */
function useProgress(startedAt: string | undefined, estimatedSeconds: number | undefined) {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!startedAt) return;
		const t = setInterval(() => setNow(Date.now()), 500);
		return () => clearInterval(t);
	}, [startedAt]);
	if (!startedAt) return { progress: 0, secondsLeft: undefined };
	const elapsed = (now - new Date(startedAt).getTime()) / 1000;
	const total = estimatedSeconds || 30;
	return {
		progress: Math.min(0.95, Math.max(0.03, elapsed / total)),
		secondsLeft: Math.max(0, Math.ceil(total - elapsed)),
	};
}

function creditLabel(n: number | undefined): string | null {
	if (n === undefined) return null;
	return n === 0 ? "No credits" : `${n} ${n === 1 ? "credit" : "credits"}`;
}

export interface StepMenuActions {
	onUseAsReference?: (image: ViewerImage) => void;
	onVary?: (image: ViewerImage) => void;
	onUpscale?: (image: ViewerImage) => void;
	onReusePrompt?: (prompt: string) => void;
	onDownload: (image: ViewerImage) => void;
	onShare?: (generationId: string) => void;
	onTrash?: (generationId: string) => void;
	costs?: ImageActionCosts;
}

interface CompletedStepProps extends StepMenuActions {
	generation: Generation;
	images: ViewerImage[];
	number: number;
	selected: boolean;
	referenceUrls: string[];
	onSelect: () => void;
	onOpen: (image: ViewerImage) => void;
}

const costSuffix = (n: number | undefined) =>
	n === undefined ? "" : ` · ${creditLabel(n)?.toLowerCase()}`;

/** A finished step: its image (or its set of four), the instruction that made it, model and cost. */
export function CompletedStep({
	generation,
	images,
	number,
	selected,
	referenceUrls,
	onSelect,
	onOpen,
	...menu
}: CompletedStepProps) {
	const isSet = images.length > 1;
	const first = images[0];
	const credits = creditLabel(
		typeof generation.parameters?.creditsCharged === "number"
			? generation.parameters.creditsCharged
			: undefined,
	);
	const referenced = images.some((img) => referenceUrls.includes(img.url));

	return (
		<figure className="m-0 flex min-w-0 flex-col gap-2.5">
			<div
				className={cn(
					"rounded-xl outline-2 outline-offset-3 transition-[outline-color]",
					selected ? "outline-verdigris" : "outline-transparent",
				)}
			>
				{isSet ? (
					<div className="grid grid-cols-2 gap-1 overflow-hidden rounded-xl">
						{images.map((img, i) => (
							<button
								key={img.key}
								type="button"
								onClick={() => {
									onSelect();
									onOpen(img);
								}}
								className="relative block aspect-square overflow-hidden bg-muted outline-none focus-visible:ring-3 focus-visible:ring-ring/60 focus-visible:ring-inset"
								aria-label={`Open image ${i + 1} of ${images.length}`}
							>
								<img
									src={absoluteUrl(img.url)}
									alt=""
									loading="lazy"
									className="h-full w-full object-cover"
								/>
								{referenceUrls.includes(img.url) && (
									<span className="absolute bottom-1 left-1 rounded-full bg-verdigris px-1.5 py-0.5 text-[0.7rem] font-medium text-background">
										Reference
									</span>
								)}
							</button>
						))}
					</div>
				) : first ? (
					<button
						type="button"
						onClick={() => {
							onSelect();
							onOpen(first);
						}}
						className="block w-full overflow-hidden rounded-xl bg-muted outline-none focus-visible:ring-3 focus-visible:ring-ring/60"
						aria-label="Open image"
					>
						<img
							src={absoluteUrl(first.url)}
							alt={generation.prompt}
							loading="lazy"
							className="block h-auto w-full"
						/>
					</button>
				) : null}
			</div>

			<figcaption className="flex min-w-0 flex-col gap-1.5">
				<button
					type="button"
					onClick={onSelect}
					className="text-left text-sm leading-snug font-medium text-foreground outline-none focus-visible:underline"
					aria-pressed={selected}
					title={generation.prompt}
				>
					<span className="line-clamp-3">{generation.prompt}</span>
				</button>
				<div className="flex items-center gap-1">
					<p className="min-w-0 flex-1 text-xs leading-snug text-muted-foreground">
						<span>Step {number}</span>
						<span aria-hidden="true"> · </span>
						<span>{modelName(generation.model)}</span>
						{credits && (
							<>
								<span aria-hidden="true"> · </span>
								<span>{credits}</span>
							</>
						)}
						{selected && <span className="sr-only">, selected</span>}
					</p>
					<StepMenu generation={generation} image={first} isSet={isSet} {...menu} />
				</div>
				{selected && menu.onUseAsReference && first && (
					<Button
						variant="outline"
						size="sm"
						className="h-9 self-start"
						onClick={() => (isSet ? onOpen(first) : menu.onUseAsReference?.(first))}
					>
						<ImagePlusIcon />
						{referenced ? "Reference added" : isSet ? "Pick a reference" : "Use as reference"}
					</Button>
				)}
			</figcaption>
		</figure>
	);
}

function StepMenu({
	generation,
	image,
	isSet,
	onUseAsReference,
	onVary,
	onUpscale,
	onReusePrompt,
	onDownload,
	onShare,
	onTrash,
	costs,
}: StepMenuActions & { generation: Generation; image?: ViewerImage; isSet: boolean }) {
	if (!image) return null;
	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				render={
					<Button variant="ghost" size="icon" className="-mr-2 shrink-0 text-muted-foreground" />
				}
				aria-label="Step actions"
			>
				<MoreHorizontalIcon />
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="w-auto min-w-52">
				{onUseAsReference && !isSet && (
					<DropdownMenuItem onClick={() => onUseAsReference(image)}>
						Use as reference
					</DropdownMenuItem>
				)}
				{onVary && (
					<DropdownMenuItem
						onClick={() => onVary(image)}
					>{`Vary${costSuffix(costs?.vary)}`}</DropdownMenuItem>
				)}
				{onUpscale && !isSet && (
					<DropdownMenuItem
						onClick={() => onUpscale(image)}
					>{`Upscale${costSuffix(costs?.upscale)}`}</DropdownMenuItem>
				)}
				{onReusePrompt && (
					<DropdownMenuItem onClick={() => onReusePrompt(generation.prompt)}>
						Reuse prompt
					</DropdownMenuItem>
				)}
				<DropdownMenuItem onClick={() => onDownload(image)}>
					{isSet ? "Download first image" : "Download"}
				</DropdownMenuItem>
				{onShare && (
					<DropdownMenuItem onClick={() => onShare(generation.id)}>
						Copy share link
					</DropdownMenuItem>
				)}
				{onTrash && (
					<>
						<DropdownMenuSeparator />
						<DropdownMenuItem variant="destructive" onClick={() => onTrash(generation.id)}>
							{isSet ? "Move set to Trash" : "Move to Trash"}
						</DropdownMenuItem>
					</>
				)}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

/** A step still rendering: holds its final shape with the laurel gilding as it goes. */
export function PendingStep({
	item,
	number,
	fallbackAspect,
}: { item: QueuedGeneration; number: number; fallbackAspect?: string }) {
	const { progress, secondsLeft } = useProgress(
		item.status === "generating" ? item.startedAt : undefined,
		item.estimatedDuration,
	);
	const aspect = cssAspect(item.aspectRatio) ?? cssAspect(fallbackAspect) ?? "1 / 1";
	const generating = item.status === "generating" && !!item.startedAt;
	const status = generating
		? secondsLeft && secondsLeft > 0
			? `Rendering, about ${secondsLeft} s left`
			: "Rendering, almost there"
		: "Queued";

	return (
		<figure className="m-0 flex min-w-0 flex-col gap-2.5" aria-busy="true">
			<div
				className="relative grid place-items-center overflow-hidden rounded-xl bg-muted"
				style={{ aspectRatio: aspect }}
			>
				<Laurel progress={generating ? progress : 0} className="w-[46%] max-w-40" />
				<progress className="sr-only" max={100} value={generating ? Math.round(progress * 100) : 0}>
					Rendering
				</progress>
			</div>
			<figcaption className="flex min-w-0 flex-col gap-1">
				<p className="line-clamp-3 text-sm leading-snug font-medium text-foreground">
					{item.prompt}
				</p>
				<p className="text-xs leading-snug text-muted-foreground">
					<span>Step {number}</span>
					<span aria-hidden="true"> · </span>
					<span>{modelName(item.model)}</span>
					<span aria-hidden="true"> · </span>
					<span className={generating ? "text-verdigris" : undefined}>{status}</span>
				</p>
			</figcaption>
		</figure>
	);
}

/** A step that failed: what happened, in plain words, with Retry and Dismiss. */
export function FailedStep({
	item,
	onRetry,
	onDismiss,
}: {
	item: QueuedGeneration;
	onRetry?: (item: QueuedGeneration) => void;
	onDismiss?: (id: string) => void;
}) {
	const withHandlers: QueuedGeneration = {
		...item,
		onRetry: item.onRetry ?? (onRetry ? () => onRetry(item) : undefined),
		onDismiss: item.onDismiss ?? (onDismiss ? () => onDismiss(item.id) : undefined),
	};
	return <GenerationErrorNotice item={withHandlers} showPrompt />;
}
