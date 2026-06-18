import crypto from "node:crypto";
import Stripe from "stripe";
import { getDb } from "../db";

// Initialize Stripe client
const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
if (!stripeSecretKey) {
	console.warn("STRIPE_SECRET_KEY not set - billing features will be disabled");
}

export const stripe = stripeSecretKey
	? new Stripe(stripeSecretKey, { apiVersion: "2024-12-18.acacia" })
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

// Record a payment in the database
export function recordPayment(
	userId: string,
	stripePaymentIntentId: string | null,
	stripeInvoiceId: string | null,
	amountCents: number,
	status: string,
	paymentType: string,
	description?: string,
	metadata?: Record<string, unknown>,
): string {
	const db = getDb();
	const id = crypto.randomUUID();

	db.prepare(`
		INSERT INTO payments (id, user_id, stripe_payment_intent_id, stripe_invoice_id, amount_cents, status, payment_type, description, metadata)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
	`).run(
		id,
		userId,
		stripePaymentIntentId,
		stripeInvoiceId,
		amountCents,
		status,
		paymentType,
		description,
		metadata ? JSON.stringify(metadata) : null,
	);

	return id;
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

// Update user subscription in database
export function updateUserSubscription(
	userId: string,
	productId: string,
	stripeSubscriptionId: string,
	status: string,
	periodStart: Date,
	periodEnd: Date,
): void {
	const db = getDb();

	// Check for existing subscription
	const existing = db
		.prepare("SELECT id FROM user_subscriptions WHERE user_id = ? AND stripe_subscription_id = ?")
		.get(userId, stripeSubscriptionId) as { id: string } | undefined;

	if (existing) {
		// Update existing
		db.prepare(`
			UPDATE user_subscriptions
			SET product_id = ?, status = ?, current_period_start = ?, current_period_end = ?
			WHERE id = ?
		`).run(
			productId,
			status,
			periodStart.toISOString().split("T")[0],
			periodEnd.toISOString().split("T")[0],
			existing.id,
		);
	} else {
		// Create new
		const id = crypto.randomUUID();
		db.prepare(`
			INSERT INTO user_subscriptions (id, user_id, product_id, stripe_subscription_id, status, current_period_start, current_period_end)
			VALUES (?, ?, ?, ?, ?, ?, ?)
		`).run(
			id,
			userId,
			productId,
			stripeSubscriptionId,
			status,
			periodStart.toISOString().split("T")[0],
			periodEnd.toISOString().split("T")[0],
		);
	}
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
