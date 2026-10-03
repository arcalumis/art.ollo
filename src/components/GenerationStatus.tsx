import type { QueuedGeneration } from "../types";
import { GenerationErrorNotice } from "./billing/GenerationErrorNotice";

interface GenerationStatusProps {
	/**
	 * Failed generations the current view doesn't already show (the gallery, or
	 * another series). Each gets its own specific message with Retry/Dismiss.
	 */
	failures: QueuedGeneration[];
}

export function GenerationStatus({ failures }: GenerationStatusProps) {
	if (failures.length === 0) return null;

	// Newest first; more than two stacked notices would crowd out the prompt bar.
	const shown = failures.slice(0, 2);
	return (
		<div className="mx-auto flex w-full max-w-3xl flex-col gap-2">
			{shown.map((item) => (
				<GenerationErrorNotice key={item.id} item={item} showPrompt />
			))}
			{failures.length > shown.length && (
				<p className="text-xs text-muted-foreground">
					{failures.length - shown.length} more didn't finish. Open their series to retry.
				</p>
			)}
		</div>
	);
}
