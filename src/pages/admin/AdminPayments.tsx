import { Button } from "@/components/ui/button";
import { Link, useSearchParams } from "react-router-dom";
import {
	type PaymentItem,
	fmtCents,
	fmtDate,
	fmtInt,
	solanaTxUrl,
	stripeInvoiceUrl,
	stripePaymentUrl,
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
	StatusBadge,
	Td,
	Th,
} from "./parts";

interface Response {
	total: number;
	page: number;
	limit: number;
	payments: PaymentItem[];
}

const KIND_LABEL: Record<string, string> = {
	subscription: "Subscription",
	credit_purchase: "Credit pack",
	overage: "Overage",
	sol_subscription: "Plan (SOL)",
	sol_credits: "Credits (SOL)",
};

export default function AdminPayments() {
	const [params, setParams] = useSearchParams();
	const method = params.get("method") ?? "";
	const status = params.get("status") ?? "";
	const page = Math.max(1, Number(params.get("page") ?? "1") || 1);
	const qs = new URLSearchParams({ page: String(page), limit: "50" });
	if (method) qs.set("method", method);
	if (status) qs.set("status", status);
	const { data, error, loading, reload } = useAdminQuery<Response>(`/api/admin/payments?${qs}`);
	const totalPages = data ? Math.max(1, Math.ceil(data.total / data.limit)) : 1;

	const update = (key: string, value: string) => {
		const next = new URLSearchParams(params);
		if (value) next.set(key, value);
		else next.delete(key);
		if (key !== "page") next.delete("page");
		setParams(next, { replace: true });
	};

	return (
		<div>
			<PageHeader
				title="Payments"
				description="Stripe card payments and SOL transactions in one list, newest first."
			/>
			{error && <ErrorState message={error} onRetry={reload} />}
			<Panel
				bodyClassName="pt-0"
				title={
					data ? `${fmtInt(data.total)} ${data.total === 1 ? "payment" : "payments"}` : "Payments"
				}
				description="Failed invoices are highlighted. SOL amounts show the dollar value booked when the payment was verified."
				actions={
					<div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row">
						<FilterSelect
							label="Methods"
							value={method}
							options={[
								{ value: "card", label: "Card (Stripe)" },
								{ value: "sol", label: "SOL" },
							]}
							onChange={(v) => update("method", v)}
						/>
						<FilterSelect
							label="Statuses"
							value={status}
							options={[
								{ value: "succeeded", label: "Paid (card)" },
								{ value: "completed", label: "Paid (SOL)" },
								{ value: "failed", label: "Failed" },
								{ value: "pending", label: "Pending" },
							]}
							onChange={(v) => update("status", v)}
						/>
					</div>
				}
			>
				{loading && !data && <LoadingBlock />}
				{data && data.payments.length === 0 && (
					<EmptyState
						title={method || status ? "No payments match these filters" : "No payments yet"}
					>
						Stripe invoices, credit pack purchases and SOL transactions will appear here as they
						happen.
					</EmptyState>
				)}
				{data && data.payments.length > 0 && (
					<>
						<DataTable className="min-w-[56rem]">
							<thead>
								<tr>
									<Th>When</Th>
									<Th>User</Th>
									<Th>What</Th>
									<Th>Method</Th>
									<Th>Status</Th>
									<Th right>Amount</Th>
									<Th>Details</Th>
								</tr>
							</thead>
							<tbody>
								{data.payments.map((p) => (
									<tr
										key={`${p.method}-${p.id}`}
										className={p.status === "failed" ? "bg-destructive/5" : undefined}
									>
										<Td className="whitespace-nowrap tabular-nums">{fmtDate(p.createdAt, true)}</Td>
										<Td>
											<Link
												to={`/admin/users/${p.userId}`}
												className="underline-offset-4 hover:underline"
											>
												{p.username ?? "Unknown"}
											</Link>
										</Td>
										<Td>
											{KIND_LABEL[p.kind] ?? p.kind}
											{p.description && (
												<div className="text-xs text-muted-foreground">{p.description}</div>
											)}
										</Td>
										<Td>{p.method === "sol" ? "SOL" : "Card"}</Td>
										<Td>
											<StatusBadge status={p.status} />
										</Td>
										<Td num>
											{fmtCents(p.amountCents)}
											{p.amountSol != null && (
												<div className="text-xs text-muted-foreground">{p.amountSol} SOL</div>
											)}
										</Td>
										<Td>
											<div className="flex flex-col gap-0.5 text-xs">
												{p.stripeInvoiceId && (
													<ExternalLink href={stripeInvoiceUrl(p.stripeInvoiceId)}>
														Invoice
													</ExternalLink>
												)}
												{p.stripePaymentIntentId && (
													<ExternalLink href={stripePaymentUrl(p.stripePaymentIntentId)}>
														Payment
													</ExternalLink>
												)}
												{p.signature && (
													<ExternalLink href={solanaTxUrl(p.signature)}>Transaction</ExternalLink>
												)}
												{!p.stripeInvoiceId && !p.stripePaymentIntentId && !p.signature && (
													<span className="text-muted-foreground">—</span>
												)}
											</div>
										</Td>
									</tr>
								))}
							</tbody>
						</DataTable>
						{totalPages > 1 && (
							<div className="flex items-center justify-between pt-4 text-sm text-muted-foreground">
								<span>
									Page {page} of {totalPages}
								</span>
								<div className="flex gap-2">
									<Button
										variant="outline"
										size="sm"
										disabled={page <= 1}
										onClick={() => update("page", String(page - 1))}
									>
										Previous
									</Button>
									<Button
										variant="outline"
										size="sm"
										disabled={page >= totalPages}
										onClick={() => update("page", String(page + 1))}
									>
										Next
									</Button>
								</div>
							</div>
						)}
					</>
				)}
			</Panel>
		</div>
	);
}
