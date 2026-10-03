import { CheckIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Plan } from "./api";
import { approxImages, formatUsd, refillCadence } from "./plans";

interface PlanCardProps {
	plan: Plan;
	recommended?: boolean;
	current?: boolean;
	/** Per-image cost at the default model, to turn credits into images. */
	perImage: number;
	defaultModelName: string;
	/** Total models in the catalog, to say "8 of 10 models". */
	totalModels?: number;
	/** The call to action (a Button or Link); the card doesn't decide what it does. */
	action: React.ReactNode;
	className?: string;
}

export function PlanCard({
	plan,
	recommended,
	current,
	perImage,
	defaultModelName,
	totalModels,
	action,
	className,
}: PlanCardProps) {
	const images = approxImages(plan.creditRefillAmount, perImage);
	const models =
		plan.allowedModels === null
			? "Every model"
			: totalModels
				? `${plan.allowedModels.length} of ${totalModels} models`
				: `${plan.allowedModels.length} models`;

	return (
		<article
			aria-label={`${plan.name} plan`}
			className={cn(
				"relative flex flex-col rounded-2xl border bg-card p-6",
				recommended ? "border-verdigris" : "border-border",
				className,
			)}
		>
			<header className="flex items-center justify-between gap-3">
				<h3 className="text-base font-semibold text-foreground">{plan.name}</h3>
				{current ? (
					<span className="rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium text-foreground">Your plan</span>
				) : recommended ? (
					<span className="rounded-full bg-verdigris/15 px-2.5 py-0.5 text-xs font-medium text-verdigris">
						Recommended
					</span>
				) : null}
			</header>

			<p className="mt-4 flex items-baseline gap-1.5">
				<span className="font-display text-[2.6rem] leading-none text-foreground">{formatUsd(plan.price)}</span>
				<span className="text-sm text-muted-foreground">a month</span>
			</p>

			<p className="mt-5 text-[0.95rem] font-medium text-foreground">
				{plan.creditRefillAmount} credits {refillCadence(plan.topoffIntervalHours)}
			</p>
			<p className="text-sm text-muted-foreground">
				About {images} images with {defaultModelName}
			</p>

			<ul className="mt-5 flex flex-1 flex-col gap-2 text-sm text-foreground">
				{plan.bonusCredits > 0 && (
					<li className="flex gap-2">
						<CheckIcon className="mt-0.5 size-4 shrink-0 text-verdigris" aria-hidden />
						{plan.bonusCredits} bonus credits when you start
					</li>
				)}
				<li className="flex gap-2">
					<CheckIcon className="mt-0.5 size-4 shrink-0 text-verdigris" aria-hidden />
					{models}
				</li>
				<li className="flex gap-2">
					<CheckIcon className="mt-0.5 size-4 shrink-0 text-verdigris" aria-hidden />
					Cancel anytime
				</li>
			</ul>

			<div className="mt-6">{action}</div>
		</article>
	);
}
