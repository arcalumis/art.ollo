import type { FastifyInstance, FastifyRequest } from "fastify";
import rawBody from "fastify-raw-body";
import type Stripe from "stripe";
import { getDb } from "../db";
import { recordWebhookFailure } from "../services/admin-health";
import {
	STRIPE_WEBHOOK_SECRET,
	getProductByStripePriceId,
	getUserIdFromStripeCustomer,
	isStripeConfigured,
	recordPayment,
	recordRevenueEvent,
	stripe,
	syncStripeSubscription,
	updateUserMetrics,
} from "../services/stripe";
import { sendPaymentFailedOnce, sendReceiptOnce } from "../services/email";
import { addCredits } from "../services/usage";

/** Emails queued by a handler, sent only after its transaction commits. */
type Outbox = Array<() => Promise<void>>;

/**
 * Thrown when an event can't be applied yet but a retry could succeed (e.g. a paid subscription
 * whose price isn't mapped to a product, or a customer we can't map to a user). The handler
 * answers 500 so Stripe retries with backoff for up to 3 days, giving the operator time to fix
 * the mapping; Stripe's dashboard also flags the failing endpoint.
 */
export class RetryableWebhookError extends Error {}

/** Loud, greppable operator log for mapping problems. */
function alert(message: string, details: Record<string, unknown>): void {
	console.error(`[stripe-webhook][ALERT] ${message}`, JSON.stringify(details));
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
				// Must be the async variant: under Bun the Stripe SDK uses SubtleCrypto, and the
				// sync constructEvent() always throws ("cannot be used in a synchronous context").
				event = await stripe.webhooks.constructEventAsync(body, sig, STRIPE_WEBHOOK_SECRET);
			} catch (err) {
				const message = err instanceof Error ? err.message : "Unknown error";
				request.log.warn({ err: message }, "Stripe webhook signature verification failed");
				return reply.status(400).send({ error: "Webhook signature verification failed" });
			}

			try {
				const outcome = processStripeEvent(event);
				if (outcome === "duplicate") {
					request.log.info({ eventId: event.id, type: event.type }, "Duplicate Stripe webhook skipped");
				}
				return { received: true };
			} catch (error) {
				// Not marked processed (the transaction rolled back): answer 500 so Stripe retries.
				recordWebhookFailure(event.id, event.type, error);
				request.log.error(
					{ eventId: event.id, type: event.type, err: error instanceof Error ? error.message : String(error) },
					error instanceof RetryableWebhookError
						? "Stripe webhook could not be applied yet; asking Stripe to retry"
						: "Stripe webhook handler failed; asking Stripe to retry",
				);
				return reply.status(500).send({ error: "Webhook handler failed" });
			}
		},
	);
}

/**
 * Apply one event. Idempotency check, all DB effects and the processed marker run in a single
 * transaction: an exception rolls everything back so a retry starts clean (no double grants).
 */
export function processStripeEvent(event: Stripe.Event): "processed" | "duplicate" {
	const db = getDb();
	const outbox: Outbox = [];
	const outcome = db.transaction(() => {
		const seen = db.prepare("SELECT 1 FROM processed_webhook_events WHERE stripe_event_id = ?").get(event.id);
		if (seen) return "duplicate" as const;

		switch (event.type) {
			case "invoice.paid":
				handleInvoicePaid(event.data.object as Stripe.Invoice, outbox);
				break;
			case "invoice.payment_failed":
				handleInvoicePaymentFailed(event.data.object as Stripe.Invoice, outbox);
				break;
			case "customer.subscription.created":
			case "customer.subscription.updated":
				handleSubscriptionChange(event.data.object as Stripe.Subscription);
				break;
			case "customer.subscription.deleted":
				handleSubscriptionDeleted(event.data.object as Stripe.Subscription);
				break;
			case "checkout.session.completed":
			case "checkout.session.async_payment_succeeded":
				handleCheckoutCompleted(event.data.object as Stripe.Checkout.Session, outbox);
				break;
			default:
				console.log(`Unhandled Stripe event type: ${event.type}`);
		}

		db.prepare("INSERT OR IGNORE INTO processed_webhook_events (stripe_event_id, event_type) VALUES (?, ?)").run(
			event.id,
			event.type,
		);
		return "processed" as const;
	})();

	// Committed: now it is safe to email. Fire-and-forget; the send helpers never throw.
	if (outcome === "processed") {
		for (const send of outbox) void send();
	}
	return outcome;
}

// Fields present in our pinned API version (2024-12-18.acacia) but missing from the SDK's newer types.
type LegacyInvoice = Stripe.Invoice & {
	payment_intent?: string | { id: string } | null;
	subscription?: string | { id: string } | null;
};

function invoicePaymentIntentId(invoice: Stripe.Invoice): string | null {
	const pi = (invoice as LegacyInvoice).payment_intent;
	if (!pi) return null;
	return typeof pi === "string" ? pi : pi.id;
}

function invoiceSubscriptionId(invoice: Stripe.Invoice): string | null {
	const legacy = (invoice as LegacyInvoice).subscription;
	if (legacy) return typeof legacy === "string" ? legacy : legacy.id;
	const modern = (
		invoice as unknown as { parent?: { subscription_details?: { subscription?: string | { id: string } } } }
	).parent?.subscription_details?.subscription;
	if (!modern) return null;
	return typeof modern === "string" ? modern : modern.id;
}

function customerId(customer: string | { id: string } | null | undefined): string | null {
	if (!customer) return null;
	return typeof customer === "string" ? customer : customer.id;
}

// Bookkeeping event: an unmapped customer can't be fixed by retrying, so log loudly and ack.
function handleInvoicePaid(invoice: Stripe.Invoice, outbox: Outbox): void {
	const customer = customerId(invoice.customer as string | null);
	if (!customer) return;

	const userId = getUserIdFromStripeCustomer(customer);
	if (!userId) {
		alert("invoice.paid for unmapped Stripe customer (payment not recorded)", {
			customer,
			invoice: invoice.id,
			amount: invoice.amount_paid,
		});
		return;
	}

	const amountCents = invoice.amount_paid;
	const paymentType =
		invoice.billing_reason === "subscription_create" || invoice.billing_reason === "subscription_cycle"
			? "subscription"
			: "credit_purchase";

	const paymentId = recordPayment(
		userId,
		invoicePaymentIntentId(invoice),
		invoice.id ?? null,
		amountCents,
		"succeeded",
		paymentType,
		invoice.description || `Invoice ${invoice.number}`,
		{ billing_reason: invoice.billing_reason },
	);

	recordRevenueEvent(userId, paymentType, amountCents, {
		paymentId,
		description: `Invoice ${invoice.number}`,
		periodStart: invoice.period_start ? new Date(invoice.period_start * 1000).toISOString().split("T")[0] : undefined,
		periodEnd: invoice.period_end ? new Date(invoice.period_end * 1000).toISOString().split("T")[0] : undefined,
	});

	updateUserMetrics(userId, amountCents);
	console.log(`Recorded payment of ${amountCents} cents for user ${userId}`);

	if (amountCents > 0 && invoice.id) {
		const invoiceId = invoice.id;
		outbox.push(() =>
			sendReceiptOnce(userId, `receipt:${invoiceId}`, {
				amountCents,
				currency: invoice.currency || "usd",
				description: invoice.description || (paymentType === "subscription" ? "ollo.art subscription" : `Invoice ${invoice.number ?? invoiceId}`),
				date: invoice.created ? new Date(invoice.created * 1000) : new Date(),
				invoiceUrl: invoice.hosted_invoice_url ?? null,
			}),
		);
	}
}

function handleInvoicePaymentFailed(invoice: Stripe.Invoice, outbox: Outbox): void {
	const customer = customerId(invoice.customer as string | null);
	if (!customer) return;

	const userId = getUserIdFromStripeCustomer(customer);
	if (!userId) {
		alert("invoice.payment_failed for unmapped Stripe customer", { customer, invoice: invoice.id });
		return;
	}

	recordPayment(
		userId,
		invoicePaymentIntentId(invoice),
		invoice.id ?? null,
		invoice.amount_due,
		"failed",
		"subscription",
		`Failed: Invoice ${invoice.number}`,
	);

	// Only the subscription this invoice belongs to becomes past_due (never Free/admin rows).
	// customer.subscription.updated carries the same status change and is handled too.
	const subscriptionId = invoiceSubscriptionId(invoice);
	if (subscriptionId) {
		getDb()
			.prepare(
				"UPDATE user_subscriptions SET status = 'past_due' WHERE stripe_subscription_id = ? AND status IN ('active', 'trialing')",
			)
			.run(subscriptionId);
	}

	console.log(`Payment failed for user ${userId}, invoice ${invoice.id}`);

	if (invoice.id) {
		const invoiceId = invoice.id;
		outbox.push(() =>
			sendPaymentFailedOnce(userId, `failed:${invoiceId}`, {
				amountCents: invoice.amount_due,
				currency: invoice.currency || "usd",
			}),
		);
	}
}

/**
 * customer.subscription.created / .updated. Grants value (tier + bonus credits), so mapping
 * failures are retried rather than silently dropped.
 */
function handleSubscriptionChange(subscription: Stripe.Subscription): void {
	const customer = customerId(subscription.customer as string | null);
	if (!customer) return;

	const userId = getUserIdFromStripeCustomer(customer);
	if (!userId) {
		alert("Subscription event for unmapped Stripe customer", { customer, subscription: subscription.id });
		throw new RetryableWebhookError(`No user for Stripe customer ${customer}`);
	}

	const item = subscription.items.data[0];
	const priceId = item?.price.id;
	if (!priceId) {
		alert("Subscription has no price; ignoring", { subscription: subscription.id });
		return;
	}

	const product = getProductByStripePriceId(priceId);
	if (!product) {
		alert("Subscription price is not mapped to any subscription_products.stripe_price_id", {
			price: priceId,
			subscription: subscription.id,
			userId,
		});
		throw new RetryableWebhookError(`No product for Stripe price ${priceId}`);
	}

	const legacy = subscription as unknown as Record<string, number | undefined>;
	const periodStart = item?.current_period_start ?? legacy.current_period_start;
	const periodEnd = item?.current_period_end ?? legacy.current_period_end;
	if (!periodStart || !periodEnd) {
		alert("Subscription missing period dates; ignoring", { subscription: subscription.id });
		return;
	}

	const { bonusGranted } = syncStripeSubscription(
		userId,
		product.id,
		subscription.id,
		subscription.status,
		new Date(periodStart * 1000),
		new Date(periodEnd * 1000),
	);

	if (bonusGranted > 0) {
		console.log(`Granted ${bonusGranted} bonus credits to user ${userId} for subscription ${subscription.id}`);
	}
	console.log(`Synced subscription ${subscription.id} for user ${userId}: ${subscription.status}`);
}

function handleSubscriptionDeleted(subscription: Stripe.Subscription): void {
	const db = getDb();

	db.prepare(`
		UPDATE user_subscriptions
		SET status = 'canceled', ends_at = datetime('now')
		WHERE stripe_subscription_id = ?
	`).run(subscription.id);

	const customer = customerId(subscription.customer as string | null);
	const userId = customer ? getUserIdFromStripeCustomer(customer) : null;
	if (!userId) {
		alert("subscription.deleted for unmapped Stripe customer", { customer, subscription: subscription.id });
		return;
	}

	db.prepare("UPDATE user_metrics SET churned_at = datetime('now') WHERE user_id = ?").run(userId);
	console.log(`Subscription canceled for user ${userId}`);
}

function handleCheckoutCompleted(session: Stripe.Checkout.Session, outbox: Outbox): void {
	// Subscription-mode checkouts are handled by customer.subscription.* events.
	if (session.mode !== "payment") return;

	// Delayed payment methods complete checkout before the money arrives; the grant happens on
	// checkout.session.async_payment_succeeded instead.
	if (session.payment_status !== "paid") {
		console.log(`Checkout ${session.id} completed with payment_status=${session.payment_status}; not granting yet`);
		return;
	}

	const db = getDb();
	const customer = customerId(session.customer as string | null);
	const userId = session.metadata?.user_id || (customer ? getUserIdFromStripeCustomer(customer) : null);
	if (!userId || !db.prepare("SELECT 1 FROM users WHERE id = ?").get(userId)) {
		alert("Paid credit checkout can't be mapped to a user", { session: session.id, customer, userId });
		throw new RetryableWebhookError(`No user for checkout ${session.id}`);
	}

	const credits = Number(session.metadata?.credits);
	const packageId = session.metadata?.package_id;
	if (!Number.isInteger(credits) || credits <= 0) {
		alert("Paid credit checkout has invalid credits metadata", { session: session.id, metadata: session.metadata });
		throw new RetryableWebhookError(`Invalid credits metadata on ${session.id}`);
	}

	const paymentIntentId = typeof session.payment_intent === "string" ? session.payment_intent : null;
	if (paymentIntentId && db.prepare("SELECT 1 FROM payments WHERE stripe_payment_intent_id = ?").get(paymentIntentId)) {
		console.log(`Checkout ${session.id} already granted (payment intent ${paymentIntentId}); skipping`);
		return;
	}

	addCredits(userId, credits, "purchased", "Stripe credit purchase");

	const amountCents = session.amount_total || 0;
	const paymentId = recordPayment(
		userId,
		paymentIntentId,
		null,
		amountCents,
		"succeeded",
		"credit_purchase",
		`Credit purchase: ${credits} credits`,
		{ package_id: packageId, checkout_session: session.id },
	);

	recordRevenueEvent(userId, "credit_purchase", amountCents, {
		paymentId,
		description: `Stripe credit purchase: ${credits} credits`,
	});

	updateUserMetrics(userId, amountCents);
	console.log(`Granted ${credits} credits to user ${userId} via Stripe (${amountCents} cents)`);

	if (amountCents > 0) {
		outbox.push(() =>
			sendReceiptOnce(userId, `receipt:${session.id}`, {
				amountCents,
				currency: session.currency || "usd",
				description: `${credits} credits`,
				date: new Date(),
			}),
		);
	}
}
