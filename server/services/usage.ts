import crypto from "node:crypto";
import { getDb } from "../db";

export const MODEL_CREDIT_COSTS: Record<string, number> = {
	"black-forest-labs/flux-schnell": 1,
	"black-forest-labs/flux-2-dev": 2,
	"black-forest-labs/flux-dev": 2,
	"black-forest-labs/flux-redux-schnell": 2,
	"black-forest-labs/flux-2-pro": 3,
	"black-forest-labs/flux-1.1-pro": 3,
	"black-forest-labs/flux-kontext-pro": 3,
	"black-forest-labs/flux-1.1-pro-ultra": 4,
	"black-forest-labs/flux-redux-dev": 5,
	"google/nano-banana-pro": 10,
};
const DEFAULT_CREDIT_COST = 2;

export function getModelCreditCost(modelId: string): number {
	const db = getDb();
	const row = db
		.prepare("SELECT credit_cost FROM model_credit_costs WHERE model_id = ?")
		.get(modelId) as { credit_cost: number } | undefined;
	if (row) return row.credit_cost;
	return MODEL_CREDIT_COSTS[modelId] ?? DEFAULT_CREDIT_COST;
}

export function getAllModelCreditCosts(): { modelId: string; creditCost: number; isOverride: boolean }[] {
	const db = getDb();
	const overrides = db
		.prepare("SELECT model_id, credit_cost FROM model_credit_costs")
		.all() as { model_id: string; credit_cost: number }[];
	const overrideMap = new Map(overrides.map((r) => [r.model_id, r.credit_cost]));

	// Merge all known models from the hardcoded map
	const allModelIds = new Set([
		...Object.keys(MODEL_CREDIT_COSTS),
		...overrideMap.keys(),
	]);

	return Array.from(allModelIds).map((modelId) => {
		const override = overrideMap.get(modelId);
		return {
			modelId,
			creditCost: override ?? MODEL_CREDIT_COSTS[modelId] ?? DEFAULT_CREDIT_COST,
			isOverride: override !== undefined,
		};
	});
}

export function setModelCreditCost(modelId: string, creditCost: number): void {
	const db = getDb();
	db.prepare(
		`INSERT INTO model_credit_costs (model_id, credit_cost, updated_at)
		VALUES (?, ?, datetime('now'))
		ON CONFLICT(model_id) DO UPDATE SET credit_cost = ?, updated_at = datetime('now')`,
	).run(modelId, creditCost, creditCost);
}

export function deleteModelCreditCost(modelId: string): boolean {
	const db = getDb();
	const result = db
		.prepare("DELETE FROM model_credit_costs WHERE model_id = ?")
		.run(modelId);
	return result.changes > 0;
}

interface SubscriptionProduct {
	id: string;
	name: string;
	description: string | null;
	monthly_image_limit: number | null;
	monthly_cost_limit: number | null;
	daily_image_limit: number | null;
	bonus_credits: number;
	price: number;
	is_active: number;
	allowed_models: string | null;
	credit_refill_amount: number;
	topoff_interval_hours: number;
}

interface UserSubscription {
	id: string;
	user_id: string;
	product_id: string;
	starts_at: string;
	ends_at: string | null;
}

interface MonthlyUsage {
	id: string;
	user_id: string;
	year_month: string;
	image_count: number;
	total_cost: number;
	used_own_key: number;
}

interface DailyUsage {
	id: string;
	user_id: string;
	date: string;
	image_count: number;
}

interface CreditRow {
	total: number;
}

export interface UsageLimitResult {
	allowed: boolean;
	reason?: string;
	subscription?: SubscriptionProduct;
	usage?: {
		imageCount: number;
		totalCost: number;
		usedOwnKey: number;
	};
	limits?: {
		monthlyCostLimit: number | null;
	};
	availableCredits?: number;
	creditCost?: number;
	creditRefillAmount?: number;
}

/**
 * Get current year-month string (e.g., "2025-01")
 */
export function getCurrentYearMonth(): string {
	const now = new Date();
	return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

/**
 * Get current UTC date string (e.g., "2025-01-13")
 */
export function getCurrentUTCDate(): string {
	const now = new Date();
	return now.toISOString().split("T")[0];
}

/**
 * Get user's daily usage for a specific date (defaults to today UTC)
 */
export function getDailyUsage(userId: string, date?: string): DailyUsage | null {
	const db = getDb();
	const targetDate = date || getCurrentUTCDate();

	const usage = db
		.prepare("SELECT * FROM usage_daily WHERE user_id = ? AND date = ?")
		.get(userId, targetDate) as DailyUsage | undefined;

	return usage || null;
}

/**
 * Record daily usage after a generation
 */
export function recordDailyUsage(userId: string): void {
	const db = getDb();
	const date = getCurrentUTCDate();

	const existing = db
		.prepare("SELECT id FROM usage_daily WHERE user_id = ? AND date = ?")
		.get(userId, date) as { id: string } | undefined;

	if (existing) {
		db.prepare(
			"UPDATE usage_daily SET image_count = image_count + 1 WHERE id = ?",
		).run(existing.id);
	} else {
		const id = crypto.randomUUID();
		db.prepare(
			"INSERT INTO usage_daily (id, user_id, date, image_count) VALUES (?, ?, ?, 1)",
		).run(id, userId, date);
	}
}

/**
 * Get user's usage history for the last N days
 * Returns an array of { date, imageCount } sorted by date ascending
 */
export function getUserUsageHistory(userId: string, days = 30): { date: string; imageCount: number }[] {
	const db = getDb();

	// Get dates for the last N days
	const endDate = new Date();
	const startDate = new Date();
	startDate.setDate(startDate.getDate() - days + 1);

	const startDateStr = startDate.toISOString().split("T")[0];
	const endDateStr = endDate.toISOString().split("T")[0];

	const usage = db
		.prepare(
			`SELECT date, image_count FROM usage_daily
			WHERE user_id = ? AND date >= ? AND date <= ?
			ORDER BY date ASC`
		)
		.all(userId, startDateStr, endDateStr) as { date: string; image_count: number }[];

	// Create a map for quick lookup
	const usageMap = new Map(usage.map(u => [u.date, u.image_count]));

	// Fill in all days (including zeros)
	const result: { date: string; imageCount: number }[] = [];
	const current = new Date(startDate);
	while (current <= endDate) {
		const dateStr = current.toISOString().split("T")[0];
		result.push({
			date: dateStr,
			imageCount: usageMap.get(dateStr) || 0
		});
		current.setDate(current.getDate() + 1);
	}

	return result;
}

interface BoostInfo {
	isBoost: boolean;
	boostId?: string;
	boostEndsAt?: string;
	originalProductId?: string | null;
}

/**
 * Get user's active subscription and associated product
 * Now boost-aware: if user has an active boost, return the boost product instead
 */
export function getUserSubscription(userId: string): {
	subscription: UserSubscription | null;
	product: SubscriptionProduct | null;
	boost?: BoostInfo;
} {
	const db = getDb();

	// Only active/trialing rows that haven't ended grant their tier. past_due, canceled, unpaid,
	// incomplete, superseded and expired rows fall back to the Free product below.
	const currentSubscription = () =>
		db
			.prepare(
				`SELECT us.* FROM user_subscriptions us
				WHERE us.user_id = ?
				AND COALESCE(us.status, 'active') IN ('active', 'trialing')
				AND (us.ends_at IS NULL OR datetime(us.ends_at) > datetime('now'))
				ORDER BY us.created_at DESC
				LIMIT 1`,
			)
			.get(userId) as UserSubscription | undefined;

	// First check for an active boost (takes precedence over everything)
	const activeBoost = db
		.prepare(`
			SELECT sb.id, sb.boost_product_id, sb.original_product_id, sb.ends_at
			FROM subscription_boosts sb
			WHERE sb.user_id = ?
			AND sb.status = 'active'
			AND sb.ends_at > datetime('now')
			ORDER BY sb.created_at DESC
			LIMIT 1
		`)
		.get(userId) as {
		id: string;
		boost_product_id: string;
		original_product_id: string | null;
		ends_at: string;
	} | undefined;

	if (activeBoost) {
		const boostProduct = db
			.prepare("SELECT * FROM subscription_products WHERE id = ?")
			.get(activeBoost.boost_product_id) as SubscriptionProduct | undefined;

		return {
			subscription: currentSubscription() || null,
			product: boostProduct || null,
			boost: {
				isBoost: true,
				boostId: activeBoost.id,
				boostEndsAt: activeBoost.ends_at,
				originalProductId: activeBoost.original_product_id,
			},
		};
	}

	const subscription = currentSubscription();
	const product = subscription
		? (db.prepare("SELECT * FROM subscription_products WHERE id = ?").get(subscription.product_id) as
				| SubscriptionProduct
				| undefined)
		: undefined;

	if (subscription && product) {
		return { subscription, product, boost: { isBoost: false } };
	}

	const freeProduct = db
		.prepare(
			"SELECT * FROM subscription_products WHERE name = 'Free' AND is_active = 1 ORDER BY created_at ASC LIMIT 1",
		)
		.get() as SubscriptionProduct | undefined;

	return { subscription: null, product: freeProduct || null, boost: { isBoost: false } };
}

/**
 * Get user's current month usage
 */
export function getMonthlyUsage(userId: string, yearMonth?: string): MonthlyUsage | null {
	const db = getDb();
	const month = yearMonth || getCurrentYearMonth();

	const usage = db
		.prepare("SELECT * FROM usage_monthly WHERE user_id = ? AND year_month = ?")
		.get(userId, month) as MonthlyUsage | undefined;

	return usage || null;
}

/**
 * Get user's available credits (sum of all credits)
 */
export function getAvailableCredits(userId: string): number {
	const db = getDb();

	const result = db
		.prepare("SELECT COALESCE(SUM(amount), 0) as total FROM user_credits WHERE user_id = ?")
		.get(userId) as CreditRow;

	return result.total;
}

/**
 * Get allowed models for a user based on their subscription tier
 * Returns null if all models are allowed, or an array of model IDs
 */
export function getAllowedModelsForUser(userId: string): string[] | null {
	const { product } = getUserSubscription(userId);

	if (!product || !product.allowed_models) {
		return null; // No restriction - all models allowed
	}

	try {
		return JSON.parse(product.allowed_models) as string[];
	} catch {
		return null; // Invalid JSON - allow all models as fallback
	}
}

/**
 * Check if a user can use a specific model
 */
export function canUserUseModel(userId: string, modelId: string): boolean {
	const allowedModels = getAllowedModelsForUser(userId);

	if (allowedModels === null) {
		return true; // All models allowed
	}

	return allowedModels.includes(modelId);
}

/**
 * Check if user can generate an image based on credit balance and safety limits
 * Credits are the primary gate. Monthly cost limit is a safety backstop.
 */
export function canUserGenerate(userId: string, modelId: string): UsageLimitResult {
	const { product } = getUserSubscription(userId);
	const usage = getMonthlyUsage(userId);
	const availableCredits = getAvailableCredits(userId);
	const creditCost = getModelCreditCost(modelId);

	// If no subscription, check for credits only
	if (!product) {
		if (availableCredits >= creditCost) {
			return {
				allowed: true,
				availableCredits,
				creditCost,
			};
		}
		return {
			allowed: false,
			reason: `No active subscription. This model costs ${creditCost} credits but you have ${availableCredits}. Please subscribe to continue generating images.`,
			availableCredits,
			creditCost,
		};
	}

	const currentUsage = {
		imageCount: usage?.image_count || 0,
		totalCost: usage?.total_cost || 0,
		usedOwnKey: usage?.used_own_key || 0,
	};

	const limits = {
		monthlyCostLimit: product.monthly_cost_limit,
	};

	const creditRefillAmount = product.credit_refill_amount || 0;

	// Primary gate: credit balance
	if (availableCredits < creditCost) {
		return {
			allowed: false,
			reason: `Not enough credits. This model costs ${creditCost} credits but you have ${availableCredits}.`,
			subscription: product,
			usage: currentUsage,
			limits,
			availableCredits,
			creditCost,
			creditRefillAmount,
		};
	}

	// Safety backstop: monthly cost limit
	if (product.monthly_cost_limit !== null && currentUsage.totalCost >= product.monthly_cost_limit) {
		return {
			allowed: false,
			reason: "Platform safety limit reached. Please contact support or wait for next month.",
			subscription: product,
			usage: currentUsage,
			limits,
			availableCredits,
			creditCost,
			creditRefillAmount,
		};
	}

	return {
		allowed: true,
		subscription: product,
		usage: currentUsage,
		limits,
		availableCredits,
		creditCost,
		creditRefillAmount,
	};
}

/**
 * Record usage after a generation
 */
export function recordUsage(userId: string, cost: number, usedOwnKey: boolean): void {
	const db = getDb();
	const yearMonth = getCurrentYearMonth();

	// Record monthly usage
	const existing = db
		.prepare("SELECT id FROM usage_monthly WHERE user_id = ? AND year_month = ?")
		.get(userId, yearMonth) as { id: string } | undefined;

	if (existing) {
		db.prepare(
			`UPDATE usage_monthly
			SET image_count = image_count + 1,
				total_cost = total_cost + ?,
				used_own_key = used_own_key + ?
			WHERE id = ?`,
		).run(cost, usedOwnKey ? 1 : 0, existing.id);
	} else {
		const id = crypto.randomUUID();
		db.prepare(
			`INSERT INTO usage_monthly (id, user_id, year_month, image_count, total_cost, used_own_key)
			VALUES (?, ?, ?, 1, ?, ?)`,
		).run(id, userId, yearMonth, cost, usedOwnKey ? 1 : 0);
	}

	// Record daily usage
	recordDailyUsage(userId);
}

/**
 * Deduct credits from user for a generation
 */
export function deductCredit(userId: string, amount: number, reason: string): boolean {
	const db = getDb();
	const credits = getAvailableCredits(userId);

	if (credits < amount) {
		return false;
	}

	const id = crypto.randomUUID();
	db.prepare(
		`INSERT INTO user_credits (id, user_id, credit_type, amount, reason)
		VALUES (?, ?, 'used', ?, ?)`,
	).run(id, userId, -amount, reason);

	return true;
}

/**
 * Add credits to a user
 */
export function addCredits(
	userId: string,
	amount: number,
	creditType: string,
	reason: string,
): void {
	const db = getDb();
	const id = crypto.randomUUID();

	db.prepare(
		`INSERT INTO user_credits (id, user_id, credit_type, amount, reason)
		VALUES (?, ?, ?, ?, ?)`,
	).run(id, userId, creditType, amount, reason);
}

export interface AssignSubscriptionOptions {
	stripeSubscriptionId?: string | null;
	/** 'active' (default) or 'trialing'. */
	status?: "active" | "trialing";
	startsAt?: string;
	endsAt?: string | null;
	periodStart?: string | null;
	periodEnd?: string | null;
	/** Grant the product's bonus_credits (default true). */
	grantBonus?: boolean;
	bonusReason?: string;
}

/**
 * Assign a subscription to a user. In one transaction: every currently 'active'/'trialing' row
 * for the user is retired as 'superseded' (respecting the one-active-row unique index), the new
 * row is inserted, and the product's welcome bonus is granted once.
 */
export function assignSubscription(userId: string, productId: string, opts: AssignSubscriptionOptions = {}): string {
	const db = getDb();
	const id = crypto.randomUUID();

	db.transaction(() => {
		db.prepare(
			`UPDATE user_subscriptions
			SET status = 'superseded', ends_at = COALESCE(ends_at, datetime('now'))
			WHERE user_id = ? AND status IN ('active', 'trialing')`,
		).run(userId);

		const product = db
			.prepare("SELECT bonus_credits FROM subscription_products WHERE id = ?")
			.get(productId) as { bonus_credits: number } | undefined;
		const grantBonus = opts.grantBonus !== false && !!product && product.bonus_credits > 0;

		db.prepare(
			`INSERT INTO user_subscriptions
				(id, user_id, product_id, starts_at, ends_at, status, stripe_subscription_id,
				 current_period_start, current_period_end, bonus_granted)
			VALUES (?, ?, ?, COALESCE(?, datetime('now')), ?, ?, ?, ?, ?, ?)`,
		).run(
			id,
			userId,
			productId,
			opts.startsAt ?? null,
			opts.endsAt ?? null,
			opts.status ?? "active",
			opts.stripeSubscriptionId ?? null,
			opts.periodStart ?? null,
			opts.periodEnd ?? null,
			grantBonus ? 1 : 0,
		);

		if (grantBonus && product) {
			addCredits(userId, product.bonus_credits, "bonus", opts.bonusReason ?? "Subscription welcome bonus");
		}
	})();

	return id;
}

/**
 * Assign default subscription to new user
 */
export function assignDefaultSubscription(userId: string): void {
	const db = getDb();

	db.transaction(() => {
		// Find the default (Free) product
		const freeProduct = db
			.prepare("SELECT id FROM subscription_products WHERE name = 'Free' AND is_active = 1 LIMIT 1")
			.get() as { id: string } | undefined;

		if (freeProduct) {
			assignSubscription(userId, freeProduct.id);
		}

		// Grant initial credits to new users
		const initialCredits = Number(process.env.INITIAL_CREDITS) || 10;
		addCredits(userId, initialCredits, "initial", "Welcome credits for new account");
	})();
}

/**
 * Process subscription credit refills for all eligible users.
 * Refills credits to the target level (not additive -- "top off" model).
 * Returns count of users actually refilled.
 */
export function processSubscriptionRefills(): number {
	const db = getDb();

	// Find all active subscriptions eligible for refill
	const eligibleSubscriptions = db
		.prepare(`
			SELECT
				us.id as subscription_id,
				us.user_id,
				us.last_credit_topoff_at,
				sp.credit_refill_amount,
				sp.topoff_interval_hours
			FROM user_subscriptions us
			JOIN subscription_products sp ON sp.id = us.product_id
			WHERE sp.credit_refill_amount > 0
			AND (us.ends_at IS NULL OR us.ends_at > datetime('now'))
			AND us.status = 'active'
			AND (
				us.last_credit_topoff_at IS NULL
				OR us.last_credit_topoff_at < datetime('now', '-' || sp.topoff_interval_hours || ' hours')
			)
		`)
		.all() as Array<{
		subscription_id: string;
		user_id: string;
		last_credit_topoff_at: string | null;
		credit_refill_amount: number;
		topoff_interval_hours: number;
	}>;

	let refillCount = 0;

	for (const sub of eligibleSubscriptions) {
		const currentBalance = getAvailableCredits(sub.user_id);
		let creditsAdded = 0;

		if (currentBalance < sub.credit_refill_amount) {
			creditsAdded = sub.credit_refill_amount - currentBalance;
			addCredits(sub.user_id, creditsAdded, "refill", "Subscription credit refill");
			refillCount++;
		}

		// Log the refill event (even if no credits were added -- for breakage analysis)
		const logId = crypto.randomUUID();
		db.prepare(`
			INSERT INTO credit_topoff_log (id, user_id, subscription_id, credits_added, balance_before, balance_after, refill_target)
			VALUES (?, ?, ?, ?, ?, ?, ?)
		`).run(
			logId,
			sub.user_id,
			sub.subscription_id,
			creditsAdded,
			currentBalance,
			currentBalance + creditsAdded,
			sub.credit_refill_amount,
		);

		// Update timestamp
		db.prepare(
			"UPDATE user_subscriptions SET last_credit_topoff_at = datetime('now') WHERE id = ?",
		).run(sub.subscription_id);
	}

	if (eligibleSubscriptions.length > 0) {
		console.log(
			`Credit refills: ${refillCount} users topped off, ${eligibleSubscriptions.length - refillCount} already at target`,
		);
	}

	return refillCount;
}
