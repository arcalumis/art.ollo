import { Link } from "react-router-dom";
import {
	type Overview,
	fmtCents,
	fmtCost,
	fmtDate,
	fmtInt,
	fmtPct,
	fmtUsd,
	useAdminQuery,
} from "./api";
import {
	DailyBars,
	DataTable,
	EmptyState,
	ErrorState,
	LoadingBlock,
	PageHeader,
	Panel,
	Stat,
	Td,
	Th,
} from "./parts";

const pct = (part: number, whole: number) => (whole > 0 ? (part / whole) * 100 : null);

export default function AdminOverview() {
	const { data, error, loading, reload } = useAdminQuery<Overview>("/api/admin/overview");
	const month = new Date().toLocaleDateString("en-US", { month: "long", timeZone: "UTC" });

	return (
		<div>
			<PageHeader
				title="Overview"
				description={
					data
						? `Live numbers as of ${fmtDate(data.asOf, true)}. Months are UTC.`
						: "Live numbers for ollo."
				}
			/>
			{error && <ErrorState message={error} onRetry={reload} />}
			{loading && !data && <LoadingBlock rows={6} />}
			{data && (
				<div className="flex flex-col gap-6">
					<div className="grid grid-cols-2 gap-3 md:grid-cols-4">
						<Stat
							label="MRR"
							value={fmtCents(data.mrr.cents)}
							hint={`Stripe ${fmtCents(data.mrr.stripeCents)} · SOL ${fmtCents(data.mrr.solCents)}`}
						/>
						<Stat
							label="Paid subscribers"
							value={fmtInt(data.paidSubscribers)}
							hint={data.pastDue > 0 ? `${data.pastDue} past due` : "Stripe and SOL plans"}
							tone={data.pastDue > 0 ? "danger" : undefined}
						/>
						<Stat
							label={`Revenue in ${month}`}
							value={fmtUsd(data.revenueThisMonth.total)}
							hint={`Stripe ${fmtUsd(data.revenueThisMonth.stripe)} · SOL ${fmtUsd(data.revenueThisMonth.sol)}`}
						/>
						<Stat
							label={`Replicate cost in ${month}`}
							value={fmtCost(data.costThisMonth.total)}
							hint={
								data.costThisMonth.backfilled > 0
									? `${fmtCost(data.costThisMonth.backfilled)} estimated`
									: "Booked per image"
							}
						/>
						<Stat
							label="Gross margin"
							value={fmtPct(data.grossMargin)}
							hint={
								data.grossMargin === null
									? "No revenue yet this month"
									: `${fmtUsd(data.grossProfit)} gross profit`
							}
							tone={data.grossMargin !== null && data.grossMargin < 0 ? "danger" : undefined}
						/>
						<Stat
							label="Signups"
							value={`${fmtInt(data.signups.last7)} / ${fmtInt(data.signups.last30)}`}
							hint={`Last 7 / 30 days · ${fmtInt(data.signups.total)} total`}
						/>
						<Stat
							label="Activation"
							value={fmtPct(pct(data.activation.activated, data.activation.users))}
							hint={`${fmtInt(data.activation.activated)} of ${fmtInt(data.activation.users)} made an image${
								data.activation.users30 > 0
									? ` · 30 days: ${fmtPct(pct(data.activation.activated30, data.activation.users30))}`
									: ""
							}`}
						/>
						<Stat
							label="Failed payments"
							value={fmtInt(data.failedPayments30d)}
							hint="Last 30 days"
							tone={data.failedPayments30d > 0 ? "danger" : undefined}
						/>
					</div>

					{data.stale > 0 && (
						<p className="rounded-2xl border border-border bg-card px-4 py-3 text-sm text-muted-foreground">
							{data.stale === 1
								? "1 Stripe subscription has"
								: `${data.stale} Stripe subscriptions have`}{" "}
							a renewal date more than 3 days in the past, so Stripe updates may be missing. They
							still count toward MRR.{" "}
							<Link
								to="/admin/subscriptions?status=paid"
								className="text-foreground underline underline-offset-4"
							>
								Review subscriptions
							</Link>
						</p>
					)}

					<Panel title="Last 30 days" bodyClassName="grid gap-6 md:grid-cols-2">
						<DailyBars
							title="Revenue per day"
							data={data.trend.map((t) => ({ date: t.date, value: t.revenue }))}
							format={(v) => fmtUsd(v)}
						/>
						<DailyBars
							title="Signups per day"
							data={data.trend.map((t) => ({ date: t.date, value: t.signups }))}
							format={(v) => fmtInt(v)}
						/>
					</Panel>

					<div className="grid gap-6 lg:grid-cols-2">
						<Panel
							title="Paid subscribers by plan"
							description="MRR each plan contributes right now."
							bodyClassName="pt-0"
						>
							{data.paidByPlan.length === 0 ? (
								<EmptyState title="No paid subscribers">
									Stripe subscriptions and SOL plans with time left will appear here.
								</EmptyState>
							) : (
								<DataTable className="min-w-0">
									<thead>
										<tr>
											<Th>Plan</Th>
											<Th right>Subscribers</Th>
											<Th right>MRR</Th>
										</tr>
									</thead>
									<tbody>
										{data.paidByPlan.map((p) => (
											<tr key={p.plan}>
												<Td>{p.plan}</Td>
												<Td num>{fmtInt(p.subscribers)}</Td>
												<Td num>{fmtCents(p.mrrCents)}</Td>
											</tr>
										))}
									</tbody>
								</DataTable>
							)}
						</Panel>
						<Panel
							title={`Subscription revenue by plan, ${month}`}
							description="Each payment counts once, for the plan held when it was paid."
							bodyClassName="pt-0"
						>
							{data.revenueByPlan.length === 0 ? (
								<EmptyState title={`No subscription payments in ${month}`}>
									Stripe invoices and SOL plan purchases will appear here as they are paid.
								</EmptyState>
							) : (
								<DataTable className="min-w-0">
									<thead>
										<tr>
											<Th>Plan</Th>
											<Th right>Payers</Th>
											<Th right>Revenue</Th>
										</tr>
									</thead>
									<tbody>
										{data.revenueByPlan.map((p) => (
											<tr key={p.tier}>
												<Td>{p.tier}</Td>
												<Td num>{fmtInt(p.subscribers)}</Td>
												<Td num>{fmtUsd(p.revenue)}</Td>
											</tr>
										))}
									</tbody>
								</DataTable>
							)}
						</Panel>
					</div>
					<p className="text-xs text-muted-foreground">
						Lifetime value:{" "}
						{data.ltv === null
							? "not enough data yet (needs paid subscription history)."
							: fmtUsd(data.ltv)}
					</p>
				</div>
			)}
		</div>
	);
}
