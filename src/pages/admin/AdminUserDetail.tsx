import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAuth } from "@/contexts/AuthContext";
import { ArrowLeftIcon } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { toast } from "sonner";
import { API_BASE } from "../../config";
import {
	type AuditEntry,
	type PaymentItem,
	type Product,
	SOURCE_LABEL,
	type SubscriptionItem,
	fmtCents,
	fmtCost,
	fmtDate,
	fmtInt,
	solanaTxUrl,
	stripeCustomerUrl,
	stripeInvoiceUrl,
	stripeSubscriptionUrl,
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
	ReasonDialog,
	Stat,
	StatusBadge,
	Td,
	Th,
	Thumb,
} from "./parts";

interface Detail {
	id: string;
	username: string;
	email: string | null;
	walletAddress: string | null;
	isAdmin: boolean;
	isActive: boolean;
	deletedAt: string | null;
	createdAt: string | null;
	lastLogin: string | null;
	sessionVersion: number;
	stripeCustomerId: string | null;
	balance: number;
	totalPaidCents: number;
	generationCount: number;
	generationCost: number;
	current: SubscriptionItem | null;
	ledger: Array<{
		id: string;
		type: string;
		amount: number;
		reason: string | null;
		createdAt: string | null;
	}>;
	generations: Array<{
		id: string;
		prompt: string;
		model: string;
		imageUrl: string | null;
		createdAt: string | null;
		deleted: boolean;
		moderated: boolean;
		moderationReason: string | null;
		cost: number;
	}>;
	payments: PaymentItem[];
	subscriptions: Array<{
		id: string;
		plan: string;
		source: "stripe" | "sol" | "admin" | "free";
		status: string;
		startsAt: string | null;
		endsAt: string | null;
		currentPeriodEnd: string | null;
		stripeSubscriptionId: string | null;
		monthlyValueCents: number;
	}>;
	boosts: Array<{
		id: string;
		plan: string;
		status: string;
		startsAt: string | null;
		endsAt: string | null;
		reason: string | null;
		grantedBy: string | null;
	}>;
	shareLinks: Array<{
		slug: string;
		generationId: string;
		imageUrl: string | null;
		createdAt: string | null;
		revokedAt: string | null;
	}>;
	audit: AuditEntry[];
}

type Action = "credits" | "plan" | "boost" | "link" | "signout" | "active" | null;

const asset = (url: string | null) =>
	url ? (url.startsWith("http") ? url : `${API_BASE}${url}`) : null;

function Field({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div className="min-w-0">
			<dt className="text-xs text-muted-foreground">{label}</dt>
			<dd className="mt-0.5 truncate text-sm text-foreground">{children}</dd>
		</div>
	);
}

function ProductSelect({
	products,
	value,
	onChange,
	label,
}: { products: Product[]; value: string; onChange: (v: string) => void; label: string }) {
	const name = (id: string) => products.find((p) => p.id === id)?.name ?? "Choose a plan";
	return (
		<div className="grid gap-1.5">
			<span className="text-sm font-medium">{label}</span>
			<Select value={value || null} onValueChange={(v) => onChange((v as string) ?? "")}>
				<SelectTrigger className="h-10 w-full data-[size=default]:h-10" aria-label={label}>
					<SelectValue>{(v: string | null) => (v ? name(v) : "Choose a plan")}</SelectValue>
				</SelectTrigger>
				<SelectContent>
					{products
						.filter((p) => p.isActive)
						.map((p) => (
							<SelectItem key={p.id} value={p.id}>
								{p.name}
								{p.price > 0 ? ` · $${p.price}/mo` : ""}
							</SelectItem>
						))}
				</SelectContent>
			</Select>
		</div>
	);
}

export default function AdminUserDetail() {
	const { id = "" } = useParams();
	const { user: me } = useAuth();
	const call = useAdminCall();
	const { data, error, loading, reload } = useAdminQuery<Detail>(
		`/api/admin/users/${encodeURIComponent(id)}`,
	);
	const products = useAdminQuery<{ products: Product[] }>("/api/admin/products");
	const [action, setAction] = useState<Action>(null);
	const [amount, setAmount] = useState("");
	const [planId, setPlanId] = useState("");
	const [grantBonus, setGrantBonus] = useState(false);
	const [boostId, setBoostId] = useState("");
	const [boostDays, setBoostDays] = useState("30");
	const fid = useId();

	const run = async (
		method: string,
		path: string,
		body: Record<string, unknown>,
		success: string,
	) => {
		const res = await call(method, path, body);
		if (!res.ok) return res.data.error ?? "That didn't work. Try again.";
		toast.success(success);
		void reload();
		return null;
	};
	const base = `/api/admin/users/${encodeURIComponent(id)}`;
	const amountNum = Number(amount);
	const amountValid =
		Number.isInteger(amountNum) && amountNum !== 0 && Math.abs(amountNum) <= 10_000;
	const daysNum = Number(boostDays);
	const daysValid = Number.isInteger(daysNum) && daysNum >= 1 && daysNum <= 365;
	const isSelf = me?.id === id;

	if (error) return <ErrorState message={error} onRetry={reload} />;
	if (loading && !data) return <LoadingBlock rows={8} />;
	if (!data) return null;

	const current = data.current;
	const productList = products.data?.products ?? [];

	return (
		<div>
			<Link
				to="/admin/users"
				className="mb-3 inline-flex h-10 items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
			>
				<ArrowLeftIcon className="size-4" aria-hidden />
				Users
			</Link>
			<PageHeader
				title={data.username}
				description={
					<span className="flex flex-wrap items-center gap-1.5">
						<span>{data.email ?? (data.walletAddress ? "Wallet sign-in" : "No email")}</span>
						{data.isAdmin && <Badge variant="outline">Admin</Badge>}
						{!data.isActive && <Badge variant="destructive">Deactivated</Badge>}
						{data.deletedAt && (
							<Badge variant="destructive">Deleted {fmtDate(data.deletedAt)}</Badge>
						)}
					</span>
				}
			/>

			<div className="mb-6 flex flex-wrap gap-2">
				<Button variant="outline" onClick={() => setAction("credits")}>
					Adjust credits
				</Button>
				<Button variant="outline" onClick={() => setAction("plan")}>
					Change plan
				</Button>
				<Button variant="outline" onClick={() => setAction("boost")}>
					Comp a boost
				</Button>
				<Button
					variant="outline"
					onClick={() => setAction("link")}
					disabled={!data.email || !data.isActive}
				>
					Send sign-in link
				</Button>
				<Button variant="ghost" onClick={() => setAction("signout")}>
					Sign out everywhere
				</Button>
				<Button
					variant={data.isActive ? "destructive" : "outline"}
					onClick={() => setAction("active")}
					disabled={isSelf}
				>
					{data.isActive ? "Deactivate" : "Reactivate"}
				</Button>
			</div>

			<div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
				<Stat label="Credit balance" value={fmtInt(data.balance)} />
				<Stat
					label="Total paid"
					value={fmtCents(data.totalPaidCents)}
					hint="Stripe and SOL, all time"
				/>
				<Stat
					label="Images"
					value={fmtInt(data.generationCount)}
					hint={`${fmtCost(data.generationCost)} Replicate cost`}
				/>
				<Stat
					label="Plan"
					value={current?.plan ?? "Free"}
					hint={
						!current || current.source === "free"
							? "No paid plan"
							: `${SOURCE_LABEL[current.source]}${current.mrrCents > 0 ? ` · ${fmtCents(current.mrrCents)}/mo` : ""}`
					}
				/>
			</div>

			<Panel title="Account" className="mb-6">
				<dl className="grid grid-cols-2 gap-4 md:grid-cols-4">
					<Field label="Joined">{fmtDate(data.createdAt, true)}</Field>
					<Field label="Last sign-in">{fmtDate(data.lastLogin, true)}</Field>
					<Field label="Plan status">
						{current ? (
							<span className="inline-flex flex-wrap gap-1">
								<StatusBadge status={current.status} />
								{current.stale && <Badge variant="destructive">Renewal overdue</Badge>}
							</span>
						) : (
							"Free"
						)}
					</Field>
					<Field label={current?.renewsAt ? "Renews" : "Ends"}>
						{fmtDate(current?.renewsAt ?? current?.endsAt)}
					</Field>
					<Field label="Stripe customer">
						{data.stripeCustomerId ? (
							<ExternalLink href={stripeCustomerUrl(data.stripeCustomerId)}>
								{data.stripeCustomerId}
							</ExternalLink>
						) : (
							"None"
						)}
					</Field>
					<Field label="Stripe subscription">
						{current?.stripeSubscriptionId ? (
							<ExternalLink href={stripeSubscriptionUrl(current.stripeSubscriptionId)}>
								Open in Stripe
							</ExternalLink>
						) : (
							"None"
						)}
					</Field>
					<Field label="Wallet">
						{data.walletAddress
							? `${data.walletAddress.slice(0, 6)}…${data.walletAddress.slice(-4)}`
							: "None"}
					</Field>
					<Field label="User id">
						<span className="font-mono text-xs">{data.id}</span>
					</Field>
				</dl>
			</Panel>

			<Tabs defaultValue="ledger">
				<div className="-mx-4 overflow-x-auto px-4">
					<TabsList>
						<TabsTrigger value="ledger">Credits</TabsTrigger>
						<TabsTrigger value="images">Images</TabsTrigger>
						<TabsTrigger value="payments">Payments</TabsTrigger>
						<TabsTrigger value="plans">Plan history</TabsTrigger>
						<TabsTrigger value="shares">Share links</TabsTrigger>
						<TabsTrigger value="audit">Admin actions</TabsTrigger>
					</TabsList>
				</div>

				<TabsContent value="ledger">
					<Panel bodyClassName="pt-0" title={`${fmtInt(data.ledger.length)} ledger entries`}>
						{data.ledger.length === 0 ? (
							<EmptyState title="No credit activity">
								Grants, purchases, refills and spending will appear here.
							</EmptyState>
						) : (
							<DataTable>
								<thead>
									<tr>
										<Th>When</Th>
										<Th>Type</Th>
										<Th>Reason</Th>
										<Th right>Credits</Th>
									</tr>
								</thead>
								<tbody>
									{data.ledger.map((r) => (
										<tr key={r.id}>
											<Td className="whitespace-nowrap tabular-nums">
												{fmtDate(r.createdAt, true)}
											</Td>
											<Td className="whitespace-nowrap">{r.type}</Td>
											<Td className="text-muted-foreground">{r.reason ?? "—"}</Td>
											<Td num className={r.amount > 0 ? "text-verdigris" : undefined}>
												{r.amount > 0 ? `+${fmtInt(r.amount)}` : fmtInt(r.amount)}
											</Td>
										</tr>
									))}
								</tbody>
							</DataTable>
						)}
					</Panel>
				</TabsContent>

				<TabsContent value="images">
					<Panel
						title={`Latest ${fmtInt(data.generations.length)} of ${fmtInt(data.generationCount)} images`}
					>
						{data.generations.length === 0 ? (
							<EmptyState title="No images yet">
								Images this user generates will appear here, newest first.
							</EmptyState>
						) : (
							<ul className="grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-6">
								{data.generations.map((g) => (
									<li key={g.id} className="min-w-0">
										<div className="relative aspect-square overflow-hidden rounded-xl bg-muted">
											{asset(g.imageUrl) ? (
												<Thumb
													src={asset(g.imageUrl) ?? undefined}
													alt={g.prompt}
													title={g.prompt}
													className="size-full object-cover"
												/>
											) : (
												<span className="grid size-full place-items-center text-xs text-muted-foreground">
													Purged
												</span>
											)}
											{(g.deleted || g.moderated) && (
												<Badge
													variant={g.moderated ? "destructive" : "secondary"}
													className="absolute top-1.5 left-1.5"
												>
													{g.moderated ? "Removed" : "In trash"}
												</Badge>
											)}
										</div>
										<p className="mt-1 truncate text-xs text-muted-foreground" title={g.prompt}>
											{fmtDate(g.createdAt)} · {fmtCost(g.cost)}
										</p>
									</li>
								))}
							</ul>
						)}
					</Panel>
				</TabsContent>

				<TabsContent value="payments">
					<Panel bodyClassName="pt-0" title="Payments">
						{data.payments.length === 0 ? (
							<EmptyState title="No payments">
								Card payments through Stripe and SOL purchases will appear here.
							</EmptyState>
						) : (
							<DataTable>
								<thead>
									<tr>
										<Th>When</Th>
										<Th>What</Th>
										<Th>Method</Th>
										<Th>Status</Th>
										<Th right>Amount</Th>
										<Th>Link</Th>
									</tr>
								</thead>
								<tbody>
									{data.payments.map((p) => (
										<tr
											key={p.id}
											className={p.status === "failed" ? "bg-destructive/5" : undefined}
										>
											<Td className="whitespace-nowrap tabular-nums">
												{fmtDate(p.createdAt, true)}
											</Td>
											<Td>{p.description ?? p.kind}</Td>
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
												{p.stripeInvoiceId ? (
													<ExternalLink
														href={stripeInvoiceUrl(p.stripeInvoiceId)}
														className="text-xs"
													>
														Invoice
													</ExternalLink>
												) : p.signature ? (
													<ExternalLink href={solanaTxUrl(p.signature)} className="text-xs">
														Transaction
													</ExternalLink>
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
				</TabsContent>

				<TabsContent value="plans">
					<div className="grid gap-6">
						<Panel bodyClassName="pt-0" title="Subscriptions">
							{data.subscriptions.length === 0 ? (
								<EmptyState title="No plan history">
									Plan assignments, upgrades and SOL purchases will appear here.
								</EmptyState>
							) : (
								<DataTable>
									<thead>
										<tr>
											<Th>Plan</Th>
											<Th>Source</Th>
											<Th>Status</Th>
											<Th>Started</Th>
											<Th>Ended / period end</Th>
											<Th right>Monthly value</Th>
										</tr>
									</thead>
									<tbody>
										{data.subscriptions.map((s) => (
											<tr key={s.id}>
												<Td>
													{s.plan}
													{s.stripeSubscriptionId && (
														<div>
															<ExternalLink
																href={stripeSubscriptionUrl(s.stripeSubscriptionId)}
																className="text-xs"
															>
																Stripe
															</ExternalLink>
														</div>
													)}
												</Td>
												<Td>{SOURCE_LABEL[s.source]}</Td>
												<Td>
													<StatusBadge status={s.status} />
												</Td>
												<Td className="whitespace-nowrap tabular-nums">{fmtDate(s.startsAt)}</Td>
												<Td className="whitespace-nowrap tabular-nums">
													{fmtDate(s.endsAt ?? s.currentPeriodEnd)}
												</Td>
												<Td num>{s.monthlyValueCents > 0 ? fmtCents(s.monthlyValueCents) : "—"}</Td>
											</tr>
										))}
									</tbody>
								</DataTable>
							)}
						</Panel>
						<Panel bodyClassName="pt-0" title="Boosts">
							{data.boosts.length === 0 ? (
								<EmptyState title="No boosts">
									Temporary plan upgrades granted by an admin will appear here.
								</EmptyState>
							) : (
								<DataTable>
									<thead>
										<tr>
											<Th>Plan</Th>
											<Th>Status</Th>
											<Th>From</Th>
											<Th>Until</Th>
											<Th>Granted by</Th>
											<Th>Reason</Th>
										</tr>
									</thead>
									<tbody>
										{data.boosts.map((b) => (
											<tr key={b.id}>
												<Td>{b.plan}</Td>
												<Td>
													<StatusBadge status={b.status} />
												</Td>
												<Td className="whitespace-nowrap tabular-nums">{fmtDate(b.startsAt)}</Td>
												<Td className="whitespace-nowrap tabular-nums">{fmtDate(b.endsAt)}</Td>
												<Td>{b.grantedBy ?? "—"}</Td>
												<Td className="text-muted-foreground">{b.reason ?? "—"}</Td>
											</tr>
										))}
									</tbody>
								</DataTable>
							)}
						</Panel>
					</div>
				</TabsContent>

				<TabsContent value="shares">
					<Panel bodyClassName="pt-0" title="Share links">
						{data.shareLinks.length === 0 ? (
							<EmptyState title="No share links">
								Public links this user creates for their images will appear here.
							</EmptyState>
						) : (
							<DataTable>
								<thead>
									<tr>
										<Th>Link</Th>
										<Th>Created</Th>
										<Th>Status</Th>
									</tr>
								</thead>
								<tbody>
									{data.shareLinks.map((s) => (
										<tr key={s.slug}>
											<Td>
												<ExternalLink href={`/s/${s.slug}`}>/s/{s.slug}</ExternalLink>
											</Td>
											<Td className="whitespace-nowrap tabular-nums">{fmtDate(s.createdAt)}</Td>
											<Td>{s.revokedAt ? `Revoked ${fmtDate(s.revokedAt)}` : "Live"}</Td>
										</tr>
									))}
								</tbody>
							</DataTable>
						)}
					</Panel>
				</TabsContent>

				<TabsContent value="audit">
					<Panel bodyClassName="pt-0" title="Admin actions on this account">
						{data.audit.length === 0 ? (
							<EmptyState title="No admin actions yet">
								Every change an admin makes here is recorded with its reason.
							</EmptyState>
						) : (
							<DataTable>
								<thead>
									<tr>
										<Th>When</Th>
										<Th>Admin</Th>
										<Th>Action</Th>
										<Th>Reason</Th>
									</tr>
								</thead>
								<tbody>
									{data.audit.map((a) => (
										<tr key={a.id}>
											<Td className="whitespace-nowrap tabular-nums">
												{fmtDate(a.createdAt, true)}
											</Td>
											<Td>{a.adminUsername ?? "—"}</Td>
											<Td className="font-mono text-xs">{a.action}</Td>
											<Td className="text-muted-foreground">{a.reason ?? "—"}</Td>
										</tr>
									))}
								</tbody>
							</DataTable>
						)}
						<p className="pt-3 text-xs text-muted-foreground">
							<Link
								to={`/admin/audit?targetId=${data.id}`}
								className="underline underline-offset-4"
							>
								Open in the audit log
							</Link>
						</p>
					</Panel>
				</TabsContent>
			</Tabs>

			{/* ---- Action dialogs ---- */}
			<ReasonDialog
				open={action === "credits"}
				onOpenChange={(o) => {
					if (!o) setAction(null);
					setAmount("");
				}}
				title="Adjust credits"
				description={`Balance now: ${fmtInt(data.balance)}. Use a negative number to deduct; the balance can't go below 0.`}
				confirmLabel={amountValid && amountNum < 0 ? "Deduct credits" : "Grant credits"}
				canConfirm={amountValid && data.balance + amountNum >= 0}
				onConfirm={(reason) =>
					run(
						"POST",
						`${base}/credits`,
						{ amount: amountNum, reason },
						amountNum > 0 ? `Granted ${amountNum} credits` : `Deducted ${-amountNum} credits`,
					)
				}
			>
				<div className="grid gap-1.5">
					<label htmlFor={`${fid}-amt`} className="text-sm font-medium">
						Credits (−10,000 to 10,000)
					</label>
					<Input
						id={`${fid}-amt`}
						inputMode="numeric"
						value={amount}
						onChange={(e) => setAmount(e.target.value.trim())}
						placeholder="e.g. 50 or -20"
						aria-invalid={amount !== "" && (!amountValid || data.balance + amountNum < 0)}
					/>
					{amount !== "" && amountValid && data.balance + amountNum < 0 && (
						<p className="text-xs text-destructive">That would leave a negative balance.</p>
					)}
				</div>
			</ReasonDialog>

			<ReasonDialog
				open={action === "plan"}
				onOpenChange={(o) => !o && setAction(null)}
				title="Change plan"
				description={
					current?.stripeSubscriptionId
						? "This user pays through Stripe. Change or cancel the plan in Stripe first; Stripe will update ollo."
						: "The new plan starts now and replaces the current one. It isn't billed."
				}
				confirmLabel="Change plan"
				canConfirm={!!planId && !current?.stripeSubscriptionId}
				onConfirm={(reason) =>
					run(
						"POST",
						`${base}/subscription`,
						{ productId: planId, reason, grantBonus },
						"Plan changed",
					)
				}
			>
				<ProductSelect
					products={productList}
					value={planId}
					onChange={setPlanId}
					label="New plan"
				/>
				<label className="flex items-center gap-2 text-sm">
					<input
						type="checkbox"
						checked={grantBonus}
						onChange={(e) => setGrantBonus(e.target.checked)}
						className="size-4 accent-verdigris"
					/>
					Also grant the plan's welcome bonus credits
				</label>
			</ReasonDialog>

			<ReasonDialog
				open={action === "boost"}
				onOpenChange={(o) => !o && setAction(null)}
				title="Comp a boost"
				description="Temporary access to another plan's models and limits. It replaces any active boost and adds 25 bonus credits."
				confirmLabel="Grant boost"
				canConfirm={!!boostId && daysValid}
				onConfirm={(reason) =>
					run(
						"POST",
						`${base}/boost`,
						{ productId: boostId, durationDays: daysNum, reason },
						`Boost granted for ${daysNum} days`,
					)
				}
			>
				<ProductSelect
					products={productList}
					value={boostId}
					onChange={setBoostId}
					label="Boost plan"
				/>
				<div className="grid gap-1.5">
					<label htmlFor={`${fid}-days`} className="text-sm font-medium">
						Days (1 to 365)
					</label>
					<Input
						id={`${fid}-days`}
						inputMode="numeric"
						value={boostDays}
						onChange={(e) => setBoostDays(e.target.value.trim())}
						aria-invalid={!daysValid}
					/>
				</div>
			</ReasonDialog>

			<ReasonDialog
				open={action === "link"}
				onOpenChange={(o) => !o && setAction(null)}
				title="Send a sign-in link"
				description={`Emails ${data.email ?? "this user"} a link that signs them in. It expires in 15 minutes.`}
				confirmLabel="Send link"
				onConfirm={(reason) =>
					run("POST", `${base}/sign-in-link`, { reason }, `Sign-in link sent to ${data.email}`)
				}
			/>

			<ReasonDialog
				open={action === "signout"}
				onOpenChange={(o) => !o && setAction(null)}
				title="Sign out everywhere"
				description="Ends every session on every device. They can sign in again right away."
				confirmLabel="Sign out everywhere"
				onConfirm={(reason) => run("POST", `${base}/sign-out`, { reason }, "Signed out everywhere")}
			/>

			<ReasonDialog
				open={action === "active"}
				onOpenChange={(o) => !o && setAction(null)}
				title={data.isActive ? "Deactivate this account" : "Reactivate this account"}
				description={
					data.isActive
						? "They are signed out everywhere and can't sign in until reactivated. Their images and payments are kept."
						: "They can sign in again."
				}
				confirmLabel={data.isActive ? "Deactivate" : "Reactivate"}
				destructive={data.isActive}
				onConfirm={(reason) =>
					run(
						"PATCH",
						base,
						{ isActive: !data.isActive, reason },
						data.isActive ? "Account deactivated" : "Account reactivated",
					)
				}
			/>
		</div>
	);
}
