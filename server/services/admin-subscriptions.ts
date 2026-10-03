/**
 * Subscriptions as the admin sees them: where each plan came from, whether it is paid, and
 * what it contributes to MRR.
 *
 * Paid means money changed hands for the current period:
 *   - a Stripe subscription (stripe_subscription_id) in 'active' or 'trialing', priced at its
 *     product's monthly price; or
 *   - a SOL subscription (a completed solana_subscription_transactions row) whose ends_at is in
 *     the future, valued at what the user paid normalized to a 30.44-day month.
 * Free, admin-assigned (comped) plans and boosts are never paid, even on a priced product.
 */
import type { Database } from "bun:sqlite";
import { getDb } from "../db";
import { DAYS_PER_MONTH, DAY_MS, dbTimeMs, isoOrNull } from "./admin-time";
import { assignSubscription } from "./usage";

export type SubscriptionSource = "stripe" | "sol" | "admin" | "free" | "boost";

interface RawSubscriptionRow {
	id: string;
	user_id: string;
	product_id: string;
	product_name: string;
	product_price: number | null;
	status: string | null;
	starts_at: string | null;
	ends_at: string | null;
	current_period_end: string | null;
	stripe_subscription_id: string | null;
	created_at: string | null;
	sol_amount_sol: number | null;
	sol_paid_at: string | null;
}

export interface SubscriptionRecord {
	id: string;
	userId: string;
	productId: string;
	plan: string;
	source: Exclude<SubscriptionSource, "boost">;
	status: string;
	startsAt: string | null;
	endsAt: string | null;
	currentPeriodEnd: string | null;
	stripeSubscriptionId: string | null;
	createdAt: string | null;
	/** Price of one month of this row when it is paid, in cents (0 for free/admin). */
	monthlyValueCents: number;
}

const ENTITLED = new Set(["active", "trialing"]);
/** Stripe states after which a subscription no longer bills. */
const STRIPE_ENDED = new Set([
	"canceled",
	"incomplete",
	"incomplete_expired",
	"unpaid",
	"superseded",
	"expired",
]);

function latestSolPriceUsd(db: Database): number | null {
	const row = db
		.prepare("SELECT price_usd FROM sol_price_snapshots ORDER BY captured_at DESC LIMIT 1")
		.get() as { price_usd: number } | undefined;
	return row?.price_usd ?? null;
}

/**
 * Every user_subscriptions row with its source and monthly value. The SOL amount comes from the
 * revenue event booked at verification (same user, within 10 minutes of the row), falling back
 * to amount_sol x the latest SOL price.
 */
export function loadSubscriptionRecords(db: Database = getDb()): SubscriptionRecord[] {
	const rows = db
		.prepare(`
			SELECT us.id, us.user_id, us.product_id, sp.name AS product_name, sp.price AS product_price,
				us.status, us.starts_at, us.ends_at, us.current_period_end, us.stripe_subscription_id, us.created_at,
				st.amount_sol AS sol_amount_sol, COALESCE(st.verified_at, us.created_at) AS sol_paid_at
			FROM user_subscriptions us
			JOIN subscription_products sp ON sp.id = us.product_id
			LEFT JOIN solana_subscription_transactions st ON st.subscription_id = us.id AND st.status = 'completed'
			ORDER BY us.created_at ASC
		`)
		.all() as RawSubscriptionRow[];

	const solPrice = latestSolPriceUsd(db);
	const solEvents = db
		.prepare(
			"SELECT user_id, amount_cents, created_at FROM revenue_events WHERE event_type = 'sol_subscription'",
		)
		.all() as Array<{ user_id: string; amount_cents: number; created_at: string }>;
	/** The SOL revenue event booked for this payment: same user, nearest within 10 minutes. */
	const solRevenueCents = (userId: string, paidAt: string | null): number | null => {
		const t = dbTimeMs(paidAt);
		if (t === null) return null;
		let best: { d: number; cents: number } | null = null;
		for (const e of solEvents) {
			if (e.user_id !== userId) continue;
			const et = dbTimeMs(e.created_at);
			if (et === null) continue;
			const d = Math.abs(et - t);
			if (d <= 10 * 60_000 && (!best || d < best.d)) best = { d, cents: e.amount_cents };
		}
		return best?.cents ?? null;
	};
	return rows.map((r) => {
		let source: SubscriptionRecord["source"];
		if (r.stripe_subscription_id) source = "stripe";
		else if (r.sol_amount_sol !== null) source = "sol";
		else if (r.product_name === "Free") source = "free";
		else source = "admin";

		let monthlyValueCents = 0;
		if (source === "stripe") {
			monthlyValueCents = Math.round((r.product_price ?? 0) * 100);
		} else if (source === "sol") {
			const paidCents =
				solRevenueCents(r.user_id, r.sol_paid_at) ??
				(solPrice !== null && r.sol_amount_sol !== null
					? Math.round(r.sol_amount_sol * solPrice * 100)
					: 0);
			// The paid period: current_period_end is the 30-day end even if the row was later
			// superseded early (which shortens ends_at but not what the user paid for).
			const start = dbTimeMs(r.starts_at);
			const end = dbTimeMs(r.current_period_end) ?? dbTimeMs(r.ends_at);
			const days = start !== null && end !== null && end > start ? (end - start) / DAY_MS : 30;
			monthlyValueCents = Math.round(paidCents * (DAYS_PER_MONTH / Math.max(1, days)));
		}

		return {
			id: r.id,
			userId: r.user_id,
			productId: r.product_id,
			plan: r.product_name,
			source,
			status: r.status ?? "active",
			startsAt: isoOrNull(r.starts_at),
			endsAt: isoOrNull(r.ends_at),
			currentPeriodEnd: isoOrNull(r.current_period_end),
			stripeSubscriptionId: r.stripe_subscription_id,
			createdAt: isoOrNull(r.created_at),
			monthlyValueCents,
		};
	});
}

/**
 * Is this row a paid subscription at `at`? With `live` (now), the row's status must be
 * active/trialing; for a past instant the status may have moved on since, so the time window
 * decides (Stripe rows that ended without an ends_at are excluded).
 */
export function isPaidAt(rec: SubscriptionRecord, at: number, live: boolean): boolean {
	if (rec.source !== "stripe" && rec.source !== "sol") return false;
	const start = Date.parse(rec.startsAt ?? rec.createdAt ?? "");
	if (Number.isNaN(start) || start > at) return false;
	const end = rec.endsAt ? Date.parse(rec.endsAt) : null;
	if (end !== null && end <= at) return false;
	if (rec.source === "sol" && end === null) return false;
	if (live) return ENTITLED.has(rec.status);
	if (rec.source === "stripe" && end === null && STRIPE_ENDED.has(rec.status)) return false;
	return true;
}

export interface PaidSnapshot {
	at: string;
	mrrCents: number;
	paidSubscribers: number;
	stripeMrrCents: number;
	solMrrCents: number;
	byPlan: Array<{ plan: string; subscribers: number; mrrCents: number }>;
}

/** Paid subscribers and MRR at an instant (defaults to now, which also checks status). */
export function paidSnapshot(
	at: Date = new Date(),
	records = loadSubscriptionRecords(),
): PaidSnapshot {
	const t = at.getTime();
	const live = Math.abs(Date.now() - t) < 60_000 || t > Date.now();
	// One paid row per user (the newest wins if history overlaps).
	const byUser = new Map<string, SubscriptionRecord>();
	for (const rec of records) {
		if (isPaidAt(rec, t, live)) byUser.set(rec.userId, rec);
	}
	let mrr = 0;
	let stripe = 0;
	let sol = 0;
	const plans = new Map<string, { plan: string; subscribers: number; mrrCents: number }>();
	for (const rec of byUser.values()) {
		mrr += rec.monthlyValueCents;
		if (rec.source === "stripe") stripe += rec.monthlyValueCents;
		else sol += rec.monthlyValueCents;
		const p = plans.get(rec.plan) ?? { plan: rec.plan, subscribers: 0, mrrCents: 0 };
		p.subscribers++;
		p.mrrCents += rec.monthlyValueCents;
		plans.set(rec.plan, p);
	}
	return {
		at: at.toISOString(),
		mrrCents: mrr,
		paidSubscribers: byUser.size,
		stripeMrrCents: stripe,
		solMrrCents: sol,
		byPlan: Array.from(plans.values()).sort(
			(a, b) => b.mrrCents - a.mrrCents || b.subscribers - a.subscribers,
		),
	};
}

// ---- The subscriptions table ------------------------------------------------------

export interface SubscriptionListItem {
	userId: string;
	username: string;
	email: string | null;
	subscriptionId: string | null;
	plan: string;
	productId: string | null;
	source: SubscriptionSource;
	status: string;
	startedAt: string | null;
	/** Next renewal (Stripe current_period_end) for renewing plans. */
	renewsAt: string | null;
	/** Fixed end (SOL period, boost end, canceled plans). */
	endsAt: string | null;
	pastDue: boolean;
	/** Stripe row whose period ended days ago without an update: webhooks may be missing. */
	stale: boolean;
	mrrCents: number;
	stripeSubscriptionId: string | null;
	/** The plan underneath an active boost. */
	basePlan: string | null;
}

interface UserLite {
	id: string;
	username: string;
	email: string | null;
	deleted_at: string | null;
}

interface ActiveBoostRow {
	user_id: string;
	ends_at: string;
	product_name: string;
	boost_product_id: string;
}

/** Every user's current plan (the newest non-superseded row; no row = Free) plus any active boost. */
export function listCurrentSubscriptions(db: Database = getDb()): SubscriptionListItem[] {
	const now = Date.now();
	const records = loadSubscriptionRecords(db);
	const current = new Map<string, SubscriptionRecord>();
	for (const rec of records) {
		if (rec.status === "superseded") continue;
		current.set(rec.userId, rec); // ordered by created_at ASC: last one wins
	}
	const users = db
		.prepare("SELECT id, username, email, deleted_at FROM users ORDER BY created_at DESC")
		.all() as UserLite[];
	const boosts = db
		.prepare(`
			SELECT sb.user_id, sb.ends_at, sb.boost_product_id, sp.name AS product_name
			FROM subscription_boosts sb JOIN subscription_products sp ON sp.id = sb.boost_product_id
			WHERE sb.status = 'active' AND datetime(sb.ends_at) > datetime('now')
			ORDER BY sb.created_at ASC
		`)
		.all() as ActiveBoostRow[];
	const boostByUser = new Map(boosts.map((b) => [b.user_id, b]));

	return users.map((u) => {
		const rec = current.get(u.id);
		const boost = boostByUser.get(u.id);
		const paid = rec ? isPaidAt(rec, now, true) : false;
		const expiredByTime = rec?.endsAt ? Date.parse(rec.endsAt) <= now : false;
		const status = !rec
			? "active"
			: expiredByTime && ENTITLED.has(rec.status)
				? "expired"
				: rec.status;
		const periodEnd = rec?.currentPeriodEnd ? Date.parse(rec.currentPeriodEnd) : null;
		const stale =
			rec?.source === "stripe" &&
			ENTITLED.has(rec.status) &&
			periodEnd !== null &&
			periodEnd < now - 3 * DAY_MS;
		const base: SubscriptionListItem = {
			userId: u.id,
			username: u.username,
			email: u.email,
			subscriptionId: rec?.id ?? null,
			plan: rec?.plan ?? "Free",
			productId: rec?.productId ?? null,
			source: rec?.source ?? "free",
			status,
			startedAt: rec?.startsAt ?? null,
			renewsAt: rec?.source === "stripe" && ENTITLED.has(rec.status) ? rec.currentPeriodEnd : null,
			endsAt: rec?.endsAt ?? null,
			pastDue: rec?.status === "past_due",
			stale,
			mrrCents: paid && rec ? rec.monthlyValueCents : 0,
			stripeSubscriptionId: rec?.stripeSubscriptionId ?? null,
			basePlan: null,
		};
		if (boost) {
			return {
				...base,
				plan: boost.product_name,
				productId: boost.boost_product_id,
				source: "boost" as const,
				endsAt: isoOrNull(boost.ends_at),
				basePlan: base.plan,
			};
		}
		return base;
	});
}

// ---- Expiry -----------------------------------------------------------------------

/**
 * SOL (and any other non-Stripe, time-limited) subscriptions past ends_at are marked
 * 'expired' and the user moves to Free (no welcome bonus). Stripe rows are left to Stripe's
 * webhooks. Returns the number of rows expired.
 */
export function expireEndedSubscriptions(db: Database = getDb()): number {
	const rows = db
		.prepare(`
			SELECT id, user_id FROM user_subscriptions
			WHERE status IN ('active', 'trialing')
			AND stripe_subscription_id IS NULL
			AND ends_at IS NOT NULL
			AND datetime(ends_at) <= datetime('now')
		`)
		.all() as Array<{ id: string; user_id: string }>;
	if (rows.length === 0) return 0;

	const free = db
		.prepare(
			"SELECT id FROM subscription_products WHERE name = 'Free' AND is_active = 1 ORDER BY created_at ASC LIMIT 1",
		)
		.get() as { id: string } | undefined;

	let expired = 0;
	for (const row of rows) {
		db.transaction(() => {
			const res = db
				.prepare(
					"UPDATE user_subscriptions SET status = 'expired' WHERE id = ? AND status IN ('active', 'trialing')",
				)
				.run(row.id);
			if (res.changes !== 1) return;
			expired++;
			const stillActive = db
				.prepare(
					"SELECT 1 FROM user_subscriptions WHERE user_id = ? AND status IN ('active', 'trialing')",
				)
				.get(row.user_id);
			if (!stillActive && free) {
				assignSubscription(row.user_id, free.id, { grantBonus: false });
			}
		})();
	}
	if (expired > 0)
		console.log(`[subscriptions] Expired ${expired} ended non-Stripe subscription(s)`);
	return expired;
}
