import { useEffect } from "react";
import { refillCadence } from "@/components/billing/plans";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useAuth } from "../contexts/AuthContext";
import { useUserCredits, useUserSubscription, useUserUsage } from "../hooks/useUserSettings";

interface UserSettingsProps {
	isOpen: boolean;
	onClose: () => void;
	onOpenBilling?: () => void;
	onRelaunchTutorial?: () => void;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<div className="flex items-baseline justify-between gap-4 py-2.5 text-sm">
			<span className="text-muted-foreground">{label}</span>
			<span className="text-right text-foreground">{children}</span>
		</div>
	);
}

/** Account settings. The finish (Night/Plaster) lives in the ThemeSwitcher menu, not here. */
export function UserSettings({ isOpen, onClose, onOpenBilling, onRelaunchTutorial }: UserSettingsProps) {
	const { token, user } = useAuth();
	const { subscription, fetchSubscription } = useUserSubscription(token);
	const { usage, fetchUsage } = useUserUsage(token);
	const { credits, fetchCredits } = useUserCredits(token);

	useEffect(() => {
		if (isOpen) {
			fetchSubscription();
			fetchUsage();
			fetchCredits();
		}
	}, [isOpen, fetchSubscription, fetchUsage, fetchCredits]);

	const plan = subscription?.subscription ?? null;
	const balance = credits?.credits ?? usage?.availableCredits ?? null;
	// Cadence comes from the plan itself: Free refills monthly, not daily.
	const refillAmount = plan?.creditRefillAmount ?? usage?.creditRefillAmount ?? 0;
	const refill = refillAmount > 0 ? `${refillAmount} credits ${refillCadence(plan?.topoffIntervalHours)}` : "None";

	return (
		<Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
			<DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-md">
				<DialogHeader>
					<DialogTitle>Account</DialogTitle>
					{user && <DialogDescription>Signed in as {user.username}</DialogDescription>}
				</DialogHeader>

				<section aria-label="Plan and credits" className="divide-y divide-border">
					<Row label="Plan">
						{plan ? (
							<>
								{plan.name}
								{plan.price > 0 ? <span className="text-muted-foreground">, ${plan.price} a month</span> : null}
							</>
						) : (
							"Free"
						)}
					</Row>
					<Row label="Balance">{balance === null ? "–" : `${balance} credits`}</Row>
					<Row label="Top-up">{refill}</Row>
					<Row label="Images this month">{usage?.usage.imageCount ?? 0}</Row>
				</section>

				<Button
					variant="outline"
					className="w-full"
					onClick={() => {
						onClose();
						onOpenBilling?.();
					}}
				>
					Billing and credits
				</Button>

				{onRelaunchTutorial && (
					<section aria-label="Tutorial" className="flex flex-col gap-2 border-t border-border pt-4">
						<p className="text-sm text-muted-foreground">
							Walk through making a character, composing a scene and using reference images.
						</p>
						<Button variant="ghost" className="self-start" onClick={onRelaunchTutorial}>
							Replay the tutorial
						</Button>
					</section>
				)}
			</DialogContent>
		</Dialog>
	);
}
