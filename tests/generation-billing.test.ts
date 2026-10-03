import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, test } from "bun:test";
import { getDb } from "../server/db";
import { purgeTrashedGenerations } from "../server/services/cleanup";
import { getNonPurchasedBalance, processSubscriptionRefills } from "../server/services/usage";
import { addLedger, assignFree, installFakes, nextIp, PNG_BYTES } from "./generation-fakes";
import { authHeader, createUser, creditBalance, getApp } from "./helpers";

let imagesDir: string;
beforeAll(() => {
	({ imagesDir } = installFakes());
});

describe("Free tier refill", () => {
	test("migration set Free to 5 credits every 720h", () => {
		const free = getDb()
			.prepare("SELECT credit_refill_amount, topoff_interval_hours FROM subscription_products WHERE name = 'Free'")
			.get() as { credit_refill_amount: number; topoff_interval_hours: number };
		expect(free.credit_refill_amount).toBe(5);
		expect(free.topoff_interval_hours).toBe(720);
	});

	test("tops up to 5 after the interval, ignoring purchased credits", () => {
		// Paying user: bought 100, got 10 free, spent 12 -> balance 98, all of it purchased.
		const buyer = createUser();
		addLedger(buyer.id, 10, "initial");
		addLedger(buyer.id, 100, "purchased");
		addLedger(buyer.id, -12, "used");
		assignFree(buyer.id, "-721 hours");

		// Free user with 3 left.
		const freeUser = createUser();
		addLedger(freeUser.id, 10, "initial");
		addLedger(freeUser.id, -7, "used");
		assignFree(freeUser.id, "-721 hours");

		// Interval not elapsed yet.
		const early = createUser();
		assignFree(early.id, "-100 hours");

		// Already above target with free credits.
		const rich = createUser();
		addLedger(rich.id, 8, "bonus");
		assignFree(rich.id, "-721 hours");

		expect(getNonPurchasedBalance(buyer.id)).toBe(0);
		processSubscriptionRefills();

		expect(creditBalance(buyer.id)).toBe(98 + 5);
		expect(creditBalance(freeUser.id)).toBe(5);
		expect(creditBalance(early.id)).toBe(0);
		expect(creditBalance(rich.id)).toBe(8);

		// Not eligible again until the next interval.
		processSubscriptionRefills();
		expect(creditBalance(buyer.id)).toBe(103);
		expect(creditBalance(freeUser.id)).toBe(5);

		const log = getDb()
			.prepare("SELECT credits_added, balance_before, balance_after FROM credit_topoff_log WHERE user_id = ?")
			.all(buyer.id) as { credits_added: number; balance_before: number; balance_after: number }[];
		expect(log).toEqual([{ credits_added: 5, balance_before: 98, balance_after: 103 }]);
	});
});

describe("trash purge", () => {
	test("marks purged_at, deletes primary + grid files, keeps the row, hides it from history", async () => {
		const user = createUser();
		const names = [0, 1, 2, 3].map(() => `${randomUUID()}.png`);
		for (const n of names) fs.writeFileSync(path.join(imagesDir, n), PNG_BYTES);
		const genId = randomUUID();
		getDb()
			.prepare(
				`INSERT INTO generations (id, prompt, model, image_path, parameters, user_id, cost, deleted_at)
				VALUES (?, 'p', 'm', ?, ?, ?, 0.1, datetime('now', '-31 days'))`,
			)
			.run(
				genId,
				names[0],
				JSON.stringify({ images: names.map((n) => ({ id: n, url: `/images/${n}`, path: n })) }),
				user.id,
			);

		expect(purgeTrashedGenerations()).toBeGreaterThanOrEqual(1);

		for (const n of names) expect(fs.existsSync(path.join(imagesDir, n))).toBe(false);
		const row = getDb().prepare("SELECT purged_at, cost FROM generations WHERE id = ?").get(genId) as {
			purged_at: string | null;
			cost: number;
		};
		expect(row.purged_at).not.toBeNull();
		expect(row.cost).toBe(0.1);

		const app = await getApp();
		const trash = await app.inject({
			method: "GET",
			url: "/api/history?trash=true",
			headers: authHeader(user),
			remoteAddress: nextIp(),
		});
		expect(trash.json().generations).toHaveLength(0);
		expect(trash.json().totalCost).toBeCloseTo(0.1);

		// Idempotent: an already-purged row is not processed again.
		expect(purgeTrashedGenerations()).toBe(0);
	});
});
