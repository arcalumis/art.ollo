/**
 * Operational health for the admin console: webhooks, Replicate failures, email caps,
 * pending SOL payments, cost reconciliation and backups.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getDb } from "../db";
import { getReconcileJob } from "./admin-maintenance";
import { isoOrNull } from "./admin-time";

/** Record a Stripe webhook that failed to apply (called from the webhook route's catch). Never throws. */
export function recordWebhookFailure(eventId: string, eventType: string, error: unknown): void {
	try {
		getDb()
			.prepare("INSERT INTO webhook_failures (id, stripe_event_id, event_type, error) VALUES (?, ?, ?, ?)")
			.run(
				crypto.randomUUID(),
				eventId,
				eventType,
				(error instanceof Error ? error.message : String(error)).slice(0, 500),
			);
	} catch {
		// Logging must never break the webhook response.
	}
}

/** Ledger reasons the generation route uses when it refunds a failed Replicate run. */
const FAILURE_REASON_SQL = `(
	reason LIKE 'Generation failed%' OR reason LIKE 'Generation returned no images%'
	OR (reason LIKE 'Tool %' AND reason LIKE '% failed%')
)`;
const RUN_REASON_SQL = "(reason LIKE 'Generation:%' OR reason LIKE 'Tool:%')";

export interface FailureWindow {
	runs: number;
	failures: number;
	rate: number | null;
}

export function replicateFailureWindow(hours: number): FailureWindow {
	const db = getDb();
	const since = `-${hours} hours`;
	const runs = (
		db
			.prepare(
				`SELECT COUNT(*) AS n FROM user_credits WHERE credit_type = 'used' AND ${RUN_REASON_SQL} AND datetime(created_at) >= datetime('now', ?)`,
			)
			.get(since) as { n: number }
	).n;
	const failures = (
		db
			.prepare(
				`SELECT COUNT(*) AS n FROM user_credits WHERE credit_type = 'refund' AND ${FAILURE_REASON_SQL} AND datetime(created_at) >= datetime('now', ?)`,
			)
			.get(since) as { n: number }
	).n;
	return { runs, failures, rate: runs > 0 ? (failures / runs) * 100 : null };
}

/** Newest file mtime in the backup directory (BACKUP_DIR, default the host path); null if absent. */
export function lastBackupTime(dir = process.env.BACKUP_DIR || "/home/baud/backups/ollo"): string | null {
	try {
		if (!fs.existsSync(dir)) return null;
		let newest = 0;
		for (const name of fs.readdirSync(dir)) {
			if (!/\.(db|gz|sqlite|tar|zst)$/.test(name)) continue;
			const st = fs.statSync(path.join(dir, name));
			if (st.isFile() && st.mtimeMs > newest) newest = st.mtimeMs;
		}
		return newest > 0 ? new Date(newest).toISOString() : null;
	} catch {
		return null;
	}
}

const PER_RECIPIENT_HOURLY = 3;
const PER_RECIPIENT_DAILY = 10;

export function getHealth() {
	const db = getDb();

	const webhooks = db
		.prepare(`
			SELECT
				SUM(CASE WHEN datetime(processed_at) >= datetime('now', '-1 day') THEN 1 ELSE 0 END) AS day,
				SUM(CASE WHEN datetime(processed_at) >= datetime('now', '-7 days') THEN 1 ELSE 0 END) AS week,
				MAX(processed_at) AS last
			FROM processed_webhook_events
		`)
		.get() as { day: number | null; week: number | null; last: string | null };
	const webhookFailures = db
		.prepare(`
			SELECT wf.stripe_event_id AS eventId, wf.event_type AS type, MAX(wf.created_at) AS lastFailedAt,
				COUNT(*) AS attempts, MAX(wf.error) AS error,
				EXISTS (SELECT 1 FROM processed_webhook_events p WHERE p.stripe_event_id = wf.stripe_event_id) AS resolved
			FROM webhook_failures wf
			WHERE datetime(wf.created_at) >= datetime('now', '-7 days')
			GROUP BY wf.stripe_event_id
			ORDER BY lastFailedAt DESC
			LIMIT 50
		`)
		.all() as Array<{ eventId: string; type: string; lastFailedAt: string; attempts: number; error: string; resolved: number }>;

	const failedPayments = db
		.prepare(`
			SELECT p.id, p.user_id AS userId, u.username, p.amount_cents AS amountCents, p.stripe_invoice_id AS invoiceId,
				p.description, p.created_at AS createdAt
			FROM payments p LEFT JOIN users u ON u.id = p.user_id
			WHERE p.status = 'failed' AND datetime(p.created_at) >= datetime('now', '-30 days')
			ORDER BY datetime(p.created_at) DESC
			LIMIT 20
		`)
		.all() as Array<{ id: string; userId: string; username: string | null; amountCents: number; invoiceId: string | null; description: string | null; createdAt: string }>;

	const capRows = db
		.prepare(`
			SELECT recipient,
				SUM(CASE WHEN datetime(created_at) > datetime('now', '-1 hour') THEN 1 ELSE 0 END) AS hour,
				COUNT(*) AS day
			FROM email_send_log
			WHERE datetime(created_at) > datetime('now', '-1 day')
			GROUP BY recipient
			HAVING hour >= ? OR day >= ?
			ORDER BY day DESC
			LIMIT 20
		`)
		.all(PER_RECIPIENT_HOURLY, PER_RECIPIENT_DAILY) as Array<{ recipient: string; hour: number; day: number }>;
	const emailTotal = (
		db.prepare("SELECT COUNT(*) AS n FROM email_send_log WHERE datetime(created_at) > datetime('now', '-1 day')").get() as {
			n: number;
		}
	).n;
	const capEnv = Number(process.env.EMAIL_DAILY_CAP);
	const dailyCap = Number.isFinite(capEnv) && capEnv > 0 ? capEnv : 500;

	const pendingSol = db
		.prepare(`
			SELECT 'credits' AS kind, t.id, t.user_id AS userId, u.username, t.amount_sol AS amountSol, t.created_at AS createdAt
			FROM solana_transactions t LEFT JOIN users u ON u.id = t.user_id WHERE t.status = 'pending'
			UNION ALL
			SELECT 'subscription', t.id, t.user_id, u.username, t.amount_sol, t.created_at
			FROM solana_subscription_transactions t LEFT JOIN users u ON u.id = t.user_id WHERE t.status = 'pending'
			ORDER BY createdAt DESC
			LIMIT 50
		`)
		.all() as Array<{ kind: string; id: string; userId: string; username: string | null; amountSol: number; createdAt: string }>;

	const unreconciled = db
		.prepare(`
			SELECT COUNT(*) AS n FROM platform_costs
			WHERE actual_cost IS NULL AND source IS NULL AND datetime(created_at) < datetime('now', '-7 days')
		`)
		.get() as { n: number };
	const estimatedRows = db
		.prepare("SELECT COUNT(*) AS n FROM platform_costs WHERE source IS NOT NULL")
		.get() as { n: number };

	return {
		webhooks: {
			processed24h: webhooks.day ?? 0,
			processed7d: webhooks.week ?? 0,
			lastProcessedAt: isoOrNull(webhooks.last),
			failures: webhookFailures.map((f) => ({
				...f,
				lastFailedAt: isoOrNull(f.lastFailedAt),
				resolved: f.resolved === 1,
			})),
		},
		failedPayments: failedPayments.map((p) => ({ ...p, createdAt: isoOrNull(p.createdAt) })),
		replicate: { day: replicateFailureWindow(24), week: replicateFailureWindow(24 * 7) },
		email: {
			sent24h: emailTotal,
			dailyCap,
			globalCapReached: emailTotal >= dailyCap,
			recipientsAtCap: capRows,
		},
		pendingSol: pendingSol.map((p) => ({ ...p, createdAt: isoOrNull(p.createdAt) })),
		reconciliation: {
			job: getReconcileJob(),
			unreconciledOlderThan7d: unreconciled.n,
			estimatedRows: estimatedRows.n,
		},
		backup: { lastBackupAt: lastBackupTime() },
	};
}
