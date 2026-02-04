import crypto from "node:crypto";
import { getDb } from "../db";

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
	dailyUsage?: {
		imageCount: number;
	};
	limits?: {
		monthlyImageLimit: number | null;
		monthlyCostLimit: number | null;
		dailyImageLimit: number | null;
	};
	availableCredits?: number;
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

	// First check for an active boost
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
		// User has an active boost - return the boost product
		const boostProduct = db
			.prepare("SELECT * FROM subscription_products WHERE id = ?")
			.get(activeBoost.boost_product_id) as SubscriptionProduct | undefined;

		// Get original subscription for reference
		const originalSubscription = db
			.prepare(
				`SELECT us.* FROM user_subscriptions us
				WHERE us.user_id = ?
				AND (us.ends_at IS NULL OR us.ends_at > datetime('now'))
				ORDER BY us.created_at DESC
				LIMIT 1`,
			)
			.get(userId) as UserSubscription | undefined;

		return {
			subscription: originalSubscription || null,
			product: boostProduct || null,
			boost: {
				isBoost: true,
				boostId: activeBoost.id,
				boostEndsAt: activeBoost.ends_at,
				originalProductId: activeBoost.original_product_id,
			},
		};
	}

	// No boost - return normal subscription
	const subscription = db
		.prepare(
			`SELECT us.* FROM user_subscriptions us
			WHERE us.user_id = ?
			AND (us.ends_at IS NULL OR us.ends_at > datetime('now'))
			ORDER BY us.created_at DESC
			LIMIT 1`,
		)
		.get(userId) as UserSubscription | undefined;

	if (!subscription) {
		return { subscription: null, product: null, boost: { isBoost: false } };
	}

	const product = db
		.prepare("SELECT * FROM subscription_products WHERE id = ?")
		.get(subscription.product_id) as SubscriptionProduct | undefined;

	return {
		subscription: subscription || null,
		product: product || null,
		boost: { isBoost: false },
	};
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
 * Check if user can generate an image based on their subscription limits
 */
export function canUserGenerate(userId: string): UsageLimitResult {
	const { subscription, product } = getUserSubscription(userId);
	const usage = getMonthlyUsage(userId);
	const dailyUsageRecord = getDailyUsage(userId);
	const availableCredits = getAvailableCredits(userId);

	// If no subscription, check for credits only
	if (!product) {
		if (availableCredits > 0) {
			return {
				allowed: true,
				availableCredits,
			};
		}
		return {
			allowed: false,
			reason: "No active subscription. Please subscribe to continue generating images.",
			availableCredits: 0,
		};
	}

	const currentUsage = {
		imageCount: usage?.image_count || 0,
		totalCost: usage?.total_cost || 0,
		usedOwnKey: usage?.used_own_key || 0,
	};

	const currentDailyUsage = {
		imageCount: dailyUsageRecord?.image_count || 0,
	};

	const limits = {
		monthlyImageLimit: product.monthly_image_limit,
		monthlyCostLimit: product.monthly_cost_limit,
		dailyImageLimit: product.daily_image_limit,
	};

	// Check daily limit first (resets more frequently)
	if (
		product.daily_image_limit !== null &&
		currentDailyUsage.imageCount >= product.daily_image_limit
	) {
		// Check for bonus credits to override daily limit
		if (availableCredits <= 0) {
			return {
				allowed: false,
				reason: `Daily limit (${product.daily_image_limit}) reached. Come back tomorrow or upgrade your plan.`,
				subscription: product,
				usage: currentUsage,
				dailyUsage: currentDailyUsage,
				limits,
				availableCredits: 0,
			};
		}
		// Has credits, can proceed (credits will be deducted)
	}

	// Check monthly image limit
	if (
		product.monthly_image_limit !== null &&
		currentUsage.imageCount >= product.monthly_image_limit
	) {
		// Check for bonus credits
		if (availableCredits <= 0) {
			return {
				allowed: false,
				reason: `Monthly image limit (${product.monthly_image_limit}) reached. Upgrade your plan or wait for next month.`,
				subscription: product,
				usage: currentUsage,
				dailyUsage: currentDailyUsage,
				limits,
				availableCredits: 0,
			};
		}
		// Has credits, can proceed (credits will be deducted)
	}

	// Check cost limit (hard cap, no credit override)
	if (product.monthly_cost_limit !== null && currentUsage.totalCost >= product.monthly_cost_limit) {
		return {
			allowed: false,
			reason: `Monthly cost limit ($${product.monthly_cost_limit.toFixed(2)}) reached. Upgrade your plan or wait for next month.`,
			subscription: product,
			usage: currentUsage,
			dailyUsage: currentDailyUsage,
			limits,
			availableCredits,
		};
	}

	return {
		allowed: true,
		subscription: product,
		usage: currentUsage,
		dailyUsage: currentDailyUsage,
		limits,
		availableCredits,
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
 * Deduct a credit from user (for when they exceed limits but have credits)
 */
export function deductCredit(userId: string, reason: string): boolean {
	const db = getDb();
	const credits = getAvailableCredits(userId);

	if (credits <= 0) {
		return false;
	}

	const id = crypto.randomUUID();
	db.prepare(
		`INSERT INTO user_credits (id, user_id, credit_type, amount, reason)
		VALUES (?, ?, 'used', -1, ?)`,
	).run(id, userId, reason);

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

/**
 * Assign subscription to user
 */
export function assignSubscription(userId: string, productId: string): string {
	const db = getDb();

	// End any existing active subscriptions
	db.prepare(
		`UPDATE user_subscriptions
		SET ends_at = datetime('now')
		WHERE user_id = ? AND (ends_at IS NULL OR ends_at > datetime('now'))`,
	).run(userId);

	// Create new subscription
	const id = crypto.randomUUID();
	db.prepare(
		`INSERT INTO user_subscriptions (id, user_id, product_id, starts_at)
		VALUES (?, ?, ?, datetime('now'))`,
	).run(id, userId, productId);

	// Add bonus credits from the product
	const product = db
		.prepare("SELECT bonus_credits FROM subscription_products WHERE id = ?")
		.get(productId) as { bonus_credits: number } | undefined;

	if (product && product.bonus_credits > 0) {
		addCredits(userId, product.bonus_credits, "bonus", "Subscription welcome bonus");
	}

	return id;
}

/**
 * Assign default subscription to new user
 */
export function assignDefaultSubscription(userId: string): void {
	const db = getDb();

	// Find the default (Free) product
	const freeProduct = db
		.prepare("SELECT id FROM subscription_products WHERE name = 'Free' AND is_active = 1 LIMIT 1")
		.get() as { id: string } | undefined;

	if (freeProduct) {
		assignSubscription(userId, freeProduct.id);
	}
}
