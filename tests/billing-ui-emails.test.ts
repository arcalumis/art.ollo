import "./inject-bun-fix";
import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import crypto from "node:crypto";
import { getDb } from "../server/db";
import { maybeSendLowCreditEmail, type OutgoingEmail, setEmailTransport } from "../server/services/email";
import * as stripeService from "../server/services/stripe";
import { deleteModelCreditCost, setModelCreditCost } from "../server/services/usage";
import { createUser, getApp } from "./helpers";

const WEBHOOK_SECRET = "whsec_test";
let fetchSpy: ReturnType<typeof spyOn>;
let sent: OutgoingEmail[] = [];

beforeAll(() => {
	fetchSpy = spyOn(globalThis, "fetch").mockImplementation((() => {
		throw new Error("network access in tests");
	}) as unknown as typeof fetch);
	setEmailTransport(async (mail) => {
		sent.push(mail);
		return { success: true };
	});
});
afterAll(() => {
	fetchSpy.mockRestore();
	setEmailTransport(null);
});
beforeEach(() => {
	sent = [];
});

const flush = () => Bun.sleep(10);

function rid(prefix: string): string {
	return `${prefix}_${crypto.randomBytes(6).toString("hex")}`;
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
	const client = stripeService.stripe;
	if (!client) throw new Error("Stripe test client missing");
	const signature = await client.webhooks.generateTestHeaderStringAsync({ payload, secret: WEBHOOK_SECRET });
	return app.inject({
		method: "POST",
		url: "/api/webhooks/stripe",
		headers: { "stripe-signature": signature, "content-type": "application/json" },
		payload,
	});
}

const mailTo = (to: string) => sent.filter((m) => m.to === to);

describe("payment receipts", () => {
	test("invoice.paid sends one receipt per invoice, even across repeated and distinct events", async () => {
		const user = createUser();
		const customer = linkCustomer(user.id);
		const invoice = {
			id: rid("in"),
			object: "invoice",
			customer,
			amount_paid: 1900,
			currency: "usd",
			number: "INV-1",
			billing_reason: "subscription_cycle",
		};
		const eventId = rid("evt");
		expect((await sendEvent("invoice.paid", invoice, eventId)).statusCode).toBe(200);
		expect((await sendEvent("invoice.paid", invoice, eventId)).statusCode).toBe(200); // same event retried
		expect((await sendEvent("invoice.paid", invoice)).statusCode).toBe(200); // same invoice, new event id
		await flush();

		const mails = mailTo(user.email);
		expect(mails.length).toBe(1);
		expect(mails[0].subject).toContain("$19.00");
		expect(mails[0].html).toContain("/billing");
		expect(mails[0].html).not.toMatch(/<img/i);
	});

	test("a zero-amount invoice sends no receipt", async () => {
		const user = createUser();
		const customer = linkCustomer(user.id);
		await sendEvent("invoice.paid", {
			id: rid("in"),
			object: "invoice",
			customer,
			amount_paid: 0,
			billing_reason: "subscription_create",
		});
		await flush();
		expect(mailTo(user.email).length).toBe(0);
	});

	test("a rolled-back event sends nothing", async () => {
		const user = createUser();
		const customer = linkCustomer(user.id);
		const spy = spyOn(stripeService, "updateUserMetrics").mockImplementation(() => {
			throw new Error("db exploded");
		});
		try {
			const res = await sendEvent("invoice.paid", {
				id: rid("in"),
				object: "invoice",
				customer,
				amount_paid: 900,
				billing_reason: "subscription_cycle",
			});
			expect(res.statusCode).toBe(500);
		} finally {
			spy.mockRestore();
		}
		await flush();
		expect(mailTo(user.email).length).toBe(0);
	});

	test("a paid credit-pack checkout sends a receipt once", async () => {
		const user = createUser();
		const customer = linkCustomer(user.id);
		const session = {
			id: rid("cs"),
			object: "checkout.session",
			mode: "payment",
			payment_status: "paid",
			customer,
			amount_total: 800,
			currency: "usd",
			payment_intent: rid("pi"),
			metadata: { user_id: user.id, credits: "100", package_id: "stripe-pack-100" },
		};
		await sendEvent("checkout.session.completed", session);
		await sendEvent("checkout.session.completed", session);
		await flush();
		const mails = mailTo(user.email);
		expect(mails.length).toBe(1);
		expect(mails[0].subject).toContain("$8.00");
		expect(mails[0].html).toContain("100 credits");
	});

	test("invoice.payment_failed sends a failure email linking to /billing", async () => {
		const user = createUser();
		const customer = linkCustomer(user.id);
		const invoice = { id: rid("in"), object: "invoice", customer, amount_due: 3900, currency: "usd", number: "INV-2" };
		await sendEvent("invoice.payment_failed", invoice);
		await sendEvent("invoice.payment_failed", invoice);
		await flush();
		const mails = mailTo(user.email);
		expect(mails.length).toBe(1);
		expect(mails[0].subject).toBe("Your ollo.art payment didn't go through");
		expect(mails[0].html).toContain("http://localhost:5173/billing");
		expect(mails[0].html).toContain("$39.00");
	});
});

describe("low-credit email", () => {
	test("sent below 5 credits, throttled for 7 days, then sent again", async () => {
		const user = createUser();
		await maybeSendLowCreditEmail(user.id, 5);
		expect(mailTo(user.email).length).toBe(0);

		await maybeSendLowCreditEmail(user.id, 3);
		expect(mailTo(user.email).length).toBe(1);
		expect(mailTo(user.email)[0].html).toContain("/pricing");

		await maybeSendLowCreditEmail(user.id, 1);
		expect(mailTo(user.email).length).toBe(1);

		getDb()
			.prepare("UPDATE users SET low_credit_email_at = datetime('now', '-8 days') WHERE id = ?")
			.run(user.id);
		await maybeSendLowCreditEmail(user.id, 1);
		expect(mailTo(user.email).length).toBe(2);
	});

	test("concurrent triggers send only one email", async () => {
		const user = createUser();
		await Promise.all([maybeSendLowCreditEmail(user.id, 2), maybeSendLowCreditEmail(user.id, 2)]);
		expect(mailTo(user.email).length).toBe(1);
	});
});

describe("credit costs", () => {
	const model = "black-forest-labs/flux-2-dev";
	afterAll(() => {
		deleteModelCreditCost(model);
	});

	test("/api/models/credit-costs and /api/models reflect admin overrides", async () => {
		const app = await getApp();
		const before = (await app.inject({ method: "GET", url: "/api/models/credit-costs" })).json();
		expect(before.defaultModel).toBe(model);
		expect(before.costs[model]).toBe(2);
		expect(before.costs["google/nano-banana-2"]).toBe(3);
		expect(before.costs["google/nano-banana-pro"]).toBeUndefined();

		setModelCreditCost(model, 7);
		const after = (await app.inject({ method: "GET", url: "/api/models/credit-costs" })).json();
		expect(after.costs[model]).toBe(7);

		const models = (await app.inject({ method: "GET", url: "/api/models" })).json().models as Array<{
			id: string;
			creditCost: number;
		}>;
		expect(models.find((m) => m.id === model)?.creditCost).toBe(7);
		expect(models.every((m) => typeof m.creditCost === "number")).toBe(true);
	});

	test("the admin endpoint override shows up in credit costs", async () => {
		const app = await getApp();
		const admin = createUser({ isAdmin: true });
		const res = await app.inject({
			method: "PATCH",
			url: `/api/admin/model-costs/${encodeURIComponent(model)}`,
			headers: { authorization: `Bearer ${admin.token}` },
			payload: { creditCost: 4 },
		});
		expect(res.statusCode).toBe(200);
		const costs = (await app.inject({ method: "GET", url: "/api/models/credit-costs" })).json().costs;
		expect(costs[model]).toBe(4);
	});
});

describe("public products", () => {
	test("hides internal limits and reports the Free tier", async () => {
		const app = await getApp();
		getDb()
			.prepare(
				`INSERT INTO subscription_products (id, name, price, is_active, stripe_price_id, credit_refill_amount, monthly_cost_limit)
				VALUES (?, 'Creator', 19, 1, ?, 200, 12.5)`,
			)
			.run(crypto.randomUUID(), rid("price"));
		const body = (await app.inject({ method: "GET", url: "/api/billing/products" })).json();
		expect(body.products.length).toBeGreaterThan(0);
		for (const p of body.products) {
			expect(p).not.toHaveProperty("monthlyCostLimit");
			expect(p).not.toHaveProperty("monthlyImageLimit");
			expect(p).not.toHaveProperty("overagePriceCents");
		}
		expect(body.free?.name).toBe("Free");
		expect(typeof body.free?.creditRefillAmount).toBe("number");
	});
});
