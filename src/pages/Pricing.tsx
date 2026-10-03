import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { openPortal, startPlanCheckout, fetchCurrentPlan, type Plan } from "@/components/billing/api";
import { useBillingCatalog } from "@/components/billing/hooks";
import { PlanCard } from "@/components/billing/PlanCard";
import { approxImages, modelName, RECOMMENDED_PLAN_NAME, refillCadence } from "@/components/billing/plans";
import { Laurel } from "@/components/brand/Laurel";
import { Button, buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/contexts/AuthContext";
import { cn } from "@/lib/utils";

const FAQ: { q: string; a: string }[] = [
	{
		q: "What is a credit?",
		a: "Credits are how ollo prices images. Each model costs a set number of credits per image, shown on the Generate button before you press it. Faster models cost fewer credits; the most detailed ones cost more.",
	},
	{
		q: "How do monthly credits work?",
		a: "Each month your balance is topped back up to your plan's amount. Unused plan credits don't pile up, but credits you buy in a pack are kept on top and never expire.",
	},
	{
		q: "Can I cancel anytime?",
		a: "Yes. Cancel from Billing in a couple of clicks. Your plan stays active until the end of the period you paid for, then you move to Free.",
	},
	{
		q: "How can I pay?",
		a: "By card through Stripe, or with SOL from a Solana wallet. Paying with SOL buys 30 days of a plan or a pack of credits; it doesn't renew on its own.",
	},
	{
		q: "What if I run out mid-month?",
		a: "Buy a one-time pack of credits, or move up a plan. Either takes effect as soon as payment goes through.",
	},
];

/** Public plans page, signed in or out. Route: /pricing. */
export function Pricing() {
	const { user, token } = useAuth();
	const catalog = useBillingCatalog();
	const [currentId, setCurrentId] = useState<string | null>(null);
	const [currentPrice, setCurrentPrice] = useState(0);
	const [busy, setBusy] = useState<string | null>(null);

	useEffect(() => {
		document.title = "Plans and pricing · ollo";
	}, []);

	useEffect(() => {
		if (!token) return;
		fetchCurrentPlan(token).then((p) => {
			setCurrentId(p?.id ?? null);
			setCurrentPrice(p?.price ?? 0);
		});
	}, [token]);

	const plans = catalog?.plans ?? [];
	const defaultModel = catalog?.costs?.defaultModel ?? "black-forest-labs/flux-2-dev";
	const perImage = catalog?.costs?.costs[defaultModel] ?? 2;
	const defaultModelName = modelName(defaultModel);
	const totalModels = catalog?.costs ? Object.keys(catalog.costs.costs).length : undefined;
	const recommendedId = (plans.find((p) => p.name === RECOMMENDED_PLAN_NAME) ?? plans[Math.min(1, plans.length - 1)])?.id;
	const onPaidPlan = currentPrice > 0;

	const choose = async (plan: Plan) => {
		if (!token || !plan.stripePriceId || busy) return;
		setBusy(plan.id);
		const result = onPaidPlan ? await openPortal(token, "/billing") : await startPlanCheckout(token, plan.stripePriceId, "/billing");
		if (!result.ok) {
			toast.error(result.reason);
			setBusy(null);
		}
	};

	const actionFor = (plan: Plan) => {
		const isRecommended = plan.id === recommendedId;
		if (!user) {
			return (
				<Link
					to="/login?next=/pricing"
					className={cn(buttonVariants({ variant: isRecommended ? "default" : "outline" }), "w-full")}
				>
					Choose {plan.name}
				</Link>
			);
		}
		if (plan.id === currentId) {
			return (
				<Link to="/billing" className={cn(buttonVariants({ variant: "outline" }), "w-full")}>
					Manage your plan
				</Link>
			);
		}
		return (
			<Button
				variant={isRecommended ? "default" : "outline"}
				className="w-full"
				disabled={!!busy}
				onClick={() => choose(plan)}
			>
				{busy === plan.id ? "Opening checkout…" : onPaidPlan ? `Switch to ${plan.name}` : `Choose ${plan.name}`}
			</Button>
		);
	};

	return (
		<div className="min-h-dvh bg-background text-foreground">
			<header className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-4 sm:px-6">
				<Link to="/" className="flex items-center gap-2 rounded-lg outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
					<Laurel className="size-7 text-bronze" />
					<span className="font-display text-[1.35rem] leading-none">ollo</span>
				</Link>
				{user ? (
					<Link to="/" className={buttonVariants({ variant: "ghost" })}>
						Back to ollo
					</Link>
				) : (
					<Link to="/login?next=/pricing" className={buttonVariants({ variant: "outline" })}>
						Sign in
					</Link>
				)}
			</header>

			<main className="mx-auto max-w-6xl px-4 pt-8 pb-20 sm:px-6 sm:pt-14">
				<div className="max-w-2xl">
					<h1 className="font-display text-[2.4rem] leading-[1.1] sm:text-[3.2rem]">Plans for every pace</h1>
					<p className="mt-4 text-[1.05rem] text-muted-foreground">
						Each plan tops your credits back up every month. The Generate button always shows what an image
						costs before you spend anything. Prices in US dollars; cancel whenever you like.
					</p>
				</div>

				<section aria-label="Plans" className="mt-10 grid gap-4 md:grid-cols-3 md:gap-5">
					{!catalog
						? [0, 1, 2].map((i) => <Skeleton key={i} className="h-[26rem] rounded-2xl" />)
						: plans.map((plan) => (
								<PlanCard
									key={plan.id}
									plan={plan}
									recommended={plan.id === recommendedId}
									current={plan.id === currentId}
									perImage={perImage}
									defaultModelName={defaultModelName}
									totalModels={totalModels}
									action={actionFor(plan)}
								/>
							))}
				</section>

				{catalog && plans.length === 0 && (
					<p className="mt-6 text-muted-foreground">Plans aren't on sale right now. Check back soon.</p>
				)}

				{catalog?.free && (
					<p className="mt-6 text-sm text-muted-foreground">
						Just trying it out? Free includes {catalog.free.creditRefillAmount} credits{" "}
						{refillCadence(catalog.free.topoffIntervalHours)}, about{" "}
						{approxImages(catalog.free.creditRefillAmount, perImage)} images. No card needed.
						{!user && (
							<>
								{" "}
								<Link to="/login" className="font-medium text-foreground underline underline-offset-4">
									Start free
								</Link>
							</>
						)}
					</p>
				)}

				<section aria-labelledby="faq-title" className="mt-20 max-w-2xl">
					<h2 id="faq-title" className="text-lg font-semibold">
						Questions
					</h2>
					<div className="mt-4 divide-y divide-border border-y border-border">
						{FAQ.map(({ q, a }) => (
							<details key={q} className="group py-1">
								<summary className="flex cursor-pointer list-none items-center justify-between gap-4 rounded-lg py-3 text-[0.98rem] font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50 [&::-webkit-details-marker]:hidden">
									{q}
									<span
										aria-hidden
										className="text-xl leading-none text-muted-foreground transition-transform group-open:rotate-45"
									>
										+
									</span>
								</summary>
								<p className="pb-4 text-[0.95rem] leading-relaxed text-muted-foreground">{a}</p>
							</details>
						))}
					</div>
				</section>
			</main>
		</div>
	);
}

export default Pricing;
