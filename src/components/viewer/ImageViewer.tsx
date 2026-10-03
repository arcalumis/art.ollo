import { modelName } from "@/components/billing/plans";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/contexts/AuthContext";
import { cn } from "@/lib/utils";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import {
	ArchiveIcon,
	ArchiveRestoreIcon,
	ChevronLeftIcon,
	ChevronRightIcon,
	CopyIcon,
	DownloadIcon,
	ImagePlusIcon,
	Link2Icon,
	MaximizeIcon,
	MinimizeIcon,
	RotateCcwIcon,
	Trash2Icon,
	XIcon,
} from "lucide-react";
import {
	type KeyboardEvent,
	type ReactNode,
	type TouchEvent,
	useEffect,
	useRef,
	useState,
} from "react";
import {
	type ImageActionCosts,
	type ImageTool,
	type ViewerImage,
	absoluteUrl,
	copyPrompt,
	copyShareLink,
	creditsOf,
	downloadImage,
	formatDate,
	promptOf,
	shortTitle,
} from "./media";

export interface ImageViewerActions {
	/** Four new variations of this image. */
	onVary?: (image: ViewerImage) => void;
	onTool?: (image: ViewerImage, tool: ImageTool) => void;
	/** "Edit": put this image in the prompt bar as the reference for the next step. */
	onUseAsReference?: (image: ViewerImage) => void;
	/** URLs currently in the prompt bar, so the button can say "Reference added". */
	referenceUrls?: string[];
	/** Put the prompt back in the prompt bar. */
	onReusePrompt?: (prompt: string, image: ViewerImage) => void;
	onTrash?: (image: ViewerImage) => void;
	onRestore?: (image: ViewerImage) => void;
	/** Permanent delete; the viewer asks for confirmation through `onDelete`'s caller. */
	onDelete?: (image: ViewerImage) => void;
	onArchive?: (image: ViewerImage) => void;
	onUnarchive?: (image: ViewerImage) => void;
	costs?: ImageActionCosts;
}

interface ImageViewerProps extends ImageViewerActions {
	images: ViewerImage[];
	/** Index of the open image; null when closed. */
	index: number | null;
	onIndexChange: (index: number | null) => void;
}

function cost(n: number | undefined): string {
	return n === undefined ? "" : n === 0 ? "free" : `${n} ${n === 1 ? "credit" : "credits"}`;
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
	return (
		<>
			<dt className="text-muted-foreground">{label}</dt>
			<dd className="m-0 tabular-nums text-foreground">{children}</dd>
		</>
	);
}

function ActionButton({
	onClick,
	icon,
	children,
	price,
	className,
	variant = "outline",
}: {
	onClick: () => void;
	icon?: ReactNode;
	children: ReactNode;
	price?: number;
	className?: string;
	variant?: "outline" | "secondary" | "ghost";
}) {
	return (
		<Button variant={variant} onClick={onClick} className={cn("h-10 justify-center", className)}>
			{icon}
			<span>{children}</span>
			{price !== undefined && (
				<span className="font-normal text-muted-foreground tabular-nums">{cost(price)}</span>
			)}
		</Button>
	);
}

/**
 * The one image viewer: the image as large as the screen allows, and a rail (a bottom panel on
 * phones) with the prompt, the facts and every action with its cost. Base UI's Dialog handles
 * focus, Escape and focus return; arrow keys and swipes move within `images`.
 */
export function ImageViewer({ images, index, onIndexChange, ...actions }: ImageViewerProps) {
	const { token } = useAuth();
	const open = index !== null && images.length > 0;
	const safeIndex =
		index === null ? 0 : Math.min(Math.max(index, 0), Math.max(images.length - 1, 0));
	const image = open ? images[safeIndex] : null;
	const [zoomed, setZoomed] = useState(false);
	const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
	const touch = useRef<{ x: number; y: number } | null>(null);

	// A new image starts fitted to the screen.
	// biome-ignore lint/correctness/useExhaustiveDependencies: reset on image change only
	useEffect(() => {
		setZoomed(false);
		setNatural(null);
	}, [image?.key]);

	const count = images.length;
	const go = (delta: number) => {
		if (!open || count < 2) return;
		onIndexChange((safeIndex + delta + count) % count);
	};

	const onKeyDown = (e: KeyboardEvent) => {
		const target = e.target as HTMLElement;
		if (target.closest("input, textarea, [role='menu']")) return;
		if (e.key === "ArrowRight") {
			e.preventDefault();
			go(1);
		} else if (e.key === "ArrowLeft") {
			e.preventDefault();
			go(-1);
		}
	};

	const onTouchStart = (e: TouchEvent) => {
		const t = e.touches[0];
		touch.current = { x: t.clientX, y: t.clientY };
	};
	const onTouchEnd = (e: TouchEvent) => {
		const start = touch.current;
		touch.current = null;
		if (!start || zoomed) return;
		const t = e.changedTouches[0];
		const dx = t.clientX - start.x;
		const dy = t.clientY - start.y;
		if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) go(dx < 0 ? 1 : -1);
	};

	const gen = image?.generation;
	const prompt = image ? promptOf(image) : "";
	const isUpload = image?.kind === "upload";
	const trashed = !!(gen?.deletedAt ?? image?.upload?.deletedAt);
	const archived = !!(gen?.archivedAt ?? image?.upload?.archivedAt);
	const credits = creditsOf(gen);
	const width = natural?.w ?? gen?.width;
	const height = natural?.h ?? gen?.height;
	const isReference = !!image && !!actions.referenceUrls?.includes(image.url);
	const title = isUpload ? (image?.upload?.originalName ?? "Upload") : shortTitle(prompt);
	const closeAfter = (fn: () => void) => () => {
		fn();
		onIndexChange(null);
	};

	return (
		<DialogPrimitive.Root open={open} onOpenChange={(next) => !next && onIndexChange(null)}>
			<DialogPrimitive.Portal>
				<DialogPrimitive.Backdrop className="fixed inset-0 z-50 bg-scrim duration-150 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0" />
				<DialogPrimitive.Popup
					onKeyDown={onKeyDown}
					className={cn(
						"fixed inset-0 z-50 flex flex-col overflow-hidden bg-card text-card-foreground outline-none",
						"lg:inset-4 lg:grid lg:grid-cols-[minmax(0,1fr)_22rem] lg:rounded-2xl lg:border lg:border-border",
						"duration-150 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-[0.98] data-closed:animate-out data-closed:fade-out-0",
					)}
				>
					{image && (
						<>
							{/* The image well */}
							<div
								className="relative flex min-h-0 flex-1 flex-col bg-background"
								onTouchStart={onTouchStart}
								onTouchEnd={onTouchEnd}
							>
								<div className="flex shrink-0 items-center justify-between gap-2 px-3 pt-3 pb-1 sm:px-4">
									<p
										className="min-w-0 truncate text-sm text-muted-foreground tabular-nums"
										aria-live="polite"
									>
										{count > 1 ? `${safeIndex + 1} of ${count}` : " "}
									</p>
									<div className="flex items-center gap-1">
										<Button
											variant="ghost"
											size="icon"
											onClick={() => setZoomed((z) => !z)}
											aria-pressed={zoomed}
											aria-label={zoomed ? "Fit to screen" : "Actual size"}
											title={zoomed ? "Fit to screen" : "Actual size"}
										>
											{zoomed ? <MinimizeIcon /> : <MaximizeIcon />}
										</Button>
										<DialogPrimitive.Close
											render={
												<Button variant="ghost" size="icon" aria-label="Close" title="Close" />
											}
										>
											<XIcon />
										</DialogPrimitive.Close>
									</div>
								</div>

								<div
									className={cn(
										"relative min-h-0 flex-1",
										zoomed
											? "overflow-auto"
											: "flex items-center justify-center overflow-hidden p-3 sm:p-6",
									)}
								>
									<button
										type="button"
										onClick={() => setZoomed((z) => !z)}
										className={cn(
											"block outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
											zoomed ? "m-auto cursor-zoom-out" : "h-full w-full cursor-zoom-in",
										)}
										aria-label={zoomed ? "Fit to screen" : "Show at actual size"}
									>
										<img
											key={image.key}
											src={absoluteUrl(image.url)}
											alt={prompt || title}
											onLoad={(e) =>
												setNatural({
													w: e.currentTarget.naturalWidth,
													h: e.currentTarget.naturalHeight,
												})
											}
											className={cn(
												"select-none",
												zoomed ? "max-w-none" : "h-full w-full object-contain",
												trashed && "opacity-60 grayscale",
											)}
											draggable={false}
										/>
									</button>
								</div>

								{count > 1 && (
									<>
										<Button
											variant="secondary"
											size="icon"
											onClick={() => go(-1)}
											aria-label="Previous image"
											className="absolute top-1/2 left-3 -translate-y-1/2 rounded-full opacity-90 max-sm:hidden"
										>
											<ChevronLeftIcon />
										</Button>
										<Button
											variant="secondary"
											size="icon"
											onClick={() => go(1)}
											aria-label="Next image"
											className="absolute top-1/2 right-3 -translate-y-1/2 rounded-full opacity-90 max-sm:hidden"
										>
											<ChevronRightIcon />
										</Button>
									</>
								)}
							</div>

							{/* The rail */}
							<aside className="flex max-h-[46dvh] shrink-0 flex-col gap-5 overflow-y-auto border-t border-border px-4 pt-4 pb-[max(1rem,env(safe-area-inset-bottom))] lg:max-h-none lg:border-t-0 lg:border-l lg:p-5">
								<div className="flex flex-col gap-3">
									<DialogPrimitive.Title className="text-lg leading-snug font-semibold text-foreground">
										{title}
									</DialogPrimitive.Title>
									{!isUpload && prompt && (
										<div className="rounded-lg bg-muted p-3">
											<DialogPrimitive.Description className="text-[0.95rem] leading-relaxed whitespace-pre-wrap text-foreground">
												{prompt}
											</DialogPrimitive.Description>
											<Button
												variant="ghost"
												size="sm"
												className="mt-2 -ml-1.5"
												onClick={() => void copyPrompt(prompt)}
											>
												<CopyIcon />
												Copy prompt
											</Button>
										</div>
									)}
									{trashed && (
										<p className="text-sm text-muted-foreground">
											In Trash. Restore it to use it again, or delete it for good.
										</p>
									)}
								</div>

								<dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
									{gen && <Fact label="Model">{modelName(gen.model)}</Fact>}
									{isUpload && <Fact label="Source">Your upload</Fact>}
									{width && height ? (
										<Fact label="Size">
											{width} × {height}
										</Fact>
									) : null}
									{credits !== undefined && <Fact label="Cost">{cost(credits)}</Fact>}
									{(gen?.createdAt ?? image.upload?.createdAt) && (
										<Fact label="Made">
											{formatDate(gen?.createdAt ?? image.upload?.createdAt)}
										</Fact>
									)}
									{image.setSize ? (
										<Fact label="Set">{`Image ${(image.setIndex ?? 0) + 1} of ${image.setSize}`}</Fact>
									) : null}
								</dl>

								{trashed ? (
									<div className="grid grid-cols-2 gap-2">
										{actions.onRestore && (
											<ActionButton
												variant="secondary"
												icon={<RotateCcwIcon />}
												onClick={closeAfter(() => actions.onRestore?.(image))}
											>
												Restore
											</ActionButton>
										)}
										{actions.onDelete && (
											<Button
												variant="destructive"
												className="h-10"
												onClick={() => actions.onDelete?.(image)}
											>
												<Trash2Icon />
												Delete forever
											</Button>
										)}
									</div>
								) : (
									<div className="grid grid-cols-2 gap-2">
										{gen && actions.onVary && (
											<ActionButton
												onClick={closeAfter(() => actions.onVary?.(image))}
												price={actions.costs?.vary}
											>
												Vary
											</ActionButton>
										)}
										{gen && actions.onTool && (
											<ActionButton
												onClick={closeAfter(() => actions.onTool?.(image, "upscale"))}
												price={actions.costs?.upscale}
											>
												Upscale
											</ActionButton>
										)}
										{gen &&
											actions.onTool &&
											actions.costs?.["remove-background"] !== undefined && (
												<ActionButton
													className="col-span-2"
													onClick={closeAfter(() => actions.onTool?.(image, "remove-background"))}
													price={actions.costs?.["remove-background"]}
												>
													Remove background
												</ActionButton>
											)}
										{actions.onUseAsReference && (
											<ActionButton
												icon={<ImagePlusIcon />}
												onClick={closeAfter(() => actions.onUseAsReference?.(image))}
											>
												{isReference ? "Reference added" : "Edit"}
											</ActionButton>
										)}
										{gen && actions.onReusePrompt && (
											<ActionButton
												onClick={closeAfter(() => actions.onReusePrompt?.(prompt, image))}
											>
												Reuse prompt
											</ActionButton>
										)}
										<ActionButton
											variant="secondary"
											className="col-span-2"
											icon={<DownloadIcon />}
											onClick={() => void downloadImage(image)}
										>
											Download
										</ActionButton>
									</div>
								)}

								{!trashed && (
									<div className="-ml-2 flex flex-wrap gap-1">
										{gen && token && (
											<Button variant="ghost" onClick={() => void copyShareLink(token, gen.id)}>
												<Link2Icon />
												Copy share link
											</Button>
										)}
										{archived && actions.onUnarchive && (
											<Button
												variant="ghost"
												onClick={closeAfter(() => actions.onUnarchive?.(image))}
											>
												<ArchiveRestoreIcon />
												Move out of Archive
											</Button>
										)}
										{!archived && actions.onArchive && (
											<Button
												variant="ghost"
												onClick={closeAfter(() => actions.onArchive?.(image))}
											>
												<ArchiveIcon />
												Archive
											</Button>
										)}
										{actions.onTrash && (
											<Button
												variant="ghost"
												className="text-destructive hover:text-destructive"
												onClick={closeAfter(() => actions.onTrash?.(image))}
											>
												<Trash2Icon />
												{isUpload
													? "Delete upload"
													: image.setSize
														? "Move set to Trash"
														: "Move to Trash"}
											</Button>
										)}
									</div>
								)}
							</aside>
						</>
					)}
				</DialogPrimitive.Popup>
			</DialogPrimitive.Portal>
		</DialogPrimitive.Root>
	);
}
