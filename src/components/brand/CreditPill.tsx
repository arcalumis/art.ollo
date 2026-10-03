import { cn } from "@/lib/utils";

interface CreditPillProps {
	credits: number | null;
	/** Below this the dot turns bronze to signal a top-up is near. */
	lowAt?: number;
	onClick?: () => void;
	className?: string;
	/** Hide the word "credits" where space is tight (phone header). */
	compact?: boolean;
}

/** The balance in the app chrome. Clicking it opens billing. */
export function CreditPill({ credits, lowAt = 5, onClick, className, compact }: CreditPillProps) {
	const low = credits !== null && credits < lowAt;
	const content = (
		<>
			<span className={cn("size-[7px] rounded-full", low ? "bg-bronze" : "bg-verdigris")} aria-hidden />
			<b className="font-semibold tabular-nums">{credits ?? "–"}</b>
			{!compact && <span>credits</span>}
		</>
	);
	const classes = cn(
		"inline-flex h-8 items-center gap-1.5 rounded-full border border-border bg-stone-2 px-3 text-[0.82rem] font-medium whitespace-nowrap text-foreground",
		onClick && "hover:border-foreground/30",
		className,
	);
	const label = credits === null ? "Credit balance loading" : `${credits} credits${low ? ", running low" : ""}`;

	return onClick ? (
		<button type="button" onClick={onClick} className={classes} aria-label={`${label}. Open billing`}>
			{content}
		</button>
	) : (
		<span className={classes} aria-label={label}>
			{content}
		</span>
	);
}
