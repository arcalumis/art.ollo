import crypto from "node:crypto";
import { getDb } from "../db";
import { addCredits } from "./usage";

export interface SubscriptionBoost {
	id: string;
	userId: string;
	boostProductId: string;
	boostProductName?: string;
	originalProductId: string | null;
	originalProductName?: string;
	grantedByUserId: string | null;
	reason: string | null;
	startsAt: string;
	endsAt: string;
	status: "active" | "expired" | "cancelled";
	createdAt: string;
}

interface BoostRow {
	id: string;
	user_id: string;
	boost_product_id: string;
	boost_product_name: string;
	original_product_id: string | null;
	original_product_name: string | null;
	granted_by_user_id: string | null;
	reason: string | null;
	starts_at: string;
	ends_at: string;
	status: string;
	created_at: string;
}

interface SubscriptionRow {
	id: string;
	product_id: string;
}

/**
 * Grant a subscription boost to a user
 */
export function grantSubscriptionBoost(
	userId: string,
	boostProductId: string,
	durationDays: number,
	grantedByUserId: string | null,
	reason: string | null,
): SubscriptionBoost | null {
	const db = getDb();

	// Check if user exists
	const user = db.prepare("SELECT id FROM users WHERE id = ?").get(userId);
	if (!user) {
		return null;
	}

	// Check if boost product exists
	const boostProduct = db
		.prepare("SELECT id, name FROM subscription_products WHERE id = ? AND is_active = 1")
		.get(boostProductId) as { id: string; name: string } | undefined;
	if (!boostProduct) {
		return null;
	}

	// Cancel any existing active boost
	db.prepare(`
		UPDATE subscription_boosts
		SET status = 'cancelled'
		WHERE user_id = ? AND status = 'active'
	`).run(userId);

	// Get user's current subscription (to store as original)
	const currentSubscription = db
		.prepare(`
			SELECT us.id, us.product_id
			FROM user_subscriptions us
			WHERE us.user_id = ?
			AND (us.ends_at IS NULL OR us.ends_at > datetime('now'))
			ORDER BY us.created_at DESC
			LIMIT 1
		`)
		.get(userId) as SubscriptionRow | undefined;

	// Create the boost
	const boostId = crypto.randomUUID();
	const startsAt = new Date().toISOString();
	const endsAt = new Date(Date.now() + durationDays * 24 * 60 * 60 * 1000).toISOString();

	db.prepare(`
		INSERT INTO subscription_boosts
		(id, user_id, boost_product_id, original_product_id, granted_by_user_id, reason, starts_at, ends_at, status)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active')
	`).run(
		boostId,
		userId,
		boostProductId,
		currentSubscription?.product_id || null,
		grantedByUserId,
		reason,
		startsAt,
		endsAt,
	);

	// Add 25 bonus credits with the boost
	addCredits(userId, 25, "bonus", `Boost bonus: ${boostProduct.name}`);

	return {
		id: boostId,
		userId,
		boostProductId,
		boostProductName: boostProduct.name,
		originalProductId: currentSubscription?.product_id || null,
		grantedByUserId,
		reason,
		startsAt,
		endsAt,
		status: "active",
		createdAt: startsAt,
	};
}

/**
 * Get a user's active boost if any
 */
export function getActiveBoost(userId: string): SubscriptionBoost | null {
	const db = getDb();

	const boost = db
		.prepare(`
			SELECT
				sb.id,
				sb.user_id,
				sb.boost_product_id,
				sp_boost.name as boost_product_name,
				sb.original_product_id,
				sp_orig.name as original_product_name,
				sb.granted_by_user_id,
				sb.reason,
				sb.starts_at,
				sb.ends_at,
				sb.status,
				sb.created_at
			FROM subscription_boosts sb
			JOIN subscription_products sp_boost ON sb.boost_product_id = sp_boost.id
			LEFT JOIN subscription_products sp_orig ON sb.original_product_id = sp_orig.id
			WHERE sb.user_id = ?
			AND sb.status = 'active'
			AND sb.ends_at > datetime('now')
			ORDER BY sb.created_at DESC
			LIMIT 1
		`)
		.get(userId) as BoostRow | undefined;

	if (!boost) {
		return null;
	}

	return {
		id: boost.id,
		userId: boost.user_id,
		boostProductId: boost.boost_product_id,
		boostProductName: boost.boost_product_name,
		originalProductId: boost.original_product_id,
		originalProductName: boost.original_product_name || undefined,
		grantedByUserId: boost.granted_by_user_id,
		reason: boost.reason,
		startsAt: boost.starts_at,
		endsAt: boost.ends_at,
		status: boost.status as "active" | "expired" | "cancelled",
		createdAt: boost.created_at,
	};
}

/**
 * Cancel a boost early
 */
export function cancelBoost(boostId: string): boolean {
	const db = getDb();

	const result = db
		.prepare(`
			UPDATE subscription_boosts
			SET status = 'cancelled'
			WHERE id = ? AND status = 'active'
		`)
		.run(boostId);

	return result.changes > 0;
}

/**
 * Process expired boosts - mark them as expired
 * This should be called periodically by the cleanup job
 */
export function processExpiredBoosts(): number {
	const db = getDb();

	const result = db
		.prepare(`
			UPDATE subscription_boosts
			SET status = 'expired'
			WHERE status = 'active'
			AND ends_at <= datetime('now')
		`)
		.run();

	if (result.changes > 0) {
		console.log(`Processed ${result.changes} expired subscription boosts`);
	}

	return result.changes;
}

/**
 * Get all active boosts (for admin viewing)
 */
export function getAllActiveBoosts(): SubscriptionBoost[] {
	const db = getDb();

	const boosts = db
		.prepare(`
			SELECT
				sb.id,
				sb.user_id,
				sb.boost_product_id,
				sp_boost.name as boost_product_name,
				sb.original_product_id,
				sp_orig.name as original_product_name,
				sb.granted_by_user_id,
				sb.reason,
				sb.starts_at,
				sb.ends_at,
				sb.status,
				sb.created_at
			FROM subscription_boosts sb
			JOIN subscription_products sp_boost ON sb.boost_product_id = sp_boost.id
			LEFT JOIN subscription_products sp_orig ON sb.original_product_id = sp_orig.id
			WHERE sb.status = 'active'
			AND sb.ends_at > datetime('now')
			ORDER BY sb.ends_at ASC
		`)
		.all() as BoostRow[];

	return boosts.map((boost) => ({
		id: boost.id,
		userId: boost.user_id,
		boostProductId: boost.boost_product_id,
		boostProductName: boost.boost_product_name,
		originalProductId: boost.original_product_id,
		originalProductName: boost.original_product_name || undefined,
		grantedByUserId: boost.granted_by_user_id,
		reason: boost.reason,
		startsAt: boost.starts_at,
		endsAt: boost.ends_at,
		status: boost.status as "active" | "expired" | "cancelled",
		createdAt: boost.created_at,
	}));
}

/**
 * Get boost by ID
 */
export function getBoostById(boostId: string): SubscriptionBoost | null {
	const db = getDb();

	const boost = db
		.prepare(`
			SELECT
				sb.id,
				sb.user_id,
				sb.boost_product_id,
				sp_boost.name as boost_product_name,
				sb.original_product_id,
				sp_orig.name as original_product_name,
				sb.granted_by_user_id,
				sb.reason,
				sb.starts_at,
				sb.ends_at,
				sb.status,
				sb.created_at
			FROM subscription_boosts sb
			JOIN subscription_products sp_boost ON sb.boost_product_id = sp_boost.id
			LEFT JOIN subscription_products sp_orig ON sb.original_product_id = sp_orig.id
			WHERE sb.id = ?
		`)
		.get(boostId) as BoostRow | undefined;

	if (!boost) {
		return null;
	}

	return {
		id: boost.id,
		userId: boost.user_id,
		boostProductId: boost.boost_product_id,
		boostProductName: boost.boost_product_name,
		originalProductId: boost.original_product_id,
		originalProductName: boost.original_product_name || undefined,
		grantedByUserId: boost.granted_by_user_id,
		reason: boost.reason,
		startsAt: boost.starts_at,
		endsAt: boost.ends_at,
		status: boost.status as "active" | "expired" | "cancelled",
		createdAt: boost.created_at,
	};
}
