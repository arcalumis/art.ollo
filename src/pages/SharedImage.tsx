import { modelName } from "@/components/billing/plans";
import { Laurel } from "@/components/brand/Laurel";
import { Button, buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { absoluteUrl, copyPrompt, cssAspect, formatDate } from "@/components/viewer/media";
import { cn } from "@/lib/utils";
import { CopyIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { API_BASE } from "../config";

interface PublicShare {
	slug: string;
	imageUrl: string;
	images?: { url: string }[];
	prompt: string;
	model: string;
	width?: number;
	height?: number;
	aspectRatio?: string;
	createdAt: string;
}

/**
 * A shared image at /s/:slug. Public: no account needed. The server serves this route's HTML
 * with the image's Open Graph tags (server/routes/share.ts); this page sets the title for
 * in-app navigation.
 */
export function SharedImage({ slug: slugProp }: { slug?: string } = {}) {
	const params = useParams<{ slug: string }>();
	const slug = slugProp ?? params.slug ?? "";
	const [share, setShare] = useState<PublicShare | null>(null);
	const [state, setState] = useState<"loading" | "ready" | "gone" | "error">("loading");
	const [active, setActive] = useState(0);

	useEffect(() => {
		let cancelled = false;
		setState("loading");
		fetch(`${API_BASE}/api/share/${encodeURIComponent(slug)}`)
			.then(async (res) => {
				if (cancelled) return;
				if (res.status === 404) return setState("gone");
				if (!res.ok) return setState("error");
				setShare((await res.json()) as PublicShare);
				setState("ready");
			})
			.catch(() => !cancelled && setState("error"));
		return () => {
			cancelled = true;
		};
	}, [slug]);

	useEffect(() => {
		if (share) document.title = `${share.prompt.slice(0, 60)} | ollo`;
	}, [share]);

	const images = share
		? share.images?.length
			? share.images.map((i) => i.url)
			: [share.imageUrl]
		: [];
	const current = images[active] ?? images[0];
	const aspect =
		cssAspect(share?.aspectRatio) ??
		(share?.width && share?.height ? `${share.width} / ${share.height}` : "1 / 1");

	return (
		<div className="flex min-h-dvh flex-col bg-background text-foreground">
			<header className="mx-auto flex w-full max-w-6xl items-center justify-between gap-4 px-4 py-4 sm:px-6">
				<Link to="/" className="flex items-center gap-2" aria-label="ollo home">
					<Laurel className="size-7" />
					<span className="font-display text-2xl leading-none">ollo</span>
				</Link>
				<Link to="/" className={cn(buttonVariants({ variant: "outline" }))}>
					Make your own
				</Link>
			</header>

			<main className="mx-auto grid w-full max-w-6xl flex-1 gap-6 px-4 pb-10 sm:px-6 lg:grid-cols-[minmax(0,1fr)_22rem] lg:gap-10">
				{state === "loading" ? (
					<>
						<Skeleton className="w-full rounded-2xl" style={{ aspectRatio: aspect }} />
						<div className="flex flex-col gap-3">
							<Skeleton className="h-6 w-3/4" />
							<Skeleton className="h-24 w-full" />
						</div>
					</>
				) : state === "ready" && share && current ? (
					<>
						<div className="flex flex-col gap-3">
							<div className="flex items-center justify-center rounded-2xl bg-card p-3 sm:p-6">
								<img
									src={absoluteUrl(current)}
									alt={share.prompt}
									className="max-h-[78dvh] w-auto max-w-full rounded-xl object-contain"
								/>
							</div>
							{images.length > 1 && (
								<div className="flex gap-2" role="tablist" aria-label="Images in this set">
									{images.map((url, i) => (
										<button
											key={url}
											type="button"
											role="tab"
											aria-selected={i === active}
											aria-label={`Image ${i + 1} of ${images.length}`}
											onClick={() => setActive(i)}
											className={cn(
												"size-16 overflow-hidden rounded-lg bg-muted outline-2 outline-offset-2 sm:size-20",
												i === active ? "outline-verdigris" : "outline-transparent",
											)}
										>
											<img src={absoluteUrl(url)} alt="" className="h-full w-full object-cover" />
										</button>
									))}
								</div>
							)}
						</div>

						<aside className="flex flex-col gap-5 lg:pt-2">
							<div className="flex flex-col gap-3">
								<h1 className="text-sm font-medium text-muted-foreground">Prompt</h1>
								<p className="text-lg leading-relaxed text-foreground">{share.prompt}</p>
								<div>
									<Button
										variant="ghost"
										size="sm"
										className="-ml-2"
										onClick={() => void copyPrompt(share.prompt)}
									>
										<CopyIcon />
										Copy prompt
									</Button>
								</div>
							</div>
							<dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 border-t border-border pt-4 text-sm">
								<dt className="text-muted-foreground">Model</dt>
								<dd className="m-0">{modelName(share.model)}</dd>
								{share.width && share.height ? (
									<>
										<dt className="text-muted-foreground">Size</dt>
										<dd className="m-0 tabular-nums">
											{share.width} × {share.height}
										</dd>
									</>
								) : null}
								<dt className="text-muted-foreground">Made</dt>
								<dd className="m-0">{formatDate(share.createdAt)}</dd>
							</dl>
							<div className="flex flex-col gap-3 rounded-2xl border border-border bg-card p-5">
								<p className="font-medium text-foreground">Made with ollo</p>
								<p className="text-sm text-muted-foreground">
									Describe an image, then ask for changes one step at a time. Your first images are
									free.
								</p>
								<Link to="/" className={cn(buttonVariants({ variant: "secondary" }), "self-start")}>
									Start making images
								</Link>
							</div>
						</aside>
					</>
				) : (
					<div className="col-span-full flex min-h-[50vh] flex-col items-center justify-center gap-3 text-center">
						<Laurel className="size-14 opacity-60" />
						<h1 className="text-xl font-semibold">
							{state === "gone" ? "This link has been turned off" : "Couldn't load this image"}
						</h1>
						<p className="max-w-sm text-sm text-muted-foreground">
							{state === "gone"
								? "The person who shared it may have removed it, or the link was copied wrong."
								: "Check your connection and refresh the page."}
						</p>
						<Link to="/" className={cn(buttonVariants({ variant: "outline" }))}>
							Go to ollo
						</Link>
					</div>
				)}
			</main>
		</div>
	);
}

export default SharedImage;
