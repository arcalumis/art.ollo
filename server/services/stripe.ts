import crypto from "node:crypto";
import Stripe from "stripe";
import { getDb } from "../db";
import { addCredits, assignSubscription } from "./usage";

// Initialize Stripe client
const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
if (!stripeSecretKey) {
	console.warn("STRIPE_SECRET_KEY not set - billing features will be disabled");
}

// Pinned to the API version the account and webhook payloads were built against. The SDK's
// types track a newer version, hence the cast; runtime behaviour is unchanged.
export const stripe = stripeSecretKey
	? new Stripe(stripeSecretKey, { apiVersion: "2024-12-18.acacia" as Stripe.StripeConfig["apiVersion"] })
	: null;

export const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

// Check if Stripe is configured
export function isStripeConfigured(): boolean {
	return stripe !== null;
}

// Get or create Stripe customer for a user
export async function getOrCreateStripeCustomer(
	userId: string,
	email?: string,
	username?: string,
): Promise<string | null> {
	if (!stripe) return null;

	const db = getDb();

	// Check if customer already exists
	const existing = db
		.prepare("SELECT stripe_customer_id FROM stripe_customers WHERE user_id = ?")
		.get(userId) as { stripe_customer_id: string } | undefined;

	if (existing) {
		return existing.stripe_customer_id;
	}

	// Create new Stripe customer
	const customer = await stripe.customers.create({
		email: email || undefined,
		name: username || undefined,
		metadata: {
			user_id: userId,
		},
	});

	// Store mapping
	const id = crypto.randomUUID();
	db.prepare("INSERT INTO stripe_customers (id, user_id, stripe_customer_id) VALUES (?, ?, ?)").run(
		id,
		userId,
		customer.id,
	);

	return customer.id;
}

// Get Stripe customer ID for a user
export function getStripeCustomerId(userId: string): string | null {
	const db = getDb();
	const result = db
		.prepare("SELECT stripe_customer_id FROM stripe_customers WHERE user_id = ?")
		.get(userId) as { stripe_customer_id: string } | undefined;

	return result?.stripe_customer_id || null;
}

// Get user ID from Stripe customer ID
export function getUserIdFromStripeCustomer(stripeCustomerId: string): string | null {
	const db = getDb();
	const result = db
		.prepare("SELECT user_id FROM stripe_customers WHERE stripe_customer_id = ?")
		.get(stripeCustomerId) as { user_id: string } | undefined;

	return result?.user_id || null;
}

// Create checkout session for subscription
export async function createCheckoutSession(
	userId: string,
	priceId: string,
	successUrl: string,
	cancelUrl: string,
): Promise<string | null> {
	if (!stripe) return null;

	const db = getDb();

	// Get user email
	const user = db.prepare("SELECT email, username FROM users WHERE id = ?").get(userId) as
		| { email: string | null; username: string }
		| undefined;

	if (!user) return null;

	// Get or create customer
	const customerId = await getOrCreateStripeCustomer(
		userId,
		user.email || undefined,
		user.username,
	);

	if (!customerId) return null;

	const session = await stripe.checkout.sessions.create({
		customer: customerId,
		mode: "subscription",
		line_items: [
			{
				price: priceId,
				quantity: 1,
			},
		],
		success_url: successUrl,
		cancel_url: cancelUrl,
		metadata: {
			user_id: userId,
		},
	});

	return session.url;
}

// Create checkout session for one-time credit purchase
export async function createCreditCheckoutSession(
	userId: string,
	packageId: string,
	successUrl: string,
	cancelUrl: string,
): Promise<string | null> {
	if (!stripe) return null;

	const db = getDb();

	// Look up credit package
	const pkg = db
		.prepare(
			"SELECT id, name, credits, price_cents, stripe_price_id FROM solana_credit_packages WHERE id = ? AND is_active = 1 AND available_for_usd = 1",
		)
		.get(packageId) as
		| { id: string; name: string; credits: number; price_cents: number | null; stripe_price_id: string | null }
		| undefined;

	if (!pkg || !pkg.stripe_price_id || !pkg.price_cents) {
		return null;
	}

	// Get user info
	const user = db.prepare("SELECT email, username FROM users WHERE id = ?").get(userId) as
		| { email: string | null; username: string }
		| undefined;

	if (!user) return null;

	// Get or create customer
	const customerId = await getOrCreateStripeCustomer(
		userId,
		user.email || undefined,
		user.username,
	);

	if (!customerId) return null;

	const session = await stripe.checkout.sessions.create({
		customer: customerId,
		mode: "payment",
		line_items: [
			{
				price: pkg.stripe_price_id,
				quantity: 1,
			},
		],
		success_url: successUrl,
		cancel_url: cancelUrl,
		metadata: {
			user_id: userId,
			package_id: pkg.id,
			credits: pkg.credits.toString(),
			type: "credit_purchase",
		},
	});

	return session.url;
}

// Create customer portal session
export async function createPortalSession(
	userId: string,
	returnUrl: string,
): Promise<string | null> {
	if (!stripe) return null;

	const customerId = getStripeCustomerId(userId);
	if (!customerId) return null;

	const session = await stripe.billingPortal.sessions.create({
		customer: customerId,
		return_url: returnUrl,
	});

	return session.url;
}

// Get subscription for a user
export async function getUserSubscription(userId: string): Promise<Stripe.Subscription | null> {
	if (!stripe) return null;

	const customerId = getStripeCustomerId(userId);
	if (!customerId) return null;

	const subscriptions = await stripe.subscriptions.list({
		customer: customerId,
		status: "active",
		limit: 1,
	});

	return subscriptions.data[0] || null;
}

// Cancel subscription
export async function cancelSubscription(subscriptionId: string): Promise<boolean> {
	if (!stripe) return false;

	try {
		await stripe.subscriptions.cancel(subscriptionId);
		return true;
	} catch (error) {
		console.error("Failed to cancel subscription:", error);
		return false;
	}
}

export interface RecordedPayment {
	/** payments.id of the (new or existing) row. */
	id: string;
	/**
	 * True only when this call moved the payment into 'succeeded' (new row, or a failed row that
	 * a retry paid). Revenue, metrics and receipts key off this so they happen exactly once.
	 */
	becameSucceeded: boolean;
}

/**
 * Record a payment, idempotently per Stripe payment intent (or, when there is no payment intent,
 * per invoice). Stripe retries a failed invoice on the SAME payment intent, so a later attempt
 * updates the existing row instead of tripping the UNIQUE constraint (which used to roll the
 * webhook back and 500 forever). A succeeded row is never downgraded by a late failure event.
 */
export function recordPayment(
	userId: string,
	stripePaymentIntentId: string | null,
	stripeInvoiceId: string | null,
	amountCents: number,
	status: string,
	paymentType: string,
	description?: string,
	metadata?: Record<string, unknown>,
): RecordedPayment {
	const db = getDb();
	const metadataJson = metadata ? JSON.stringify(metadata) : null;

	const previous = (
		stripePaymentIntentId
			? db.prepare("SELECT id, status FROM payments WHERE stripe_payment_intent_id = ?").get(stripePaymentIntentId)
			: stripeInvoiceId
				? db
						.prepare(
							"SELECT id, status FROM payments WHERE stripe_invoice_id = ? AND stripe_payment_intent_id IS NULL ORDER BY created_at DESC LIMIT 1",
						)
						.get(stripeInvoiceId)
				: undefined
	) as { id: string; status: string } | undefined | null;

	const becameSucceeded = status === "succeeded" && previous?.status !== "succeeded";
	// Used only when no row exists yet (an existing row keeps its id through the upsert).
	const newId = crypto.randomUUID();

	if (previous && !stripePaymentIntentId) {
		db.prepare(`
			UPDATE payments SET status = ?, amount_cents = ?, payment_type = ?,
				description = COALESCE(?, description), metadata = COALESCE(?, metadata)
			WHERE id = ? AND status <> 'succeeded'
		`).run(status, amountCents, paymentType, description ?? null, metadataJson, previous.id);
		return { id: previous.id, becameSucceeded };
	}

	db.prepare(`
		INSERT INTO payments (id, user_id, stripe_payment_intent_id, stripe_invoice_id, amount_cents, status, payment_type, description, metadata)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(stripe_payment_intent_id) DO UPDATE SET
			status = excluded.status,
			amount_cents = excluded.amount_cents,
			stripe_invoice_id = COALESCE(excluded.stripe_invoice_id, payments.stripe_invoice_id),
			payment_type = excluded.payment_type,
			description = COALESCE(excluded.description, payments.description),
			metadata = COALESCE(excluded.metadata, payments.metadata)
		WHERE payments.status <> 'succeeded'
	`).run(
		newId,
		userId,
		stripePaymentIntentId,
		stripeInvoiceId,
		amountCents,
		status,
		paymentType,
		description ?? null,
		metadataJson,
	);

	const id = previous?.id ?? newId;
	return { id, becameSucceeded };
}

// Record a revenue event
export function recordRevenueEvent(
	userId: string,
	eventType: string,
	amountCents: number,
	options?: {
		paymentId?: string;
		generationId?: string;
		description?: string;
		periodStart?: string;
		periodEnd?: string;
	},
): string {
	const db = getDb();
	const id = crypto.randomUUID();

	db.prepare(`
		INSERT INTO revenue_events (id, user_id, payment_id, generation_id, event_type, amount_cents, description, period_start, period_end)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
	`).run(
		id,
		userId,
		options?.paymentId || null,
		options?.generationId || null,
		eventType,
		amountCents,
		options?.description || null,
		options?.periodStart || null,
		options?.periodEnd || null,
	);

	return id;
}

/** Stripe statuses that grant the subscribed tier. Everything else falls back to Free. */
export const ENTITLED_STRIPE_STATUSES = new Set(["active", "trialing"]);

/**
 * Sync a Stripe subscription into user_subscriptions. Must be called inside a DB transaction
 * by the webhook handler.
 *
 * - Becoming entitled (active/trialing) retires the user's other active rows via
 *   assignSubscription (one active row per user).
 * - Non-entitled statuses (incomplete, past_due, canceled, unpaid...) are recorded but never
 *   retire the user's existing subscription and never grant credits.
 * - The product's welcome bonus is granted exactly once per row, the first time it is entitled
 *   (so a subscription that starts 'incomplete' gets its bonus when the payment succeeds).
 */
export function syncStripeSubscription(
	userId: string,
	productId: string,
	stripeSubscriptionId: string,
	status: string,
	periodStart: Date,
	periodEnd: Date,
): { subscriptionId: string; bonusGranted: number } {
	const db = getDb();
	const ps = periodStart.toISOString().split("T")[0];
	const pe = periodEnd.toISOString().split("T")[0];
	const entitled = ENTITLED_STRIPE_STATUSES.has(status);

	const existing = db
		.prepare("SELECT id, status, bonus_granted FROM user_subscriptions WHERE stripe_subscription_id = ?")
		.get(stripeSubscriptionId) as { id: string; status: string | null; bonus_granted: number } | undefined;

	let subscriptionId: string;
	let bonusAlreadyGranted: boolean;

	if (existing) {
		if (entitled && !ENTITLED_STRIPE_STATUSES.has(existing.status ?? "")) {
			// Newly entitled: retire whatever else is active for this user first
			db.prepare(
				`UPDATE user_subscriptions SET status = 'superseded', ends_at = COALESCE(ends_at, datetime('now'))
				WHERE user_id = ? AND id != ? AND status IN ('active', 'trialing')`,
			).run(userId, existing.id);
		}
		db.prepare(`
			UPDATE user_subscriptions
			SET product_id = ?, status = ?, current_period_start = ?, current_period_end = ?,
				ends_at = CASE WHEN ? THEN NULL ELSE ends_at END
			WHERE id = ?
		`).run(productId, status, ps, pe, entitled ? 1 : 0, existing.id);
		subscriptionId = existing.id;
		bonusAlreadyGranted = existing.bonus_granted === 1;
	} else if (entitled) {
		subscriptionId = assignSubscription(userId, productId, {
			stripeSubscriptionId,
			status: status as "active" | "trialing",
			periodStart: ps,
			periodEnd: pe,
			grantBonus: false,
		});
		bonusAlreadyGranted = false;
	} else {
		subscriptionId = crypto.randomUUID();
		db.prepare(`
			INSERT INTO user_subscriptions
				(id, user_id, product_id, stripe_subscription_id, status, current_period_start, current_period_end, bonus_granted)
			VALUES (?, ?, ?, ?, ?, ?, ?, 0)
		`).run(subscriptionId, userId, productId, stripeSubscriptionId, status, ps, pe);
		bonusAlreadyGranted = false;
	}

	let bonusGranted = 0;
	if (entitled && !bonusAlreadyGranted) {
		const product = db.prepare("SELECT bonus_credits FROM subscription_products WHERE id = ?").get(productId) as
			| { bonus_credits: number }
			| undefined;
		if (product && product.bonus_credits > 0) {
			addCredits(userId, product.bonus_credits, "bonus", "Subscription welcome bonus");
			bonusGranted = product.bonus_credits;
		}
		db.prepare("UPDATE user_subscriptions SET bonus_granted = 1 WHERE id = ?").run(subscriptionId);
	}

	return { subscriptionId, bonusGranted };
}

/** Does the user already have a live Stripe subscription (should manage it in the portal)? */
export function hasLiveStripeSubscription(userId: string): boolean {
	const row = getDb()
		.prepare(`
			SELECT 1 FROM user_subscriptions
			WHERE user_id = ? AND stripe_subscription_id IS NOT NULL
			AND status IN ('active', 'trialing', 'past_due', 'unpaid')
			LIMIT 1
		`)
		.get(userId);
	return !!row;
}

// Update user metrics after payment
export function updateUserMetrics(userId: string, amountCents: number): void {
	const db = getDb();

	// Check if user metrics exist
	const existing = db.prepare("SELECT user_id FROM user_metrics WHERE user_id = ?").get(userId);

	if (existing) {
		db.prepare(`
			UPDATE user_metrics
			SET total_paid_cents = total_paid_cents + ?,
				last_payment_at = datetime('now')
			WHERE user_id = ?
		`).run(amountCents, userId);
	} else {
		db.prepare(`
			INSERT INTO user_metrics (user_id, first_payment_at, last_payment_at, total_paid_cents)
			VALUES (?, datetime('now'), datetime('now'), ?)
		`).run(userId, amountCents);
	}
}

// Get product by Stripe price ID
export function getProductByStripePriceId(stripePriceId: string): {
	id: string;
	name: string;
	monthly_image_limit: number | null;
	monthly_cost_limit: number | null;
	bonus_credits: number;
} | null {
	const db = getDb();
	const result = db
		.prepare(
			"SELECT id, name, monthly_image_limit, monthly_cost_limit, bonus_credits FROM subscription_products WHERE stripe_price_id = ?",
		)
		.get(stripePriceId) as
		| {
				id: string;
				name: string;
				monthly_image_limit: number | null;
				monthly_cost_limit: number | null;
				bonus_credits: number;
		  }
		| undefined;

	return result || null;
}

// Get invoices for a user
export async function getUserInvoices(userId: string, limit = 10): Promise<Stripe.Invoice[]> {
	if (!stripe) return [];

	const customerId = getStripeCustomerId(userId);
	if (!customerId) return [];

	const invoices = await stripe.invoices.list({
		customer: customerId,
		limit,
	});

	return invoices.data;
}
