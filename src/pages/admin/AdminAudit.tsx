import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ChevronDownIcon, ChevronRightIcon, SearchIcon } from "lucide-react";
import { Fragment, useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { type AuditEntry, fmtDate, fmtInt, useAdminQuery } from "./api";
import {
	DataTable,
	EmptyState,
	ErrorState,
	FilterSelect,
	LoadingBlock,
	PageHeader,
	Panel,
	Td,
	Th,
} from "./parts";

const ACTION_LABEL: Record<string, string> = {
	"credits.grant": "Credits granted",
	"credits.deduct": "Credits deducted",
	"subscription.change": "Plan changed",
	"boost.grant": "Boost granted",
	"boost.cancel": "Boost canceled",
	"user.create": "User created",
	"user.deactivate": "User deactivated",
	"user.reactivate": "User reactivated",
	"user.grant_admin": "Admin granted",
	"user.revoke_admin": "Admin removed",
	"user.update_email": "Email changed",
	"user.sign_out_everywhere": "Signed out everywhere",
	"user.send_sign_in_link": "Sign-in link sent",
	"product.create": "Plan created",
	"product.update": "Plan edited",
	"product.deactivate": "Plan deactivated",
	"credit_package.create": "Credit pack created",
	"credit_package.update": "Credit pack edited",
	"credit_package.deactivate": "Credit pack deactivated",
	"model_cost.set": "Credit cost set",
	"model_cost.reset": "Credit cost reset",
	"moderation.remove": "Image removed",
	"costs.reconcile": "Cost reconciliation started",
	"financials.snapshot": "Snapshot computed",
};

export const actionLabel = (a: string) => ACTION_LABEL[a] ?? a;

const LIMIT = 50;

function Target({ e }: { e: AuditEntry }) {
	if (!e.targetId) return <span className="text-muted-foreground">{e.targetType}</span>;
	if (e.targetType === "user") {
		return (
			<Link to={`/admin/users/${e.targetId}`} className="hover:underline">
				{e.targetLabel ?? `${e.targetId.slice(0, 8)}…`}
			</Link>
		);
	}
	return (
		<span className="block max-w-[16rem] truncate" title={e.targetId}>
			<span className="text-muted-foreground">{e.targetType.replace("_", " ")} </span>
			{e.targetId}
		</span>
	);
}

const json = (v: unknown) => (v == null ? "—" : JSON.stringify(v, null, 2));

export default function AdminAudit() {
	const [searchParams, setSearchParams] = useSearchParams();
	const targetId = searchParams.get("targetId") ?? "";
	const [action, setAction] = useState("");
	const [search, setSearch] = useState("");
	const [q, setQ] = useState("");
	const [page, setPage] = useState(1);
	const [open, setOpen] = useState<string | null>(null);

	// Search applies 300 ms after typing stops (or at once on Enter).
	useEffect(() => {
		const t = setTimeout(() => {
			setQ(search.trim());
			setPage(1);
		}, 300);
		return () => clearTimeout(t);
	}, [search]);

	const params = new URLSearchParams({ page: String(page), limit: String(LIMIT) });
	if (action) params.set("action", action);
	if (q) params.set("q", q);
	if (targetId) params.set("targetId", targetId);
	const { data, error, loading, reload } = useAdminQuery<{
		entries: AuditEntry[];
		total: number;
		actions: string[];
	}>(`/api/admin/audit?${params}`);
	const entries = data?.entries ?? [];
	const pages = data ? Math.max(1, Math.ceil(data.total / LIMIT)) : 1;

	return (
		<div className="flex flex-col gap-6">
			<PageHeader
				title="Audit log"
				description="Every change made from this console: who, what, to whom, and why."
			/>

			<form
				className="flex flex-col gap-2 sm:flex-row"
				onSubmit={(e) => {
					e.preventDefault();
					setQ(search.trim());
					setPage(1);
				}}
			>
				<div className="relative sm:w-80">
					<SearchIcon
						className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
						aria-hidden
					/>
					<Input
						type="search"
						value={search}
						onChange={(e) => setSearch(e.target.value)}
						placeholder="Search reason, admin or user"
						aria-label="Search the audit log"
						className="pl-9"
					/>
				</div>
				<FilterSelect
					label="Actions"
					value={action}
					className="sm:w-56"
					options={(data?.actions ?? []).map((a) => ({ value: a, label: actionLabel(a) }))}
					onChange={(v) => {
						setAction(v);
						setPage(1);
					}}
				/>
			</form>

			{targetId && (
				<p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
					Showing entries for one target ({targetId.slice(0, 8)}…).
					<Button variant="ghost" size="sm" onClick={() => setSearchParams({}, { replace: true })}>
						Show all
					</Button>
				</p>
			)}

			{error && <ErrorState message={error} onRetry={reload} />}

			<Panel
				description={data ? `${fmtInt(data.total)} entries` : undefined}
				title="Entries"
				actions={
					pages > 1 ? (
						<div className="flex items-center gap-2 text-xs tabular-nums text-muted-foreground">
							<Button
								size="sm"
								variant="outline"
								disabled={page <= 1}
								onClick={() => setPage((p) => p - 1)}
							>
								Previous
							</Button>
							<span>
								Page {page} of {pages}
							</span>
							<Button
								size="sm"
								variant="outline"
								disabled={page >= pages}
								onClick={() => setPage((p) => p + 1)}
							>
								Next
							</Button>
						</div>
					) : undefined
				}
				bodyClassName="pt-0 pb-0"
			>
				{loading && !data ? (
					<div className="py-4">
						<LoadingBlock />
					</div>
				) : entries.length === 0 ? (
					<EmptyState title={q || action ? "No matching entries" : "Nothing logged yet"}>
						Credit changes, plan changes, boosts, removals and other admin actions appear here with
						their reason.
					</EmptyState>
				) : (
					<DataTable className="min-w-[48rem]">
						<thead>
							<tr>
								<Th>
									<span className="sr-only">Details</span>
								</Th>
								<Th>When</Th>
								<Th>Admin</Th>
								<Th>Action</Th>
								<Th>Target</Th>
								<Th>Reason</Th>
							</tr>
						</thead>
						<tbody>
							{entries.map((e) => {
								const expanded = open === e.id;
								return (
									<Fragment key={e.id}>
										<tr>
											<Td className="w-10 px-2">
												<Button
													variant="ghost"
													size="icon-sm"
													aria-expanded={expanded}
													aria-label={expanded ? "Hide details" : "Show details"}
													onClick={() => setOpen(expanded ? null : e.id)}
												>
													{expanded ? <ChevronDownIcon /> : <ChevronRightIcon />}
												</Button>
											</Td>
											<Td className="whitespace-nowrap tabular-nums">
												{fmtDate(e.createdAt, true)}
											</Td>
											<Td>{e.adminUsername ?? "System"}</Td>
											<Td className="whitespace-nowrap">{actionLabel(e.action)}</Td>
											<Td>
												<Target e={e} />
											</Td>
											<Td className="max-w-[20rem] text-muted-foreground">{e.reason ?? "—"}</Td>
										</tr>
										{expanded && (
											<tr>
												<td colSpan={6} className="border-b border-border bg-muted/40 px-4 py-3">
													<div className="grid gap-3 md:grid-cols-2">
														<div className="min-w-0">
															<p className="mb-1 text-xs font-medium text-muted-foreground">
																Before
															</p>
															<pre className="max-h-64 overflow-auto rounded-lg bg-background p-2 text-xs text-foreground">
																{json(e.before)}
															</pre>
														</div>
														<div className="min-w-0">
															<p className="mb-1 text-xs font-medium text-muted-foreground">
																After
															</p>
															<pre className="max-h-64 overflow-auto rounded-lg bg-background p-2 text-xs text-foreground">
																{json(e.after)}
															</pre>
														</div>
													</div>
												</td>
											</tr>
										)}
									</Fragment>
								);
							})}
						</tbody>
					</DataTable>
				)}
			</Panel>
		</div>
	);
}
