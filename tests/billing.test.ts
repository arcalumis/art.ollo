import "./inject-bun-fix";
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import crypto from "node:crypto";
import { getDb } from "../server/db";
import { dedupeActiveSubscriptions, initializeSchema } from "../server/db/schema";
import { type OutgoingEmail, setEmailTransport } from "../server/services/email";
import * as stripeService from "../server/services/stripe";
import { assignSubscription, getUserSubscription } from "../server/services/usage";
import { authHeader, createUser, creditBalance, getApp } from "./helpers";

const WEBHOOK_SECRET = "whsec_test";
let fetchSpy: ReturnType<typeof spyOn>;

beforeAll(() => {
	fetchSpy = spyOn(globalThis, "fetch").mockImplementation((() => {
		throw new Error("network access in tests");
	}) as unknown as typeof fetch);
});
afterAll(() => fetchSpy.mockRestore());

function rid(prefix: string): string {
	return `${prefix}_${crypto.randomBytes(6).toString("hex")}`;
}

function makeProduct(opts: { bonus?: number; name?: string; allowedModels?: string[] } = {}) {
	const id = crypto.randomUUID();
	const priceId = rid("price");
	getDb()
		.prepare(`INSERT INTO subscription_products (id, name, bonus_credits, price, is_active, stripe_price_id, allowed_models)
			VALUES (?, ?, ?, 10, 1, ?, ?)`)
		.run(id, opts.name ?? rid("Plan"), opts.bonus ?? 0, priceId, opts.allowedModels ? JSON.stringify(opts.allowedModels) : null);
	return { id, priceId };
}

function linkCustomer(userId: string): string {
	const customer = rid("cus");
	getDb()
		.prepare("INSERT INTO stripe_customers (id, user_id, stripe_customer_id) VALUES (?, ?, ?)")
		.run(crypto.randomUUID(), userId, customer);
	return customer;
}

async function sendEvent(type: string, object: Record<string, unknown>, id = rid("evt")) {
	const app = await getApp();
	const payload = JSON.stringify({ id, object: "event", type, data: { object } });
	const signature = await stripeService.stripe!.webhooks.generateTestHeaderStringAsync({ payload, secret: WEBHOOK_SECRET });
	return app.inject({
		method: "POST",
		url: "/api/webhooks/stripe",
		headers: { "stripe-signature": signature, "content-type": "application/json" },
		payload,
	});
}

function subscriptionObject(opts: { sub: string; customer: string; priceId: string; status: string }) {
	const now = Math.floor(Date.now() / 1000);
	return {
		id: opts.sub,
		object: "subscription",
		customer: opts.customer,
		status: opts.status,
		items: {
			data: [{ price: { id: opts.priceId }, current_period_start: now, current_period_end: now + 30 * 86400 }],
		},
	};
}

function activeSubs(userId: string) {
	return getDb()
		.prepare("SELECT id, product_id, status, stripe_subscription_id FROM user_subscriptions WHERE user_id = ? AND status = 'active'")
		.all(userId) as Array<{ id: string; product_id: string; status: string; stripe_subscription_id: string | null }>;
}

function isProcessed(eventId: string): boolean {
	return !!getDb().prepare("SELECT 1 FROM processed_webhook_events WHERE stripe_event_id = ?").get(eventId);
}

describe("stripe webhooks", () => {
	test("rejects a bad signature with 400", async () => {
		const app = await getApp();
		const res = await app.inject({
			method: "POST",
			url: "/api/webhooks/stripe",
			headers: { "stripe-signature": "t=1,v1=bad", "content-type": "application/json" },
			payload: JSON.stringify({ id: "evt_x", type: "invoice.paid", data: { object: {} } }),
		});
		expect(res.statusCode).toBe(400);
	});

	test("a handler error returns 500 and leaves the event unprocessed so Stripe retries", async () => {
		const user = createUser();
		const customer = linkCustomer(user.id);
		const spy = spyOn(stripeService, "recordPayment").mockImplementation(() => {
			throw new Error("db exploded");
		});
		try {
			const eventId = rid("evt");
			const res = await sendEvent(
				"invoice.paid",
				{ id: rid("in"), object: "invoice", customer, amount_paid: 500, billing_reason: "subscription_cycle" },
				eventId,
			);
			expect(res.statusCode).toBe(500);
			expect(isProcessed(eventId)).toBe(false);
		} finally {
			spy.mockRestore();
		}
	});

	test("an unmapped price on a subscription is retried (500), then applies once mapped", async () => {
		const user = createUser();
		const customer = linkCustomer(user.id);
		const sub = rid("sub");
		const unmappedPrice = rid("price");
		const eventId = rid("evt");
		const obj = subscriptionObject({ sub, customer, priceId: unmappedPrice, status: "active" });

		const first = await sendEvent("customer.subscription.created", obj, eventId);
		expect(first.statusCode).toBe(500);
		expect(isProcessed(eventId)).toBe(false);

		const product = makeProduct();
		getDb().prepare("UPDATE subscription_products SET stripe_price_id = ? WHERE id = ?").run(unmappedPrice, product.id);
		const retry = await sendEvent("customer.subscription.created", obj, eventId);
		expect(retry.statusCode).toBe(200);
		expect(isProcessed(eventId)).toBe(true);
		expect(activeSubs(user.id).map((s) => s.stripe_subscription_id)).toEqual([sub]);
	});

	test("an incomplete subscription grants no bonus; becoming active grants it exactly once", async () => {
		const user = createUser();
		const customer = linkCustomer(user.id);
		const free = assignSubscription(user.id, (getDb().prepare("SELECT id FROM subscription_products WHERE name = 'Free'").get() as { id: string }).id);
		const product = makeProduct({ bonus: 50 });
		const sub = rid("sub");

		expect((await sendEvent("customer.subscription.created", subscriptionObject({ sub, customer, priceId: product.priceId, status: "incomplete" }))).statusCode).toBe(200);
		expect(creditBalance(user.id)).toBe(0);
		// The incomplete subscription does not displace the existing Free row
		expect(activeSubs(user.id).map((s) => s.id)).toEqual([free]);

		expect((await sendEvent("customer.subscription.updated", subscriptionObject({ sub, customer, priceId: product.priceId, status: "active" }))).statusCode).toBe(200);
		expect(creditBalance(user.id)).toBe(50);
		const active = activeSubs(user.id);
		expect(active).toHaveLength(1);
		expect(active[0].stripe_subscription_id).toBe(sub);

		// Renewal / later updates don't re-grant
		expect((await sendEvent("customer.subscription.updated", subscriptionObject({ sub, customer, priceId: product.priceId, status: "active" }))).statusCode).toBe(200);
		expect(creditBalance(user.id)).toBe(50);
	});

	test("a duplicate event is applied once", async () => {
		const user = createUser();
		const customer = linkCustomer(user.id);
		const product = makeProduct({ bonus: 7 });
		const eventId = rid("evt");
		const obj = subscriptionObject({ sub: rid("sub"), customer, priceId: product.priceId, status: "active" });
		await sendEvent("customer.subscription.created", obj, eventId);
		await sendEvent("customer.subscription.created", obj, eventId);
		expect(creditBalance(user.id)).toBe(7);
	});

	test("past_due falls back to the Free tier", async () => {
		const user = createUser();
		const customer = linkCustomer(user.id);
		const product = makeProduct({ name: "Pro Test", allowedModels: ["flux-2-pro"] });
		const sub = rid("sub");
		await sendEvent("customer.subscription.created", subscriptionObject({ sub, customer, priceId: product.priceId, status: "active" }));
		expect(getUserSubscription(user.id).product?.id).toBe(product.id);

		const res = await sendEvent("invoice.payment_failed", {
			id: rid("in"),
			object: "invoice",
			customer,
			subscription: sub,
			amount_due: 1000,
		});
		expect(res.statusCode).toBe(200);
		expect(getUserSubscription(user.id).product?.name).toBe("Free");

		// Payment recovered -> back to the paid tier
		await sendEvent("customer.subscription.updated", subscriptionObject({ sub, customer, priceId: product.priceId, status: "active" }));
		expect(getUserSubscription(user.id).product?.id).toBe(product.id);

		await sendEvent("customer.subscription.updated", subscriptionObject({ sub, customer, priceId: product.priceId, status: "canceled" }));
		expect(getUserSubscription(user.id).product?.name).toBe("Free");
	});

	test("invoice.payment_failed only touches that subscription, not Free/admin rows", async () => {
		const user = createUser();
		const customer = linkCustomer(user.id);
		const adminProduct = makeProduct();
		assignSubscription(user.id, adminProduct.id);
		await sendEvent("invoice.payment_failed", { id: rid("in"), object: "invoice", customer, subscription: rid("sub"), amount_due: 1 });
		expect(activeSubs(user.id).map((s) => s.product_id)).toEqual([adminProduct.id]);
	});

	test("credit-pack checkout grants only when paid, once per payment intent", async () => {
		const user = createUser();
		const customer = linkCustomer(user.id);
		const pi = rid("pi");
		const session = (payment_status: string) => ({
			id: rid("cs"),
			object: "checkout.session",
			mode: "payment",
			customer,
			payment_status,
			payment_intent: pi,
			amount_total: 999,
			metadata: { user_id: user.id, credits: "40", package_id: "pkg" },
		});
		expect((await sendEvent("checkout.session.completed", session("unpaid"))).statusCode).toBe(200);
		expect(creditBalance(user.id)).toBe(0);

		expect((await sendEvent("checkout.session.async_payment_succeeded", session("paid"))).statusCode).toBe(200);
		expect(creditBalance(user.id)).toBe(40);

		// A different event for the same payment intent doesn't double-grant
		expect((await sendEvent("checkout.session.completed", session("paid"))).statusCode).toBe(200);
		expect(creditBalance(user.id)).toBe(40);
	});
});

describe("invoice retries on the same payment intent", () => {
	function invoice(opts: { id: string; customer: string; pi: string; amount?: number }) {
		return {
			id: opts.id,
			object: "invoice",
			customer: opts.customer,
			payment_intent: opts.pi,
			subscription: rid("sub"),
			amount_paid: opts.amount ?? 1500,
			amount_due: opts.amount ?? 1500,
			billing_reason: "subscription_cycle",
			number: "INV-1",
			currency: "usd",
		};
	}
	function paymentRows(pi: string) {
		return getDb().prepare("SELECT id, status, amount_cents FROM payments WHERE stripe_payment_intent_id = ?").all(pi) as Array<{
			id: string;
			status: string;
			amount_cents: number;
		}>;
	}
	function revenueCount(userId: string): number {
		return (getDb().prepare("SELECT COUNT(*) AS n FROM revenue_events WHERE user_id = ?").get(userId) as { n: number }).n;
	}
	function totalPaid(userId: string): number {
		const row = getDb().prepare("SELECT total_paid_cents FROM user_metrics WHERE user_id = ?").get(userId) as
			| { total_paid_cents: number }
			| undefined;
		return row?.total_paid_cents ?? 0;
	}
	let mail: OutgoingEmail[] = [];
	beforeAll(() =>
		setEmailTransport(async (m) => {
			mail.push(m);
			return { success: true };
		}),
	);
	afterAll(() => setEmailTransport(null));
	beforeEach(() => {
		mail = [];
	});
	/** Receipts actually sent to this user (emails go out after the webhook commits). */
	async function receiptsSent(email: string): Promise<number> {
		await Bun.sleep(5);
		return mail.filter((m) => m.to === email && m.subject.includes("receipt")).length;
	}

	test("failed then paid: the failed row becomes succeeded, revenue recorded once", async () => {
		const user = createUser();
		const customer = linkCustomer(user.id);
		const inv = invoice({ id: rid("in"), customer, pi: rid("pi") });
		expect((await sendEvent("invoice.payment_failed", inv)).statusCode).toBe(200);
		expect(paymentRows(inv.payment_intent).map((r) => r.status)).toEqual(["failed"]);
		expect(revenueCount(user.id)).toBe(0);

		expect((await sendEvent("invoice.paid", inv)).statusCode).toBe(200);
		const rows = paymentRows(inv.payment_intent);
		expect(rows.map((r) => r.status)).toEqual(["succeeded"]);
		expect(revenueCount(user.id)).toBe(1);
		expect(totalPaid(user.id)).toBe(1500);
		expect(await receiptsSent(user.email)).toBe(1);
	});

	test("failed, failed, then paid all return 200 and end as one succeeded row", async () => {
		const user = createUser();
		const customer = linkCustomer(user.id);
		const inv = invoice({ id: rid("in"), customer, pi: rid("pi") });
		expect((await sendEvent("invoice.payment_failed", inv)).statusCode).toBe(200);
		expect((await sendEvent("invoice.payment_failed", inv)).statusCode).toBe(200);
		expect(paymentRows(inv.payment_intent)).toHaveLength(1);
		expect((await sendEvent("invoice.paid", inv)).statusCode).toBe(200);
		expect(paymentRows(inv.payment_intent).map((r) => r.status)).toEqual(["succeeded"]);
		expect(revenueCount(user.id)).toBe(1);
		expect(totalPaid(user.id)).toBe(1500);
	});

	test("invoice.paid delivered three times (distinct events) counts once; a late failure doesn't downgrade", async () => {
		const user = createUser();
		const customer = linkCustomer(user.id);
		const inv = invoice({ id: rid("in"), customer, pi: rid("pi") });
		for (let i = 0; i < 3; i++) expect((await sendEvent("invoice.paid", inv)).statusCode).toBe(200);
		expect(paymentRows(inv.payment_intent).map((r) => r.status)).toEqual(["succeeded"]);
		expect(revenueCount(user.id)).toBe(1);
		expect(totalPaid(user.id)).toBe(1500);
		expect(await receiptsSent(user.email)).toBe(1);

		expect((await sendEvent("invoice.payment_failed", inv)).statusCode).toBe(200);
		expect(paymentRows(inv.payment_intent).map((r) => r.status)).toEqual(["succeeded"]);
	});
});

describe("subscriptions", () => {
	test("assignSubscription retires the previous active row", () => {
		const user = createUser();
		const a = makeProduct();
		const b = makeProduct();
		assignSubscription(user.id, a.id);
		const second = assignSubscription(user.id, b.id);
		const active = activeSubs(user.id);
		expect(active.map((s) => s.id)).toEqual([second]);
		const superseded = getDb()
			.prepare("SELECT COUNT(*) AS n FROM user_subscriptions WHERE user_id = ? AND status = 'superseded'")
			.get(user.id) as { n: number };
		expect(superseded.n).toBe(1);
	});

	test("the unique index forbids two active rows", () => {
		const user = createUser();
		const p = makeProduct();
		assignSubscription(user.id, p.id);
		expect(() =>
			getDb()
				.prepare("INSERT INTO user_subscriptions (id, user_id, product_id, status) VALUES (?, ?, ?, 'active')")
				.run(crypto.randomUUID(), user.id, p.id),
		).toThrow();
	});

	test("dedupe migration on a fixture with 3 active rows leaves 1 (and is idempotent)", () => {
		const db = new Database(":memory:");
		initializeSchema(db);
		db.exec("DROP INDEX idx_user_subscriptions_one_active");

		const userId = crypto.randomUUID();
		db.prepare("INSERT INTO users (id, username, password_hash) VALUES (?, 'fixture', 'x')").run(userId);
		const free = (db.prepare("SELECT id FROM subscription_products WHERE name = 'Free'").get() as { id: string }).id;
		const paid = crypto.randomUUID();
		db.prepare("INSERT INTO subscription_products (id, name) VALUES (?, 'Premium')").run(paid);
		const insert = db.prepare(
			"INSERT INTO user_subscriptions (id, user_id, product_id, status, stripe_subscription_id, created_at) VALUES (?, ?, ?, 'active', ?, ?)",
		);
		insert.run("free-old", userId, free, null, "2026-01-01 00:00:00");
		insert.run("stripe-paid", userId, paid, "sub_123", "2026-01-02 00:00:00");
		insert.run("free-newest", userId, free, null, "2026-01-03 00:00:00");

		expect(dedupeActiveSubscriptions(db)).toBe(2);
		const active = db.prepare("SELECT id FROM user_subscriptions WHERE status = 'active'").all() as Array<{ id: string }>;
		expect(active.map((r) => r.id)).toEqual(["stripe-paid"]);
		const superseded = db.prepare("SELECT COUNT(*) AS n FROM user_subscriptions WHERE status = 'superseded'").get() as { n: number };
		expect(superseded.n).toBe(2);
		expect(db.prepare("SELECT COUNT(*) AS n FROM user_subscriptions").get()).toEqual({ n: 3 });

		expect(dedupeActiveSubscriptions(db)).toBe(0);
		// Re-running the whole schema init re-creates the index without error
		initializeSchema(db);
		db.close();
	});

	test("dedupe prefers a currently-effective non-Free row over newer Free", () => {
		const db = new Database(":memory:");
		initializeSchema(db);
		db.exec("DROP INDEX idx_user_subscriptions_one_active");
		const userId = crypto.randomUUID();
		db.prepare("INSERT INTO users (id, username, password_hash) VALUES (?, 'fixture2', 'x')").run(userId);
		const free = (db.prepare("SELECT id FROM subscription_products WHERE name = 'Free'").get() as { id: string }).id;
		const premium = crypto.randomUUID();
		db.prepare("INSERT INTO subscription_products (id, name) VALUES (?, 'Premium Tier')").run(premium);
		const insert = db.prepare(
			"INSERT INTO user_subscriptions (id, user_id, product_id, status, created_at, ends_at) VALUES (?, ?, ?, 'active', ?, ?)",
		);
		// Mirrors live data: Free ended when Premium was assigned
		insert.run("free", userId, free, "2026-02-03 20:55:04", "2026-02-03 20:59:07");
		insert.run("premium", userId, premium, "2026-02-03 20:59:07", null);
		dedupeActiveSubscriptions(db);
		expect(db.prepare("SELECT id FROM user_subscriptions WHERE status = 'active'").all()).toEqual([{ id: "premium" }]);
		db.close();
	});
});

describe("billing checkout guards", () => {
	test("rejects a priceId that isn't one of our active products", async () => {
		const app = await getApp();
		const user = createUser();
		const res = await app.inject({
			method: "POST",
			url: "/api/billing/checkout",
			headers: authHeader(user),
			payload: { priceId: "price_attacker", successUrl: "http://localhost:5173/ok", cancelUrl: "http://localhost:5173/no" },
		});
		expect(res.statusCode).toBe(400);
	});

	test("blocks a second subscription checkout and points to the portal", async () => {
		const app = await getApp();
		const user = createUser();
		const customer = linkCustomer(user.id);
		const product = makeProduct();
		await sendEvent("customer.subscription.created", subscriptionObject({ sub: rid("sub"), customer, priceId: product.priceId, status: "active" }));
		const res = await app.inject({
			method: "POST",
			url: "/api/billing/checkout",
			headers: authHeader(user),
			payload: { priceId: product.priceId, successUrl: "http://localhost:5173/ok", cancelUrl: "http://localhost:5173/no" },
		});
		expect(res.statusCode).toBe(409);
		expect(res.json().usePortal).toBe(true);
	});
});
