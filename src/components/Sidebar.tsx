import {
	LIBRARY_TITLES,
	type LibraryView,
	libraryPath,
	seriesPath,
} from "@/components/shell/routes";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
	ArchiveIcon,
	BookOpenIcon,
	ImagesIcon,
	MoreHorizontalIcon,
	PencilIcon,
	PlusIcon,
	SearchIcon,
	Trash2Icon,
} from "lucide-react";
import { useMemo, useState } from "react";
import { NavLink } from "react-router-dom";
import type { Thread } from "../types";

interface SidebarProps {
	/** Series in the list (archived series live under Archive, not here). */
	threads: Thread[];
	selectedThreadId?: string;
	loading?: boolean;
	onNewSeries: () => void;
	onRenameSeries: (thread: Thread) => void;
	onDeleteSeries: (thread: Thread) => void;
	onOpenModelGuide?: () => void;
	/** Called after any navigation, so the phone drawer can close. */
	onNavigate?: () => void;
	className?: string;
}

const GROUP_ORDER = ["Today", "Yesterday", "This week", "Earlier"] as const;
type Group = (typeof GROUP_ORDER)[number];

function groupOf(dateStr: string, now = new Date()): Group {
	const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
	const d = new Date(dateStr);
	const day = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
	const dayMs = 86_400_000;
	if (day >= today) return "Today";
	if (day >= today - dayMs) return "Yesterday";
	if (day >= today - 7 * dayMs) return "This week";
	return "Earlier";
}

const LIBRARY: { view: LibraryView; icon: typeof ImagesIcon }[] = [
	{ view: "all", icon: ImagesIcon },
	{ view: "archive", icon: ArchiveIcon },
	{ view: "trash", icon: Trash2Icon },
];

const rowClasses = ({ isActive }: { isActive: boolean }) =>
	cn(
		"flex min-h-10 min-w-0 flex-1 items-center gap-3 rounded-lg px-2 py-1.5 text-sm outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50",
		isActive
			? "bg-muted text-foreground"
			: "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
	);

/** The series list and the library: a desktop rail, and the phone drawer's content. */
export function Sidebar({
	threads,
	selectedThreadId,
	loading,
	onNewSeries,
	onRenameSeries,
	onDeleteSeries,
	onOpenModelGuide,
	onNavigate,
	className,
}: SidebarProps) {
	const [query, setQuery] = useState("");
	const showSearch = threads.length > 8;

	const groups = useMemo(() => {
		const q = query.trim().toLowerCase();
		const list = q ? threads.filter((t) => t.title.toLowerCase().includes(q)) : threads;
		const now = new Date();
		const map = new Map<Group, Thread[]>();
		for (const thread of list) {
			const g = groupOf(thread.lastGenerationAt || thread.updatedAt, now);
			map.set(g, [...(map.get(g) ?? []), thread]);
		}
		return GROUP_ORDER.filter((g) => map.has(g)).map((g) => ({
			label: g,
			threads: map.get(g) ?? [],
		}));
	}, [threads, query]);

	return (
		<nav aria-label="Series and library" className={cn("flex min-h-0 flex-1 flex-col", className)}>
			<div className="flex flex-col gap-3 p-3">
				<Button
					variant="outline"
					className="w-full justify-start"
					onClick={() => {
						onNewSeries();
						onNavigate?.();
					}}
				>
					<PlusIcon />
					New series
				</Button>
				{showSearch && (
					<div className="relative">
						<SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
						<Input
							type="search"
							value={query}
							onChange={(e) => setQuery(e.target.value)}
							placeholder="Find a series"
							aria-label="Find a series"
							className="h-9 pl-9 text-sm"
						/>
					</div>
				)}
			</div>

			<div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
				<section aria-labelledby="series-heading">
					<h2 id="series-heading" className="sr-only">
						Series
					</h2>
					{groups.length === 0 ? (
						<p className="px-2 py-3 text-sm text-muted-foreground">
							{loading
								? "Loading series"
								: query
									? "No series match that."
									: "Your series will appear here."}
						</p>
					) : (
						groups.map((group) => (
							<div key={group.label} className="mt-2 first:mt-0">
								<h3 className="px-2 pt-2 pb-1 text-xs text-muted-foreground">{group.label}</h3>
								<ul className="flex flex-col gap-0.5">
									{group.threads.map((thread) => (
										<SeriesRow
											key={thread.id}
											thread={thread}
											selected={thread.id === selectedThreadId}
											onRename={() => onRenameSeries(thread)}
											onDelete={() => onDeleteSeries(thread)}
											onNavigate={onNavigate}
										/>
									))}
								</ul>
							</div>
						))
					)}
				</section>

				<section aria-labelledby="library-heading" className="mt-5 border-t border-border pt-3">
					<h2 id="library-heading" className="px-2 pb-1 text-xs text-muted-foreground">
						Library
					</h2>
					<ul className="flex flex-col gap-0.5">
						{LIBRARY.map(({ view, icon: Icon }) => (
							<li key={view} className="flex">
								<NavLink to={libraryPath(view)} end className={rowClasses} onClick={onNavigate}>
									<Icon className="size-4 shrink-0" aria-hidden />
									{LIBRARY_TITLES[view]}
								</NavLink>
							</li>
						))}
					</ul>
				</section>
			</div>

			{onOpenModelGuide && (
				<div className="border-t border-border p-3">
					<Button
						variant="ghost"
						className="w-full justify-start text-muted-foreground"
						onClick={() => {
							onOpenModelGuide();
							onNavigate?.();
						}}
					>
						<BookOpenIcon />
						Models and credit costs
					</Button>
				</div>
			)}
		</nav>
	);
}

interface SeriesRowProps {
	thread: Thread;
	selected: boolean;
	onRename: () => void;
	onDelete: () => void;
	onNavigate?: () => void;
}

function SeriesRow({ thread, selected, onRename, onDelete, onNavigate }: SeriesRowProps) {
	return (
		<li className="group/row relative flex items-center">
			<NavLink
				to={seriesPath(thread.id)}
				className={({ isActive }) => cn(rowClasses({ isActive: isActive || selected }), "pr-10")}
				onClick={onNavigate}
				title={thread.title}
			>
				<SeriesThumb url={thread.coverImageUrl} />
				<span className="truncate">{thread.title}</span>
			</NavLink>
			<DropdownMenu>
				<DropdownMenuTrigger
					className={cn(
						"absolute right-1 inline-flex size-8 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-stone-2 hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 aria-expanded:bg-stone-2 aria-expanded:opacity-100",
						// Always visible on touch screens; on hover-capable screens, when the row is hovered or focused.
						"[@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-focus-within/row:opacity-100 [@media(hover:hover)]:group-hover/row:opacity-100",
						selected && "[@media(hover:hover)]:opacity-100",
					)}
					aria-label={`Options for ${thread.title}`}
				>
					<MoreHorizontalIcon className="size-4" />
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end" className="w-44">
					<DropdownMenuItem onClick={onRename} className="min-h-9">
						<PencilIcon />
						Rename
					</DropdownMenuItem>
					<DropdownMenuSeparator />
					<DropdownMenuItem variant="destructive" onClick={onDelete} className="min-h-9">
						<Trash2Icon />
						Remove series
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
		</li>
	);
}

/** Newest image of the series, or a quiet placeholder. */
export function SeriesThumb({ url, className }: { url?: string; className?: string }) {
	return url ? (
		<img
			src={url}
			alt=""
			loading="lazy"
			decoding="async"
			className={cn("size-8 shrink-0 rounded-md bg-stone-2 object-cover", className)}
		/>
	) : (
		<span
			className={cn("size-8 shrink-0 rounded-md border border-border bg-stone-2", className)}
			aria-hidden
		/>
	);
}
