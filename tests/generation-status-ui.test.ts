// Client side of the live generation status: turning server durations into
// local times, the queue's "live" transition and the in-progress tile copy.
import { describe, expect, test } from "bun:test";
import { describeGenerationError } from "../src/components/billing/generationErrors";
import { pendingView } from "../src/components/series/pendingView";
import { type QueueEntry, liveFromStatus, queueReducer } from "../src/hooks/useGenerationQueue";

const NOW = 1_000_000;
const startedAt = new Date(NOW - 20_000).toISOString();

function generating(extra: Partial<QueueEntry> = {}): QueueEntry {
	return {
		id: "a",
		prompt: "a fox",
		model: "black-forest-labs/flux-2-dev",
		status: "generating",
		createdAt: startedAt,
		startedAt,
		estimatedDuration: 10,
		request: { prompt: "a fox" },
		...extra,
	};
}

describe("live status", () => {
	test("server durations become local timestamps", () => {
		expect(liveFromStatus({ phase: "waiting_gpu", waitingForMs: 12_000 }, NOW)).toEqual({
			phase: "waiting_gpu",
			waitingSince: NOW - 12_000,
		});
		expect(
			liveFromStatus({ phase: "rendering", waitingForMs: 9_000, renderingForMs: 3_000 }, NOW),
		).toEqual({ phase: "rendering", renderingSince: NOW - 3_000, waitingSince: NOW - 12_000 });
	});

	test("the queue stores live status only on generating items and clears it on retry", () => {
		let q = queueReducer([generating()], {
			type: "live",
			id: "a",
			live: { phase: "waiting_gpu", waitingSince: NOW },
		});
		expect(q[0].live?.phase).toBe("waiting_gpu");
		q = queueReducer(q, { type: "fail", id: "a", failure: { errorCode: "GPU_BUSY" } });
		q = queueReducer(q, { type: "live", id: "a", live: { phase: "rendering" } });
		expect(q[0].live?.phase).toBe("waiting_gpu");
		q = queueReducer(q, { type: "retry", id: "a", createdAt: "later" });
		expect(q[0].live).toBeUndefined();
	});
});

describe("in-progress tile", () => {
	test("waiting for a GPU: elapsed seconds, no estimate", () => {
		const view = pendingView(
			generating({ live: { phase: "waiting_gpu", waitingSince: NOW - 12_400 } }),
			NOW,
		);
		expect(view).toEqual({ label: "Waiting for a GPU · 12s", active: true });
		expect(view.progress).toBeUndefined();
	});

	test("rendering: the estimate starts at render start, not at submission", () => {
		const view = pendingView(
			generating({ live: { phase: "rendering", renderingSince: NOW - 2_000 } }),
			NOW,
		);
		expect(view.label).toBe("Rendering, about 8 s left");
		expect(view.progress).toBeCloseTo(0.2);
	});

	test("saving, queued, and the brief start before the first status", () => {
		expect(pendingView(generating({ live: { phase: "saving" } }), NOW).label).toBe("Saving");
		expect(pendingView(generating({ status: "queued", startedAt: undefined }), NOW).label).toBe(
			"Queued",
		);
		const fresh = generating({ startedAt: new Date(NOW - 1_000).toISOString() });
		expect(pendingView(fresh, NOW)).toEqual({ label: "Starting", active: true });
	});

	test("GPU_BUSY offers Retry and says the credits came back", () => {
		const copy = describeGenerationError("GPU_BUSY");
		expect(copy.actions).toEqual(["retry"]);
		expect(copy.detail).toContain("credits were returned");
	});
});
