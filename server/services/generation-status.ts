/**
 * Live status of in-flight generations, so the client can show what is really
 * happening during one long POST /api/generate (or /api/tools/:tool):
 * waiting for a GPU, rendering, saving.
 *
 * In memory only: entries are owner-scoped (keyed by the client's request id,
 * readable only by the user who made the request) and expire 10 minutes after
 * the request finishes. A restart loses them, which only costs the client its
 * live phase for requests that the restart killed anyway.
 */

export type GenerationPhase = "queued" | "waiting_gpu" | "rendering" | "saving" | "done" | "failed";

export interface GenerationStatus {
	clientRequestId: string;
	phase: GenerationPhase;
	model: string;
	/** When the request started waiting for a GPU (ISO). */
	waitingSince?: string;
	/** When a GPU picked it up (ISO). */
	renderingSince?: string;
	/** Milliseconds spent waiting so far (or in total, once rendering): no client clock needed. */
	waitingForMs?: number;
	/** Milliseconds since rendering started. */
	renderingForMs?: number;
}

interface Entry {
	userId: string;
	model: string;
	phase: GenerationPhase;
	waitingSince?: number;
	renderingSince?: number;
	finishedAt?: number;
}

/** Entries live this long after the request finished. */
export const STATUS_TTL_MS = 10 * 60 * 1000;
/** Hard bound on memory; oldest finished entries go first. */
const MAX_ENTRIES = 20_000;
const ORDER: Record<GenerationPhase, number> = {
	queued: 0,
	waiting_gpu: 1,
	rendering: 2,
	saving: 3,
	done: 4,
	failed: 4,
};

export const CLIENT_REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const entries = new Map<string, Entry>();
let now = () => Date.now();

function sweep(): void {
	const t = now();
	for (const [id, e] of entries) {
		if (e.finishedAt !== undefined && t - e.finishedAt >= STATUS_TTL_MS) entries.delete(id);
	}
	if (entries.size > MAX_ENTRIES) {
		for (const [id, e] of entries) {
			if (entries.size <= MAX_ENTRIES) break;
			if (e.finishedAt !== undefined) entries.delete(id);
		}
	}
}

/**
 * Start tracking a request. Returns false when the id is already in use by a
 * request that is still running, or by another user.
 */
export function startStatus(id: string, userId: string, model: string): boolean {
	sweep();
	const existing = entries.get(id);
	if (existing && (existing.userId !== userId || existing.finishedAt === undefined)) return false;
	entries.set(id, { userId, model, phase: "queued" });
	return true;
}

/** Move a request forward. Phases never go backwards (parallel predictions all report). */
export function setPhase(id: string, phase: GenerationPhase): void {
	const e = entries.get(id);
	if (!e || e.finishedAt !== undefined) return;
	if (phase === e.phase || ORDER[phase] < ORDER[e.phase]) return;
	const t = now();
	if (phase === "waiting_gpu") e.waitingSince = t;
	if (phase === "rendering") {
		e.waitingSince ??= t;
		e.renderingSince = t;
	}
	if (phase === "done" || phase === "failed") e.finishedAt = t;
	e.phase = phase;
}

/** The status for its owner; undefined for anyone else or when unknown/expired. */
export function getStatus(id: string, userId: string): GenerationStatus | undefined {
	sweep();
	const e = entries.get(id);
	if (!e || e.userId !== userId) return undefined;
	const t = e.finishedAt ?? now();
	const iso = (ms: number | undefined) => (ms === undefined ? undefined : new Date(ms).toISOString());
	return {
		clientRequestId: id,
		phase: e.phase,
		model: e.model,
		waitingSince: iso(e.waitingSince),
		renderingSince: iso(e.renderingSince),
		waitingForMs:
			e.waitingSince === undefined ? undefined : (e.renderingSince ?? t) - e.waitingSince,
		renderingForMs: e.renderingSince === undefined ? undefined : t - e.renderingSince,
	};
}

export const __testing = {
	setNow(fn: (() => number) | null): void {
		now = fn ?? (() => Date.now());
	},
	clear(): void {
		entries.clear();
	},
	size(): number {
		return entries.size;
	},
};
