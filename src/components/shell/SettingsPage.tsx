import { refillCadence } from "@/components/billing/plans";
import { buttonVariants } from "@/components/ui/button";
import { useAuth } from "@/contexts/AuthContext";
import { useUserCredits, useUserSubscription, useUserUsage } from "@/hooks/useUserSettings";
import { useEffect } from "react";
import { Link } from "react-router-dom";
import { BILLING_PATH } from "./routes";

/*
 * /settings, showing what the account dialog (UserSettings) shows, as a page.
 * Placeholder until the settings page is rebuilt.
 */

function Row({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<div className="flex items-baseline justify-between gap-4 py-3 text-sm">
			<dt className="text-muted-foreground">{label}</dt>
			<dd className="text-right text-foreground">{children}</dd>
		</div>
	);
}

export function SettingsPage() {
	const { token, user } = useAuth();
	const { subscription, fetchSubscription } = useUserSubscription(token);
	const { usage, fetchUsage } = useUserUsage(token);
	const { credits, fetchCredits } = useUserCredits(token);

	useEffect(() => {
		fetchSubscription();
		fetchUsage();
		fetchCredits();
	}, [fetchSubscription, fetchUsage, fetchCredits]);

	const plan = subscription?.subscription ?? null;
	const balance = credits?.credits ?? usage?.availableCredits ?? null;
	const refillAmount = plan?.creditRefillAmount ?? usage?.creditRefillAmount ?? 0;
	const refill =
		refillAmount > 0
			? `${refillAmount} credits ${refillCadence(plan?.topoffIntervalHours)}`
			: "None";

	return (
		<div className="mx-auto w-full max-w-xl px-4 py-8">
			<h1 className="font-display text-3xl">Settings</h1>
			{user && <p className="mt-2 text-sm text-muted-foreground">Signed in as {user.username}</p>}

			<section
				aria-labelledby="plan-heading"
				className="mt-8 rounded-2xl border border-border bg-card p-5"
			>
				<h2 id="plan-heading" className="text-base font-semibold">
					Plan and credits
				</h2>
				<dl className="mt-2 divide-y divide-border">
					<Row label="Plan">
						{plan ? (
							<>
								{plan.name}
								{plan.price > 0 ? (
									<span className="text-muted-foreground">, ${plan.price} a month</span>
								) : null}
							</>
						) : (
							"Free"
						)}
					</Row>
					<Row label="Balance">{balance === null ? "–" : `${balance} credits`}</Row>
					<Row label="Top-up">{refill}</Row>
					<Row label="Images this month">{usage?.usage.imageCount ?? 0}</Row>
				</dl>
				<Link
					to={BILLING_PATH}
					className={buttonVariants({ variant: "outline", className: "mt-4 w-full" })}
				>
					Billing and credits
				</Link>
			</section>
		</div>
	);
}
