import { Link } from "react-router-dom";
import { Wordmark } from "@/components/brand/Laurel";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** Public-page navigation: wordmark home, Pricing, Sign in. */
export function SiteHeader({ className }: { className?: string }) {
	return (
		<header
			className={cn(
				"mx-auto flex w-full max-w-6xl items-center justify-between gap-4 px-4 py-3 sm:px-6",
				className,
			)}
		>
			<Link
				to="/"
				className="inline-flex min-h-10 items-center rounded-lg px-1"
				aria-label="ollo home"
			>
				<Wordmark />
			</Link>
			<nav aria-label="Main" className="flex items-center gap-1">
				<Button render={<Link to="/pricing" />} nativeButton={false} variant="ghost">
					Pricing
				</Button>
				<Button render={<Link to="/login" />} nativeButton={false} variant="outline">
					Sign in
				</Button>
			</nav>
		</header>
	);
}

/** Public-page footer: legal links and pricing. */
export function SiteFooter({ className }: { className?: string }) {
	return (
		<footer className={cn("border-t border-border", className)}>
			<div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-8 sm:flex-row sm:items-center sm:justify-between sm:px-6">
				<Wordmark className="text-lg" />
				<nav aria-label="Footer" className="-mx-2 flex flex-wrap items-center gap-x-2">
					<FooterLink to="/pricing">Pricing</FooterLink>
					<FooterLink to="/terms">Terms</FooterLink>
					<FooterLink to="/privacy">Privacy</FooterLink>
				</nav>
			</div>
		</footer>
	);
}

function FooterLink({ to, children }: { to: string; children: string }) {
	return (
		<Link
			to={to}
			className="inline-flex min-h-10 items-center rounded-lg px-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
		>
			{children}
		</Link>
	);
}
