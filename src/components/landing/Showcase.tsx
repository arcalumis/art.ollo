import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

export interface ShowcaseItem {
	slug: string;
	model: string;
	prompt: string;
}

/** Loads public/showcase/showcase.json. Empty on failure: the section just doesn't render. */
export function useShowcase(): ShowcaseItem[] {
	const [items, setItems] = useState<ShowcaseItem[]>([]);
	useEffect(() => {
		let cancelled = false;
		fetch("/showcase/showcase.json")
			.then((r) => (r.ok ? r.json() : []))
			.then((data: unknown) => {
				if (cancelled || !Array.isArray(data)) return;
				setItems(
					data.filter(
						(d): d is ShowcaseItem =>
							typeof d?.slug === "string" &&
							typeof d?.prompt === "string" &&
							typeof d?.model === "string",
					),
				);
			})
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	}, []);
	return items;
}

/**
 * One real output. The prompt that made it shows on hover or keyboard focus,
 * and on tap for touch screens.
 */
export function ShowcaseTile({ item, className }: { item: ShowcaseItem; className?: string }) {
	const [open, setOpen] = useState(false);
	return (
		<figure className={cn("group relative overflow-hidden rounded-xl bg-muted", className)}>
			<button
				type="button"
				onClick={() => setOpen((o) => !o)}
				aria-expanded={open}
				aria-label={open ? "Hide prompt" : "Show prompt"}
				className="block w-full outline-none focus-visible:ring-3 focus-visible:ring-ring focus-visible:ring-inset"
			>
				<img
					src={`/showcase/${item.slug}-480.webp`}
					srcSet={`/showcase/${item.slug}-480.webp 480w, /showcase/${item.slug}.webp 1024w`}
					sizes="(min-width: 1024px) 25vw, (min-width: 640px) 50vw, 100vw"
					alt={item.prompt}
					loading="lazy"
					decoding="async"
					width={1024}
					height={768}
					className="aspect-[4/3] w-full object-cover"
				/>
			</button>
			<figcaption
				className={cn(
					"finish-night pointer-events-none absolute inset-x-0 bottom-0 bg-scrim p-3 text-sm leading-snug text-foreground transition-opacity duration-150",
					"opacity-0 group-hover:opacity-100 group-has-[:focus-visible]:opacity-100",
					open && "opacity-100",
				)}
			>
				<span className="line-clamp-4">{item.prompt}</span>
				<span className="mt-1 block text-xs text-muted-foreground">{item.model}</span>
			</figcaption>
		</figure>
	);
}
