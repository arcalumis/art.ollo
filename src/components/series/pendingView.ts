import type { QueuedGeneration } from "../../types";

/** What an in-progress tile shows at a moment in time. */
export interface PendingView {
	/** Short status line ("Waiting for a GPU · 12s", "Rendering, about 8 s left", "Saving"). */
	label: string;
	/** 0..1 for the laurel, or undefined when the amount is unknown (indeterminate). */
	progress?: number;
	/** The request is actively moving (verdigris status text). */
	active: boolean;
}

/** Before the first status arrives, the tile says "Starting" for this long, then estimates. */
const STATUS_GRACE_MS = 3000;

/** Estimated render progress, capped at 95% until the server answers. */
function estimate(sinceMs: number, now: number, estimatedSeconds: number | undefined) {
	const elapsed = (now - sinceMs) / 1000;
	const total = estimatedSeconds || 30;
	return {
		progress: Math.min(0.95, Math.max(0.03, elapsed / total)),
		secondsLeft: Math.max(0, Math.ceil(total - elapsed)),
	};
}

function renderingLabel(secondsLeft: number): string {
	return secondsLeft > 0 ? `Rendering, about ${secondsLeft} s left` : "Rendering, almost there";
}

/**
 * The honest state of an in-flight generation: waiting for a GPU (no estimate,
 * just how long so far), rendering (estimate from render start), saving.
 * Falls back to an estimate from the request start when no live status exists.
 */
export function pendingView(item: QueuedGeneration, now: number): PendingView {
	if (item.status !== "generating" || !item.startedAt) {
		return { label: "Queued", progress: 0, active: false };
	}
	const live = item.live;
	if (live?.phase === "saving") return { label: "Saving", progress: 0.97, active: true };
	if (live?.phase === "rendering") {
		const { progress, secondsLeft } = estimate(
			live.renderingSince ?? now,
			now,
			item.estimatedDuration,
		);
		return { label: renderingLabel(secondsLeft), progress, active: true };
	}
	if (live?.phase === "waiting_gpu") {
		const seconds = Math.max(0, Math.floor((now - (live.waitingSince ?? now)) / 1000));
		return { label: `Waiting for a GPU · ${seconds}s`, active: true };
	}

	const started = new Date(item.startedAt).getTime();
	if (now - started < STATUS_GRACE_MS) return { label: "Starting", active: true };
	const { progress, secondsLeft } = estimate(started, now, item.estimatedDuration);
	return { label: renderingLabel(secondsLeft), progress, active: true };
}
