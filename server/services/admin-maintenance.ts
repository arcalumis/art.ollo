/**
 * Admin-side background work, run from the cleanup job (services/cleanup.ts) and the console:
 *   - expire SOL / time-limited subscriptions past ends_at;
 *   - keep monthly financial_periods snapshots current (and backfill past months once);
 *   - run Replicate cost reconciliation as a background job instead of inside a request.
 */
import { getDb } from "../db";
import { expireEndedSubscriptions } from "./admin-subscriptions";
import { addUtcMonths, startOfUtcMonth } from "./admin-time";
import { computePeriodSnapshot } from "./financial-reports";
import { reconcileAllCosts } from "./replicate-billing";

const PERIOD_BACKFILL_MIGRATION = "6_backfill_financial_periods";

function migrationDone(name: string): boolean {
	return !!getDb().prepare("SELECT 1 FROM schema_migrations WHERE name = ?").get(name);
}

/** Backfill every month from the first user/revenue row up to last month. Returns months written. */
export function backfillFinancialPeriods(now: Date = new Date()): number {
	const db = getDb();
	const first = db
		.prepare(`
			SELECT MIN(t) AS t FROM (
				SELECT MIN(datetime(created_at)) AS t FROM users
				UNION ALL SELECT MIN(datetime(created_at)) FROM revenue_events
				UNION ALL SELECT MIN(datetime(created_at)) FROM generations
			)
		`)
		.get() as { t: string | null };
	if (!first.t) return 0;
	let month = startOfUtcMonth(new Date(`${first.t.replace(" ", "T")}Z`));
	const current = startOfUtcMonth(now);
	let written = 0;
	while (month.getTime() < current.getTime() && written < 240) {
		computePeriodSnapshot("monthly", month);
		month = addUtcMonths(month, 1);
		written++;
	}
	return written;
}

/**
 * Keep monthly snapshots current: last month is (re)computed until a snapshot exists that was
 * taken after the month closed; the current month refreshes at most hourly.
 */
export function refreshMonthlySnapshots(now: Date = new Date()): void {
	const db = getDb();
	const current = startOfUtcMonth(now);
	const previous = addUtcMonths(current, -1);
	const prevStart = previous.toISOString().slice(0, 10);
	const prevRow = db
		.prepare("SELECT computed_at FROM financial_periods WHERE period_type = 'monthly' AND period_start = ?")
		.get(prevStart) as { computed_at: string | null } | undefined;
	const closedAt = current.toISOString().slice(0, 19).replace("T", " ");
	if (!prevRow || !prevRow.computed_at || prevRow.computed_at < closedAt) {
		computePeriodSnapshot("monthly", previous);
	}
	const curRow = db
		.prepare(`
			SELECT 1 FROM financial_periods WHERE period_type = 'monthly' AND period_start = ?
			AND datetime(computed_at) > datetime('now', '-1 hour')
		`)
		.get(current.toISOString().slice(0, 10));
	if (!curRow) computePeriodSnapshot("monthly", current);
}

/** One call from the cleanup job. Each step is isolated so one failure never blocks the others. */
export function runAdminMaintenance(): void {
	const step = (name: string, fn: () => void) => {
		try {
			fn();
		} catch (err) {
			console.error(`[admin-maintenance] ${name} failed:`, err);
		}
	};
	step("expire subscriptions", () => {
		expireEndedSubscriptions();
	});
	step("backfill financial periods", () => {
		if (migrationDone(PERIOD_BACKFILL_MIGRATION)) return;
		const n = backfillFinancialPeriods();
		getDb().prepare("INSERT OR IGNORE INTO schema_migrations (name) VALUES (?)").run(PERIOD_BACKFILL_MIGRATION);
		console.log(`[migration] Backfilled ${n} monthly financial snapshots`);
	});
	step("monthly snapshots", () => refreshMonthlySnapshots());
}

// ---- Reconciliation as a background job ---------------------------------------------

export interface ReconcileJobState {
	status: "idle" | "running" | "done" | "failed";
	startedAt: string | null;
	finishedAt: string | null;
	result: { processed: number; reconciled: number; errors: number } | null;
	error: string | null;
	startedBy: string | null;
}

let reconcileState: ReconcileJobState = {
	status: "idle",
	startedAt: null,
	finishedAt: null,
	result: null,
	error: null,
	startedBy: null,
};

export function getReconcileJob(): ReconcileJobState {
	return { ...reconcileState };
}

/**
 * Start a reconciliation pass in the background (returns immediately). A second call while one
 * is running returns the running job instead of starting another.
 */
export function startReconcileJob(
	startedBy: string | null,
	run: (limit: number) => Promise<{ processed: number; reconciled: number; errors: number }> = reconcileAllCosts,
	limit = 500,
): { started: boolean; job: ReconcileJobState } {
	if (reconcileState.status === "running") return { started: false, job: getReconcileJob() };
	reconcileState = {
		status: "running",
		startedAt: new Date().toISOString(),
		finishedAt: null,
		result: null,
		error: null,
		startedBy,
	};
	const promise = Promise.resolve()
		.then(() => run(limit))
		.then((result) => {
			reconcileState = { ...reconcileState, status: "done", finishedAt: new Date().toISOString(), result };
		})
		.catch((err: unknown) => {
			reconcileState = {
				...reconcileState,
				status: "failed",
				finishedAt: new Date().toISOString(),
				error: err instanceof Error ? err.message : String(err),
			};
		});
	lastJobPromise = promise;
	return { started: true, job: getReconcileJob() };
}

let lastJobPromise: Promise<void> | null = null;

/** Tests: wait for the job started last. */
export async function waitForReconcileJob(): Promise<void> {
	if (lastJobPromise) await lastJobPromise;
}
