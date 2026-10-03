import "./inject-bun-fix";
import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { getDb } from "../server/db";
import { BACKFILL_SOURCE, backfillPlatformCosts, estimateHistoricalCost } from "../server/services/admin-cost-backfill";
import { getReconcileJob, startReconcileJob, waitForReconcileJob } from "../server/services/admin-maintenance";
import {
	expireEndedSubscriptions,
	listCurrentSubscriptions,
	loadSubscriptionRecords,
	paidSnapshot,
} from "../server/services/admin-subscriptions";
import { toSqlTime } from "../server/services/admin-time";
import { calculateMetrics, getRevenueByTier } from "../server/services/financial-reports";
import { authHeader, createUser, getApp } from "./helpers";

// Fixtures live in years no other test touches (2019-2021), so global sums stay exact.
const db = () => getDb();

function product(name: string, price: number): string {
	const id = randomUUID();
	db().prepare("INSERT INTO subscription_products (id, name, price, is_active) VALUES (?, ?, ?, 1)").run(id, name, price);
	return id;
}

function sub(opts: {
	userId: string;
	productId: string;
	status?: string;
	startsAt: string;
	endsAt?: string | null;
	periodEnd?: string | null;
	stripeId?: string | null;
}): string {
	const id = randomUUID();
	db()
		.prepare(`
			INSERT INTO user_subscriptions (id, user_id, product_id, status, starts_at, ends_at, current_period_end, stripe_subscription_id, created_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		`)
		.run(
			id,
			opts.userId,
			opts.productId,
			opts.status ?? "superseded",
			opts.startsAt,
			opts.endsAt ?? null,
			opts.periodEnd ?? null,
			opts.stripeId ?? null,
			opts.startsAt,
		);
	return id;
}

function solTx(userId: string, productId: string, subscriptionId: string, at: string) {
	db()
		.prepare(`
			INSERT INTO solana_subscription_transactions
				(id, user_id, product_id, wallet_address, transaction_signature, amount_lamports, amount_sol, status, subscription_id, verified_at, created_at)
			VALUES (?, ?, ?, 'w', ?, 100000000, 0.1, 'completed', ?, ?, ?)
		`)
		.run(randomUUID(), userId, productId, `sig_${randomUUID()}`, subscriptionId, at, at);
}

function revenue(userId: string, type: string, cents: number, at: string, description: string | null = null) {
	db()
		.prepare(
			"INSERT INTO revenue_events (id, user_id, event_type, amount_cents, description, created_at) VALUES (?, ?, ?, ?, ?, ?)",
		)
		.run(randomUUID(), userId, type, cents, description, at);
}

const utc = (s: string) => new Date(`${s}Z`);

describe("financial maths", () => {
	test("the first day of a range is included (SQLite times vs ISO bounds)", () => {
		const u = createUser();
		revenue(u.id, "credit_purchase", 500, "2019-03-01 00:00:05");
		revenue(u.id, "credit_purchase", 700, "2019-02-28 23:59:59");
		db()
			.prepare("INSERT INTO platform_costs (id, model, estimated_cost, created_at) VALUES (?, 'm', 0.25, '2019-03-01 00:10:00')")
			.run(randomUUID());
		const m = calculateMetrics(utc("2019-03-01T00:00:00"), utc("2019-04-01T00:00:00"));
		expect(m.revenue.total).toBe(5);
		expect(m.revenue.credits).toBe(5);
		expect(m.costs.platform).toBe(0.25);
		const feb = calculateMetrics(utc("2019-02-01T00:00:00"), utc("2019-03-01T00:00:00"));
		expect(feb.revenue.total).toBe(7);
	});

	test("overage revenue adds up, Stripe and SOL are split", () => {
		const u = createUser();
		revenue(u.id, "overage", 150, "2019-05-03 10:00:00");
		revenue(u.id, "overage", 250, "2019-05-04 10:00:00");
		revenue(u.id, "sol_subscription", 1300, "2019-05-05 10:00:00", "SOL subscription: 0.1 SOL");
		const m = calculateMetrics(utc("2019-05-01T00:00:00"), utc("2019-06-01T00:00:00"));
		expect(m.revenue.overage).toBe(4);
		expect(m.revenue.stripe).toBe(4);
		expect(m.revenue.sol).toBe(13);
		expect(m.revenue.subscription).toBe(13);
	});

	test("paid subscribers exclude Free, comped and boosted plans; Stripe counts at its price", () => {
		const free = (db().prepare("SELECT id FROM subscription_products WHERE name = 'Free' LIMIT 1").get() as { id: string }).id;
		const priced = product(`Starter ${randomUUID().slice(0, 4)}`, 9);
		const a = createUser();
		const b = createUser();
		const c = createUser();
		sub({ userId: a.id, productId: free, startsAt: "2020-01-01 00:00:00", endsAt: "2020-12-31 00:00:00" });
		// Admin-assigned priced plan (no Stripe id, no SOL payment): comped, not paid.
		sub({ userId: b.id, productId: priced, startsAt: "2020-01-01 00:00:00", endsAt: "2020-12-31 00:00:00" });
		sub({
			userId: c.id,
			productId: priced,
			startsAt: "2020-01-01 00:00:00",
			endsAt: "2020-12-31 00:00:00",
			stripeId: `sub_${randomUUID().slice(0, 6)}`,
		});
		const snap = paidSnapshot(utc("2020-06-15T00:00:00"));
		expect(snap.paidSubscribers).toBe(1);
		expect(snap.mrrCents).toBe(900);
		expect(snap.stripeMrrCents).toBe(900);
	});

	test("SOL subscription MRR is what was paid, normalized to a month, and only while it runs", () => {
		const boost = product(`SOL Boost ${randomUUID().slice(0, 4)}`, 0);
		const u = createUser();
		const sid = sub({
			userId: u.id,
			productId: boost,
			startsAt: "2021-03-01T00:00:00.000Z",
			endsAt: "2021-03-11 00:00:00", // superseded early...
			periodEnd: "2021-03-31T00:00:00.000Z", // ...but 30 days were paid for
		});
		solTx(u.id, boost, sid, "2021-03-01 00:00:00");
		revenue(u.id, "sol_subscription", 1500, "2021-03-01 00:00:30", "SOL subscription: 0.1 SOL");
		const rec = loadSubscriptionRecords().find((r) => r.id === sid);
		expect(rec?.source).toBe("sol");
		expect(rec?.monthlyValueCents).toBe(Math.round(1500 * (30.4375 / 30)));
		expect(paidSnapshot(utc("2021-03-05T00:00:00")).solMrrCents).toBe(rec?.monthlyValueCents ?? -1);
		expect(paidSnapshot(utc("2021-03-20T00:00:00")).solMrrCents).toBe(0);
	});

	test("expired SOL subscriptions leave MRR and the user moves to Free", () => {
		const boost = product(`SOL Boost ${randomUUID().slice(0, 4)}`, 0);
		const u = createUser();
		const start = new Date(Date.now() - 40 * 86_400_000);
		const end = new Date(Date.now() - 10 * 86_400_000);
		const sid = sub({
			userId: u.id,
			productId: boost,
			status: "active",
			startsAt: start.toISOString(),
			endsAt: end.toISOString(),
			periodEnd: end.toISOString(),
		});
		solTx(u.id, boost, sid, toSqlTime(start));
		revenue(u.id, "sol_subscription", 1300, toSqlTime(start), "SOL subscription: 0.1 SOL");

		// Before expiry the row is still status 'active' but its period is over: not paid.
		expect(listCurrentSubscriptions().find((s) => s.userId === u.id)?.mrrCents).toBe(0);
		expect(expireEndedSubscriptions()).toBeGreaterThanOrEqual(1);
		const row = db().prepare("SELECT status FROM user_subscriptions WHERE id = ?").get(sid) as { status: string };
		expect(row.status).toBe("expired");
		const current = listCurrentSubscriptions().find((s) => s.userId === u.id);
		expect(current?.plan).toBe("Free");
		expect(current?.source).toBe("free");
		// Idempotent.
		expect(db().prepare("SELECT COUNT(*) AS n FROM user_subscriptions WHERE user_id = ? AND status = 'active'").get(u.id)).toEqual({ n: 1 });
	});

	test("live MRR counts an active Stripe subscription and an unexpired SOL one", () => {
		const before = paidSnapshot();
		const pro = product(`Pro ${randomUUID().slice(0, 4)}`, 39);
		const boost = product(`SOL Boost ${randomUUID().slice(0, 4)}`, 0);
		const a = createUser();
		const b = createUser();
		sub({
			userId: a.id,
			productId: pro,
			status: "active",
			startsAt: toSqlTime(new Date(Date.now() - 86_400_000)),
			stripeId: `sub_${randomUUID().slice(0, 6)}`,
		});
		const start = new Date(Date.now() - 5 * 86_400_000);
		const end = new Date(start.getTime() + 30 * 86_400_000);
		const sid = sub({ userId: b.id, productId: boost, status: "active", startsAt: start.toISOString(), endsAt: end.toISOString(), periodEnd: end.toISOString() });
		solTx(b.id, boost, sid, toSqlTime(start));
		revenue(b.id, "sol_subscription", 3000, toSqlTime(start), "SOL subscription: 0.2 SOL");
		const after = paidSnapshot();
		expect(after.paidSubscribers - before.paidSubscribers).toBe(2);
		expect(after.stripeMrrCents - before.stripeMrrCents).toBe(3900);
		expect(after.solMrrCents - before.solMrrCents).toBe(Math.round(3000 * (30.4375 / 30)));
	});

	test("LTV is null (not enough data) instead of inventing 12 months", () => {
		const m = calculateMetrics(utc("2018-01-01T00:00:00"), utc("2018-02-01T00:00:00"));
		expect(m.avgRevenuePerUser).toBeNull();
		expect(m.ltv).toBeNull();
		expect(m.profit.margin).toBeNull();
	});

	test("revenue by plan attributes each payment to one plan, once", () => {
		const starter = product(`Starter ${randomUUID().slice(0, 4)}`, 9);
		const creator = product(`Creator ${randomUUID().slice(0, 4)}`, 19);
		const u = createUser();
		sub({ userId: u.id, productId: starter, startsAt: "2019-07-01 00:00:00", endsAt: "2019-07-10 00:00:00" });
		sub({ userId: u.id, productId: creator, startsAt: "2019-07-10 00:00:00", stripeId: "sub_x" });
		revenue(u.id, "subscription", 1900, "2019-07-15 00:00:00");
		const rows = getRevenueByTier(utc("2019-07-01T00:00:00"), utc("2019-08-01T00:00:00"));
		expect(rows).toHaveLength(1);
		expect(rows[0].revenue).toBe(19);
		expect(rows[0].tier.startsWith("Creator")).toBe(true);
	});
});

describe("platform cost backfill", () => {
	test("estimates from the catalog formula, tags rows, and is idempotent", () => {
		expect(
			estimateHistoricalCost({
				model: "google/nano-banana-pro",
				width: 1024,
				height: 1024,
				parameters: JSON.stringify({ resolution: "2K", imageInputs: [] }),
				cost: 0.2,
			}),
		).toBe(0.15);
		// Two outputs cost twice one.
		const one = estimateHistoricalCost({ model: "black-forest-labs/flux-2-dev", width: 1024, height: 1024, parameters: "{}", cost: 0 });
		const two = estimateHistoricalCost({
			model: "black-forest-labs/flux-2-dev",
			width: 1024,
			height: 1024,
			parameters: JSON.stringify({ images: [{}, {}] }),
			cost: 0,
		});
		expect(two).toBeCloseTo(one * 2, 10);

		const u = createUser();
		const gid = randomUUID();
		db()
			.prepare(
				"INSERT INTO generations (id, prompt, model, image_path, user_id, width, height, replicate_id, created_at) VALUES (?, 'p', 'black-forest-labs/flux-schnell', 'x.png', ?, 1024, 1024, 'r_1', '2019-09-01 12:00:00')",
			)
			.run(gid, u.id);
		expect(backfillPlatformCosts(db())).toBeGreaterThanOrEqual(1);
		const row = db().prepare("SELECT estimated_cost, actual_cost, source, created_at FROM platform_costs WHERE generation_id = ?").get(gid) as {
			estimated_cost: number;
			actual_cost: number | null;
			source: string;
			created_at: string;
		};
		expect(row).toEqual({ estimated_cost: 0.003, actual_cost: null, source: BACKFILL_SOURCE, created_at: "2019-09-01 12:00:00" });
		expect(backfillPlatformCosts(db())).toBe(0);
		const m = calculateMetrics(utc("2019-09-01T00:00:00"), utc("2019-10-01T00:00:00"));
		expect(m.costs.backfilled).toBeCloseTo(0.003, 10);
	});
});

describe("reconciliation job and date validation", () => {
	test("reconciliation runs in the background and never twice at once", async () => {
		let release: () => void = () => {};
		const gate = new Promise<void>((r) => {
			release = r;
		});
		const first = startReconcileJob("tester", async () => {
			await gate;
			return { processed: 2, reconciled: 2, errors: 0 };
		});
		expect(first.started).toBe(true);
		expect(first.job.status).toBe("running");
		const second = startReconcileJob("tester", async () => ({ processed: 0, reconciled: 0, errors: 0 }));
		expect(second.started).toBe(false);
		release();
		await waitForReconcileJob();
		expect(getReconcileJob()).toMatchObject({ status: "done", result: { processed: 2, reconciled: 2, errors: 0 } });
	});

	test("bad dates and periods are 400s, not 500s", async () => {
		const app = await getApp();
		const admin = createUser({ isAdmin: true });
		const get = (url: string) => app.inject({ method: "GET", url, headers: authHeader(admin), remoteAddress: "203.0.113.9" });
		expect((await get("/api/admin/financials/overview?period=custom&startDate=nope&endDate=2020-01-01")).statusCode).toBe(400);
		expect((await get("/api/admin/financials/overview?period=custom&startDate=2020-02-01&endDate=2020-01-01")).statusCode).toBe(400);
		expect((await get("/api/admin/financials/overview?period=forever")).statusCode).toBe(400);
		expect((await get("/api/admin/financials/comparison/weekly")).statusCode).toBe(400);
		expect((await get("/api/admin/financials/trend?type=hourly")).statusCode).toBe(400);
		const ok = await get("/api/admin/financials/overview?period=custom&startDate=2019-03-01&endDate=2019-04-01");
		expect(ok.statusCode).toBe(200);
		expect(ok.json().ltvNote).toBe("Not enough data");
		const snap = await app.inject({
			method: "POST",
			url: "/api/admin/financials/snapshot",
			headers: authHeader(admin),
			payload: { periodType: "weekly" },
			remoteAddress: "203.0.113.9",
		});
		expect(snap.statusCode).toBe(400);
	});
});
