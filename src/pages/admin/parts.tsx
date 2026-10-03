import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { ExternalLinkIcon } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { type PlanSource, SOURCE_LABEL } from "./api";

/** The one display-face title on an admin screen, with an optional line and actions. */
export function PageHeader({
	title,
	description,
	actions,
}: { title: string; description?: ReactNode; actions?: ReactNode }) {
	return (
		<header className="flex flex-col gap-3 pb-6 sm:flex-row sm:items-end sm:justify-between">
			<div className="min-w-0">
				<h1 className="font-display text-[1.75rem] leading-tight text-foreground">{title}</h1>
				{description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
			</div>
			{actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
		</header>
	);
}

/** A surface that groups one block of content. */
export function Panel({
	title,
	description,
	actions,
	children,
	className,
	bodyClassName,
}: {
	title?: string;
	description?: ReactNode;
	actions?: ReactNode;
	children: ReactNode;
	className?: string;
	bodyClassName?: string;
}) {
	return (
		<section className={cn("min-w-0 rounded-2xl border border-border bg-card", className)}>
			{(title || actions) && (
				<div className="flex flex-wrap items-start justify-between gap-2 border-b border-border px-4 py-3">
					<div className="min-w-0">
						{title && <h2 className="text-sm font-semibold text-foreground">{title}</h2>}
						{description && <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>}
					</div>
					{actions}
				</div>
			)}
			<div className={cn("p-4", bodyClassName)}>{children}</div>
		</section>
	);
}

/** A headline number. */
export function Stat({
	label,
	value,
	hint,
	tone,
}: { label: string; value: ReactNode; hint?: ReactNode; tone?: "danger" | "good" }) {
	return (
		<div className="min-w-0 rounded-2xl border border-border bg-card px-4 py-3">
			<p className="text-xs text-muted-foreground">{label}</p>
			<p
				className={cn(
					"mt-1 truncate text-2xl font-semibold tabular-nums text-foreground",
					tone === "danger" && "text-destructive",
					tone === "good" && "text-verdigris",
				)}
			>
				{value}
			</p>
			{hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
		</div>
	);
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
	return (
		<div className="px-4 py-10 text-center">
			<p className="text-sm font-medium text-foreground">{title}</p>
			{children && (
				<p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">{children}</p>
			)}
		</div>
	);
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
	return (
		<div
			role="alert"
			className="rounded-2xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive"
		>
			<span>{message}</span>
			{onRetry && (
				<Button variant="outline" size="sm" className="ml-3" onClick={onRetry}>
					Try again
				</Button>
			)}
		</div>
	);
}

export function LoadingBlock({ rows = 4 }: { rows?: number }) {
	return (
		<div className="flex flex-col gap-3" aria-busy="true">
			{Array.from({ length: rows }, (_, i) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: static placeholders
				<Skeleton key={i} className="h-10 w-full" />
			))}
		</div>
	);
}

// ---- Tables ----------------------------------------------------------------------

/** Scrolls sideways inside its panel on phones, never the page. */
export function DataTable({ children, className }: { children: ReactNode; className?: string }) {
	return (
		<div className="relative -mx-4 overflow-x-auto">
			<table className={cn("w-full min-w-[40rem] border-collapse text-sm", className)}>
				{children}
			</table>
		</div>
	);
}

export function Th({
	children,
	className,
	right,
}: { children?: ReactNode; className?: string; right?: boolean }) {
	return (
		<th
			scope="col"
			className={cn(
				"border-b border-border px-4 py-2 text-left text-xs font-medium whitespace-nowrap text-muted-foreground",
				right && "text-right",
				className,
			)}
		>
			{children}
		</th>
	);
}

export function Td({
	children,
	className,
	right,
	num,
}: { children?: ReactNode; className?: string; right?: boolean; num?: boolean }) {
	return (
		<td
			className={cn(
				"border-b border-border px-4 py-2.5 align-top text-foreground",
				(right || num) && "text-right",
				num && "tabular-nums whitespace-nowrap",
				className,
			)}
		>
			{children}
		</td>
	);
}

// ---- Controls --------------------------------------------------------------------

export interface Option {
	value: string;
	label: string;
}

/** A labelled filter built on the kit Select. "" means "all". */
export function FilterSelect({
	label,
	value,
	options,
	onChange,
	className,
}: {
	label: string;
	value: string;
	options: Option[];
	onChange: (v: string) => void;
	className?: string;
}) {
	const all: Option[] = [{ value: "__all", label: `All ${label.toLowerCase()}` }, ...options];
	const labelOf = (v: string) => all.find((o) => o.value === v)?.label ?? v;
	return (
		<Select
			value={value || "__all"}
			onValueChange={(v) => onChange(!v || v === "__all" ? "" : (v as string))}
		>
			<SelectTrigger
				className={cn("h-10 w-full data-[size=default]:h-10 sm:w-44", className)}
				aria-label={`Filter by ${label.toLowerCase()}`}
			>
				<SelectValue>{(v: string) => labelOf(v)}</SelectValue>
			</SelectTrigger>
			<SelectContent>
				{all.map((o) => (
					<SelectItem key={o.value} value={o.value}>
						{o.label}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}

export function ExternalLink({
	href,
	children,
	className,
}: { href: string; children: ReactNode; className?: string }) {
	return (
		<a
			href={href}
			target="_blank"
			rel="noreferrer noopener"
			className={cn(
				"relative inline-flex items-center gap-1 text-foreground underline-offset-4 hover:underline",
				className,
			)}
		>
			{children}
			<ExternalLinkIcon className="size-3.5 text-muted-foreground" aria-hidden />
			<span className="sr-only">(opens in a new tab)</span>
		</a>
	);
}

export function SourceBadge({ source }: { source: PlanSource }) {
	return (
		<Badge variant={source === "stripe" || source === "sol" ? "secondary" : "outline"}>
			{SOURCE_LABEL[source]}
		</Badge>
	);
}

const STATUS_LABEL: Record<string, string> = {
	active: "Active",
	trialing: "Trial",
	past_due: "Past due",
	canceled: "Canceled",
	expired: "Expired",
	superseded: "Replaced",
	incomplete: "Incomplete",
	unpaid: "Unpaid",
	succeeded: "Paid",
	completed: "Paid",
	failed: "Failed",
	pending: "Pending",
};

export function StatusBadge({ status }: { status: string }) {
	const bad = ["past_due", "failed", "unpaid", "incomplete"].includes(status);
	return <Badge variant={bad ? "destructive" : "outline"}>{STATUS_LABEL[status] ?? status}</Badge>;
}

// ---- Confirm with a reason ---------------------------------------------------------

/**
 * A confirmation dialog that requires a reason (3+ characters). `onConfirm` returns an error
 * message to show, or null on success (the dialog closes).
 */
export function ReasonDialog({
	open,
	onOpenChange,
	title,
	description,
	confirmLabel,
	destructive,
	children,
	onConfirm,
	canConfirm = true,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	title: string;
	description?: ReactNode;
	confirmLabel: string;
	destructive?: boolean;
	children?: ReactNode;
	onConfirm: (reason: string) => Promise<string | null>;
	canConfirm?: boolean;
}) {
	const id = useId();
	const [reason, setReason] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const valid = reason.trim().length >= 3 && canConfirm;

	const close = (next: boolean) => {
		if (!next) {
			setReason("");
			setError(null);
		}
		onOpenChange(next);
	};

	return (
		<Dialog open={open} onOpenChange={close}>
			<DialogContent className="sm:max-w-md">
				<form
					className="grid gap-4"
					onSubmit={async (e) => {
						e.preventDefault();
						if (!valid || busy) return;
						setBusy(true);
						const err = await onConfirm(reason.trim());
						setBusy(false);
						if (err) setError(err);
						else close(false);
					}}
				>
					<DialogHeader>
						<DialogTitle>{title}</DialogTitle>
						{description && <DialogDescription>{description}</DialogDescription>}
					</DialogHeader>
					{children}
					<div className="grid gap-1.5">
						<label htmlFor={`${id}-reason`} className="text-sm font-medium text-foreground">
							Reason
						</label>
						<Textarea
							id={`${id}-reason`}
							value={reason}
							onChange={(e) => setReason(e.target.value)}
							placeholder="Recorded in the audit log"
							rows={2}
							maxLength={500}
							required
						/>
					</div>
					{error && (
						<p role="alert" className="text-sm text-destructive">
							{error}
						</p>
					)}
					<DialogFooter>
						<Button type="button" variant="ghost" onClick={() => close(false)}>
							Cancel
						</Button>
						<Button
							type="submit"
							variant={destructive ? "destructive" : "outline"}
							disabled={!valid || busy}
						>
							{busy ? "Working…" : confirmLabel}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

// ---- A small single-series bar chart -------------------------------------------------

/**
 * Daily bars for one measure (title names it; no legend). Bars are verdigris with rounded
 * tops on a recessive baseline; hovering or focusing a bar shows its value; a visually
 * hidden table carries the same numbers for screen readers.
 */
export function DailyBars({
	title,
	data,
	format,
}: { title: string; data: Array<{ date: string; value: number }>; format: (v: number) => string }) {
	const [active, setActive] = useState<number | null>(null);
	const max = Math.max(0, ...data.map((d) => d.value));
	const total = data.reduce((s, d) => s + d.value, 0);
	const shown = active !== null ? data[active] : null;
	const label = (d: { date: string }) =>
		new Date(`${d.date}T00:00:00Z`).toLocaleDateString("en-US", {
			month: "short",
			day: "numeric",
			timeZone: "UTC",
		});

	return (
		<figure className="min-w-0">
			<figcaption className="flex items-baseline justify-between gap-2">
				<span className="text-sm font-semibold text-foreground">{title}</span>
				<span className="text-xs tabular-nums text-muted-foreground" aria-live="polite">
					{shown ? `${label(shown)}: ${format(shown.value)}` : `30 days: ${format(total)}`}
				</span>
			</figcaption>
			{max === 0 ? (
				<p className="mt-3 grid h-28 place-items-center border-b border-border text-center text-xs text-muted-foreground">
					Nothing in the last 30 days. Days with activity will show as bars.
				</p>
			) : (
				<div
					className="mt-3 flex h-28 items-end gap-[2px] border-b border-border"
					onMouseLeave={() => setActive(null)}
				>
					{data.map((d, i) => {
						const h = max > 0 ? Math.max(d.value > 0 ? 4 : 0, (d.value / max) * 100) : 0;
						return (
							<button
								key={d.date}
								type="button"
								className="group flex h-full min-w-0 flex-1 items-end outline-none"
								onMouseEnter={() => setActive(i)}
								onFocus={() => setActive(i)}
								onBlur={() => setActive(null)}
								aria-label={`${label(d)}: ${format(d.value)}`}
							>
								<span
									className={cn(
										"block w-full rounded-t-[4px] bg-verdigris/70 transition-colors group-hover:bg-verdigris group-focus-visible:bg-verdigris",
										active === i && "bg-verdigris",
									)}
									style={{ height: `${h}%` }}
								/>
							</button>
						);
					})}
				</div>
			)}
			<div className="mt-1 flex justify-between text-[11px] text-muted-foreground">
				<span>{data[0] ? label(data[0]) : ""}</span>
				<span>{data.length ? label(data[data.length - 1]) : ""}</span>
			</div>
			<table className="sr-only">
				<caption>{title}, last 30 days</caption>
				<tbody>
					{data.map((d) => (
						<tr key={d.date}>
							<th scope="row">{label(d)}</th>
							<td>{format(d.value)}</td>
						</tr>
					))}
				</tbody>
			</table>
		</figure>
	);
}

/** A thumbnail that falls back to a plain tile when the file is missing (purged, or a scratch DB). */
export function Thumb({
	src,
	alt,
	title,
	className,
}: { src: string | undefined; alt: string; title?: string; className?: string }) {
	const [broken, setBroken] = useState(false);
	if (!src || broken) {
		return (
			<span
				className={cn("grid place-items-center bg-muted text-xs text-muted-foreground", className)}
				title={title}
			>
				Image unavailable
			</span>
		);
	}
	return (
		<img
			src={src}
			alt={alt}
			title={title}
			loading="lazy"
			className={className}
			onError={() => setBroken(true)}
		/>
	);
}
