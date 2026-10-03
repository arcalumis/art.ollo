import { cn } from "@/lib/utils";

/**
 * The 4-digit code shown on both devices during a cross-device sign-in, so the person can
 * check that the link they opened belongs to the device they're holding.
 */
export function MatchCode({
	code,
	label,
	className,
}: { code: string; label: string; className?: string }) {
	return (
		<div className={cn("rounded-xl bg-muted px-4 py-3.5", className)}>
			<p className="text-sm text-muted-foreground">{label}</p>
			<p className="mt-1 text-4xl font-semibold tracking-[0.25em] text-foreground tabular-nums">
				<span aria-hidden>{code}</span>
				{/* Read digit by digit, not as "four thousand eight hundred…" */}
				<span className="sr-only">{code.split("").join(" ")}</span>
			</p>
		</div>
	);
}
