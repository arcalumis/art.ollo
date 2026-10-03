import { describe, expect, test } from "bun:test";
import { getDb } from "../server/db";
import { initiatePayment } from "../server/services/solana";
import { createUser } from "./helpers";

// Regression: Stripe credit packs are stored with price_sol = 0 and
// available_for_sol = 0. Initiating a SOL payment for one used to create a
// 0-lamport payment that any dust transfer to the treasury could satisfy.
describe("SOL initiate refuses USD-only credit packs", () => {
	test("a Stripe pack can't be bought with SOL", () => {
		const db = getDb();
		db.prepare(
			`INSERT OR REPLACE INTO solana_credit_packages (id, name, credits, price_sol, price_cents, available_for_usd, available_for_sol, is_active)
			 VALUES ('stripe-pack-test', '1000 credits', 1000, 0, 6900, 1, 0, 1)`,
		).run();
		const user = createUser();
		expect(initiatePayment(user.id, "stripe-pack-test", "11111111111111111111111111111112")).toBeNull();
	});

	test("a SOL pack with a zero price can't be initiated either", () => {
		const db = getDb();
		db.prepare(
			`INSERT OR REPLACE INTO solana_credit_packages (id, name, credits, price_sol, available_for_usd, available_for_sol, is_active)
			 VALUES ('sol-free-test', 'broken', 50, 0, 0, 1, 1)`,
		).run();
		const user = createUser();
		expect(initiatePayment(user.id, "sol-free-test", "11111111111111111111111111111112")).toBeNull();
	});
});
