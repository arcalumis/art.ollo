import type { FastifyInstance } from "fastify";
import { getDb } from "../db";
import { authMiddleware } from "../middleware/auth";
import {
	createCheckoutSession,
	createCreditCheckoutSession,
	createPortalSession,
	getStripeCustomerId,
	getUserInvoices,
	getUserSubscription,
	isStripeConfigured,
} from "../services/stripe";
import { getAvailableCredits } from "../services/usage";

interface CheckoutBody {
	priceId: string;
	successUrl: string;
	cancelUrl: string;
}

interface PortalBody {
	returnUrl: string;
}

/**
 * Validates that a redirect URL belongs to the configured app domain.
 * Prevents open redirect attacks where an attacker supplies an external URL.
 */
function isAllowedRedirectUrl(url: string): boolean {
	const appUrl = process.env.APP_URL;
	if (!appUrl) {
		// Can't validate without APP_URL — fail closed
		console.warn("APP_URL not set; cannot validate redirect URL");
		return false;
	}
	try {
		const parsed = new URL(url);
		const allowed = new URL(appUrl);
		return parsed.hostname === allowed.hostname;
	} catch {
		return false;
	}
}

export async function billingRoutes(fastify: FastifyInstance): Promise<void> {
	// Check if Stripe is configured
	fastify.get("/api/billing/status", async () => {
		return {
			enabled: isStripeConfigured(),
		};
	});

	// Get user's billing info
	fastify.get("/api/billing", { preHandler: authMiddleware }, async (request) => {
		const userId = request.user?.userId;
		if (!userId) {
			return { error: "Unauthorized" };
		}

		const db = getDb();

		// Get current subscription
		const subscription = db
			.prepare(`
					SELECT
						us.id,
						us.status,
						us.current_period_start,
						us.current_period_end,
						us.last_credit_topoff_at,
						sp.name as plan_name,
						sp.price,
						sp.monthly_image_limit,
						sp.monthly_cost_limit,
						sp.credit_refill_amount,
						sp.topoff_interval_hours
					FROM user_subscriptions us
					JOIN subscription_products sp ON us.product_id = sp.id
					WHERE us.user_id = ? AND us.status IN ('active', 'trialing', 'past_due')
					ORDER BY us.created_at DESC
					LIMIT 1
				`)
			.get(userId) as
			| {
					id: string;
					status: string;
					current_period_start: string | null;
					current_period_end: string | null;
					last_credit_topoff_at: string | null;
					plan_name: string;
					price: number;
					monthly_image_limit: number | null;
					monthly_cost_limit: number | null;
					credit_refill_amount: number;
					topoff_interval_hours: number;
			  }
			| undefined;

		// Get current month usage
		const now = new Date();
		const yearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
		const usage = db
			.prepare(`
					SELECT image_count, total_cost
					FROM usage_monthly
					WHERE user_id = ? AND year_month = ?
				`)
			.get(userId, yearMonth) as { image_count: number; total_cost: number } | undefined;

		// Get total spent all time
		const totalSpent = db
			.prepare(`
					SELECT total_paid_cents
					FROM user_metrics
					WHERE user_id = ?
				`)
			.get(userId) as { total_paid_cents: number } | undefined;

		// Get recent payments
		const recentPayments = db
			.prepare(`
					SELECT id, amount_cents, currency, status, payment_type, description, created_at
					FROM payments
					WHERE user_id = ? AND status = 'succeeded'
					ORDER BY created_at DESC
					LIMIT 5
				`)
			.all(userId) as Array<{
			id: string;
			amount_cents: number;
			currency: string;
			status: string;
			payment_type: string;
			description: string | null;
			created_at: string;
		}>;

		// Get available credits
		const availableCredits = getAvailableCredits(userId);

		// Compute next refill time
		let nextRefillAt: string | null = null;
		if (subscription?.credit_refill_amount && subscription.credit_refill_amount > 0) {
			if (subscription.last_credit_topoff_at) {
				const lastTopoff = new Date(subscription.last_credit_topoff_at);
				const nextTopoff = new Date(lastTopoff.getTime() + (subscription.topoff_interval_hours || 24) * 60 * 60 * 1000);
				nextRefillAt = nextTopoff.toISOString();
			} else {
				// Never refilled -- next cleanup cycle will do it
				nextRefillAt = new Date().toISOString();
			}
		}

		return {
			availableCredits,
			subscription: subscription
				? {
						id: subscription.id,
						status: subscription.status,
						planName: subscription.plan_name,
						price: subscription.price,
						monthlyImageLimit: subscription.monthly_image_limit,
						monthlyCostLimit: subscription.monthly_cost_limit,
						creditRefillAmount: subscription.credit_refill_amount || 0,
						topoffIntervalHours: subscription.topoff_interval_hours || 24,
						nextRefillAt,
						periodStart: subscription.current_period_start,
						periodEnd: subscription.current_period_end,
					}
				: null,
			usage: {
				imageCount: usage?.image_count || 0,
				totalCost: usage?.total_cost || 0,
			},
			totalSpentCents: totalSpent?.total_paid_cents || 0,
			recentPayments: recentPayments.map((p) => ({
				id: p.id,
				amount: p.amount_cents / 100,
				currency: p.currency,
				status: p.status,
				type: p.payment_type,
				description: p.description,
				date: p.created_at,
			})),
			hasStripeCustomer: getStripeCustomerId(userId) !== null,
		};
	});

	// Get available subscription products
	fastify.get("/api/billing/products", async () => {
		const db = getDb();
		const products = db
			.prepare(`
				SELECT
					id,
					name,
					description,
					monthly_image_limit,
					monthly_cost_limit,
					credit_refill_amount,
					topoff_interval_hours,
					bonus_credits,
					price,
					price_sol,
					available_for_usd,
					available_for_sol,
					stripe_price_id,
					overage_price_cents,
					allowed_models
				FROM subscription_products
				WHERE is_active = 1
					AND stripe_price_id IS NOT NULL
				ORDER BY price ASC
			`)
			.all() as Array<{
			id: string;
			name: string;
			description: string | null;
			monthly_image_limit: number | null;
			monthly_cost_limit: number | null;
			credit_refill_amount: number;
			topoff_interval_hours: number;
			bonus_credits: number;
			price: number;
			price_sol: number | null;
			available_for_usd: number;
			available_for_sol: number;
			stripe_price_id: string | null;
			overage_price_cents: number;
			allowed_models: string | null;
		}>;

		return {
			products: products.map((p) => ({
				id: p.id,
				name: p.name,
				description: p.description,
				monthlyImageLimit: p.monthly_image_limit,
				monthlyCostLimit: p.monthly_cost_limit,
				creditRefillAmount: p.credit_refill_amount || 0,
				topoffIntervalHours: p.topoff_interval_hours || 24,
				bonusCredits: p.bonus_credits,
				price: p.price,
				priceSol: p.price_sol,
				availableForUsd: p.available_for_usd === 1,
				availableForSol: p.available_for_sol === 1,
				stripePriceId: p.stripe_price_id,
				overagePriceCents: p.overage_price_cents,
				allowedModels: p.allowed_models ? JSON.parse(p.allowed_models) : null,
			})),
		};
	});

	// Create checkout session
	fastify.post<{ Body: CheckoutBody }>(
		"/api/billing/checkout",
		{ preHandler: authMiddleware },
		async (request, reply) => {
			if (!isStripeConfigured()) {
				return reply.status(400).send({ error: "Billing is not configured" });
			}

			const userId = request.user?.userId;
			if (!userId) {
				return reply.status(401).send({ error: "Unauthorized" });
			}

			const { priceId, successUrl, cancelUrl } = request.body;

			if (!priceId || !successUrl || !cancelUrl) {
				return reply.status(400).send({ error: "Missing required fields" });
			}

			if (!isAllowedRedirectUrl(successUrl) || !isAllowedRedirectUrl(cancelUrl)) {
				return reply.status(400).send({ error: "Invalid redirect URL" });
			}

			const url = await createCheckoutSession(userId, priceId, successUrl, cancelUrl);

			if (!url) {
				return reply.status(500).send({ error: "Failed to create checkout session" });
			}

			return { url };
		},
	);

	// Create customer portal session
	fastify.post<{ Body: PortalBody }>(
		"/api/billing/portal",
		{ preHandler: authMiddleware },
		async (request, reply) => {
			if (!isStripeConfigured()) {
				return reply.status(400).send({ error: "Billing is not configured" });
			}

			const userId = request.user?.userId;
			if (!userId) {
				return reply.status(401).send({ error: "Unauthorized" });
			}

			const { returnUrl } = request.body;

			if (!returnUrl) {
				return reply.status(400).send({ error: "Missing return URL" });
			}

			if (!isAllowedRedirectUrl(returnUrl)) {
				return reply.status(400).send({ error: "Invalid return URL" });
			}

			const url = await createPortalSession(userId, returnUrl);

			if (!url) {
				return reply.status(400).send({
					error: "No billing account found. Please subscribe first.",
				});
			}

			return { url };
		},
	);

	// Get invoices (from Stripe)
	fastify.get("/api/billing/invoices", { preHandler: authMiddleware }, async (request, reply) => {
		if (!isStripeConfigured()) {
			// Return empty array if Stripe isn't configured
			return { invoices: [] };
		}

		const userId = request.user?.userId;
		if (!userId) {
			return reply.status(401).send({ error: "Unauthorized" });
		}

		const invoices = await getUserInvoices(userId);

		return {
			invoices: invoices.map((inv) => ({
				id: inv.id,
				number: inv.number,
				amount: (inv.amount_paid || 0) / 100,
				currency: inv.currency,
				status: inv.status,
				date: inv.created ? new Date(inv.created * 1000).toISOString() : null,
				pdfUrl: inv.invoice_pdf,
				hostedUrl: inv.hosted_invoice_url,
			})),
		};
	});

	// Get credit packages available for USD purchase
	fastify.get("/api/billing/credit-packages", async () => {
		const db = getDb();
		const packages = db
			.prepare(`
				SELECT id, name, credits, price_cents, stripe_price_id
				FROM solana_credit_packages
				WHERE is_active = 1 AND available_for_usd = 1 AND stripe_price_id IS NOT NULL AND price_cents IS NOT NULL
				ORDER BY credits ASC
			`)
			.all() as Array<{
			id: string;
			name: string;
			credits: number;
			price_cents: number;
			stripe_price_id: string;
		}>;

		return {
			packages: packages.map((p) => ({
				id: p.id,
				name: p.name,
				credits: p.credits,
				priceCents: p.price_cents,
				stripePriceId: p.stripe_price_id,
			})),
		};
	});

	// Create checkout session for one-time credit purchase
	fastify.post<{ Body: { packageId: string; successUrl: string; cancelUrl: string } }>(
		"/api/billing/credit-checkout",
		{ preHandler: authMiddleware },
		async (request, reply) => {
			if (!isStripeConfigured()) {
				return reply.status(400).send({ error: "Billing is not configured" });
			}

			const userId = request.user?.userId;
			if (!userId) {
				return reply.status(401).send({ error: "Unauthorized" });
			}

			const { packageId, successUrl, cancelUrl } = request.body;

			if (!packageId || !successUrl || !cancelUrl) {
				return reply.status(400).send({ error: "Missing required fields" });
			}

			if (!isAllowedRedirectUrl(successUrl) || !isAllowedRedirectUrl(cancelUrl)) {
				return reply.status(400).send({ error: "Invalid redirect URL" });
			}

			const url = await createCreditCheckoutSession(userId, packageId, successUrl, cancelUrl);

			if (!url) {
				return reply.status(400).send({ error: "Package not available for USD purchase or missing Stripe price" });
			}

			return { url };
		},
	);

	// Get active Stripe subscription details
	fastify.get(
		"/api/billing/subscription",
		{ preHandler: authMiddleware },
		async (request, reply) => {
			if (!isStripeConfigured()) {
				return reply.status(400).send({ error: "Billing is not configured" });
			}

			const userId = request.user?.userId;
			if (!userId) {
				return reply.status(401).send({ error: "Unauthorized" });
			}

			const subscription = await getUserSubscription(userId);

			if (!subscription) {
				return { subscription: null };
			}

			return {
				subscription: {
					id: subscription.id,
					status: subscription.status,
					cancelAtPeriodEnd: subscription.cancel_at_period_end,
					currentPeriodStart: new Date(subscription.current_period_start * 1000).toISOString(),
					currentPeriodEnd: new Date(subscription.current_period_end * 1000).toISOString(),
				},
			};
		},
	);
}
