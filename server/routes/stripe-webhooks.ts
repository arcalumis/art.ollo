import type { FastifyInstance, FastifyRequest } from "fastify";
import rawBody from "fastify-raw-body";
import type Stripe from "stripe";
import { getDb } from "../db";
import {
	STRIPE_WEBHOOK_SECRET,
	getProductByStripePriceId,
	getUserIdFromStripeCustomer,
	isStripeConfigured,
	recordPayment,
	recordRevenueEvent,
	stripe,
	updateUserMetrics,
	updateUserSubscription,
} from "../services/stripe";
import { addCredits } from "../services/usage";

function markEventProcessed(eventId: string, eventType: string): void {
	const db = getDb();
	db.prepare(
		"INSERT OR IGNORE INTO processed_webhook_events (stripe_event_id, event_type) VALUES (?, ?)",
	).run(eventId, eventType);
}

function isEventAlreadyProcessed(eventId: string): boolean {
	const db = getDb();
	const row = db
		.prepare("SELECT 1 FROM processed_webhook_events WHERE stripe_event_id = ?")
		.get(eventId);
	return row !== undefined;
}

export async function stripeWebhookRoutes(fastify: FastifyInstance): Promise<void> {
	if (!isStripeConfigured()) {
		console.log("Stripe not configured - webhook routes disabled");
		return;
	}

	// Register raw body plugin for webhook signature verification
	await fastify.register(rawBody, {
		field: "rawBody",
		global: false,
		runFirst: true,
		routes: ["/api/webhooks/stripe"],
	});

	fastify.post(
		"/api/webhooks/stripe",
		{
			config: {
				rawBody: true,
			},
		},
		async (request: FastifyRequest, reply) => {
			if (!stripe || !STRIPE_WEBHOOK_SECRET) {
				return reply.status(500).send({ error: "Stripe not configured" });
			}

			const sig = request.headers["stripe-signature"] as string;
			const body = (request as FastifyRequest & { rawBody: Buffer }).rawBody;

			let event: Stripe.Event;

			try {
				event = stripe.webhooks.constructEvent(body, sig, STRIPE_WEBHOOK_SECRET);
			} catch (err) {
				const message = err instanceof Error ? err.message : "Unknown error";
				console.error("Webhook signature verification failed:", message);
				return reply.status(400).send({ error: `Webhook Error: ${message}` });
			}

			// Idempotency check — Stripe delivers webhooks at least once, not exactly once
			if (isEventAlreadyProcessed(event.id)) {
				console.log(`Duplicate webhook event skipped: ${event.id} (${event.type})`);
				return { received: true };
			}

			// Handle the event
			try {
				switch (event.type) {
					case "invoice.paid":
						await handleInvoicePaid(event.data.object as Stripe.Invoice);
						break;

					case "invoice.payment_failed":
						await handleInvoicePaymentFailed(event.data.object as Stripe.Invoice);
						break;

					// New subscription: sync DB row AND grant bonus credits
					case "customer.subscription.created":
						await handleSubscriptionCreated(event.data.object as Stripe.Subscription);
						break;

					// Renewal/update: sync DB row only
					case "customer.subscription.updated":
						await handleSubscriptionUpdated(event.data.object as Stripe.Subscription);
						break;

					case "customer.subscription.deleted":
						await handleSubscriptionDeleted(event.data.object as Stripe.Subscription);
						break;

					case "checkout.session.completed":
						await handleCheckoutCompleted(event.data.object as Stripe.Checkout.Session);
						break;

					default:
						console.log(`Unhandled event type: ${event.type}`);
				}

				// Only mark processed after successful handling
				markEventProcessed(event.id, event.type);
			} catch (error) {
				console.error(`Error handling ${event.type}:`, error);
				// Don't mark as processed — Stripe will retry
			}

			return { received: true };
		},
	);
}

async function handleInvoicePaid(invoice: Stripe.Invoice): Promise<void> {
	if (!invoice.customer || typeof invoice.customer !== "string") return;

	const userId = getUserIdFromStripeCustomer(invoice.customer);
	if (!userId) {
		console.error("No user found for Stripe customer:", invoice.customer);
		return;
	}

	const amountCents = invoice.amount_paid;
	const paymentIntentId =
		typeof invoice.payment_intent === "string" ? invoice.payment_intent : null;

	// Use billing_reason to classify: subscription_create and subscription_cycle are subscriptions,
	// everything else is treated as a one-time charge. Avoid relying on 'manual' which is ambiguous.
	const paymentType =
		invoice.billing_reason === "subscription_create" ||
		invoice.billing_reason === "subscription_cycle"
			? "subscription"
			: "credit_purchase";

	// Record the payment
	const paymentId = recordPayment(
		userId,
		paymentIntentId,
		invoice.id,
		amountCents,
		"succeeded",
		paymentType,
		invoice.description || `Invoice ${invoice.number}`,
		{ billing_reason: invoice.billing_reason },
	);

	// Record revenue event
	recordRevenueEvent(userId, paymentType, amountCents, {
		paymentId,
		description: `Invoice ${invoice.number}`,
		periodStart: invoice.period_start
			? new Date(invoice.period_start * 1000).toISOString().split("T")[0]
			: undefined,
		periodEnd: invoice.period_end
			? new Date(invoice.period_end * 1000).toISOString().split("T")[0]
			: undefined,
	});

	// Update user metrics
	updateUserMetrics(userId, amountCents);

	console.log(`Recorded payment of ${amountCents} cents for user ${userId}`);
}

async function handleInvoicePaymentFailed(invoice: Stripe.Invoice): Promise<void> {
	if (!invoice.customer || typeof invoice.customer !== "string") return;

	const userId = getUserIdFromStripeCustomer(invoice.customer);
	if (!userId) return;

	const paymentIntentId =
		typeof invoice.payment_intent === "string" ? invoice.payment_intent : null;

	// Record failed payment
	recordPayment(
		userId,
		paymentIntentId,
		invoice.id,
		invoice.amount_due,
		"failed",
		"subscription",
		`Failed: Invoice ${invoice.number}`,
	);

	// Update subscription status
	const db = getDb();
	db.prepare(`
		UPDATE user_subscriptions
		SET status = 'past_due'
		WHERE user_id = ? AND status = 'active'
	`).run(userId);

	console.log(`Payment failed for user ${userId}, invoice ${invoice.id}`);
}

// Called only for customer.subscription.created — syncs DB and grants bonus credits
async function handleSubscriptionCreated(subscription: Stripe.Subscription): Promise<void> {
	if (!subscription.customer || typeof subscription.customer !== "string") return;

	const userId = getUserIdFromStripeCustomer(subscription.customer);
	if (!userId) {
		console.error("No user found for Stripe customer:", subscription.customer);
		return;
	}

	const priceId = subscription.items.data[0]?.price.id;
	if (!priceId) return;

	const product = getProductByStripePriceId(priceId);
	if (!product) {
		console.error("No product found for Stripe price:", priceId);
		return;
	}

	const item = subscription.items.data[0];
	const periodStart = item?.current_period_start ?? (subscription as unknown as Record<string, number>).current_period_start;
	const periodEnd = item?.current_period_end ?? (subscription as unknown as Record<string, number>).current_period_end;

	if (!periodStart || !periodEnd) {
		console.error(`Subscription ${subscription.id} missing period dates — skipping`);
		return;
	}

	updateUserSubscription(
		userId,
		product.id,
		subscription.id,
		subscription.status,
		new Date(periodStart * 1000),
		new Date(periodEnd * 1000),
	);

	// Grant bonus credits for new subscriptions
	if (product.bonus_credits > 0) {
		addCredits(userId, product.bonus_credits, "bonus", "Subscription welcome bonus");
		console.log(`Granted ${product.bonus_credits} bonus credits to user ${userId} for new subscription`);
	}

	console.log(`Created subscription for user ${userId}: ${subscription.status}`);
}

// Called only for customer.subscription.updated — syncs DB row, no bonus credits
async function handleSubscriptionUpdated(subscription: Stripe.Subscription): Promise<void> {
	if (!subscription.customer || typeof subscription.customer !== "string") return;

	const userId = getUserIdFromStripeCustomer(subscription.customer);
	if (!userId) {
		console.error("No user found for Stripe customer:", subscription.customer);
		return;
	}

	const priceId = subscription.items.data[0]?.price.id;
	if (!priceId) return;

	const product = getProductByStripePriceId(priceId);
	if (!product) {
		console.error("No product found for Stripe price:", priceId);
		return;
	}

	const item = subscription.items.data[0];
	const periodStart = item?.current_period_start ?? (subscription as unknown as Record<string, number>).current_period_start;
	const periodEnd = item?.current_period_end ?? (subscription as unknown as Record<string, number>).current_period_end;

	if (!periodStart || !periodEnd) {
		console.error(`Subscription ${subscription.id} missing period dates — skipping`);
		return;
	}

	updateUserSubscription(
		userId,
		product.id,
		subscription.id,
		subscription.status,
		new Date(periodStart * 1000),
		new Date(periodEnd * 1000),
	);

	console.log(`Updated subscription for user ${userId}: ${subscription.status}`);
}

async function handleSubscriptionDeleted(subscription: Stripe.Subscription): Promise<void> {
	if (!subscription.customer || typeof subscription.customer !== "string") return;

	const userId = getUserIdFromStripeCustomer(subscription.customer);
	if (!userId) return;

	const db = getDb();

	// Mark subscription as canceled
	db.prepare(`
		UPDATE user_subscriptions
		SET status = 'canceled', ends_at = datetime('now')
		WHERE stripe_subscription_id = ?
	`).run(subscription.id);

	// Update user metrics for churn tracking
	db.prepare(`
		UPDATE user_metrics
		SET churned_at = datetime('now')
		WHERE user_id = ?
	`).run(userId);

	console.log(`Subscription canceled for user ${userId}`);
}

async function handleCheckoutCompleted(session: Stripe.Checkout.Session): Promise<void> {
	console.log(`Checkout completed: ${session.id}, mode: ${session.mode}`);

	if (session.mode === "payment") {
		// One-time credit purchase
		const userId =
			session.metadata?.user_id ||
			(typeof session.customer === "string"
				? getUserIdFromStripeCustomer(session.customer)
				: null);

		if (!userId) {
			console.error("No user found for credit purchase checkout:", session.id);
			return;
		}

		const credits = Number(session.metadata?.credits);
		const packageId = session.metadata?.package_id;

		if (!credits || credits <= 0) {
			console.error("Invalid credits in checkout metadata:", session.metadata);
			return;
		}

		// Grant credits
		addCredits(userId, credits, "purchased", "Stripe credit purchase");

		// Record payment
		const amountCents = session.amount_total || 0;
		const paymentIntentId =
			typeof session.payment_intent === "string" ? session.payment_intent : null;

		const paymentId = recordPayment(
			userId,
			paymentIntentId,
			null,
			amountCents,
			"succeeded",
			"credit_purchase",
			`Credit purchase: ${credits} credits`,
			{ package_id: packageId },
		);

		// Record revenue event
		recordRevenueEvent(userId, "credit_purchase", amountCents, {
			paymentId,
			description: `Stripe credit purchase: ${credits} credits`,
		});

		// Update user metrics
		updateUserMetrics(userId, amountCents);

		console.log(`Granted ${credits} credits to user ${userId} via Stripe (${amountCents} cents)`);
	}
	// Subscription bonus credits are handled by customer.subscription.created webhook
}
