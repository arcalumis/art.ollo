import type { FastifyInstance, FastifyReply } from "fastify";
import { getDb } from "../db";
import { adminMiddleware } from "../middleware/auth";
import { writeAudit } from "../services/admin-audit";
import { getReconcileJob, startReconcileJob } from "../services/admin-maintenance";
import { InvalidDateError, parseDateParam, toSqlTime } from "../services/admin-time";
import {
	type PeriodType,
	calculateMetrics,
	computePeriodSnapshot,
	generateProfitLossStatement,
	getCostsByModel,
	getMetricsWithComparison,
	getRevenueByTier,
	getRevenueTrend,
	getTopCustomers,
} from "../services/financial-reports";
import { getCostSummary } from "../services/replicate-billing";
import { actorOf } from "./admin-helpers";

interface DateRangeQuery {
	startDate?: string;
	endDate?: string;
	period?: string;
}

const PERIODS = new Set(["mtd", "qtd", "ytd", "last30", "last90", "custom"]);
const PERIOD_TYPES = new Set<PeriodType>(["daily", "monthly", "quarterly", "yearly"]);

/** [start, end) for a report request. Throws InvalidDateError for bad input (answered as 400). */
export function getDateRange(query: DateRangeQuery, now: Date = new Date()): { start: Date; end: Date } {
	const end = new Date(now);
	const utc = (y: number, m: number) => new Date(Date.UTC(y, m, 1));
	const period = query.period ?? "mtd";
	if (!PERIODS.has(period)) throw new InvalidDateError("period");
	switch (period) {
		case "qtd":
			return { start: utc(now.getUTCFullYear(), Math.floor(now.getUTCMonth() / 3) * 3), end };
		case "ytd":
			return { start: utc(now.getUTCFullYear(), 0), end };
		case "last30":
			return { start: new Date(now.getTime() - 30 * 86_400_000), end };
		case "last90":
			return { start: new Date(now.getTime() - 90 * 86_400_000), end };
		case "custom": {
			const start = parseDateParam(query.startDate, "startDate");
			const customEnd = parseDateParam(query.endDate, "endDate");
			if (customEnd.getTime() <= start.getTime()) throw new InvalidDateError("endDate");
			return { start, end: customEnd };
		}
		default:
			return { start: utc(now.getUTCFullYear(), now.getUTCMonth()), end };
	}
}

function badRequest(reply: FastifyReply, err: unknown) {
	if (err instanceof InvalidDateError) {
		return reply.status(400).send({ error: err.message, code: "INVALID_DATE" });
	}
	throw err;
}

const periodOf = (start: Date, end: Date) => ({ start: start.toISOString(), end: end.toISOString() });

export async function adminFinancialsRoutes(fastify: FastifyInstance): Promise<void> {
	fastify.addHook("preHandler", adminMiddleware);

	fastify.get<{ Querystring: DateRangeQuery }>("/api/admin/financials/overview", async (request, reply) => {
		try {
			const { start, end } = getDateRange(request.query);
			const m = calculateMetrics(start, end);
			return {
				period: periodOf(start, end),
				revenue: m.revenue,
				costs: m.costs,
				profit: m.profit,
				subscribers: m.subscribers,
				mrr: m.mrr,
				arr: m.arr,
				arpu: m.avgRevenuePerUser,
				ltv: m.ltv,
				ltvNote: m.ltv === null ? "Not enough data" : null,
				generations: m.generations,
				avgCostPerGeneration: m.avgCostPerGeneration,
			};
		} catch (err) {
			return badRequest(reply, err);
		}
	});

	fastify.get<{ Params: { periodType: string } }>(
		"/api/admin/financials/comparison/:periodType",
		async (request, reply) => {
			const { periodType } = request.params;
			if (!PERIOD_TYPES.has(periodType as PeriodType)) {
				return reply.status(400).send({ error: "Invalid period type", code: "INVALID_PERIOD" });
			}
			return getMetricsWithComparison(periodType as PeriodType);
		},
	);

	fastify.get<{ Querystring: DateRangeQuery }>("/api/admin/financials/revenue/by-tier", async (request, reply) => {
		try {
			const { start, end } = getDateRange(request.query);
			return { period: periodOf(start, end), tiers: getRevenueByTier(start, end) };
		} catch (err) {
			return badRequest(reply, err);
		}
	});

	fastify.get<{ Querystring: DateRangeQuery & { limit?: string } }>(
		"/api/admin/financials/revenue/top-customers",
		async (request, reply) => {
			try {
				const { start, end } = getDateRange(request.query);
				const limit = Math.min(50, Math.max(1, Number.parseInt(request.query.limit || "10", 10) || 10));
				return { period: periodOf(start, end), customers: getTopCustomers(start, end, limit) };
			} catch (err) {
				return badRequest(reply, err);
			}
		},
	);

	fastify.get<{ Querystring: DateRangeQuery }>("/api/admin/financials/costs/by-model", async (request, reply) => {
		try {
			const { start, end } = getDateRange(request.query);
			return { period: periodOf(start, end), models: getCostsByModel(start, end) };
		} catch (err) {
			return badRequest(reply, err);
		}
	});

	fastify.get<{ Querystring: DateRangeQuery }>("/api/admin/financials/costs/summary", async (request, reply) => {
		try {
			const { start, end } = getDateRange(request.query);
			return { period: periodOf(start, end), ...getCostSummary(start, end) };
		} catch (err) {
			return badRequest(reply, err);
		}
	});

	fastify.get<{ Querystring: { type?: string; count?: string } }>("/api/admin/financials/trend", async (request, reply) => {
		const type = request.query.type || "monthly";
		if (type !== "daily" && type !== "weekly" && type !== "monthly") {
			return reply.status(400).send({ error: "Invalid trend type", code: "INVALID_PERIOD" });
		}
		const count = Math.min(365, Math.max(1, Number.parseInt(request.query.count || "12", 10) || 12));
		return { type, data: getRevenueTrend(type, count) };
	});

	fastify.get<{ Querystring: DateRangeQuery }>("/api/admin/financials/pnl", async (request, reply) => {
		try {
			const { start, end } = getDateRange(request.query);
			return { period: periodOf(start, end), ...generateProfitLossStatement(start, end) };
		} catch (err) {
			return badRequest(reply, err);
		}
	});

	fastify.get("/api/admin/financials/mrr-history", async () => {
		const history = getDb()
			.prepare(`
				SELECT period_start, mrr_cents / 100.0 AS mrr, active_subscribers, new_subscribers, churned_subscribers,
					total_revenue_cents / 100.0 AS revenue, total_platform_cost_cents / 100.0 AS costs
				FROM financial_periods
				WHERE period_type = 'monthly'
				ORDER BY period_start DESC
				LIMIT 24
			`)
			.all();
		return { history: history.reverse() };
	});

	fastify.get<{ Querystring: DateRangeQuery }>("/api/admin/financials/churn", async (request, reply) => {
		try {
			const { start, end } = getDateRange(request.query);
			const churned = getDb()
				.prepare(`
					SELECT u.id AS userId, u.username, u.email, um.first_payment_at AS firstPayment, um.churned_at AS churnedAt,
						um.total_paid_cents / 100.0 AS totalPaid, um.subscription_months AS subscriptionMonths
					FROM user_metrics um JOIN users u ON um.user_id = u.id
					WHERE datetime(um.churned_at) >= datetime(?) AND datetime(um.churned_at) < datetime(?)
					ORDER BY datetime(um.churned_at) DESC
				`)
				.all(toSqlTime(start), toSqlTime(end));
			const m = calculateMetrics(start, end);
			return {
				period: periodOf(start, end),
				churnedCount: m.subscribers.churned,
				churnRate: m.subscribers.churnRate,
				churnedUsers: churned,
			};
		} catch (err) {
			return badRequest(reply, err);
		}
	});

	// Cost reconciliation runs in the background; poll GET for its state.
	fastify.post("/api/admin/financials/reconcile-costs", async (request, reply) => {
		const { started, job } = startReconcileJob(request.user?.username ?? null);
		if (started) {
			writeAudit(actorOf(request), { action: "costs.reconcile", targetType: "system", ip: request.ip });
		}
		return reply.status(202).send({ started, job });
	});

	fastify.get("/api/admin/financials/reconcile-costs", async () => ({ job: getReconcileJob() }));

	fastify.post<{ Body: { periodType?: string } }>("/api/admin/financials/snapshot", async (request, reply) => {
		const periodType = request.body?.periodType;
		if (!periodType || !PERIOD_TYPES.has(periodType as PeriodType)) {
			return reply.status(400).send({ error: "Invalid period type", code: "INVALID_PERIOD" });
		}
		computePeriodSnapshot(periodType as PeriodType);
		writeAudit(actorOf(request), {
			action: "financials.snapshot",
			targetType: "system",
			after: { periodType },
			ip: request.ip,
		});
		return { success: true };
	});

	fastify.get("/api/admin/financials/all-time", async () => {
		const db = getDb();
		const revenue = db.prepare("SELECT COALESCE(SUM(amount_cents), 0) / 100.0 AS total FROM revenue_events").get() as {
			total: number;
		};
		const costs = db
			.prepare("SELECT COALESCE(SUM(COALESCE(actual_cost, estimated_cost)), 0) AS total FROM platform_costs")
			.get() as { total: number };
		const generations = db.prepare("SELECT COUNT(*) AS n FROM generations").get() as { n: number };
		const users = db.prepare("SELECT COUNT(*) AS n FROM users WHERE deleted_at IS NULL").get() as { n: number };
		const paying = db.prepare("SELECT COUNT(DISTINCT user_id) AS n FROM revenue_events").get() as { n: number };
		return {
			totalRevenue: revenue.total,
			totalCosts: costs.total,
			totalProfit: revenue.total - costs.total,
			totalGenerations: generations.n,
			totalUsers: users.n,
			payingCustomers: paying.n,
		};
	});
}
