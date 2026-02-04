import crypto from "node:crypto";
import { getDb } from "../db";

export interface FinancialMetrics {
	revenue: {
		total: number;
		subscription: number;
		overage: number;
		credits: number;
	};
	costs: {
		platform: number;
		estimated: number;
		actual: number;
	};
	profit: {
		gross: number;
		margin: number;
	};
	subscribers: {
		active: number;
		new: number;
		churned: number;
		churnRate: number;
	};
	mrr: number;
	arr: number;
	avgRevenuePerUser: number;
	ltv: number;
	generations: number;
	avgCostPerGeneration: number;
}

export interface PeriodComparison {
	current: FinancialMetrics;
	previous: FinancialMetrics;
	changes: {
		revenue: number;
		profit: number;
		subscribers: number;
		mrr: number;
		generations: number;
	};
}

type PeriodType = "daily" | "monthly" | "quarterly" | "yearly";

// Get date range for a period
function getPeriodRange(
	periodType: PeriodType,
	date: Date = new Date(),
): {
	start: Date;
	end: Date;
} {
	const start = new Date(date);
	const end = new Date(date);

	switch (periodType) {
		case "daily":
			start.setHours(0, 0, 0, 0);
			end.setHours(23, 59, 59, 999);
			break;
		case "monthly":
			start.setDate(1);
			start.setHours(0, 0, 0, 0);
			end.setMonth(end.getMonth() + 1);
			end.setDate(0);
			end.setHours(23, 59, 59, 999);
			break;
		case "quarterly": {
			const quarter = Math.floor(start.getMonth() / 3);
			start.setMonth(quarter * 3, 1);
			start.setHours(0, 0, 0, 0);
			end.setMonth(quarter * 3 + 3, 0);
			end.setHours(23, 59, 59, 999);
			break;
		}
		case "yearly":
			start.setMonth(0, 1);
			start.setHours(0, 0, 0, 0);
			end.setMonth(11, 31);
			end.setHours(23, 59, 59, 999);
			break;
	}

	return { start, end };
}

// Get previous period range
function getPreviousPeriodRange(
	periodType: PeriodType,
	date: Date = new Date(),
): {
	start: Date;
	end: Date;
} {
	const prevDate = new Date(date);

	switch (periodType) {
		case "daily":
			prevDate.setDate(prevDate.getDate() - 1);
			break;
		case "monthly":
			prevDate.setMonth(prevDate.getMonth() - 1);
			break;
		case "quarterly":
			prevDate.setMonth(prevDate.getMonth() - 3);
			break;
		case "yearly":
			prevDate.setFullYear(prevDate.getFullYear() - 1);
			break;
	}

	return getPeriodRange(periodType, prevDate);
}

// Calculate financial metrics for a period
export function calculateMetrics(startDate: Date, endDate: Date): FinancialMetrics {
	const db = getDb();
	const startStr = startDate.toISOString();
	const endStr = endDate.toISOString();

	// Revenue breakdown
	const revenueByType = db
		.prepare(`
			SELECT
				event_type,
				SUM(amount_cents) as total
			FROM revenue_events
			WHERE created_at >= ? AND created_at < ?
			GROUP BY event_type
		`)
		.all(startStr, endStr) as Array<{ event_type: string; total: number }>;

	const revenue = {
		total: 0,
		subscription: 0,
		overage: 0,
		credits: 0,
	};

	for (const row of revenueByType) {
		const amount = (row.total || 0) / 100; // Convert cents to dollars
		revenue.total += amount;
		if (row.event_type === "subscription" || row.event_type === "sol_subscription") {
			revenue.subscription += amount;
		} else if (row.event_type === "overage") {
			revenue.overage = amount;
		} else if (row.event_type === "credit_usage" || row.event_type === "credit_purchase") {
			revenue.credits += amount;
		}
	}

	// Platform costs
	const costResult = db
		.prepare(`
			SELECT
				SUM(estimated_cost) as estimated,
				SUM(COALESCE(actual_cost, estimated_cost)) as actual
			FROM platform_costs
			WHERE created_at >= ? AND created_at < ?
		`)
		.get(startStr, endStr) as { estimated: number | null; actual: number | null };

	const costs = {
		platform: costResult.actual || 0,
		estimated: costResult.estimated || 0,
		actual: costResult.actual || 0,
	};

	// Profit calculation
	const grossProfit = revenue.total - costs.platform;
	const profitMargin = revenue.total > 0 ? (grossProfit / revenue.total) * 100 : 0;

	// Subscriber metrics
	const activeSubscribers = db
		.prepare(`
			SELECT COUNT(DISTINCT user_id) as count
			FROM user_subscriptions
			WHERE status = 'active'
			AND (current_period_end >= ? OR current_period_end IS NULL)
		`)
		.get(endStr) as { count: number };

	const newSubscribers = db
		.prepare(`
			SELECT COUNT(DISTINCT user_id) as count
			FROM user_subscriptions
			WHERE created_at >= ? AND created_at < ?
		`)
		.get(startStr, endStr) as { count: number };

	const churnedSubscribers = db
		.prepare(`
			SELECT COUNT(DISTINCT user_id) as count
			FROM user_metrics
			WHERE churned_at >= ? AND churned_at < ?
		`)
		.get(startStr, endStr) as { count: number };

	const subscriberCount = activeSubscribers.count || 0;
	const churnRate =
		subscriberCount + churnedSubscribers.count > 0
			? (churnedSubscribers.count / (subscriberCount + churnedSubscribers.count)) * 100
			: 0;

	// MRR calculation (sum of all active subscription prices)
	const mrrResult = db
		.prepare(`
			SELECT SUM(sp.price) as mrr
			FROM user_subscriptions us
			JOIN subscription_products sp ON us.product_id = sp.id
			WHERE us.status = 'active'
		`)
		.get() as { mrr: number | null };

	const mrr = mrrResult.mrr || 0;
	const arr = mrr * 12;

	// ARPU (Average Revenue Per User)
	const arpu = subscriberCount > 0 ? revenue.total / subscriberCount : 0;

	// LTV calculation (simple: ARPU * average subscription length)
	const avgSubscriptionMonths = db
		.prepare(`
			SELECT AVG(subscription_months) as avg
			FROM user_metrics
			WHERE subscription_months > 0
		`)
		.get() as { avg: number | null };

	const avgMonths = avgSubscriptionMonths.avg || 12; // Default to 12 months
	const ltv = arpu * avgMonths;

	// Generation metrics
	const generationStats = db
		.prepare(`
			SELECT COUNT(*) as count
			FROM generations
			WHERE created_at >= ? AND created_at < ?
			AND purged_at IS NULL
		`)
		.get(startStr, endStr) as { count: number };

	const generations = generationStats.count || 0;
	const avgCostPerGeneration = generations > 0 ? costs.platform / generations : 0;

	return {
		revenue,
		costs,
		profit: {
			gross: grossProfit,
			margin: profitMargin,
		},
		subscribers: {
			active: subscriberCount,
			new: newSubscribers.count || 0,
			churned: churnedSubscribers.count || 0,
			churnRate,
		},
		mrr,
		arr,
		avgRevenuePerUser: arpu,
		ltv,
		generations,
		avgCostPerGeneration,
	};
}

// Get metrics with period-over-period comparison
export function getMetricsWithComparison(periodType: PeriodType): PeriodComparison {
	const current = getPeriodRange(periodType);
	const previous = getPreviousPeriodRange(periodType);

	const currentMetrics = calculateMetrics(current.start, current.end);
	const previousMetrics = calculateMetrics(previous.start, previous.end);

	const calcChange = (curr: number, prev: number): number => {
		if (prev === 0) return curr > 0 ? 100 : 0;
		return ((curr - prev) / prev) * 100;
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

// Get revenue breakdown by subscription tier
export function getRevenueByTier(
	startDate: Date,
	endDate: Date,
): Array<{
	tier: string;
	revenue: number;
	subscribers: number;
}> {
	const db = getDb();

	const results = db
		.prepare(`
			SELECT
				sp.name as tier,
				SUM(re.amount_cents) / 100.0 as revenue,
				COUNT(DISTINCT us.user_id) as subscribers
			FROM revenue_events re
			JOIN user_subscriptions us ON re.user_id = us.user_id
			JOIN subscription_products sp ON us.product_id = sp.id
			WHERE re.created_at >= ? AND re.created_at < ?
			AND re.event_type = 'subscription'
			GROUP BY sp.name
			ORDER BY revenue DESC
		`)
		.all(startDate.toISOString(), endDate.toISOString()) as Array<{
		tier: string;
		revenue: number;
		subscribers: number;
	}>;

	return results;
}

// Get top customers by revenue
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

	const results = db
		.prepare(`
			SELECT
				u.id as userId,
				u.username,
				u.email,
				SUM(re.amount_cents) / 100.0 as revenue,
				(SELECT COUNT(*) FROM generations g WHERE g.user_id = u.id
				 AND g.created_at >= ? AND g.created_at < ?) as generations
			FROM revenue_events re
			JOIN users u ON re.user_id = u.id
			WHERE re.created_at >= ? AND re.created_at < ?
			GROUP BY u.id
			ORDER BY revenue DESC
			LIMIT ?
		`)
		.all(
			startDate.toISOString(),
			endDate.toISOString(),
			startDate.toISOString(),
			endDate.toISOString(),
			limit,
		) as Array<{
		userId: string;
		username: string;
		email: string | null;
		revenue: number;
		generations: number;
	}>;

	return results;
}

// Get cost breakdown by model
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

	const results = db
		.prepare(`
			SELECT
				model,
				SUM(estimated_cost) as estimatedCost,
				SUM(COALESCE(actual_cost, estimated_cost)) as actualCost,
				COUNT(*) as generations
			FROM platform_costs
			WHERE created_at >= ? AND created_at < ?
			GROUP BY model
			ORDER BY actualCost DESC
		`)
		.all(startDate.toISOString(), endDate.toISOString()) as Array<{
		model: string;
		estimatedCost: number;
		actualCost: number;
		generations: number;
	}>;

	return results.map((r) => ({
		...r,
		avgCost: r.generations > 0 ? r.actualCost / r.generations : 0,
	}));
}

// Get revenue trend over time
export function getRevenueTrend(
	periodType: "daily" | "weekly" | "monthly",
	count: number,
): Array<{
	period: string;
	revenue: number;
	costs: number;
	profit: number;
	subscribers: number;
}> {
	const db = getDb();
	const results: Array<{
		period: string;
		revenue: number;
		costs: number;
		profit: number;
		subscribers: number;
	}> = [];

	const now = new Date();

	for (let i = count - 1; i >= 0; i--) {
		const date = new Date(now);
		let periodLabel: string;
		let start: Date;
		let end: Date;

		switch (periodType) {
			case "daily":
				date.setDate(date.getDate() - i);
				periodLabel = date.toISOString().split("T")[0];
				start = new Date(date);
				start.setHours(0, 0, 0, 0);
				end = new Date(date);
				end.setHours(23, 59, 59, 999);
				break;
			case "weekly": {
				date.setDate(date.getDate() - i * 7);
				const weekStart = new Date(date);
				weekStart.setDate(weekStart.getDate() - weekStart.getDay());
				periodLabel = `Week of ${weekStart.toISOString().split("T")[0]}`;
				start = weekStart;
				start.setHours(0, 0, 0, 0);
				end = new Date(weekStart);
				end.setDate(end.getDate() + 6);
				end.setHours(23, 59, 59, 999);
				break;
			}
			case "monthly":
				date.setMonth(date.getMonth() - i);
				periodLabel = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
				start = new Date(date.getFullYear(), date.getMonth(), 1);
				end = new Date(date.getFullYear(), date.getMonth() + 1, 0, 23, 59, 59, 999);
				break;
		}

		// Get revenue for period
		const revenueResult = db
			.prepare(`
				SELECT SUM(amount_cents) / 100.0 as total
				FROM revenue_events
				WHERE created_at >= ? AND created_at < ?
			`)
			.get(start.toISOString(), end.toISOString()) as { total: number | null };

		// Get costs for period
		const costResult = db
			.prepare(`
				SELECT SUM(COALESCE(actual_cost, estimated_cost)) as total
				FROM platform_costs
				WHERE created_at >= ? AND created_at < ?
			`)
			.get(start.toISOString(), end.toISOString()) as { total: number | null };

		// Get subscriber count at end of period
		const subscriberResult = db
			.prepare(`
				SELECT COUNT(DISTINCT user_id) as count
				FROM user_subscriptions
				WHERE status = 'active'
				AND created_at <= ?
			`)
			.get(end.toISOString()) as { count: number };

		const revenue = revenueResult.total || 0;
		const costs = costResult.total || 0;

		results.push({
			period: periodLabel,
			revenue,
			costs,
			profit: revenue - costs,
			subscribers: subscriberResult.count || 0,
		});
	}

	return results;
}

// Compute and store period snapshot
export function computePeriodSnapshot(periodType: PeriodType, date: Date = new Date()): void {
	const db = getDb();
	const { start, end } = getPeriodRange(periodType, date);
	const metrics = calculateMetrics(start, end);

	const id = crypto.randomUUID();
	const periodStart = start.toISOString().split("T")[0];

	// Check if snapshot already exists
	const existing = db
		.prepare("SELECT id FROM financial_periods WHERE period_type = ? AND period_start = ?")
		.get(periodType, periodStart);

	if (existing) {
		// Update existing
		db.prepare(`
			UPDATE financial_periods SET
				total_revenue_cents = ?,
				total_platform_cost_cents = ?,
				total_generations = ?,
				active_subscribers = ?,
				new_subscribers = ?,
				churned_subscribers = ?,
				mrr_cents = ?,
				computed_at = datetime('now')
			WHERE period_type = ? AND period_start = ?
		`).run(
			Math.round(metrics.revenue.total * 100),
			Math.round(metrics.costs.platform * 100),
			metrics.generations,
			metrics.subscribers.active,
			metrics.subscribers.new,
			metrics.subscribers.churned,
			Math.round(metrics.mrr * 100),
			periodType,
			periodStart,
		);
	} else {
		// Insert new
		db.prepare(`
			INSERT INTO financial_periods (
				id, period_type, period_start, period_end,
				total_revenue_cents, total_platform_cost_cents, total_generations,
				active_subscribers, new_subscribers, churned_subscribers,
				mrr_cents, computed_at
			)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
		`).run(
			id,
			periodType,
			periodStart,
			end.toISOString().split("T")[0],
			Math.round(metrics.revenue.total * 100),
			Math.round(metrics.costs.platform * 100),
			metrics.generations,
			metrics.subscribers.active,
			metrics.subscribers.new,
			metrics.subscribers.churned,
			Math.round(metrics.mrr * 100),
		);
	}
}

// Generate P&L statement
export function generateProfitLossStatement(
	startDate: Date,
	endDate: Date,
): {
	revenue: {
		subscriptions: number;
		overage: number;
		credits: number;
		total: number;
	};
	costOfRevenue: {
		platformCosts: number;
		total: number;
	};
	grossProfit: number;
	grossMargin: number;
	metrics: {
		generations: number;
		activeSubscribers: number;
		avgRevenuePerUser: number;
	};
} {
	const metrics = calculateMetrics(startDate, endDate);

	return {
		revenue: {
			subscriptions: metrics.revenue.subscription,
			overage: metrics.revenue.overage,
			credits: metrics.revenue.credits,
			total: metrics.revenue.total,
		},
		costOfRevenue: {
			platformCosts: metrics.costs.platform,
			total: metrics.costs.platform,
		},
		grossProfit: metrics.profit.gross,
		grossMargin: metrics.profit.margin,
		metrics: {
			generations: metrics.generations,
			activeSubscribers: metrics.subscribers.active,
			avgRevenuePerUser: metrics.avgRevenuePerUser,
		},
	};
}
