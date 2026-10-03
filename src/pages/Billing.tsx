import { ArrowLeftIcon, ExternalLinkIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { openPortal, type Plan, startPlanCheckout } from "@/components/billing/api";
import { CreditPackList } from "@/components/billing/CreditPackList";
import { loadCatalog, useBillingCatalog, useCheckoutReturn } from "@/components/billing/hooks";
import { PlanCard } from "@/components/billing/PlanCard";
import { formatUsd, modelName, RECOMMENDED_PLAN_NAME, refillCadence } from "@/components/billing/plans";
import { SolanaCreditPurchase } from "@/components/SolanaCreditPurchase";
import { SolanaSubscriptionPurchase } from "@/components/SolanaSubscriptionPurchase";
import { Button, buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { usePaywall } from "@/contexts/PaywallContext";
import { cn } from "@/lib/utils";
import { API_BASE } from "../config";
import { useAuth } from "../contexts/AuthContext";

interface BillingInfo {
	subscription: {
		id: string;
		productId: string;
		status: string;
		planName: string;
		price: number;
		creditRefillAmount: number;
		topoffIntervalHours: number;
		nextRefillAt: string | null;
		periodStart: string | null;
		periodEnd: string | null;
	} | null;
	usage: { imageCount: number };
	availableCredits: number;
	recentPayments: Array<{
		id: string;
		amount: number;
		currency: string;
		status: string;
		type: string;
		description: string | null;
		date: string;
	}>;
	hasStripeCustomer: boolean;
}

interface StripeSubscription {
	status: string;
	cancelAtPeriodEnd: boolean;
	currentPeriodEnd: string | null;
}

interface CurrentPlan {
	id: string;
	name: string;
	price: number;
	creditRefillAmount?: number;
	topoffIntervalHours?: number;
}

interface CreditEntry {
	id: string;
	type: string;
	amount: number;
	reason: string | null;
	createdAt: string;
}

interface Invoice {
	id: string;
	number: string | null;
	amount: number;
	currency: string;
	status: string | null;
	date: string | null;
	pdfUrl: string | null;
	hostedUrl: string | null;
}

interface BillingProps {
	embedded?: boolean;
	onBack?: () => void;
}

const dateFmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });
const formatDate = (value: string | null | undefined) => {
	if (!value) return null;
	// SQLite timestamps come without a zone; they're UTC.
	const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value : `${value.replace(" ", "T")}Z`);
	return Number.isNaN(d.getTime()) ? null : dateFmt.format(d);
};

/** A ledger row in words. */
function describeCredit(entry: CreditEntry): string {
	switch (entry.type) {
		case "used": {
			const m = entry.reason?.match(/^Generation: (\S+) x(\d+)/);
			if (m) return `${modelName(m[1])}, ${m[2] === "1" ? "1 image" : `${m[2]} images`}`;
			return "Images";
		}
		case "refund":
			return "Refund for an image that didn't finish";
		case "refill":
			return "Monthly top-up";
		case "bonus":
			return "Plan bonus";
		case "purchase":
		case "purchased":
			return "Credit purchase";
		case "initial":
			return "Welcome credits";
		case "admin":
			return "Adjustment";
		default:
			return "Credits";
	}
}

function SectionTitle({ children, id }: { children: React.ReactNode; id?: string }) {
	return (
		<h2 id={id} className="text-base font-semibold text-foreground">
			{children}
		</h2>
	);
}

export function Billing({ embedded = false, onBack }: BillingProps) {
	const { token } = useAuth();
	const { notifyCreditsChanged } = usePaywall();
	const catalog = useBillingCatalog();
	const [billing, setBilling] = useState<BillingInfo | null>(null);
	const [current, setCurrent] = useState<CurrentPlan | null>(null);
	const [stripeSub, setStripeSub] = useState<StripeSubscription | null>(null);
	const [credits, setCredits] = useState<CreditEntry[]>([]);
	const [invoices, setInvoices] = useState<Invoice[]>([]);
	const [loaded, setLoaded] = useState(false);
	const [busy, setBusy] = useState<string | null>(null);

	const fetchData = useCallback(async () => {
		if (!token) return;
		const headers = { Authorization: `Bearer ${token}` };
		const get = async <T,>(path: string): Promise<T | null> => {
			try {
				const res = await fetch(`${API_BASE}${path}`, { headers });
				return res.ok ? ((await res.json()) as T) : null;
			} catch {
				return null;
			}
		};
		const [billingData, subData, creditData, invoiceData, stripeData] = await Promise.all([
			get<BillingInfo>("/api/billing"),
			get<{ subscription: CurrentPlan | null }>("/api/user/subscription"),
			get<{ history: CreditEntry[] }>("/api/user/credits"),
			get<{ invoices: Invoice[] }>("/api/billing/invoices"),
			get<{ subscription: StripeSubscription | null }>("/api/billing/subscription"),
		]);
		if (billingData) setBilling(billingData);
		setCurrent(subData?.subscription ?? null);
		setCredits(creditData?.history ?? []);
		setInvoices(invoiceData?.invoices ?? []);
		setStripeSub(stripeData?.subscription ?? null);
		setLoaded(true);
	}, [token]);

	useEffect(() => {
		fetchData();
	}, [fetchData]);

	// Back from Stripe: toast, then refetch (again shortly after, for the webhook).
	useCheckoutReturn(() => {
		fetchData();
		notifyCreditsChanged();
	});

	const managePlan = async () => {
		if (!token || busy) return;
		setBusy("portal");
		const result = await openPortal(token, embedded ? window.location.pathname : "/billing");
		if (!result.ok) {
			toast.error(result.reason);
			setBusy(null);
		}
	};

	const choosePlan = async (plan: Plan) => {
		if (!token || !plan.stripePriceId || busy) return;
		setBusy(plan.id);
		const result = await startPlanCheckout(token, plan.stripePriceId, embedded ? window.location.pathname : "/billing");
		if (!result.ok) {
			toast.error(result.reason);
			setBusy(null);
		}
	};

	const onSolPurchase = () => {
		fetchData();
		notifyCreditsChanged();
		loadCatalog(true);
	};

	const plans = catalog?.plans ?? [];
	const defaultModel = catalog?.costs?.defaultModel ?? "black-forest-labs/flux-2-dev";
	const perImage = catalog?.costs?.costs[defaultModel] ?? 2;
	const totalModels = catalog?.costs ? Object.keys(catalog.costs.costs).length : undefined;
	// Match the plan by product id, never by name.
	const currentPlanId = current?.id ?? billing?.subscription?.productId ?? null;
	const onPaidPlan = (current?.price ?? billing?.subscription?.price ?? 0) > 0;
	const recommendedId = (plans.find((p) => p.name === RECOMMENDED_PLAN_NAME) ?? plans[1] ?? plans[0])?.id;
	const sub = billing?.subscription ?? null;
	const refillAmount = sub?.creditRefillAmount ?? current?.creditRefillAmount ?? catalog?.free?.creditRefillAmount ?? 0;
	const refillHours = sub?.topoffIntervalHours ?? current?.topoffIntervalHours ?? catalog?.free?.topoffIntervalHours;
	const renewal = formatDate(stripeSub?.currentPeriodEnd ?? sub?.periodEnd);
	const nextTopUp = formatDate(sub?.nextRefillAt);
	const pastDue = sub?.status === "past_due" || stripeSub?.status === "past_due";
	const packs = catalog?.stripeEnabled ? (catalog?.packs ?? []) : [];
	const solanaEnabled = !!catalog?.solanaEnabled;

	const back = embedded ? (
		onBack && (
			<Button variant="ghost" onClick={onBack} className="-ml-2">
				<ArrowLeftIcon />
				Back to create
			</Button>
		)
	) : (
		<Link to="/" className={cn(buttonVariants({ variant: "ghost" }), "-ml-2")}>
			<ArrowLeftIcon />
			Back to ollo
		</Link>
	);

	return (
		<div className={cn("bg-background text-foreground", !embedded && "min-h-dvh")}>
			<div className="mx-auto flex max-w-4xl flex-col gap-8 px-4 py-6 sm:px-6 sm:py-8">
				<header className="flex flex-col gap-3">
					<div>{back}</div>
					<h1 className="font-display text-[2rem] leading-tight">Billing</h1>
				</header>

				{!loaded ? (
					<div className="grid gap-4 md:grid-cols-2">
						<Skeleton className="h-44 rounded-2xl" />
						<Skeleton className="h-44 rounded-2xl" />
					</div>
				) : (
					<>
						{pastDue && (
							<div role="alert" className="flex flex-col gap-3 rounded-2xl border border-destructive/50 p-4 sm:flex-row sm:items-center sm:justify-between">
								<div>
									<p className="font-medium text-destructive">Your last payment didn't go through</p>
									<p className="text-sm text-muted-foreground">
										Update your card to keep your plan. Until then you're on Free.
									</p>
								</div>
								<Button variant="outline" onClick={managePlan} disabled={!!busy}>
									Update payment method
								</Button>
							</div>
						)}

						<div className="grid gap-4 md:grid-cols-2">
							{/* Balance */}
							<section aria-labelledby="balance-title" className="flex flex-col rounded-2xl border border-border bg-card p-5">
								<h2 id="balance-title" className="text-sm text-muted-foreground">
									Balance
								</h2>
								<p className="mt-1 flex items-baseline gap-2">
									<span className="text-4xl font-semibold tabular-nums">{billing?.availableCredits ?? 0}</span>
									<span className="text-muted-foreground">credits</span>
								</p>
								<p className="mt-3 text-sm text-muted-foreground">
									{refillAmount > 0
										? `Tops up to ${refillAmount} credits ${refillCadence(refillHours)}${nextTopUp ? `; next on ${nextTopUp}` : ""}.`
										: "Pick a plan for credits every month."}
								</p>
								{billing && billing.usage.imageCount > 0 && (
									<p className="mt-1 text-sm text-muted-foreground">
										{billing.usage.imageCount} {billing.usage.imageCount === 1 ? "image" : "images"} made this month.
									</p>
								)}
							</section>

							{/* Plan */}
							<section aria-labelledby="plan-title" className="flex flex-col rounded-2xl border border-border bg-card p-5">
								<h2 id="plan-title" className="text-sm text-muted-foreground">
									Plan
								</h2>
								<p className="mt-1 flex flex-wrap items-baseline gap-x-3">
									<span className="text-2xl font-semibold">{current?.name ?? sub?.planName ?? "Free"}</span>
									{onPaidPlan && (
										<span className="text-muted-foreground">
											<span className="font-display text-xl text-foreground">
												{formatUsd(current?.price ?? sub?.price ?? 0)}
											</span>{" "}
											a month
										</span>
									)}
								</p>
								<p className="mt-3 text-sm text-muted-foreground">
									{onPaidPlan && renewal
										? stripeSub?.cancelAtPeriodEnd
											? `Ends on ${renewal}. You'll move to Free after that.`
											: `Renews on ${renewal}.`
										: onPaidPlan
											? "Active."
											: "Free plan. Upgrade any time for more credits and models."}
								</p>
								<div className="mt-auto flex flex-wrap gap-2 pt-4">
									{billing?.hasStripeCustomer && catalog?.stripeEnabled && (
										<Button variant="outline" onClick={managePlan} disabled={!!busy}>
											{busy === "portal" ? "Opening…" : "Manage subscription"}
											<ExternalLinkIcon data-icon="inline-end" />
										</Button>
									)}
									<Link to="/pricing" className={buttonVariants({ variant: "ghost" })}>
										Compare plans
									</Link>
								</div>
							</section>
						</div>

						{/* Plans: shown to people not yet on a paid plan */}
						{!onPaidPlan && catalog?.stripeEnabled && plans.length > 0 && (
							<section aria-labelledby="plans-title" className="flex flex-col gap-4">
								<SectionTitle id="plans-title">Upgrade</SectionTitle>
								<div className="grid gap-4 md:grid-cols-3">
									{plans.map((plan) => (
										<PlanCard
											key={plan.id}
											plan={plan}
											recommended={plan.id === recommendedId}
											current={plan.id === currentPlanId}
											perImage={perImage}
											defaultModelName={modelName(defaultModel)}
											totalModels={totalModels}
											className="p-5"
											action={
												<Button
													variant={plan.id === recommendedId ? "default" : "outline"}
													className="w-full"
													disabled={!!busy}
													onClick={() => choosePlan(plan)}
												>
													{busy === plan.id ? "Opening checkout…" : `Choose ${plan.name}`}
												</Button>
											}
										/>
									))}
								</div>
								{solanaEnabled && (
									<div className="rounded-2xl border border-border p-4 empty:hidden">
										<SolanaSubscriptionPurchase onPurchaseComplete={onSolPurchase} />
									</div>
								)}
							</section>
						)}

						{/* Credit packs: card first, SOL second. Hidden entirely when neither is available. */}
						{(packs.length > 0 || solanaEnabled) && (
							<section aria-labelledby="packs-title" className="flex flex-col gap-4">
								<div>
									<SectionTitle id="packs-title">Buy credits</SectionTitle>
									<p className="text-sm text-muted-foreground">One-time packs. Bought credits never expire.</p>
								</div>
								{packs.length > 0 && solanaEnabled ? (
									<Tabs defaultValue="card">
										<TabsList>
											<TabsTrigger value="card" className="px-4">
												Card
											</TabsTrigger>
											<TabsTrigger value="sol" className="px-4">
												SOL
											</TabsTrigger>
										</TabsList>
										<TabsContent value="card" className="pt-2">
											<CreditPackList packs={packs} token={token} perImage={perImage} />
										</TabsContent>
										<TabsContent value="sol" className="pt-2">
											<SolanaCreditPurchase onPurchaseComplete={onSolPurchase} />
										</TabsContent>
									</Tabs>
								) : packs.length > 0 ? (
									<CreditPackList packs={packs} token={token} perImage={perImage} />
								) : (
									<SolanaCreditPurchase onPurchaseComplete={onSolPurchase} />
								)}
							</section>
						)}

						{/* Recent credit history */}
						{credits.length > 0 && (
							<section aria-labelledby="history-title" className="flex flex-col gap-2">
								<SectionTitle id="history-title">Recent credits</SectionTitle>
								<ul className="divide-y divide-border rounded-2xl border border-border bg-card px-4">
									{credits.slice(0, 8).map((entry) => (
										<li key={entry.id} className="flex items-center justify-between gap-4 py-3 text-sm">
											<div className="min-w-0">
												<p className="truncate text-foreground">{describeCredit(entry)}</p>
												<p className="text-xs text-muted-foreground">{formatDate(entry.createdAt)}</p>
											</div>
											<span
												className={cn(
													"shrink-0 tabular-nums",
													entry.amount > 0 ? "text-verdigris" : "text-muted-foreground",
												)}
											>
												{entry.amount > 0 ? `+${entry.amount}` : entry.amount}
											</span>
										</li>
									))}
								</ul>
							</section>
						)}

						{/* Invoices (Stripe), or payments when there are no invoices yet (e.g. SOL) */}
						{invoices.length > 0 ? (
							<section aria-labelledby="invoices-title" className="flex flex-col gap-2">
								<SectionTitle id="invoices-title">Invoices</SectionTitle>
								<ul className="divide-y divide-border rounded-2xl border border-border bg-card px-4">
									{invoices.map((invoice) => (
										<li key={invoice.id} className="flex items-center justify-between gap-4 py-3 text-sm">
											<div className="min-w-0">
												<p className="truncate text-foreground">{formatDate(invoice.date) ?? "Invoice"}</p>
												<p className="text-xs text-muted-foreground">
													{invoice.status === "paid" ? "Paid" : invoice.status === "open" ? "Due" : "Invoice"}
													{invoice.number ? `, ${invoice.number}` : ""}
												</p>
											</div>
											<div className="flex shrink-0 items-center gap-3">
												<span className="tabular-nums">{formatUsd(invoice.amount)}</span>
												{(invoice.hostedUrl || invoice.pdfUrl) && (
													<a
														href={invoice.hostedUrl ?? invoice.pdfUrl ?? undefined}
														target="_blank"
														rel="noopener noreferrer"
														className="text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
													>
														View
													</a>
												)}
											</div>
										</li>
									))}
								</ul>
							</section>
						) : (
							billing &&
							billing.recentPayments.length > 0 && (
								<section aria-labelledby="payments-title" className="flex flex-col gap-2">
									<SectionTitle id="payments-title">Payments</SectionTitle>
									<ul className="divide-y divide-border rounded-2xl border border-border bg-card px-4">
										{billing.recentPayments.map((payment) => (
											<li key={payment.id} className="flex items-center justify-between gap-4 py-3 text-sm">
												<div className="min-w-0">
													<p className="truncate text-foreground">
														{payment.type === "subscription" ? "Plan payment" : "Credit purchase"}
													</p>
													<p className="text-xs text-muted-foreground">{formatDate(payment.date)}</p>
												</div>
												<span className="shrink-0 tabular-nums">{formatUsd(payment.amount)}</span>
											</li>
										))}
									</ul>
								</section>
							)
						)}

						{catalog && !catalog.stripeEnabled && !solanaEnabled && (
							<p className="text-sm text-muted-foreground">Payments aren't available right now. Try again later.</p>
						)}
					</>
				)}
			</div>
		</div>
	);
}
