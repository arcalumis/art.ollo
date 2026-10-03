import { Button } from "@/components/ui/button";
import { usePaywall } from "@/contexts/PaywallContext";
import { cn } from "@/lib/utils";
import type { QueuedGeneration } from "@/types";
import { describeGenerationError } from "./generationErrors";
import { modelName } from "./plans";

interface GenerationErrorNoticeProps {
	item: QueuedGeneration;
	className?: string;
	/** Show the prompt too (used where the prompt isn't already on screen). */
	showPrompt?: boolean;
}

/** A failed generation: what happened, in plain words, with the way forward. */
export function GenerationErrorNotice({ item, className, showPrompt }: GenerationErrorNoticeProps) {
	const paywall = usePaywall();
	const copy = describeGenerationError(item.errorCode, {
		creditsNeeded: item.creditsNeeded,
		balance: item.balanceAtFailure,
		modelName: modelName(item.model),
	});

	return (
		<div role="alert" className={cn("flex flex-col gap-3 rounded-2xl border border-border bg-card p-4", className)}>
			<div className="min-w-0">
				<p className="text-sm font-medium text-foreground">{copy.title}</p>
				<p className="mt-0.5 text-sm text-muted-foreground">{copy.detail}</p>
				{showPrompt && item.prompt && <p className="mt-2 truncate text-xs text-muted-foreground">“{item.prompt}”</p>}
			</div>
			<div className="flex flex-wrap items-center gap-2">
				{copy.actions.map((action) => {
					if (action === "topUp")
						return (
							<Button
								key={action}
								size="sm"
								variant="outline"
								onClick={() =>
									paywall.open({
										reason: "insufficient_credits",
										needed: item.creditsNeeded,
										balance: item.balanceAtFailure,
									})
								}
							>
								Top up
							</Button>
						);
					if (action === "upgrade")
						return (
							<Button
								key={action}
								size="sm"
								variant="outline"
								onClick={() => paywall.open({ reason: "model_not_allowed", modelId: item.model })}
							>
								See plans
							</Button>
						);
					if (action === "settings" && item.onOpenSettings)
						return (
							<Button key={action} size="sm" variant="outline" onClick={item.onOpenSettings}>
								Open Settings
							</Button>
						);
					if (action === "retry" && item.onRetry)
						return (
							// Retrying spends credits: bronze, unless a top-up has to come first.
							<Button
								key={action}
								size="sm"
								variant={copy.actions.includes("topUp") ? "outline" : "default"}
								onClick={item.onRetry}
							>
								Retry
							</Button>
						);
					return null;
				})}
				{item.onDismiss && (
					<Button size="sm" variant="ghost" onClick={item.onDismiss}>
						Dismiss
					</Button>
				)}
			</div>
		</div>
	);
}
