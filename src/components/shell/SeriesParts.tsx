import { SeriesThumb } from "@/components/Sidebar";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import type { Thread } from "@/types";
import { MoreHorizontalIcon, PencilIcon, Trash2Icon } from "lucide-react";
import { Link } from "react-router-dom";
import { seriesPath } from "./routes";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Title of the open series, with its menu. */
export function SeriesHeader({
	thread,
	onRename,
	onDelete,
}: {
	thread: Thread | null;
	onRename: (thread: Thread) => void;
	onDelete: (thread: Thread) => void;
}) {
	if (!thread) {
		return (
			<div className="flex h-10 items-center">
				<Skeleton className="h-7 w-56 max-w-full" />
			</div>
		);
	}
	const steps = thread.generations?.length ?? thread.generationCount ?? 0;
	return (
		<div className="flex items-start gap-2">
			<div className="min-w-0 flex-1">
				<h1 className="truncate font-display text-2xl leading-tight">{thread.title}</h1>
				<p className="mt-1 text-sm text-muted-foreground">
					{steps > 0 ? plural(steps, "step") : "No images yet"}
					{thread.archivedAt ? ". Archived" : ""}
				</p>
			</div>
			<DropdownMenu>
				<DropdownMenuTrigger
					render={
						<Button variant="ghost" size="icon" aria-label="Series options" className="shrink-0" />
					}
				>
					<MoreHorizontalIcon />
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end" className="w-44">
					<DropdownMenuItem onClick={() => onRename(thread)} className="min-h-9">
						<PencilIcon />
						Rename
					</DropdownMenuItem>
					{!thread.archivedAt && (
						<>
							<DropdownMenuSeparator />
							<DropdownMenuItem
								variant="destructive"
								onClick={() => onDelete(thread)}
								className="min-h-9"
							>
								<Trash2Icon />
								Remove series
							</DropdownMenuItem>
						</>
					)}
				</DropdownMenuContent>
			</DropdownMenu>
		</div>
	);
}

/** /create with no series open, for accounts that already have series. */
export function NewSeriesIntro({ recent }: { recent: Thread[] }) {
	const covers = recent.filter((t) => t.coverImageUrl).slice(0, 6);
	return (
		<div className="flex min-h-[50vh] flex-col justify-center py-6">
			<h1 className="font-display text-3xl leading-tight">New series</h1>
			<p className="mt-3 max-w-prose text-muted-foreground">
				Describe the first image in the bar below. Each change you ask for after that becomes the
				next step of the series.
			</p>
			{covers.length > 0 && (
				<section aria-labelledby="recent-series" className="mt-10">
					<h2 id="recent-series" className="text-sm font-medium">
						Continue a series
					</h2>
					<ul className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
						{covers.map((thread) => (
							<li key={thread.id} className="min-w-0">
								<Link
									to={seriesPath(thread.id)}
									className="group block rounded-xl outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
								>
									<img
										src={thread.coverImageUrl}
										alt=""
										loading="lazy"
										decoding="async"
										className="aspect-square w-full rounded-xl bg-stone-2 object-cover transition-opacity group-hover:opacity-90"
									/>
									<span className="mt-2 block truncate text-sm text-muted-foreground group-hover:text-foreground">
										{thread.title}
									</span>
								</Link>
							</li>
						))}
					</ul>
				</section>
			)}
		</div>
	);
}

/** Archived series, shown above the archived images. */
export function ArchivedSeries({
	threads,
	onRestore,
}: { threads: Thread[]; onRestore: (thread: Thread) => void }) {
	if (threads.length === 0) return null;
	return (
		<section aria-labelledby="archived-series" className="mb-8">
			<h2 id="archived-series" className="text-sm font-medium">
				Archived series
			</h2>
			<ul className="mt-3 flex flex-col divide-y divide-border rounded-2xl border border-border bg-card">
				{threads.map((thread) => (
					<li key={thread.id} className="flex items-center gap-3 px-3 py-2">
						<Link
							to={seriesPath(thread.id)}
							className="flex min-h-10 min-w-0 flex-1 items-center gap-3 rounded-lg outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
						>
							<SeriesThumb url={thread.coverImageUrl} className="size-10" />
							<span className="min-w-0">
								<span className="block truncate text-sm text-foreground">{thread.title}</span>
								<span className="block text-xs text-muted-foreground">
									{plural(thread.generationCount ?? 0, "image")}
								</span>
							</span>
						</Link>
						<Button variant="outline" size="sm" onClick={() => onRestore(thread)}>
							Restore
						</Button>
					</li>
				))}
			</ul>
		</section>
	);
}
