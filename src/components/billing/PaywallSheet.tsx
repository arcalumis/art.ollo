import { ArrowLeftIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { SolanaCreditPurchase } from "@/components/SolanaCreditPurchase";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/contexts/AuthContext";
import { type PaywallRequest, usePaywall } from "@/contexts/PaywallContext";
import { cn } from "@/lib/utils";
import { type CreditPack, fetchCurrentPlan, type Plan, startPackCheckout, startPlanCheckout } from "./api";
import { useBillingCatalog, useMediaQuery } from "./hooks";
import { approxImages, cheapestPlanWithModel, formatUsd, modelName, nextPlanUp, plural, refillCadence } from "./plans";

type Choice = { kind: "plan"; plan: Plan } | { kind: "pack"; pack: CreditPack };

function headline(request: PaywallRequest, plan: Plan | null): { title: string; detail: string } {
	const { needed, balance } = request;
	if (request.reason === "model_not_allowed") {
		const name = request.modelId ? modelName(request.modelId) : "This model";
		return {
			title: plan ? `${name} comes with ${plan.name}` : `${name} isn't on your plan`,
			detail: "Your current plan doesn't include it.",
		};
	}
	if (request.reason === "insufficient_credits" && needed !== undefined && balance !== undefined && balance !== null) {
		const short = Math.max(needed - balance, 1);
		return {
			title: `You need ${plural(short, "more credit")}`,
			detail: `This ${needed === 1 ? "image costs 1 credit" : `costs ${needed} credits`} and you have ${balance}.`,
		};
	}
	if (request.reason === "upgrade") {
		return {
			title: plan ? `Upgrade to ${plan.name}` : "Upgrade your plan",
			detail: "More credits every month, and more models to choose from.",
		};
	}
	return {
		title: "Get more credits",
		detail: balance !== undefined && balance !== null ? `You have ${plural(balance, "credit")}.` : "Pick a plan or a one-time pack.",
	};
}

/**
 * The upgrade sheet: over the user's work, never a redirect. Bottom sheet on
 * phones, right sheet on desktop. One recommended plan, any credit packs, one
 * bronze "Continue to payment", and SOL as the quiet alternative.
 */
export function PaywallSheet() {
	const { isOpen, close, request, notifyCreditsChanged } = usePaywall();
	const { token } = useAuth();
	const desktop = useMediaQuery("(min-width: 768px)");
	const catalog = useBillingCatalog(isOpen);
	const [current, setCurrent] = useState<{ id: string; price: number } | null | undefined>(undefined);
	const [choiceKey, setChoiceKey] = useState<string | null>(null);
	const [view, setView] = useState<"options" | "sol">("options");
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		if (!isOpen) return;
		setView("options");
		setChoiceKey(null);
		setBusy(false);
		if (token) fetchCurrentPlan(token).then((p) => setCurrent(p ? { id: p.id, price: p.price } : null));
	}, [isOpen, token]);

	if (!request) return null;

	const plans = catalog?.plans ?? [];
	const currentPrice = current?.price ?? 0;
	const plan =
		request.reason === "model_not_allowed" && request.modelId
			? (cheapestPlanWithModel(
					plans.filter((p) => p.price > currentPrice),
					request.modelId,
				) ?? null)
			: nextPlanUp(plans, current?.id, currentPrice);
	// Packs top up credits; they don't unlock models.
	const packs = request.reason === "model_not_allowed" ? [] : (catalog?.packs ?? []);
	const short = request.needed !== undefined && request.balance != null ? request.needed - request.balance : 0;

	const options: Choice[] = [
		...(plan ? [{ kind: "plan", plan } as const] : []),
		...packs.map((pack) => ({ kind: "pack", pack }) as const),
	];
	const keyOf = (c: Choice) => (c.kind === "plan" ? `plan:${c.plan.id}` : `pack:${c.pack.id}`);
	const defaultChoice = options.find((c) => c.kind === "plan") ?? options.find((c) => c.kind === "pack" && c.pack.credits >= short) ?? options[0];
	const selected = options.find((c) => keyOf(c) === choiceKey) ?? defaultChoice;

	const perImage = catalog?.costs ? (catalog.costs.costs[catalog.costs.defaultModel] ?? 2) : 2;
	const defaultModelName = catalog?.costs ? modelName(catalog.costs.defaultModel) : "FLUX 2 Dev";
	const { title, detail } = headline(request, plan);
	const loading = !catalog || current === undefined;
	const solanaEnabled = !!catalog?.solanaEnabled;

	const handleContinue = async () => {
		if (!selected || !token || busy) return;
		setBusy(true);
		const returnPath = window.location.pathname;
		const result =
			selected.kind === "plan" && selected.plan.stripePriceId
				? await startPlanCheckout(token, selected.plan.stripePriceId, returnPath)
				: selected.kind === "pack"
					? await startPackCheckout(token, selected.pack.id, returnPath)
					: { ok: false as const, reason: "That plan can't be bought by card right now." };
		if (!result.ok) {
			toast.error(result.reason);
			setBusy(false);
		}
	};

	return (
		<Sheet open={isOpen} onOpenChange={(open) => !open && close()}>
			<SheetContent
				side={desktop ? "right" : "bottom"}
				className={cn(
					"gap-0 data-[side=right]:sm:max-w-md",
					!desktop && "max-h-[92dvh] rounded-t-2xl",
				)}
			>
				{view === "sol" ? (
					<>
						<SheetHeader className="flex-row items-center gap-2 pr-12">
							<Button variant="ghost" size="icon-sm" onClick={() => setView("options")} aria-label="Back to plans">
								<ArrowLeftIcon />
							</Button>
							<div>
								<SheetTitle className="text-lg">Pay with SOL</SheetTitle>
								<SheetDescription>{detail}</SheetDescription>
							</div>
						</SheetHeader>
						<div className="overflow-y-auto px-4 pb-6">
							<SolanaCreditPurchase
								compact
								onPurchaseComplete={(credits) => {
									notifyCreditsChanged();
									toast.success(`${credits} credits added.`);
								}}
							/>
						</div>
					</>
				) : (
					<>
						<SheetHeader className="pr-12">
							<SheetTitle className="text-lg">{title}</SheetTitle>
							<SheetDescription>{detail}</SheetDescription>
						</SheetHeader>

						<div className="flex flex-col gap-3 overflow-y-auto px-4 pb-2">
							{loading ? (
								<>
									<Skeleton className="h-28 w-full rounded-2xl" />
									<Skeleton className="h-14 w-full rounded-xl" />
								</>
							) : options.length === 0 ? (
								<p className="text-sm text-muted-foreground">
									{request.reason === "model_not_allowed"
										? "Pick another model to keep going."
										: solanaEnabled
											? "Card payments aren't available right now. You can still pay with SOL."
											: "Payments aren't available right now. Try again later."}
								</p>
							) : (
								<fieldset aria-label="Ways to get credits" className="flex flex-col gap-2">
									{plan && (
										<OptionRow
											checked={selected?.kind === "plan"}
											onSelect={() => setChoiceKey(`plan:${plan.id}`)}
											title={plan.name}
											price={formatUsd(plan.price)}
											priceSuffix="a month"
											note={
												current && current.price > 0
													? "Your plan changes now; Stripe prorates the difference."
													: plan.bonusCredits > 0
														? `${plan.bonusCredits} bonus credits when you start. Cancel anytime.`
														: "Cancel anytime."
											}
										>
											Tops up to {plan.creditRefillAmount} credits {refillCadence(plan.topoffIntervalHours)}, about{" "}
											{approxImages(plan.creditRefillAmount, perImage)} images with {defaultModelName}.
										</OptionRow>
									)}
									{packs.length > 0 && (
										<p className="mt-2 text-xs text-muted-foreground">{plan ? "Or buy credits once" : "Buy credits once"}</p>
									)}
									{packs.map((pack) => (
										<OptionRow
											key={pack.id}
											compact
											checked={selected?.kind === "pack" && selected.pack.id === pack.id}
											onSelect={() => setChoiceKey(`pack:${pack.id}`)}
											title={`${pack.credits} credits`}
											price={formatUsd(pack.priceCents / 100)}
										>
											About {approxImages(pack.credits, perImage)} images. Never expire.
										</OptionRow>
									))}
								</fieldset>
							)}
						</div>

						<SheetFooter className="border-t border-border">
							{options.length > 0 && (
								<Button size="lg" className="w-full" onClick={handleContinue} disabled={!selected || busy || loading}>
									{busy ? "Opening checkout…" : "Continue to payment"}
								</Button>
							)}
							{solanaEnabled && request.reason !== "model_not_allowed" && (
								<Button variant="ghost" className="w-full text-muted-foreground" onClick={() => setView("sol")}>
									Pay with SOL instead
								</Button>
							)}
							<p className="text-center text-xs text-muted-foreground">Card payments are handled by Stripe.</p>
						</SheetFooter>
					</>
				)}
			</SheetContent>
		</Sheet>
	);
}

function OptionRow({
	checked,
	onSelect,
	title,
	price,
	priceSuffix,
	note,
	compact,
	children,
}: {
	checked: boolean;
	onSelect: () => void;
	title: string;
	price: string;
	priceSuffix?: string;
	note?: string;
	compact?: boolean;
	children: React.ReactNode;
}) {
	return (
		<label
			className={cn(
				"flex w-full cursor-pointer items-start gap-3 rounded-xl border p-4 text-left transition-colors has-[input:focus-visible]:ring-3 has-[input:focus-visible]:ring-ring/50",
				checked ? "border-verdigris bg-muted" : "border-border hover:border-foreground/30",
				compact && "py-3",
			)}
		>
			<input type="radio" name="paywall-option" checked={checked} onChange={onSelect} className="sr-only" />
			<span
				aria-hidden
				className={cn(
					"mt-1 grid size-4 shrink-0 place-items-center rounded-full border",
					checked ? "border-verdigris" : "border-muted-foreground",
				)}
			>
				{checked && <span className="size-2 rounded-full bg-verdigris" />}
			</span>
			<span className="min-w-0 flex-1">
				<span className="flex items-baseline justify-between gap-3">
					<span className="font-medium text-foreground">{title}</span>
					<span className="whitespace-nowrap text-foreground">
						<span className={compact ? "tabular-nums" : "font-display text-xl"}>{price}</span>
						{priceSuffix && <span className="ml-1 text-xs text-muted-foreground">{priceSuffix}</span>}
					</span>
				</span>
				<span className="mt-1 block text-sm text-muted-foreground">{children}</span>
				{note && <span className="mt-1 block text-xs text-muted-foreground">{note}</span>}
			</span>
		</label>
	);
}
