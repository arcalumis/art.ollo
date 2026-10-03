import { useEffect } from "react";
import { Link, useLocation } from "react-router-dom";
import { Laurel } from "@/components/brand/Laurel";
import { Button } from "@/components/ui/button";
import { SiteFooter, SiteHeader } from "../components/site/SiteChrome";

/** Any path the router doesn't know. */
export function NotFound() {
	const { pathname } = useLocation();
	useEffect(() => {
		document.title = "Page not found | ollo";
	}, []);

	return (
		<div className="flex min-h-dvh flex-col bg-background">
			<SiteHeader />
			<main className="mx-auto flex w-full max-w-xl flex-1 flex-col items-start justify-center px-4 py-20">
				<Laurel className="size-14 opacity-60" />
				<h1 className="mt-6 font-display text-4xl leading-tight sm:text-5xl">
					There's no page here
				</h1>
				<p className="mt-4 text-muted-foreground">
					Nothing lives at{" "}
					<code className="rounded bg-muted px-1.5 py-0.5 text-sm break-all text-foreground">
						{pathname}
					</code>
					. The link may be old or mistyped.
				</p>
				<div className="mt-8 flex flex-wrap gap-2">
					<Button render={<Link to="/" />} nativeButton={false} variant="outline">
						Go to ollo
					</Button>
					<Button render={<Link to="/pricing" />} nativeButton={false} variant="ghost">
						See pricing
					</Button>
				</div>
			</main>
			<SiteFooter />
		</div>
	);
}
