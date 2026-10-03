/**
 * Read models for the admin console: overview, users, user detail, payments, model economics
 * and moderation. Everything here is read-only.
 */
import type { SQLQueryBindings } from "bun:sqlite";
import { getDb } from "../db";
import { listAudit } from "./admin-audit";
import {
	listCurrentSubscriptions,
	loadSubscriptionRecords,
	paidSnapshot,
} from "./admin-subscriptions";
import { isoOrNull, startOfUtcMonth } from "./admin-time";
import {
	SOL_REVENUE_SQL,
	calculateMetrics,
	getRevenueByTier,
	getRevenueTrend,
} from "./financial-reports";
import { CATALOG, CREDIT_MULTIPLIER, TIERS, catalogCredits, priceOfOutput } from "./model-catalog";

// ---- Overview ------------------------------------------------------------------------

export function getOverview(now: Date = new Date()) {
	const db = getDb();
	const records = loadSubscriptionRecords(db);
	const snap = paidSnapshot(now, records);
	const monthStart = startOfUtcMonth(now);
	const month = calculateMetrics(monthStart, now);

	const signups = db
		.prepare(`
			SELECT
				SUM(CASE WHEN datetime(created_at) >= datetime('now', '-7 days') THEN 1 ELSE 0 END) AS d7,
				SUM(CASE WHEN datetime(created_at) >= datetime('now', '-30 days') THEN 1 ELSE 0 END) AS d30,
				COUNT(*) AS total
			FROM users WHERE deleted_at IS NULL
		`)
		.get() as { d7: number | null; d30: number | null; total: number };

	const activation = db
		.prepare(`
			SELECT
				COUNT(*) AS users,
				SUM(CASE WHEN EXISTS (SELECT 1 FROM generations g WHERE g.user_id = u.id) THEN 1 ELSE 0 END) AS activated,
				SUM(CASE WHEN datetime(u.created_at) >= datetime('now', '-30 days') THEN 1 ELSE 0 END) AS users30,
				SUM(CASE WHEN datetime(u.created_at) >= datetime('now', '-30 days')
					AND EXISTS (SELECT 1 FROM generations g WHERE g.user_id = u.id) THEN 1 ELSE 0 END) AS activated30
			FROM users u WHERE u.deleted_at IS NULL
		`)
		.get() as {
		users: number;
		activated: number | null;
		users30: number | null;
		activated30: number | null;
	};

	const failedPayments = (
		db
			.prepare(
				"SELECT COUNT(*) AS n FROM payments WHERE status = 'failed' AND datetime(created_at) >= datetime('now', '-30 days')",
			)
			.get() as { n: number }
	).n;

	const subs = listCurrentSubscriptions(db);
	const trend = getRevenueTrend("daily", 30).map((p) => ({
		date: p.period,
		revenue: p.revenue,
		signups: p.signups,
	}));

	return {
		asOf: now.toISOString(),
		mrr: {
			cents: snap.mrrCents,
			stripeCents: snap.stripeMrrCents,
			solCents: snap.solMrrCents,
		},
		paidSubscribers: snap.paidSubscribers,
		paidByPlan: snap.byPlan,
		pastDue: subs.filter((s) => s.pastDue).length,
		stale: subs.filter((s) => s.stale).length,
		revenueThisMonth: {
			total: month.revenue.total,
			stripe: month.revenue.stripe,
			sol: month.revenue.sol,
		},
		costThisMonth: { total: month.costs.platform, backfilled: month.costs.backfilled },
		grossMargin: month.profit.margin,
		grossProfit: month.profit.gross,
		signups: { last7: signups.d7 ?? 0, last30: signups.d30 ?? 0, total: signups.total },
		activation: {
			users: activation.users,
			activated: activation.activated ?? 0,
			users30: activation.users30 ?? 0,
			activated30: activation.activated30 ?? 0,
		},
		failedPayments30d: failedPayments,
		revenueByPlan: getRevenueByTier(monthStart, now),
		ltv: month.ltv,
		trend,
	};
}

// ---- Users ---------------------------------------------------------------------------

export function listUsers(opts: {
	search?: string;
	page?: number;
	limit?: number;
	filter?: string;
}) {
	const db = getDb();
	const search = (opts.search ?? "").trim().slice(0, 100);
	const limit = Math.min(100, Math.max(1, opts.limit ?? 25));
	const page = Math.max(1, opts.page ?? 1);
	const where: string[] = [];
	const params: SQLQueryBindings[] = [];
	if (search) {
		where.push("(u.username LIKE ? OR u.email LIKE ? OR u.wallet_address LIKE ? OR u.id = ?)");
		const like = `%${search}%`;
		params.push(like, like, like, search);
	}
	if (opts.filter === "admins") where.push("u.is_admin = 1");
	if (opts.filter === "inactive") where.push("(u.is_active = 0 OR u.deleted_at IS NOT NULL)");
	const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
	const total = (
		db.prepare(`SELECT COUNT(*) AS n FROM users u ${whereSql}`).get(...params) as { n: number }
	).n;
	const rows = db
		.prepare(`
			SELECT u.id, u.username, u.email, u.wallet_address, u.is_admin, u.is_active, u.deleted_at,
				u.created_at, u.last_login,
				(SELECT COALESCE(SUM(amount), 0) FROM user_credits c WHERE c.user_id = u.id) AS balance,
				(SELECT COUNT(*) FROM generations g WHERE g.user_id = u.id) AS generations,
				(SELECT MAX(created_at) FROM generations g WHERE g.user_id = u.id) AS last_generation
			FROM users u ${whereSql}
			ORDER BY datetime(u.created_at) DESC
			LIMIT ? OFFSET ?
		`)
		.all(...params, limit, (page - 1) * limit) as Array<{
		id: string;
		username: string;
		email: string | null;
		wallet_address: string | null;
		is_admin: number;
		is_active: number | null;
		deleted_at: string | null;
		created_at: string;
		last_login: string | null;
		balance: number;
		generations: number;
		last_generation: string | null;
	}>;
	const plans = new Map(listCurrentSubscriptions(db).map((s) => [s.userId, s]));
	return {
		total,
		page,
		limit,
		totalPages: Math.max(1, Math.ceil(total / limit)),
		users: rows.map((r) => {
			const plan = plans.get(r.id);
			return {
				id: r.id,
				username: r.username,
				email: r.email,
				hasWallet: !!r.wallet_address,
				isAdmin: r.is_admin === 1,
				isActive: r.is_active !== 0 && !r.deleted_at,
				deleted: !!r.deleted_at,
				createdAt: isoOrNull(r.created_at),
				lastLogin: isoOrNull(r.last_login),
				lastGeneration: isoOrNull(r.last_generation),
				balance: r.balance,
				generations: r.generations,
				plan: plan?.plan ?? "Free",
				planSource: plan?.source ?? "free",
				pastDue: plan?.pastDue ?? false,
			};
		}),
	};
}

export function imageUrl(imagePath: string | null): string | null {
	if (!imagePath) return null;
	if (imagePath.startsWith("/") || imagePath.startsWith("http")) return imagePath;
	return `/images/${imagePath}`;
}

export function getUserDetail(userId: string) {
	const db = getDb();
	const u = db
		.prepare(`
			SELECT id, username, email, wallet_address, is_admin, is_active, deleted_at, created_at, last_login,
				token_version, tutorial_completed_at
			FROM users WHERE id = ?
		`)
		.get(userId) as
		| {
				id: string;
				username: string;
				email: string | null;
				wallet_address: string | null;
				is_admin: number;
				is_active: number | null;
				deleted_at: string | null;
				created_at: string;
				last_login: string | null;
				token_version: number | null;
		  }
		| undefined;
	if (!u) return null;

	const ledger = db
		.prepare(
			"SELECT id, credit_type, amount, reason, created_at FROM user_credits WHERE user_id = ? ORDER BY datetime(created_at) DESC, rowid DESC",
		)
		.all(userId) as Array<{
		id: string;
		credit_type: string;
		amount: number;
		reason: string | null;
		created_at: string;
	}>;
	const balance = ledger.reduce((s, r) => s + r.amount, 0);

	const generations = db
		.prepare(`
			SELECT g.id, g.prompt, g.model, g.image_path, g.width, g.height, g.created_at, g.deleted_at, g.purged_at,
				g.moderated_at, g.moderation_reason,
				COALESCE(pc.actual_cost, pc.estimated_cost, g.cost) AS cost
			FROM generations g LEFT JOIN platform_costs pc ON pc.generation_id = g.id
			WHERE g.user_id = ?
			ORDER BY datetime(g.created_at) DESC
			LIMIT 60
		`)
		.all(userId) as Array<{
		id: string;
		prompt: string;
		model: string;
		image_path: string | null;
		width: number | null;
		height: number | null;
		created_at: string;
		deleted_at: string | null;
		purged_at: string | null;
		moderated_at: string | null;
		moderation_reason: string | null;
		cost: number | null;
	}>;
	const genStats = db
		.prepare(`
			SELECT COUNT(*) AS n, COALESCE(SUM(COALESCE(pc.actual_cost, pc.estimated_cost, g.cost)), 0) AS cost
			FROM generations g LEFT JOIN platform_costs pc ON pc.generation_id = g.id WHERE g.user_id = ?
		`)
		.get(userId) as { n: number; cost: number };

	const subs = loadSubscriptionRecords(db)
		.filter((r) => r.userId === userId)
		.reverse();
	const current = listCurrentSubscriptions(db).find((s) => s.userId === userId) ?? null;
	const boosts = db
		.prepare(`
			SELECT sb.id, sp.name AS plan, sb.status, sb.starts_at, sb.ends_at, sb.reason, gu.username AS granted_by, sb.created_at
			FROM subscription_boosts sb
			JOIN subscription_products sp ON sp.id = sb.boost_product_id
			LEFT JOIN users gu ON gu.id = sb.granted_by_user_id
			WHERE sb.user_id = ?
			ORDER BY datetime(sb.created_at) DESC
		`)
		.all(userId) as Array<{
		id: string;
		plan: string;
		status: string;
		starts_at: string;
		ends_at: string;
		reason: string | null;
		granted_by: string | null;
		created_at: string;
	}>;
	const shares = db
		.prepare(`
			SELECT s.slug, s.generation_id, s.created_at, s.revoked_at, g.image_path
			FROM share_links s LEFT JOIN generations g ON g.id = s.generation_id
			WHERE s.user_id = ? ORDER BY datetime(s.created_at) DESC
		`)
		.all(userId) as Array<{
		slug: string;
		generation_id: string;
		created_at: string;
		revoked_at: string | null;
		image_path: string | null;
	}>;
	const stripeCustomer = db
		.prepare("SELECT stripe_customer_id FROM stripe_customers WHERE user_id = ? LIMIT 1")
		.get(userId) as { stripe_customer_id: string } | undefined;
	const totalPaid = db
		.prepare("SELECT COALESCE(SUM(amount_cents), 0) AS cents FROM revenue_events WHERE user_id = ?")
		.get(userId) as { cents: number };

	return {
		id: u.id,
		username: u.username,
		email: u.email,
		walletAddress: u.wallet_address,
		isAdmin: u.is_admin === 1,
		isActive: u.is_active !== 0,
		deletedAt: isoOrNull(u.deleted_at),
		createdAt: isoOrNull(u.created_at),
		lastLogin: isoOrNull(u.last_login),
		sessionVersion: u.token_version ?? 0,
		stripeCustomerId: stripeCustomer?.stripe_customer_id ?? null,
		balance,
		totalPaidCents: totalPaid.cents,
		generationCount: genStats.n,
		generationCost: genStats.cost,
		current,
		ledger: ledger.map((r) => ({
			id: r.id,
			type: r.credit_type,
			amount: r.amount,
			reason: r.reason,
			createdAt: isoOrNull(r.created_at),
		})),
		generations: generations.map((g) => ({
			id: g.id,
			prompt: g.prompt,
			model: g.model,
			imageUrl: g.purged_at ? null : imageUrl(g.image_path),
			width: g.width,
			height: g.height,
			createdAt: isoOrNull(g.created_at),
			deleted: !!g.deleted_at,
			moderated: !!g.moderated_at,
			moderationReason: g.moderation_reason,
			cost: g.cost ?? 0,
		})),
		payments: listPayments({ userId, limit: 200 }).payments,
		subscriptions: subs,
		boosts: boosts.map((b) => ({
			id: b.id,
			plan: b.plan,
			status: b.status,
			startsAt: isoOrNull(b.starts_at),
			endsAt: isoOrNull(b.ends_at),
			reason: b.reason,
			grantedBy: b.granted_by,
			createdAt: isoOrNull(b.created_at),
		})),
		shareLinks: shares.map((s) => ({
			slug: s.slug,
			generationId: s.generation_id,
			imageUrl: imageUrl(s.image_path),
			createdAt: isoOrNull(s.created_at),
			revokedAt: isoOrNull(s.revoked_at),
		})),
		audit: listAudit({ targetType: "user", targetId: userId, limit: 50 }).entries,
	};
}

// ---- Payments ------------------------------------------------------------------------

export interface PaymentItem {
	id: string;
	userId: string;
	username: string | null;
	method: "card" | "sol";
	kind: string;
	amountCents: number | null;
	amountSol: number | null;
	currency: string;
	status: string;
	description: string | null;
	stripePaymentIntentId: string | null;
	stripeInvoiceId: string | null;
	signature: string | null;
	createdAt: string | null;
}

/** Stripe payments, Stripe revenue events without a payment row, and SOL transactions, newest first. */
export function listPayments(opts: {
	userId?: string;
	method?: string;
	status?: string;
	limit?: number;
	page?: number;
}) {
	const db = getDb();
	const limit = Math.min(500, Math.max(1, opts.limit ?? 50));
	const page = Math.max(1, opts.page ?? 1);
	const userWhere = opts.userId ? "AND x.user_id = ?" : "";
	const p = opts.userId ? [opts.userId] : [];

	const card = db
		.prepare(`
			SELECT x.id, x.user_id, u.username, x.amount_cents, x.currency, x.status, x.payment_type, x.description,
				x.stripe_payment_intent_id, x.stripe_invoice_id, x.created_at
			FROM payments x LEFT JOIN users u ON u.id = x.user_id
			WHERE 1 = 1 ${userWhere}
		`)
		.all(...p) as Array<{
		id: string;
		user_id: string;
		username: string | null;
		amount_cents: number;
		currency: string | null;
		status: string;
		payment_type: string;
		description: string | null;
		stripe_payment_intent_id: string | null;
		stripe_invoice_id: string | null;
		created_at: string;
	}>;
	const orphanRevenue = db
		.prepare(`
			SELECT x.id, x.user_id, u.username, x.amount_cents, x.event_type, x.description, x.created_at
			FROM revenue_events x LEFT JOIN users u ON u.id = x.user_id
			WHERE x.payment_id IS NULL AND NOT ${SOL_REVENUE_SQL.replaceAll("event_type", "x.event_type").replaceAll("description", "x.description")}
			${userWhere}
		`)
		.all(...p) as Array<{
		id: string;
		user_id: string;
		username: string | null;
		amount_cents: number;
		event_type: string;
		description: string | null;
		created_at: string;
	}>;
	const sol = db
		.prepare(`
			SELECT x.id, x.user_id, u.username, x.amount_sol, x.status, x.transaction_signature, x.created_at,
				'credits' AS kind, x.credits_purchased AS credits, NULL AS plan
			FROM solana_transactions x LEFT JOIN users u ON u.id = x.user_id WHERE 1 = 1 ${userWhere}
			UNION ALL
			SELECT x.id, x.user_id, u.username, x.amount_sol, x.status, x.transaction_signature, x.created_at,
				'subscription', NULL, sp.name
			FROM solana_subscription_transactions x LEFT JOIN users u ON u.id = x.user_id
			LEFT JOIN subscription_products sp ON sp.id = x.product_id WHERE 1 = 1 ${userWhere}
		`)
		.all(...p, ...p) as Array<{
		id: string;
		user_id: string;
		username: string | null;
		amount_sol: number;
		status: string;
		transaction_signature: string;
		created_at: string;
		kind: string;
		credits: number | null;
		plan: string | null;
	}>;

	// SOL USD value: the revenue event booked at verification (same user, within 10 minutes).
	const solRevenue = db
		.prepare(
			`SELECT user_id, amount_cents, created_at FROM revenue_events WHERE ${SOL_REVENUE_SQL}`,
		)
		.all() as Array<{ user_id: string; amount_cents: number; created_at: string }>;
	const solUsd = (userId: string, at: string, status: string): number | null => {
		if (status !== "completed") return null;
		const t = Date.parse(isoOrNull(at) ?? "");
		let best: { d: number; cents: number } | null = null;
		for (const r of solRevenue) {
			if (r.user_id !== userId) continue;
			const d = Math.abs(Date.parse(isoOrNull(r.created_at) ?? "") - t);
			if (d <= 10 * 60_000 && (!best || d < best.d)) best = { d, cents: r.amount_cents };
		}
		return best?.cents ?? null;
	};

	let items: PaymentItem[] = [
		...card.map((r) => ({
			id: r.id,
			userId: r.user_id,
			username: r.username,
			method: "card" as const,
			kind: r.payment_type,
			amountCents: r.amount_cents,
			amountSol: null,
			currency: r.currency ?? "usd",
			status: r.status,
			description: r.description,
			stripePaymentIntentId: r.stripe_payment_intent_id,
			stripeInvoiceId: r.stripe_invoice_id,
			signature: null,
			createdAt: isoOrNull(r.created_at),
		})),
		...orphanRevenue.map((r) => ({
			id: r.id,
			userId: r.user_id,
			username: r.username,
			method: "card" as const,
			kind: r.event_type,
			amountCents: r.amount_cents,
			amountSol: null,
			currency: "usd",
			status: "succeeded",
			description: r.description,
			stripePaymentIntentId: null,
			stripeInvoiceId: null,
			signature: null,
			createdAt: isoOrNull(r.created_at),
		})),
		...sol.map((r) => ({
			id: r.id,
			userId: r.user_id,
			username: r.username,
			method: "sol" as const,
			kind: r.kind === "subscription" ? "sol_subscription" : "sol_credits",
			amountCents: solUsd(r.user_id, r.created_at, r.status),
			amountSol: r.amount_sol,
			currency: "sol",
			status: r.status,
			description:
				r.kind === "subscription" ? `${r.plan ?? "Plan"} (SOL)` : `${r.credits ?? 0} credits (SOL)`,
			stripePaymentIntentId: null,
			stripeInvoiceId: null,
			signature: r.transaction_signature?.startsWith("pending_") ? null : r.transaction_signature,
			createdAt: isoOrNull(r.created_at),
		})),
	];
	if (opts.method === "card" || opts.method === "sol")
		items = items.filter((i) => i.method === opts.method);
	if (opts.status) items = items.filter((i) => i.status === opts.status);
	items.sort((a, b) => Date.parse(b.createdAt ?? "") - Date.parse(a.createdAt ?? ""));
	return {
		total: items.length,
		page,
		limit,
		payments: items.slice((page - 1) * limit, page * limit),
	};
}

// ---- Model economics -------------------------------------------------------------------

function percentile(sorted: number[], p: number): number | null {
	if (sorted.length === 0) return null;
	const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
	return sorted[idx];
}

/** Value of one credit in cents: the cheapest active USD credit pack (conservative), else cost basis. */
export function valuePerCredit(): { cents: number; source: string } {
	const row = getDb()
		.prepare(`
			SELECT name, price_cents * 1.0 / credits AS per FROM solana_credit_packages
			WHERE is_active = 1 AND available_for_usd = 1 AND price_cents > 0 AND credits > 0
			ORDER BY per ASC LIMIT 1
		`)
		.get() as { name: string; per: number } | undefined;
	if (row) return { cents: row.per, source: `Cheapest credit pack (${row.name})` };
	return { cents: 100 / CREDIT_MULTIPLIER, source: "Cost basis (no USD credit packs)" };
}

export function getModelEconomics(days: number) {
	const db = getDb();
	const sinceSql = days > 0 ? "AND datetime(g.created_at) >= datetime('now', ?)" : "";
	const sinceLedger = days > 0 ? "AND datetime(created_at) >= datetime('now', ?)" : "";
	const sinceParam = days > 0 ? [`-${days} days`] : [];

	const gens = db
		.prepare(`
			SELECT g.model, g.predict_time, COALESCE(pc.actual_cost, pc.estimated_cost, g.cost, 0) AS cost,
				pc.source AS cost_source,
				CASE WHEN json_valid(g.parameters) THEN json_extract(g.parameters, '$.queueWaitMs') END AS queue_wait_ms
			FROM generations g LEFT JOIN platform_costs pc ON pc.generation_id = g.id
			WHERE 1 = 1 ${sinceSql}
		`)
		.all(...sinceParam) as Array<{
		model: string;
		predict_time: number | null;
		cost: number;
		cost_source: string | null;
		queue_wait_ms: number | null;
	}>;

	const used = db
		.prepare(`
			SELECT id, amount, reason FROM user_credits
			WHERE credit_type = 'used' AND (reason LIKE 'Generation: %' OR reason LIKE 'Tool: %') ${sinceLedger}
		`)
		.all(...sinceParam) as Array<{ id: string; amount: number; reason: string }>;
	const refunds = db
		.prepare(`
			SELECT amount, reason FROM user_credits
			WHERE credit_type = 'refund' AND reason LIKE '%(reservation %)' ${sinceLedger}
		`)
		.all(...sinceParam) as Array<{ amount: number; reason: string }>;

	const modelOfReason = (reason: string): string | null => {
		const gen = reason.match(/^Generation: (\S+)/);
		if (gen) return gen[1];
		const tool = reason.match(/^Tool: .*\(([^)]+)\)/);
		return tool ? tool[1] : null;
	};
	const reservationModel = new Map<string, string>();
	const stats = new Map<
		string,
		{
			runs: number;
			failures: number;
			credits: number;
			cost: number;
			estimatedCost: number;
			latencies: number[];
			queueWaits: number[];
		}
	>();
	const get = (model: string) => {
		let s = stats.get(model);
		if (!s) {
			s = {
				runs: 0,
				failures: 0,
				credits: 0,
				cost: 0,
				estimatedCost: 0,
				latencies: [],
				queueWaits: [],
			};
			stats.set(model, s);
		}
		return s;
	};
	for (const g of gens) {
		const s = get(g.model);
		s.runs++;
		s.cost += g.cost;
		if (g.cost_source) s.estimatedCost += g.cost;
		if (g.predict_time && g.predict_time > 0) s.latencies.push(g.predict_time);
		if (typeof g.queue_wait_ms === "number" && g.queue_wait_ms >= 0) {
			s.queueWaits.push(g.queue_wait_ms / 1000);
		}
	}
	for (const u of used) {
		const model = modelOfReason(u.reason);
		if (!model) continue;
		reservationModel.set(u.id, model);
		get(model).credits += -u.amount;
	}
	for (const r of refunds) {
		const id = r.reason.match(/\(reservation ([^)]+)\)$/)?.[1];
		const model = id ? reservationModel.get(id) : undefined;
		if (!model) continue;
		const s = get(model);
		s.credits -= r.amount;
		if (/^(Generation failed|Generation returned no images|Tool .* failed)/.test(r.reason)) {
			s.failures++;
		}
	}

	const overrides = new Map(
		(
			db.prepare("SELECT model_id, credit_cost FROM model_credit_costs").all() as Array<{
				model_id: string;
				credit_cost: number;
			}>
		).map((r) => [r.model_id, r.credit_cost]),
	);
	const vpc = valuePerCredit();
	const catalogIds = new Set(CATALOG.map((m) => m.id));
	const ids = [
		...CATALOG.map((m) => m.id),
		...[...stats.keys()].filter((id) => !catalogIds.has(id)),
	];

	const models = ids
		.map((id) => {
			const m = CATALOG.find((c) => c.id === id);
			const s = stats.get(id) ?? {
				runs: 0,
				failures: 0,
				credits: 0,
				cost: 0,
				estimatedCost: 0,
				latencies: [],
				queueWaits: [],
			};
			const lat = [...s.latencies].sort((a, b) => a - b);
			const waits = [...s.queueWaits].sort((a, b) => a - b);
			const attempts = s.runs + s.failures;
			const revenueCents = s.credits * vpc.cents;
			return {
				id,
				name: m?.name ?? id.split("/").pop() ?? id,
				kind: m?.kind ?? "image",
				hidden: m?.hidden ?? false,
				runs: s.runs,
				failures: s.failures,
				failureRate: attempts > 0 ? (s.failures / attempts) * 100 : null,
				p50Seconds: percentile(lat, 50),
				p95Seconds: percentile(lat, 95),
				/** GPU queue wait of the winning prediction (recorded since GPU-wait tracking shipped). */
				queueWaitP50Seconds: percentile(waits, 50),
				queueWaitP95Seconds: percentile(waits, 95),
				costUsd: s.cost,
				estimatedCostUsd: s.estimatedCost,
				creditsCharged: s.credits,
				creditValueUsd: revenueCents / 100,
				marginUsd: revenueCents / 100 - s.cost,
				plainOverride: overrides.get(id) ?? null,
				tiers: m
					? TIERS.filter((t) => m.tiers[t]).map((t) => ({
							tier: t,
							officialCostUsd: priceOfOutput(m, t),
							formulaCredits: catalogCredits(m, t, 0),
							override: overrides.get(`${id}:${t}`) ?? null,
						}))
					: [],
			};
		})
		.filter((m) => !m.hidden || m.runs > 0 || m.plainOverride !== null);

	return { days, valuePerCredit: vpc, models };
}

// ---- Moderation --------------------------------------------------------------------------

export function getRecentImages(opts: {
	page?: number;
	limit?: number;
	userId?: string;
	includeRemoved?: boolean;
}) {
	const db = getDb();
	const limit = Math.min(120, Math.max(1, opts.limit ?? 48));
	const page = Math.max(1, opts.page ?? 1);
	const where = ["g.purged_at IS NULL"];
	const params: SQLQueryBindings[] = [];
	if (!opts.includeRemoved) where.push("g.deleted_at IS NULL");
	if (opts.userId) {
		where.push("g.user_id = ?");
		params.push(opts.userId);
	}
	const whereSql = `WHERE ${where.join(" AND ")}`;
	const total = (
		db.prepare(`SELECT COUNT(*) AS n FROM generations g ${whereSql}`).get(...params) as {
			n: number;
		}
	).n;
	const rows = db
		.prepare(`
			SELECT g.id, g.prompt, g.model, g.image_path, g.width, g.height, g.created_at, g.user_id, u.username,
				g.deleted_at, g.moderated_at, g.moderation_reason
			FROM generations g LEFT JOIN users u ON u.id = g.user_id
			${whereSql}
			ORDER BY datetime(g.created_at) DESC
			LIMIT ? OFFSET ?
		`)
		.all(...params, limit, (page - 1) * limit) as Array<{
		id: string;
		prompt: string;
		model: string;
		image_path: string | null;
		width: number | null;
		height: number | null;
		created_at: string;
		user_id: string | null;
		username: string | null;
		deleted_at: string | null;
		moderated_at: string | null;
		moderation_reason: string | null;
	}>;
	const top = db
		.prepare(`
			SELECT g.user_id AS userId, u.username, COUNT(*) AS images,
				SUM(CASE WHEN datetime(g.created_at) >= datetime('now', '-7 days') THEN 1 ELSE 0 END) AS last7
			FROM generations g LEFT JOIN users u ON u.id = g.user_id
			WHERE datetime(g.created_at) >= datetime('now', '-30 days')
			GROUP BY g.user_id
			ORDER BY images DESC
			LIMIT 10
		`)
		.all() as Array<{ userId: string; username: string | null; images: number; last7: number }>;
	return {
		total,
		page,
		limit,
		images: rows.map((r) => ({
			id: r.id,
			prompt: r.prompt,
			model: r.model,
			imageUrl: imageUrl(r.image_path),
			width: r.width,
			height: r.height,
			createdAt: isoOrNull(r.created_at),
			userId: r.user_id,
			username: r.username,
			removed: !!r.deleted_at,
			moderated: !!r.moderated_at,
			moderationReason: r.moderation_reason,
		})),
		topUsers: top,
	};
}

export { percentile };
