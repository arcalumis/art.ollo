import { getDb } from "../db";
import { startReconciliationJob, stopReconciliationJob } from "./replicate-billing";
import { captureAndGetSolPrice } from "./solana";
import { deleteGenerationFiles, getUploadsDir, unlinkInside } from "./storage";
import { processExpiredBoosts } from "./subscription-boost";
import { processSubscriptionRefills } from "./usage";

/** Run one job step; an exception is logged and never escapes the timer. */
function runStep(name: string, fn: () => void): void {
	try {
		fn();
	} catch (err) {
		console.error(`Cleanup step "${name}" failed:`, err);
	}
}

/**
 * How long a trashed generation or upload can be restored before it is purged for good.
 * The gallery's Trash view states this retention, so keep the copy in step if it changes.
 */
export const TRASH_RETENTION_DAYS = 30;

/**
 * Purge generations trashed more than TRASH_RETENTION_DAYS ago: delete their image files
 * (primary + grid images) and mark the row purged_at. Rows are kept for cost
 * tracking; history/threads/gallery queries already exclude purged rows.
 * Returns the number of rows purged.
 */
export function purgeTrashedGenerations(): number {
	const db = getDb();
	const rows = db
		.prepare(
			`SELECT id, image_path, parameters FROM generations
			 WHERE deleted_at IS NOT NULL
			 AND purged_at IS NULL
			 AND deleted_at < datetime('now', ?)`,
		)
		.all(`-${TRASH_RETENTION_DAYS} days`) as { id: string; image_path: string | null; parameters: string | null }[];

	const markPurged = db.prepare("UPDATE generations SET purged_at = datetime('now') WHERE id = ?");
	let purged = 0;
	for (const row of rows) {
		try {
			deleteGenerationFiles(row.image_path, row.parameters);
			markPurged.run(row.id);
			purged++;
		} catch (err) {
			console.error(`Failed to purge generation ${row.id}:`, err);
		}
	}
	return purged;
}

/** Hard-delete uploads trashed more than TRASH_RETENTION_DAYS ago (uploads carry no cost data). */
export function purgeTrashedUploads(): number {
	const db = getDb();
	const rows = db
		.prepare(
			`SELECT id, filename FROM uploads
			 WHERE deleted_at IS NOT NULL
			 AND deleted_at < datetime('now', ?)`,
		)
		.all(`-${TRASH_RETENTION_DAYS} days`) as { id: string; filename: string | null }[];

	const del = db.prepare("DELETE FROM uploads WHERE id = ?");
	let purged = 0;
	for (const row of rows) {
		try {
			unlinkInside(getUploadsDir(), row.filename);
			del.run(row.id);
			purged++;
		} catch (err) {
			console.error(`Failed to purge upload ${row.id}:`, err);
		}
	}
	return purged;
}

export function cleanupTrashedItems(): void {
	let totalCleaned = 0;
	runStep("purge generations", () => {
		totalCleaned += purgeTrashedGenerations();
	});
	runStep("purge uploads", () => {
		totalCleaned += purgeTrashedUploads();
	});
	if (totalCleaned > 0) {
		console.log(`Cleanup: Permanently purged ${totalCleaned} trashed items`);
	}

	// Process expired subscription boosts
	runStep("expire boosts", () => processExpiredBoosts());

	// Process subscription credit refills
	runStep("credit refills", () => {
		processSubscriptionRefills();
	});

	// Capture SOL price snapshot (~every 15 min)
	runStep("SOL price snapshot", () => {
		const recentSnapshot = getDb()
			.prepare("SELECT id FROM sol_price_snapshots WHERE captured_at >= datetime('now', '-14 minutes') LIMIT 1")
			.get();
		if (!recentSnapshot) {
			captureAndGetSolPrice().catch(console.error);
		}
	});
}

let cleanupInterval: NodeJS.Timeout | null = null;

/**
 * Start the background jobs: trash purge / boosts / refills / SOL price every
 * `intervalMs`, plus the hourly Replicate cost reconciliation.
 *
 * Returns the cleanup interval (index.ts clears it on shutdown). The
 * reconciliation interval is unref'd so it never holds the process open;
 * stopCleanupJob() clears both.
 */
export function startCleanupJob(intervalMs = 5 * 60 * 1000): NodeJS.Timeout {
	stopCleanupJob();

	// Run immediately on start
	cleanupTrashedItems();

	runStep("start cost reconciliation", () => {
		const reconciliation = startReconciliationJob();
		reconciliation.unref?.();
	});

	// Then run periodically
	cleanupInterval = setInterval(cleanupTrashedItems, intervalMs);
	return cleanupInterval;
}

export function stopCleanupJob(): void {
	if (cleanupInterval) {
		clearInterval(cleanupInterval);
		cleanupInterval = null;
	}
	stopReconciliationJob();
}
