import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { CircleAlertIcon, CircleCheckIcon } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import {
	fmtAgo,
	fmtCents,
	fmtDate,
	fmtInt,
	fmtPct,
	stripeInvoiceUrl,
	useAdminCall,
	useAdminQuery,
} from "./api";
import {
	DataTable,
	EmptyState,
	ErrorState,
	ExternalLink,
	LoadingBlock,
	PageHeader,
	Panel,
	Td,
	Th,
} from "./parts";

interface Window {
	runs: number;
	failures: number;
	rate: number | null;
}
interface Job {
	status: "idle" | "running" | "done" | "failed";
	startedAt: string | null;
	finishedAt: string | null;
	result: { processed: number; reconciled: number; errors: number } | null;
	error: string | null;
	startedBy: string | null;
}
interface Health {
	webhooks: {
		processed24h: number;
		processed7d: number;
		lastProcessedAt: string | null;
		failures: Array<{
			eventId: string;
			type: string;
			lastFailedAt: string | null;
			attempts: number;
			error: string;
			resolved: boolean;
		}>;
	};
	failedPayments: Array<{
		id: string;
		userId: string;
		username: string | null;
		amountCents: number;
		invoiceId: string | null;
		description: string | null;
		createdAt: string | null;
	}>;
	replicate: { day: Window; week: Window };
	email: {
		sent24h: number;
		dailyCap: number;
		globalCapReached: boolean;
		recipientsAtCap: Array<{ recipient: string; hour: number; day: number }>;
	};
	pendingSol: Array<{
		kind: string;
		id: string;
		userId: string;
		username: string | null;
		amountSol: number;
		createdAt: string | null;
	}>;
	reconciliation: { job: Job; unreconciledOlderThan7d: number; estimatedRows: number };
	backup: { lastBackupAt: string | null };
}

/** A status line: icon + label carry the state, never colour alone. */
function Check({ ok, title, children }: { ok: boolean; title: string; children: ReactNode }) {
	const Icon = ok ? CircleCheckIcon : CircleAlertIcon;
	return (
		<div className="flex min-w-0 gap-3 rounded-2xl border border-border bg-card px-4 py-3">
			<Icon
				className={cn("mt-0.5 size-5 shrink-0", ok ? "text-verdigris" : "text-destructive")}
				aria-hidden
			/>
			<div className="min-w-0">
				<p className="text-sm font-medium text-foreground">
					{title}
					<span className="sr-only">{ok ? " (ok)" : " (needs attention)"}</span>
				</p>
				<div className="mt-0.5 text-xs text-muted-foreground">{children}</div>
			</div>
		</div>
	);
}

function windowText(label: string, w: Window): string {
	if (w.runs === 0) return `${label}: no runs.`;
	return `${label}: ${fmtPct(w.rate, 1)} failed (${fmtInt(w.failures)} of ${fmtInt(w.runs)}).`;
}

const STALE_PENDING_MS = 15 * 60 * 1000;
const BACKUP_MAX_AGE_MS = 26 * 60 * 60 * 1000;

export default function AdminHealth() {
	const call = useAdminCall();
	const { data, error, loading, reload } = useAdminQuery<Health>("/api/admin/health");
	const [job, setJob] = useState<Job | null>(null);
	const current = job ?? data?.reconciliation.job ?? null;

	// Poll while a reconciliation job runs.
	useEffect(() => {
		if (current?.status !== "running") return;
		const t = setInterval(async () => {
			const res = await call<{ job: Job }>("GET", "/api/admin/financials/reconcile-costs");
			if (res.ok) {
				setJob(res.data.job);
				if (res.data.job.status !== "running") {
					toast.success(
						res.data.job.status === "done"
							? `Reconciled ${res.data.job.result?.reconciled ?? 0} of ${res.data.job.result?.processed ?? 0} costs`
							: "Reconciliation failed",
					);
					void reload();
				}
			}
		}, 2000);
		return () => clearInterval(t);
	}, [current?.status, call, reload]);

	const startReconcile = async () => {
		const res = await call<{ started: boolean; job: Job }>(
			"POST",
			"/api/admin/financials/reconcile-costs",
		);
		if (!res.ok) {
			toast.error(res.data.error ?? "Couldn't start reconciliation.");
			return;
		}
		setJob(res.data.job);
		toast(res.data.started ? "Reconciliation started" : "Reconciliation is already running");
	};

	if (error) return <ErrorState message={error} onRetry={reload} />;

	const now = Date.now();
	const stuckSol =
		data?.pendingSol.filter(
			(p) => p.createdAt && now - Date.parse(p.createdAt) > STALE_PENDING_MS,
		) ?? [];
	const openFailures = data?.webhooks.failures.filter((f) => !f.resolved) ?? [];
	const backupAge = data?.backup.lastBackupAt ? now - Date.parse(data.backup.lastBackupAt) : null;

	return (
		<div>
			<PageHeader
				title="Health"
				description="Webhooks, Replicate runs, email limits, SOL payments and backups."
				actions={
					<Button variant="outline" onClick={() => void reload()} disabled={loading}>
						Refresh
					</Button>
				}
			/>
			{loading && !data && <LoadingBlock rows={6} />}
			{data && (
				<div className="flex flex-col gap-6">
					<div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
						<Check ok={openFailures.length === 0} title="Stripe webhooks">
							{openFailures.length > 0
								? `${openFailures.length} event${openFailures.length === 1 ? "" : "s"} failed and not yet applied. Stripe retries them.`
								: `${fmtInt(data.webhooks.processed24h)} processed in 24 h, ${fmtInt(data.webhooks.processed7d)} in 7 days. Last ${fmtAgo(data.webhooks.lastProcessedAt)}.`}
						</Check>
						<Check ok={data.failedPayments.length === 0} title="Failed payments">
							{data.failedPayments.length > 0
								? `${data.failedPayments.length} failed in the last 30 days.`
								: "None in the last 30 days."}
						</Check>
						<Check ok={(data.replicate.day.rate ?? 0) < 10} title="Replicate runs">
							{windowText("24 h", data.replicate.day)} {windowText("7 days", data.replicate.week)}{" "}
							Failed runs are the ones refunded, timeouts included.
						</Check>
						<Check
							ok={!data.email.globalCapReached && data.email.recipientsAtCap.length === 0}
							title="Email limits"
						>
							{fmtInt(data.email.sent24h)} of {fmtInt(data.email.dailyCap)} daily sign-in emails
							used.
							{data.email.recipientsAtCap.length > 0 &&
								` ${data.email.recipientsAtCap.length} address${data.email.recipientsAtCap.length === 1 ? " is" : "es are"} at the per-address limit.`}
						</Check>
						<Check ok={stuckSol.length === 0} title="Pending SOL payments">
							{data.pendingSol.length === 0
								? "None waiting."
								: `${data.pendingSol.length} pending, ${stuckSol.length} older than 15 minutes.`}
						</Check>
						<Check
							ok={data.reconciliation.unreconciledOlderThan7d === 0 && current?.status !== "failed"}
							title="Cost reconciliation"
						>
							{data.reconciliation.unreconciledOlderThan7d > 0
								? `${fmtInt(data.reconciliation.unreconciledOlderThan7d)} costs couldn't be confirmed within 7 days. `
								: "All live costs confirmed. "}
							{data.reconciliation.estimatedRows > 0 &&
								`${fmtInt(data.reconciliation.estimatedRows)} older images use estimated costs.`}
						</Check>
						{data.backup.lastBackupAt !== null && (
							<Check
								ok={backupAge !== null && backupAge < BACKUP_MAX_AGE_MS}
								title="Database backup"
							>
								Last backup {fmtAgo(data.backup.lastBackupAt)} (
								{fmtDate(data.backup.lastBackupAt, true)}).
							</Check>
						)}
					</div>

					<Panel
						title="Cost reconciliation"
						description="Confirms Replicate costs for recent images. Runs hourly on its own; start a pass here if you need it now."
						actions={
							<Button
								variant="outline"
								size="sm"
								onClick={startReconcile}
								disabled={current?.status === "running"}
							>
								{current?.status === "running" ? "Running…" : "Reconcile now"}
							</Button>
						}
					>
						<p className="text-sm text-muted-foreground" aria-live="polite">
							{!current || current.status === "idle"
								? "No manual pass since the server started."
								: current.status === "running"
									? `Started ${fmtAgo(current.startedAt)} by ${current.startedBy ?? "an admin"}.`
									: current.status === "done"
										? `Finished ${fmtAgo(current.finishedAt)}: ${current.result?.reconciled ?? 0} of ${current.result?.processed ?? 0} confirmed, ${current.result?.errors ?? 0} errors.`
										: `Failed ${fmtAgo(current.finishedAt)}: ${current.error}`}
						</p>
					</Panel>

					<Panel title="Webhook failures, last 7 days" bodyClassName="pt-0">
						{data.webhooks.failures.length === 0 ? (
							<EmptyState title="No failed webhooks">
								Stripe events that fail to apply will appear here with the error.
							</EmptyState>
						) : (
							<DataTable>
								<thead>
									<tr>
										<Th>Event</Th>
										<Th>Last failure</Th>
										<Th right>Attempts</Th>
										<Th>Error</Th>
										<Th>State</Th>
									</tr>
								</thead>
								<tbody>
									{data.webhooks.failures.map((f) => (
										<tr key={f.eventId}>
											<Td>
												<div className="font-mono text-xs">{f.eventId}</div>
												<div className="text-xs text-muted-foreground">{f.type}</div>
											</Td>
											<Td className="whitespace-nowrap tabular-nums">
												{fmtDate(f.lastFailedAt, true)}
											</Td>
											<Td num>{f.attempts}</Td>
											<Td className="text-xs text-muted-foreground">{f.error}</Td>
											<Td>
												{f.resolved ? (
													<Badge variant="outline">Applied later</Badge>
												) : (
													<Badge variant="destructive">Not applied</Badge>
												)}
											</Td>
										</tr>
									))}
								</tbody>
							</DataTable>
						)}
					</Panel>

					<div className="grid gap-6 lg:grid-cols-2">
						<Panel title="Failed payments, last 30 days" bodyClassName="pt-0">
							{data.failedPayments.length === 0 ? (
								<EmptyState title="No failed payments">
									Declined or failed Stripe invoices will appear here.
								</EmptyState>
							) : (
								<DataTable className="min-w-[28rem]">
									<thead>
										<tr>
											<Th>User</Th>
											<Th>When</Th>
											<Th right>Amount</Th>
											<Th>Invoice</Th>
										</tr>
									</thead>
									<tbody>
										{data.failedPayments.map((p) => (
											<tr key={p.id}>
												<Td>
													<Link
														to={`/admin/users/${p.userId}`}
														className="underline-offset-4 hover:underline"
													>
														{p.username ?? "Unknown"}
													</Link>
												</Td>
												<Td className="whitespace-nowrap tabular-nums">{fmtDate(p.createdAt)}</Td>
												<Td num>{fmtCents(p.amountCents)}</Td>
												<Td>
													{p.invoiceId ? (
														<ExternalLink href={stripeInvoiceUrl(p.invoiceId)}>Open</ExternalLink>
													) : (
														"—"
													)}
												</Td>
											</tr>
										))}
									</tbody>
								</DataTable>
							)}
						</Panel>
						<Panel title="Pending SOL payments" bodyClassName="pt-0">
							{data.pendingSol.length === 0 ? (
								<EmptyState title="Nothing pending">
									SOL purchases waiting for a confirmed transaction will appear here.
								</EmptyState>
							) : (
								<DataTable className="min-w-[28rem]">
									<thead>
										<tr>
											<Th>User</Th>
											<Th>For</Th>
											<Th>Started</Th>
											<Th right>SOL</Th>
										</tr>
									</thead>
									<tbody>
										{data.pendingSol.map((p) => (
											<tr key={p.id}>
												<Td>
													<Link
														to={`/admin/users/${p.userId}`}
														className="underline-offset-4 hover:underline"
													>
														{p.username ?? "Unknown"}
													</Link>
												</Td>
												<Td>{p.kind === "subscription" ? "Plan" : "Credits"}</Td>
												<Td className="whitespace-nowrap">{fmtAgo(p.createdAt)}</Td>
												<Td num>{p.amountSol}</Td>
											</tr>
										))}
									</tbody>
								</DataTable>
							)}
						</Panel>
					</div>

					{data.email.recipientsAtCap.length > 0 && (
						<Panel title="Addresses at the email limit" bodyClassName="pt-0">
							<DataTable className="min-w-[24rem]">
								<thead>
									<tr>
										<Th>Address</Th>
										<Th right>Last hour</Th>
										<Th right>Last 24 h</Th>
									</tr>
								</thead>
								<tbody>
									{data.email.recipientsAtCap.map((r) => (
										<tr key={r.recipient}>
											<Td>{r.recipient}</Td>
											<Td num>{r.hour}</Td>
											<Td num>{r.day}</Td>
										</tr>
									))}
								</tbody>
							</DataTable>
						</Panel>
					)}
				</div>
			)}
		</div>
	);
}
