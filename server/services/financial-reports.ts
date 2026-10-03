/**
 * Financial reporting for the admin console.
 *
 * Every range is [start, end) in UTC and every timestamp comparison goes through SQLite's
 * datetime() so "YYYY-MM-DD HH:MM:SS" rows and ISO rows compare correctly (comparing text
 * against an ISO bound used to drop the first day of every range).
 *
 * Subscriber counts, MRR, ARPU, LTV and churn count PAID subscriptions only (see
 * admin-subscriptions.ts): Free, comped and boosted plans are excluded.
 */
import crypto from "node:crypto";
import { getDb } from "../db";
import { type PaidSnapshot, loadSubscriptionRecords, paidSnapshot } from "./admin-subscriptions";
import { addUtcMonths, startOfUtcDay, startOfUtcMonth, toSqlDate, toSqlTime } from "./admin-time";

export interface FinancialMetrics {
	revenue: {
		total: number;
		subscription: number;
		overage: number;
		credits: number;
		/** Paid through Stripe (USD). */
		stripe: number;
		/** Paid in SOL, valued in USD at verification. */
		sol: number;
	};
	costs: {
		platform: number;
		estimated: number;
		actual: number;
		/** Part of `platform` that comes from backfilled estimates. */
		backfilled: number;
	};
	profit: {
		gross: number;
		/** Gross margin %, null when there is no revenue. */
		margin: number | null;
	};
	subscribers: {
		/** Paid subscribers at the end of the range (or now, if the range is still open). */
		active: number;
		new: number;
		churned: number;
		/** churned / paid subscribers at the start of the range, %; null without a base. */
		churnRate: number | null;
	};
	mrr: number;
	arr: number;
	/** Revenue in the range per paid subscriber; null with no paid subscribers. */
	avgRevenuePerUser: number | null;
	/** ARPU x average paid months; null ("not enough data") until someone has paid for a month. */
	ltv: number | null;
	generations: number;
	avgCostPerGeneration: number;
}

export interface PeriodComparison {
	current: FinancialMetrics;
	previous: FinancialMetrics;
	changes: {
		revenue: number | null;
		profit: number | null;
		subscribers: number | null;
		mrr: number | null;
		generations: number | null;
	};
}

export type PeriodType = "daily" | "monthly" | "quarterly" | "yearly";

/** [start, end) of the UTC period containing `date`. */
export function getPeriodRange(
	periodType: PeriodType,
	date: Date = new Date(),
): { start: Date; end: Date } {
	switch (periodType) {
		case "daily": {
			const start = startOfUtcDay(date);
			return { start, end: new Date(start.getTime() + 86_400_000) };
		}
		case "monthly": {
			const start = startOfUtcMonth(date);
			return { start, end: addUtcMonths(start, 1) };
		}
		case "quarterly": {
			const q = Math.floor(date.getUTCMonth() / 3);
			const start = new Date(Date.UTC(date.getUTCFullYear(), q * 3, 1));
			return { start, end: addUtcMonths(start, 3) };
		}
		case "yearly": {
			const start = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
			return { start, end: new Date(Date.UTC(date.getUTCFullYear() + 1, 0, 1)) };
		}
	}
}

function getPreviousPeriodRange(
	periodType: PeriodType,
	date: Date = new Date(),
): { start: Date; end: Date } {
	const { start } = getPeriodRange(periodType, date);
	return getPeriodRange(periodType, new Date(start.getTime() - 1));
}

/** SOL-paid revenue events (SOL subscriptions, and credit packs bought with SOL). */
export const SOL_REVENUE_SQL = "(event_type LIKE 'sol_%' OR description LIKE 'SOL %')";

const SUBSCRIPTION_TYPES = new Set(["subscription", "sol_subscription"]);
const CREDIT_TYPES = new Set(["credit_purchase", "credit_usage", "sol_credits"]);

export function calculateMetrics(startDate: Date, endDate: Date): FinancialMetrics {
	const db = getDb();
	const start = toSqlTime(startDate);
	const end = toSqlTime(endDate);

	const revenueRows = db
		.prepare(`
			SELECT event_type, ${SOL_REVENUE_SQL} AS is_sol, SUM(amount_cents) AS total
			FROM revenue_events
			WHERE datetime(created_at) >= datetime(?) AND datetime(created_at) < datetime(?)
			GROUP BY event_type, is_sol
		`)
		.all(start, end) as Array<{ event_type: string; is_sol: number; total: number | null }>;

	const revenue = { total: 0, subscription: 0, overage: 0, credits: 0, stripe: 0, sol: 0 };
	for (const row of revenueRows) {
		const amount = (row.total || 0) / 100;
		revenue.total += amount;
		if (row.is_sol) revenue.sol += amount;
		else revenue.stripe += amount;
		if (SUBSCRIPTION_TYPES.has(row.event_type)) revenue.subscription += amount;
		else if (row.event_type === "overage") revenue.overage += amount;
		else if (CREDIT_TYPES.has(row.event_type)) revenue.credits += amount;
	}

	const costRow = db
		.prepare(`
			SELECT
				SUM(estimated_cost) AS estimated,
				SUM(COALESCE(actual_cost, estimated_cost)) AS actual,
				SUM(CASE WHEN source IS NOT NULL THEN COALESCE(actual_cost, estimated_cost) ELSE 0 END) AS backfilled
			FROM platform_costs
			WHERE datetime(created_at) >= datetime(?) AND datetime(created_at) < datetime(?)
		`)
		.get(start, end) as {
		estimated: number | null;
		actual: number | null;
		backfilled: number | null;
	};
	const costs = {
		platform: costRow.actual || 0,
		estimated: costRow.estimated || 0,
		actual: costRow.actual || 0,
		backfilled: costRow.backfilled || 0,
	};

	const grossProfit = revenue.total - costs.platform;
	const margin = revenue.total > 0 ? (grossProfit / revenue.total) * 100 : null;

	// Paid subscribers: at the end of the range (capped at now) and at its start.
	const records = loadSubscriptionRecords(db);
	const nowMs = Date.now();
	const endSnap = paidSnapshot(new Date(Math.min(endDate.getTime(), nowMs)), records);
	const startSnap = paidSnapshot(new Date(Math.min(startDate.getTime(), nowMs)), records);

	// New paid subscribers: users whose first paid row starts inside the range.
	const firstPaid = new Map<string, number>();
	for (const rec of records) {
		if (rec.source !== "stripe" && rec.source !== "sol") continue;
		const t = Date.parse(rec.startsAt ?? rec.createdAt ?? "");
		if (Number.isNaN(t)) continue;
		const prev = firstPaid.get(rec.userId);
		if (prev === undefined || t < prev) firstPaid.set(rec.userId, t);
	}
	let newSubscribers = 0;
	for (const t of firstPaid.values()) {
		if (t >= startDate.getTime() && t < endDate.getTime()) newSubscribers++;
	}

	// Churned: Stripe cancellations (user_metrics.churned_at) plus SOL periods that lapsed.
	const churnedRows = db
		.prepare(`
			SELECT user_id FROM user_metrics
			WHERE datetime(churned_at) >= datetime(?) AND datetime(churned_at) < datetime(?)
			UNION
			SELECT us.user_id FROM user_subscriptions us
			WHERE us.status = 'expired'
			AND EXISTS (SELECT 1 FROM solana_subscription_transactions st WHERE st.subscription_id = us.id AND st.status = 'completed')
			AND datetime(us.ends_at) >= datetime(?) AND datetime(us.ends_at) < datetime(?)
		`)
		.all(start, end, start, end) as Array<{ user_id: string }>;
	const churned = churnedRows.length;
	const churnRate =
		startSnap.paidSubscribers > 0 ? (churned / startSnap.paidSubscribers) * 100 : null;

	const mrr = endSnap.mrrCents / 100;
	const activePaid = endSnap.paidSubscribers;
	const arpu = activePaid > 0 ? revenue.total / activePaid : null;

	const avgMonths = db
		.prepare(
			"SELECT AVG(subscription_months) AS avg FROM user_metrics WHERE subscription_months > 0",
		)
		.get() as { avg: number | null };
	const ltv = arpu !== null && avgMonths.avg ? arpu * avgMonths.avg : null;

	const generations =
		(
			db
				.prepare(`
					SELECT COUNT(*) AS count FROM generations
					WHERE datetime(created_at) >= datetime(?) AND datetime(created_at) < datetime(?)
				`)
				.get(start, end) as { count: number }
		).count || 0;

	return {
		revenue,
		costs,
		profit: { gross: grossProfit, margin },
		subscribers: { active: activePaid, new: newSubscribers, churned, churnRate },
		mrr,
		arr: mrr * 12,
		avgRevenuePerUser: arpu,
		ltv,
		generations,
		avgCostPerGeneration: generations > 0 ? costs.platform / generations : 0,
	};
}

export function getMetricsWithComparison(periodType: PeriodType): PeriodComparison {
	const current = getPeriodRange(periodType);
	const previous = getPreviousPeriodRange(periodType);
	const currentMetrics = calculateMetrics(current.start, current.end);
	const previousMetrics = calculateMetrics(previous.start, previous.end);

	const calcChange = (curr: number, prev: number): number | null => {
		if (prev === 0) return curr === 0 ? 0 : null;
		return ((curr - prev) / Math.abs(prev)) * 100;
	};

	return {
		current: currentMetrics,
		previous: previousMetrics,
		changes: {
			revenue: calcChange(currentMetrics.revenue.total, previousMetrics.revenue.total),
			profit: calcChange(currentMetrics.profit.gross, previousMetrics.profit.gross),
			subscribers: calcChange(
				currentMetrics.subscribers.active,
				previousMetrics.subscribers.active,
			),
			mrr: calcChange(currentMetrics.mrr, previousMetrics.mrr),
			generations: calcChange(currentMetrics.generations, previousMetrics.generations),
		},
	};
}

/**
 * Subscription revenue by plan. Each revenue event is attributed to the ONE plan the user held
 * when it was booked (the newest row that had started by then), so history never double-counts.
 * Covers Stripe ('subscription') and SOL ('sol_subscription') events.
 */
export function getRevenueByTier(
	startDate: Date,
	endDate: Date,
): Array<{ tier: string; revenue: number; subscribers: number }> {
	const db = getDb();
	return db
		.prepare(`
			SELECT
				COALESCE((
					SELECT sp.name FROM user_subscriptions us
					JOIN subscription_products sp ON sp.id = us.product_id
					WHERE us.user_id = re.user_id
					AND datetime(us.starts_at) <= datetime(re.created_at, '+10 minutes')
					ORDER BY datetime(us.starts_at) DESC, us.created_at DESC
					LIMIT 1
				), 'Unknown') AS tier,
				SUM(re.amount_cents) / 100.0 AS revenue,
				COUNT(DISTINCT re.user_id) AS subscribers
			FROM revenue_events re
			WHERE datetime(re.created_at) >= datetime(?) AND datetime(re.created_at) < datetime(?)
			AND re.event_type IN ('subscription', 'sol_subscription')
			GROUP BY tier
			ORDER BY revenue DESC
		`)
		.all(toSqlTime(startDate), toSqlTime(endDate)) as Array<{
		tier: string;
		revenue: number;
		subscribers: number;
	}>;
}

export function getTopCustomers(
	startDate: Date,
	endDate: Date,
	limit = 10,
): Array<{
	userId: string;
	username: string;
	email: string | null;
	revenue: number;
	generations: number;
}> {
	const db = getDb();
	const start = toSqlTime(startDate);
	const end = toSqlTime(endDate);
	return db
		.prepare(`
			SELECT
				u.id AS userId, u.username, u.email,
				SUM(re.amount_cents) / 100.0 AS revenue,
				(SELECT COUNT(*) FROM generations g WHERE g.user_id = u.id
					AND datetime(g.created_at) >= datetime(?) AND datetime(g.created_at) < datetime(?)) AS generations
			FROM revenue_events re
			JOIN users u ON re.user_id = u.id
			WHERE datetime(re.created_at) >= datetime(?) AND datetime(re.created_at) < datetime(?)
			GROUP BY u.id
			ORDER BY revenue DESC
			LIMIT ?
		`)
		.all(start, end, start, end, limit) as Array<{
		userId: string;
		username: string;
		email: string | null;
		revenue: number;
		generations: number;
	}>;
}

export function getCostsByModel(
	startDate: Date,
	endDate: Date,
): Array<{
	model: string;
	estimatedCost: number;
	actualCost: number;
	generations: number;
	avgCost: number;
}> {
	const db = getDb();
	const rows = db
		.prepare(`
			SELECT model,
				SUM(estimated_cost) AS estimatedCost,
				SUM(COALESCE(actual_cost, estimated_cost)) AS actualCost,
				COUNT(*) AS generations
			FROM platform_costs
			WHERE datetime(created_at) >= datetime(?) AND datetime(created_at) < datetime(?)
			GROUP BY model
			ORDER BY actualCost DESC
		`)
		.all(toSqlTime(startDate), toSqlTime(endDate)) as Array<{
		model: string;
		estimatedCost: number;
		actualCost: number;
		generations: number;
	}>;
	return rows.map((r) => ({ ...r, avgCost: r.generations > 0 ? r.actualCost / r.generations : 0 }));
}

export interface TrendPoint {
	period: string;
	start: string;
	revenue: number;
	costs: number;
	profit: number;
	subscribers: number;
	signups: number;
}

/** Revenue, cost, paid subscribers (at period end) and signups per UTC day/week/month. */
export function getRevenueTrend(
	periodType: "daily" | "weekly" | "monthly",
	count: number,
): TrendPoint[] {
	const db = getDb();
	const records = loadSubscriptionRecords(db);
	const now = new Date();
	const points: TrendPoint[] = [];

	const revenueStmt = db.prepare(`
		SELECT COALESCE(SUM(amount_cents), 0) / 100.0 AS total FROM revenue_events
		WHERE datetime(created_at) >= datetime(?) AND datetime(created_at) < datetime(?)
	`);
	const costStmt = db.prepare(`
		SELECT COALESCE(SUM(COALESCE(actual_cost, estimated_cost)), 0) AS total FROM platform_costs
		WHERE datetime(created_at) >= datetime(?) AND datetime(created_at) < datetime(?)
	`);
	const signupStmt = db.prepare(`
		SELECT COUNT(*) AS n FROM users
		WHERE datetime(created_at) >= datetime(?) AND datetime(created_at) < datetime(?)
	`);

	for (let i = count - 1; i >= 0; i--) {
		let start: Date;
		let end: Date;
		let label: string;
		if (periodType === "daily") {
			start = new Date(startOfUtcDay(now).getTime() - i * 86_400_000);
			end = new Date(start.getTime() + 86_400_000);
			label = toSqlDate(start);
		} else if (periodType === "weekly") {
			const today = startOfUtcDay(now);
			const weekStart = new Date(today.getTime() - today.getUTCDay() * 86_400_000);
			start = new Date(weekStart.getTime() - i * 7 * 86_400_000);
			end = new Date(start.getTime() + 7 * 86_400_000);
			label = `Week of ${toSqlDate(start)}`;
		} else {
			start = addUtcMonths(now, -i);
			end = addUtcMonths(start, 1);
			label = toSqlDate(start).slice(0, 7);
		}
		const a = toSqlTime(start);
		const b = toSqlTime(end);
		const revenue = (revenueStmt.get(a, b) as { total: number }).total;
		const costs = (costStmt.get(a, b) as { total: number }).total;
		const signups = (signupStmt.get(a, b) as { n: number }).n;
		const snap: PaidSnapshot = paidSnapshot(
			new Date(Math.min(end.getTime() - 1, now.getTime())),
			records,
		);
		points.push({
			period: label,
			start: start.toISOString(),
			revenue,
			costs,
			profit: revenue - costs,
			subscribers: snap.paidSubscribers,
			signups,
		});
	}
	return points;
}

/** Compute and upsert the snapshot row for the period containing `date`. */
export function computePeriodSnapshot(periodType: PeriodType, date: Date = new Date()): void {
	const db = getDb();
	const { start, end } = getPeriodRange(periodType, date);
	const metrics = calculateMetrics(start, end);
	const periodStart = toSqlDate(start);
	// period_end is the last day inside the period.
	const periodEnd = toSqlDate(new Date(end.getTime() - 1));

	db.prepare(`
		INSERT INTO financial_periods (
			id, period_type, period_start, period_end,
			total_revenue_cents, total_platform_cost_cents, total_generations,
			active_subscribers, new_subscribers, churned_subscribers, mrr_cents, computed_at
		)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
		ON CONFLICT(period_type, period_start) DO UPDATE SET
			period_end = excluded.period_end,
			total_revenue_cents = excluded.total_revenue_cents,
			total_platform_cost_cents = excluded.total_platform_cost_cents,
			total_generations = excluded.total_generations,
			active_subscribers = excluded.active_subscribers,
			new_subscribers = excluded.new_subscribers,
			churned_subscribers = excluded.churned_subscribers,
			mrr_cents = excluded.mrr_cents,
			computed_at = excluded.computed_at
	`).run(
		crypto.randomUUID(),
		periodType,
		periodStart,
		periodEnd,
		Math.round(metrics.revenue.total * 100),
		Math.round(metrics.costs.platform * 100),
		metrics.generations,
		metrics.subscribers.active,
		metrics.subscribers.new,
		metrics.subscribers.churned,
		Math.round(metrics.mrr * 100),
	);
}

export function generateProfitLossStatement(
	startDate: Date,
	endDate: Date,
): {
	revenue: { subscriptions: number; overage: number; credits: number; total: number };
	costOfRevenue: { platformCosts: number; total: number };
	grossProfit: number;
	grossMargin: number | null;
	metrics: { generations: number; activeSubscribers: number; avgRevenuePerUser: number | null };
} {
	const metrics = calculateMetrics(startDate, endDate);
	return {
		revenue: {
			subscriptions: metrics.revenue.subscription,
			overage: metrics.revenue.overage,
			credits: metrics.revenue.credits,
			total: metrics.revenue.total,
		},
		costOfRevenue: { platformCosts: metrics.costs.platform, total: metrics.costs.platform },
		grossProfit: metrics.profit.gross,
		grossMargin: metrics.profit.margin,
		metrics: {
			generations: metrics.generations,
			activeSubscribers: metrics.subscribers.active,
			avgRevenuePerUser: metrics.avgRevenuePerUser,
		},
	};
}
