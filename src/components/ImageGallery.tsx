import { modelName } from "@/components/billing/plans";
import { Laurel } from "@/components/brand/Laurel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAuth } from "@/contexts/AuthContext";
import { cn } from "@/lib/utils";
import { SearchIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { API_BASE } from "../config";
import type { Generation, HistoryResponse, QueuedGeneration, Upload } from "../types";
import { ConfirmDialog } from "./viewer/ConfirmDialog";
import { ImageViewer } from "./viewer/ImageViewer";
import {
	type ImageActionCosts,
	type ImageTool,
	TRASH_RETENTION_DAYS,
	type ViewerImage,
	absoluteUrl,
	asGeneration,
	cssAspect,
	imagesOf,
	parseDate,
	trashWithUndo,
	uploadImage,
} from "./viewer/media";

type View = "images" | "uploads" | "archive" | "trash";

export interface ImageGalleryProps {
	/** The app's loaded history (shown until the gallery's own fetch lands, and used as a refresh signal). */
	generations: Generation[];
	uploads?: Upload[];
	queuedItems?: QueuedGeneration[];
	onTrash?: (id: string) => unknown;
	onRestore?: (id: string) => unknown;
	onDelete?: (id: string) => unknown;
	onArchive?: (id: string) => unknown;
	onUnarchive?: (id: string) => unknown;
	onArchiveUpload?: (id: string) => unknown;
	onUnarchiveUpload?: (id: string) => unknown;
	onDeleteUpload?: (id: string) => unknown;
	onDismissQueueItem?: (id: string) => void;
	/** Toggle an image in the prompt bar's references ("Edit" in the viewer). */
	onAddToInputs?: (imageUrl: string) => void;
	selectedInputUrls?: string[];
	/** Legacy paging props; the gallery now pages its own results. */
	onLoadMore?: () => void;
	hasMore?: boolean;
	loading?: boolean;
	/** Open on Trash / Archive instead of all images. */
	showTrash?: boolean;
	showArchived?: boolean;

	// ---- Phase 4 (all optional) ----
	onVariations?: (gen: Generation) => void;
	onVaryImage?: (imageUrl: string, prompt: string) => void;
	onUpscale?: (gen: Generation) => void;
	onTool?: (image: ViewerImage, tool: ImageTool) => void;
	/** "Edit": use as the reference for the next prompt (defaults to onAddToInputs). */
	onUseAsReference?: (image: ViewerImage) => void;
	onReusePrompt?: (prompt: string) => void;
	actionCosts?: ImageActionCosts;
}

const PAGE = 40;

function daysLeft(deletedAt: string | undefined): number | null {
	const d = parseDate(deletedAt);
	if (!d) return null;
	const left = TRASH_RETENTION_DAYS - (Date.now() - d.getTime()) / 86_400_000;
	return Math.max(0, Math.ceil(left));
}

function useDebounced<T>(value: T, ms: number): T {
	const [v, setV] = useState(value);
	useEffect(() => {
		const t = setTimeout(() => setV(value), ms);
		return () => clearTimeout(t);
	}, [value, ms]);
	return v;
}

/**
 * Every image: a uniform grid with search and a model filter, plus Uploads, Archive and Trash.
 * Moving to Trash offers Undo; Trash explains how long it keeps things.
 */
export function ImageGallery({
	generations,
	uploads = [],
	queuedItems = [],
	onTrash,
	onRestore,
	onDelete,
	onArchive,
	onUnarchive,
	onArchiveUpload,
	onUnarchiveUpload,
	onDeleteUpload,
	onDismissQueueItem,
	onAddToInputs,
	selectedInputUrls = [],
	showTrash = false,
	showArchived = false,
	onVariations,
	onVaryImage,
	onUpscale,
	onTool,
	onUseAsReference,
	onReusePrompt,
	actionCosts,
}: ImageGalleryProps) {
	const { token } = useAuth();
	const [view, setView] = useState<View>(showTrash ? "trash" : showArchived ? "archive" : "images");
	const [query, setQuery] = useState("");
	const [model, setModel] = useState<string>("all");
	const q = useDebounced(query.trim(), 300);

	const [items, setItems] = useState<Generation[] | null>(null);
	const [total, setTotal] = useState(0);
	const [models, setModels] = useState<string[]>([]);
	const [page, setPage] = useState(1);
	const [fetching, setFetching] = useState(false);
	const [archivedUploads, setArchivedUploads] = useState<Upload[]>([]);
	const [viewerIndex, setViewerIndex] = useState<number | null>(null);
	const [confirm, setConfirm] = useState<ViewerImage | null>(null);
	const requestId = useRef(0);

	const api = useCallback(
		async (method: string, path: string, body?: unknown) => {
			if (!token) return false;
			const res = await fetch(`${API_BASE}${path}`, {
				method,
				headers: {
					Authorization: `Bearer ${token}`,
					...(body ? { "Content-Type": "application/json" } : {}),
				},
				body: body ? JSON.stringify(body) : undefined,
			}).catch(() => null);
			return !!res?.ok;
		},
		[token],
	);

	const load = useCallback(
		async (pageNo: number) => {
			if (!token || view === "uploads") return;
			const id = ++requestId.current;
			setFetching(true);
			const params = new URLSearchParams({
				page: String(pageNo),
				limit: String(PAGE),
				trash: String(view === "trash"),
				archived: String(view === "archive"),
			});
			if (q) params.set("q", q);
			if (model !== "all") params.set("model", model);
			try {
				const res = await fetch(`${API_BASE}/api/history?${params}`, {
					headers: { Authorization: `Bearer ${token}` },
				});
				if (!res.ok) throw new Error(String(res.status));
				const data = (await res.json()) as HistoryResponse & { models?: string[] };
				if (id !== requestId.current) return;
				setItems((prev) =>
					pageNo === 1 || !prev ? data.generations : [...prev, ...data.generations],
				);
				setTotal(data.total);
				setModels(data.models ?? []);
				setPage(pageNo);
			} catch {
				if (id === requestId.current)
					toast.error("Couldn't load images. Check your connection and try again.");
			} finally {
				if (id === requestId.current) setFetching(false);
			}
		},
		[token, view, q, model],
	);

	// Reload on view/filter change, and when the app's history changes (a new image landed).
	const signal = generations[0]?.id ?? "";
	// biome-ignore lint/correctness/useExhaustiveDependencies: `signal` is a deliberate refresh trigger
	useEffect(() => {
		load(1);
	}, [load, signal]);

	useEffect(() => {
		if (view !== "archive" || !token) return;
		fetch(`${API_BASE}/api/uploads?archived=true`, {
			headers: { Authorization: `Bearer ${token}` },
		})
			.then((r) => (r.ok ? r.json() : { uploads: [] }))
			.then((d: { uploads: Upload[] }) => setArchivedUploads(d.uploads ?? []))
			.catch(() => setArchivedUploads([]));
	}, [view, token]);

	// Until the first fetch lands, the "images" view shows what the app already has.
	const shown: Generation[] = items ?? (view === "images" ? generations : []);
	const hasMore = items !== null && items.length < total;
	const filtered = !!q || model !== "all";

	const sentinel = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const el = sentinel.current;
		if (!el || !hasMore || fetching) return;
		const io = new IntersectionObserver((entries) => entries[0]?.isIntersecting && load(page + 1), {
			rootMargin: "400px",
		});
		io.observe(el);
		return () => io.disconnect();
	}, [hasMore, fetching, load, page]);

	// The viewer walks every image in view, sets included.
	const tileUploads = view === "uploads" ? uploads : view === "archive" ? archivedUploads : [];
	const viewerImages = useMemo(
		() => [...shown.flatMap(imagesOf), ...tileUploads.map(uploadImage)],
		[shown, tileUploads],
	);
	const openAt = (key: string) => {
		const i = viewerImages.findIndex((v) => v.key === key);
		setViewerIndex(i >= 0 ? i : null);
	};

	const dropLocal = (id: string) => setItems((prev) => prev?.filter((g) => g.id !== id) ?? prev);
	const refresh = () => load(1);

	const trash = async (id: string) => {
		const restore = async (rid: string) => {
			if (onRestore) await onRestore(rid);
			else await api("PATCH", `/api/history/${rid}`, { deleted: false });
			refresh();
		};
		await trashWithUndo(
			id,
			async (tid) => {
				dropLocal(tid);
				if (onTrash) await onTrash(tid);
				else await api("PATCH", `/api/history/${tid}`, { deleted: true });
			},
			restore,
		);
	};
	const restore = async (id: string) => {
		dropLocal(id);
		if (onRestore) await onRestore(id);
		else await api("PATCH", `/api/history/${id}`, { deleted: false });
		toast.success("Restored");
		refresh();
	};
	const archive = async (id: string, archived: boolean) => {
		dropLocal(id);
		const handler = archived ? onArchive : onUnarchive;
		if (handler) await handler(id);
		else await api("PATCH", `/api/history/${id}/archive`, { archived });
		toast(archived ? "Moved to Archive" : "Moved back to your images", {
			action: { label: "Undo", onClick: () => void archive(id, !archived) },
		});
		refresh();
	};
	const confirmDelete = async () => {
		const image = confirm;
		setConfirm(null);
		setViewerIndex(null);
		if (!image) return;
		if (image.kind === "upload" && image.upload) {
			const id = image.upload.id;
			if (onDeleteUpload) await onDeleteUpload(id);
			else await api("DELETE", `/api/uploads/${id}`);
			setArchivedUploads((prev) => prev.filter((u) => u.id !== id));
			toast.success("Upload deleted");
			return;
		}
		if (image.generation) {
			const id = image.generation.id;
			dropLocal(id);
			if (onDelete) await onDelete(id);
			else await api("DELETE", `/api/history/${id}`);
			toast.success("Deleted for good");
			refresh();
		}
	};
	const archiveUpload = async (id: string, archived: boolean) => {
		const handler = archived ? onArchiveUpload : onUnarchiveUpload;
		if (handler) await handler(id);
		else await api("PATCH", `/api/uploads/${id}/archive`, { archived });
		if (!archived) setArchivedUploads((prev) => prev.filter((u) => u.id !== id));
		toast(archived ? "Upload archived" : "Upload moved back");
	};

	const useAsReference =
		onUseAsReference ??
		(onAddToInputs ? (image: ViewerImage) => onAddToInputs(image.url) : undefined);
	const vary =
		onVariations || onVaryImage
			? (image: ViewerImage) => {
					const gen = asGeneration(image);
					if (!gen) return;
					if (image.setSize && onVaryImage) onVaryImage(image.url, gen.prompt);
					else if (onVariations) onVariations(gen);
					else onVaryImage?.(image.url, gen.prompt);
				}
			: undefined;
	const tool =
		onTool ??
		(onUpscale
			? (image: ViewerImage, which: ImageTool) => {
					const gen = asGeneration(image);
					if (gen && which === "upscale") onUpscale(gen);
				}
			: undefined);

	const pendingItems = view === "images" && !filtered ? queuedItems : [];
	const empty = shown.length === 0 && tileUploads.length === 0 && pendingItems.length === 0;
	const loadingFirst = items === null && fetching && shown.length === 0;

	return (
		<div className="mx-auto flex w-full max-w-6xl flex-col gap-5">
			<header className="flex flex-col gap-4">
				{/* The page title comes from the app shell's library header. */}
				<Tabs
					value={view}
					onValueChange={(v) => {
						setView(v as View);
						setItems(null);
						setViewerIndex(null);
					}}
				>
					<div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
						<TabsList className="h-10 group-data-horizontal/tabs:h-10">
							<TabsTrigger value="images" className="px-3">
								All images
							</TabsTrigger>
							<TabsTrigger value="uploads" className="px-3">
								Uploads
							</TabsTrigger>
							<TabsTrigger value="archive" className="px-3">
								Archive
							</TabsTrigger>
							<TabsTrigger value="trash" className="px-3">
								Trash
							</TabsTrigger>
						</TabsList>
					</div>
				</Tabs>

				{view !== "uploads" && (
					<div className="flex flex-col gap-2 sm:flex-row">
						<div className="relative flex-1">
							<SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
							<Input
								type="search"
								value={query}
								onChange={(e) => setQuery(e.target.value)}
								placeholder="Search your prompts"
								aria-label="Search your prompts"
								className="h-10 pr-9 pl-9"
							/>
							{query && (
								<Button
									variant="ghost"
									size="icon-sm"
									className="absolute top-1/2 right-1.5 -translate-y-1/2"
									onClick={() => setQuery("")}
									aria-label="Clear search"
								>
									<XIcon />
								</Button>
							)}
						</div>
						<Select value={model} onValueChange={(v) => setModel((v as string) ?? "all")}>
							<SelectTrigger
								className="h-10 w-full data-[size=default]:h-10 sm:w-56"
								aria-label="Filter by model"
							>
								<SelectValue>
									{(v: string) => (v === "all" ? "All models" : modelName(v))}
								</SelectValue>
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="all">All models</SelectItem>
								{models.map((m) => (
									<SelectItem key={m} value={m}>
										{modelName(m)}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>
				)}

				{view === "trash" && (
					<p className="max-w-prose text-sm text-muted-foreground">
						Images stay in Trash for {TRASH_RETENTION_DAYS} days, then they're deleted for good.
						Restore one to put it back with your images.
					</p>
				)}
				{view === "archive" && (
					<p className="max-w-prose text-sm text-muted-foreground">
						Archived images are out of the way but kept. They don't count toward anything and never
						expire.
					</p>
				)}
			</header>

			{loadingFirst ? (
				<div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
					{Array.from({ length: 10 }, (_, i) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: static placeholders
						<Skeleton key={i} className="aspect-square rounded-xl" />
					))}
				</div>
			) : empty ? (
				<div className="flex min-h-[30vh] flex-col items-center justify-center gap-1 text-center">
					<p className="font-medium text-foreground">
						{filtered
							? "No images match"
							: view === "trash"
								? "Trash is empty"
								: view === "archive"
									? "Nothing archived"
									: view === "uploads"
										? "No uploads yet"
										: "No images yet"}
					</p>
					<p className="max-w-xs text-sm text-muted-foreground">
						{filtered
							? "Try other words, or clear the model filter."
							: view === "uploads"
								? "Images you upload as references show up here."
								: view === "images"
									? "Describe an image in the prompt bar to make your first one."
									: ""}
					</p>
				</div>
			) : (
				<ul
					className="m-0 grid list-none grid-cols-2 gap-2 p-0 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5"
					aria-label="Images"
				>
					{pendingItems.map((item) => (
						<li
							key={item.id}
							className="relative aspect-square overflow-hidden rounded-xl bg-muted"
						>
							{item.status === "failed" ? (
								<div className="flex h-full flex-col items-center justify-center gap-2 p-3 text-center">
									<p className="text-sm font-medium text-foreground">This one didn't finish</p>
									{onDismissQueueItem && (
										<Button size="sm" variant="ghost" onClick={() => onDismissQueueItem(item.id)}>
											Dismiss
										</Button>
									)}
								</div>
							) : (
								<div
									className="grid h-full place-items-center"
									style={{ aspectRatio: cssAspect(item.aspectRatio) }}
								>
									{item.live?.phase === "waiting_gpu" ? (
										<Laurel indeterminate className="w-1/2" label="Waiting for a GPU" />
									) : (
										<Laurel
											progress={item.status === "generating" ? 0.5 : 0}
											className="w-1/2"
											label={item.live?.phase === "saving" ? "Saving" : "Rendering"}
										/>
									)}
								</div>
							)}
						</li>
					))}
					{shown.map((gen) => {
						const set = imagesOf(gen);
						const first = set[0];
						if (!first) return null;
						const left = view === "trash" ? daysLeft(gen.deletedAt) : null;
						const isRef = set.some((img) => selectedInputUrls.includes(img.url));
						return (
							<li key={gen.id} className="relative">
								<button
									type="button"
									onClick={() => openAt(first.key)}
									className={cn(
										"group block aspect-square w-full overflow-hidden rounded-xl bg-muted outline-2 outline-offset-2 outline-transparent focus-visible:outline-ring",
										isRef && "outline-verdigris",
									)}
									aria-label={`Open: ${gen.prompt}`}
								>
									<img
										src={absoluteUrl(first.url)}
										alt=""
										loading="lazy"
										className={cn(
											"h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.02]",
											view === "trash" && "opacity-70 grayscale",
										)}
									/>
								</button>
								{set.length > 1 && (
									<span className="pointer-events-none absolute top-2 right-2 rounded-full bg-card/90 px-2 py-0.5 text-xs font-medium text-foreground tabular-nums">
										{set.length}
									</span>
								)}
								{left !== null && (
									<span className="pointer-events-none absolute bottom-2 left-2 rounded-full bg-card/90 px-2 py-0.5 text-xs text-foreground">
										{left === 0 ? "Deleting soon" : left === 1 ? "1 day left" : `${left} days left`}
									</span>
								)}
								{isRef && (
									<span className="pointer-events-none absolute bottom-2 left-2 rounded-full bg-verdigris px-2 py-0.5 text-xs font-medium text-background">
										Reference
									</span>
								)}
							</li>
						);
					})}
					{tileUploads.map((upload) => (
						<li key={upload.id} className="relative">
							<button
								type="button"
								onClick={() => openAt(`upload:${upload.id}`)}
								className={cn(
									"block aspect-square w-full overflow-hidden rounded-xl bg-muted outline-2 outline-offset-2 outline-transparent focus-visible:outline-ring",
									selectedInputUrls.includes(upload.imageUrl) && "outline-verdigris",
								)}
								aria-label={`Open upload: ${upload.originalName}`}
							>
								<img
									src={absoluteUrl(upload.imageUrl)}
									alt=""
									loading="lazy"
									className="h-full w-full object-cover"
								/>
							</button>
							<span className="pointer-events-none absolute top-2 left-2 rounded-full bg-card/90 px-2 py-0.5 text-xs text-foreground">
								Upload
							</span>
						</li>
					))}
				</ul>
			)}

			{hasMore && (
				<div ref={sentinel} className="flex justify-center py-6">
					{fetching && <span className="text-sm text-muted-foreground">Loading more…</span>}
				</div>
			)}

			<ImageViewer
				images={viewerImages}
				index={viewerIndex}
				onIndexChange={setViewerIndex}
				onVary={view === "trash" ? undefined : vary}
				onTool={view === "trash" ? undefined : tool}
				onUseAsReference={view === "trash" ? undefined : useAsReference}
				referenceUrls={selectedInputUrls}
				onReusePrompt={onReusePrompt ? (prompt) => onReusePrompt(prompt) : undefined}
				costs={actionCosts}
				onTrash={(image) => {
					if (image.kind === "upload") setConfirm(image);
					else if (image.generation) void trash(image.generation.id);
				}}
				onRestore={(image) => image.generation && void restore(image.generation.id)}
				onDelete={(image) => setConfirm(image)}
				onArchive={(image) => {
					if (image.kind === "upload" && image.upload) void archiveUpload(image.upload.id, true);
					else if (image.generation) void archive(image.generation.id, true);
				}}
				onUnarchive={(image) => {
					if (image.kind === "upload" && image.upload) void archiveUpload(image.upload.id, false);
					else if (image.generation) void archive(image.generation.id, false);
				}}
			/>

			<ConfirmDialog
				open={confirm !== null}
				onOpenChange={(o) => !o && setConfirm(null)}
				title={confirm?.kind === "upload" ? "Delete this upload?" : "Delete this image for good?"}
				description={
					confirm?.kind === "upload"
						? "The file is removed right away. Images you already made from it stay."
						: "It's removed from Trash and can't be restored. Share links to it stop working."
				}
				confirmLabel={confirm?.kind === "upload" ? "Delete upload" : "Delete forever"}
				onConfirm={() => void confirmDelete()}
			/>
		</div>
	);
}
