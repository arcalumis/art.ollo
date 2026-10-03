import { Badge } from "@/components/ui/badge";
import { Link, useSearchParams } from "react-router-dom";
import {
	type SubscriptionItem,
	fmtCents,
	fmtDate,
	fmtInt,
	stripeSubscriptionUrl,
	useAdminQuery,
} from "./api";
import {
	DataTable,
	EmptyState,
	ErrorState,
	ExternalLink,
	FilterSelect,
	LoadingBlock,
	PageHeader,
	Panel,
	SourceBadge,
	Stat,
	StatusBadge,
	Td,
	Th,
} from "./parts";

interface Response {
	subscriptions: SubscriptionItem[];
	plans: string[];
	totals: { users: number; paid: number; mrrCents: number; pastDue: number; stale: number };
}

const STATUS_OPTIONS = [
	{ value: "paid", label: "Paid now" },
	{ value: "active", label: "Active" },
	{ value: "trialing", label: "Trial" },
	{ value: "past_due", label: "Past due" },
	{ value: "canceled", label: "Canceled" },
	{ value: "expired", label: "Expired" },
];
const SOURCE_OPTIONS = [
	{ value: "stripe", label: "Stripe" },
	{ value: "sol", label: "SOL" },
	{ value: "admin", label: "Admin" },
	{ value: "boost", label: "Boost" },
	{ value: "free", label: "Free" },
];

export default function AdminSubscriptions() {
	const [params, setParams] = useSearchParams();
	const plan = params.get("plan") ?? "";
	const status = params.get("status") ?? "";
	const source = params.get("source") ?? "";
	const qs = new URLSearchParams();
	if (plan) qs.set("plan", plan);
	if (status) qs.set("status", status);
	if (source) qs.set("source", source);
	const { data, error, loading, reload } = useAdminQuery<Response>(
		`/api/admin/subscriptions?${qs}`,
	);

	const setFilter = (key: string, value: string) => {
		const next = new URLSearchParams(params);
		if (value) next.set(key, value);
		else next.delete(key);
		setParams(next, { replace: true });
	};
	const filtered = Boolean(plan || status || source);

	return (
		<div>
			<PageHeader
				title="Subscriptions"
				description="Every user's current plan, where it came from, and what it adds to MRR."
			/>
			{error && <ErrorState message={error} onRetry={reload} />}
			{data && (
				<div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
					<Stat label="MRR" value={fmtCents(data.totals.mrrCents)} />
					<Stat
						label="Paid now"
						value={fmtInt(data.totals.paid)}
						hint={`of ${fmtInt(data.totals.users)} users`}
					/>
					<Stat
						label="Past due"
						value={fmtInt(data.totals.pastDue)}
						tone={data.totals.pastDue > 0 ? "danger" : undefined}
					/>
					<Stat
						label="Renewal overdue"
						value={fmtInt(data.totals.stale)}
						hint="Stripe renewal date passed 3+ days ago"
						tone={data.totals.stale > 0 ? "danger" : undefined}
					/>
				</div>
			)}
			<Panel
				bodyClassName="pt-0"
				title={
					data
						? `${fmtInt(data.subscriptions.length)} ${data.subscriptions.length === 1 ? "user" : "users"}`
						: "Users"
				}
				actions={
					<div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row">
						<FilterSelect
							label="Plans"
							value={plan}
							options={(data?.plans ?? []).map((p) => ({ value: p, label: p }))}
							onChange={(v) => setFilter("plan", v)}
						/>
						<FilterSelect
							label="Statuses"
							value={status}
							options={STATUS_OPTIONS}
							onChange={(v) => setFilter("status", v)}
						/>
						<FilterSelect
							label="Sources"
							value={source}
							options={SOURCE_OPTIONS}
							onChange={(v) => setFilter("source", v)}
						/>
					</div>
				}
			>
				{loading && !data && <LoadingBlock />}
				{data && data.subscriptions.length === 0 && (
					<EmptyState title={filtered ? "No users match these filters" : "No users yet"}>
						{filtered
							? "Clear a filter to see more."
							: "Each user and their plan will appear here once they sign up."}
					</EmptyState>
				)}
				{data && data.subscriptions.length > 0 && (
					<DataTable className="min-w-[60rem]">
						<thead>
							<tr>
								<Th>User</Th>
								<Th>Plan</Th>
								<Th>Source</Th>
								<Th>Status</Th>
								<Th>Started</Th>
								<Th>Renews / ends</Th>
								<Th right>MRR</Th>
								<Th>Stripe</Th>
							</tr>
						</thead>
						<tbody>
							{data.subscriptions.map((s) => (
								<tr key={s.userId} className={s.pastDue ? "bg-destructive/5" : undefined}>
									<Td>
										<Link
											to={`/admin/users/${s.userId}`}
											className="font-medium hover:underline underline-offset-4"
										>
											{s.username}
										</Link>
										{s.email && <div className="text-xs text-muted-foreground">{s.email}</div>}
									</Td>
									<Td>
										{s.plan}
										{s.basePlan && (
											<div className="text-xs text-muted-foreground">over {s.basePlan}</div>
										)}
									</Td>
									<Td>
										<SourceBadge source={s.source} />
									</Td>
									<Td>
										<div className="flex flex-wrap gap-1">
											<StatusBadge status={s.status} />
											{s.stale && <Badge variant="destructive">Renewal overdue</Badge>}
										</div>
									</Td>
									<Td num className="text-left">
										{fmtDate(s.startedAt)}
									</Td>
									<Td num className="text-left">
										{s.renewsAt ? (
											<span>Renews {fmtDate(s.renewsAt)}</span>
										) : s.endsAt ? (
											<span>Ends {fmtDate(s.endsAt)}</span>
										) : (
											<span className="text-muted-foreground">No end date</span>
										)}
									</Td>
									<Td num>
										{s.mrrCents > 0 ? (
											fmtCents(s.mrrCents)
										) : (
											<span className="text-muted-foreground">—</span>
										)}
									</Td>
									<Td>
										{s.stripeSubscriptionId ? (
											<ExternalLink
												href={stripeSubscriptionUrl(s.stripeSubscriptionId)}
												className="text-xs"
											>
												Open
											</ExternalLink>
										) : (
											<span className="text-muted-foreground">—</span>
										)}
									</Td>
								</tr>
							))}
						</tbody>
					</DataTable>
				)}
			</Panel>
		</div>
	);
}
