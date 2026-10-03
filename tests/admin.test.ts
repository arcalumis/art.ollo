import "./inject-bun-fix";
import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { getDb } from "../server/db";
import { recordWebhookFailure } from "../server/services/admin-health";
import { type OutgoingEmail, setEmailTransport } from "../server/services/email";
import { type TestUser, authHeader, createUser, creditBalance, getApp } from "./helpers";

let sent: OutgoingEmail[] = [];
let fetchSpy: ReturnType<typeof spyOn>;
let ipSeq = 0;
const ip = () => {
	ipSeq++;
	return `198.51.${Math.floor(ipSeq / 250)}.${(ipSeq % 250) + 1}`;
};

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

type Method = "GET" | "POST" | "PATCH" | "DELETE" | "PUT";

async function call(method: Method, url: string, user?: TestUser | null, payload?: Record<string, unknown>) {
	const app = await getApp();
	return app.inject({ method, url, headers: user ? authHeader(user) : {}, payload, remoteAddress: ip() });
}

function auditRows(targetId: string) {
	return getDb()
		.prepare("SELECT * FROM admin_audit_log WHERE target_id = ? ORDER BY rowid ASC")
		.all(targetId) as Array<{
		admin_user_id: string;
		action: string;
		before_json: string | null;
		after_json: string | null;
		reason: string | null;
		created_at: string;
	}>;
}

function freeProductId(): string {
	return (getDb().prepare("SELECT id FROM subscription_products WHERE name = 'Free' LIMIT 1").get() as { id: string }).id;
}

function makeProduct(name: string, price: number): string {
	const id = randomUUID();
	getDb()
		.prepare("INSERT INTO subscription_products (id, name, price, is_active) VALUES (?, ?, ?, 1)")
		.run(id, name, price);
	return id;
}

describe("admin authorization", () => {
	const routes: Array<[Method, string]> = [
		["GET", "/api/admin/overview"],
		["GET", "/api/admin/subscriptions"],
		["GET", "/api/admin/payments"],
		["GET", "/api/admin/models/economics"],
		["GET", "/api/admin/health"],
		["GET", "/api/admin/moderation/images"],
		["POST", "/api/admin/moderation/images/x/remove"],
		["GET", "/api/admin/audit"],
		["GET", "/api/admin/users"],
		["POST", "/api/admin/users"],
		["GET", "/api/admin/users/x"],
		["PATCH", "/api/admin/users/x"],
		["POST", "/api/admin/users/x/credits"],
		["POST", "/api/admin/users/x/subscription"],
		["POST", "/api/admin/users/x/sign-out"],
		["POST", "/api/admin/users/x/sign-in-link"],
		["POST", "/api/admin/users/x/boost"],
		["DELETE", "/api/admin/users/x/boost"],
		["GET", "/api/admin/products"],
		["POST", "/api/admin/products"],
		["PATCH", "/api/admin/products/x"],
		["GET", "/api/admin/credit-packages"],
		["POST", "/api/admin/credit-packages"],
		["PATCH", "/api/admin/credit-packages/x"],
		["PATCH", "/api/admin/model-costs/x"],
		["DELETE", "/api/admin/model-costs/x"],
		["GET", "/api/admin/financials/overview"],
		["POST", "/api/admin/financials/reconcile-costs"],
		["GET", "/api/admin/financials/reconcile-costs"],
		["POST", "/api/admin/financials/snapshot"],
	];

	test("every admin route rejects anonymous (401) and non-admin (403) callers", async () => {
		const user = createUser();
		for (const [method, url] of routes) {
			const anon = await call(method, url, null, method === "GET" ? undefined : {});
			expect([method, url, anon.statusCode]).toEqual([method, url, 401]);
			const res = await call(method, url, user, method === "GET" ? undefined : {});
			expect([method, url, res.statusCode]).toEqual([method, url, 403]);
		}
	});

	test("an admin can read every console view", async () => {
		const admin = createUser({ isAdmin: true });
		for (const url of [
			"/api/admin/overview",
			"/api/admin/subscriptions",
			"/api/admin/payments",
			"/api/admin/models/economics",
			"/api/admin/health",
			"/api/admin/moderation/images",
			"/api/admin/audit",
			"/api/admin/users?search=user_",
			`/api/admin/users/${admin.id}`,
		]) {
			const res = await call("GET", url, admin);
			expect([url, res.statusCode]).toEqual([url, 200]);
		}
	});

	test("history-rewriting and unused endpoints are gone", async () => {
		const admin = createUser({ isAdmin: true });
		expect((await call("POST", "/api/admin/costs/recalculate", admin, { dryRun: false })).statusCode).toBe(404);
		expect((await call("GET", "/api/admin/costs/pricing", admin)).statusCode).toBe(404);
		expect((await call("GET", "/api/admin/financials/sol-analysis", admin)).statusCode).toBe(404);
	});
});

describe("admin hardening: roles", () => {
	test("an admin cannot demote or deactivate themselves (regression)", async () => {
		const admin = createUser({ isAdmin: true });
		const demote = await call("PATCH", `/api/admin/users/${admin.id}`, admin, { isAdmin: false, reason: "testing" });
		expect(demote.statusCode).toBe(400);
		expect(demote.json().code).toBe("SELF_DEMOTION");
		const deactivate = await call("PATCH", `/api/admin/users/${admin.id}`, admin, { isActive: false, reason: "testing" });
		expect(deactivate.statusCode).toBe(400);
		expect(deactivate.json().code).toBe("SELF_DEACTIVATION");
		const row = getDb().prepare("SELECT is_admin, is_active FROM users WHERE id = ?").get(admin.id) as {
			is_admin: number;
			is_active: number;
		};
		expect(row).toEqual({ is_admin: 1, is_active: 1 });
	});

	test("the last admin who can sign in cannot be removed", async () => {
		const db = getDb();
		const actor = createUser({ isAdmin: true });
		const target = createUser({ isAdmin: true });
		// Make the target the only live admin: everyone else loses admin, the actor is soft-deleted
		// (a deleted account still holding a session must not strip the last real admin).
		db.prepare("UPDATE users SET is_admin = 0 WHERE is_admin = 1 AND id NOT IN (?, ?)").run(actor.id, target.id);
		db.prepare("UPDATE users SET deleted_at = datetime('now') WHERE id = ?").run(actor.id);
		const res = await call("PATCH", `/api/admin/users/${target.id}`, actor, { isAdmin: false, reason: "testing" });
		expect(res.statusCode).toBe(400);
		expect(res.json().code).toBe("LAST_ADMIN");
		db.prepare("UPDATE users SET deleted_at = NULL WHERE id = ?").run(actor.id);
		// With a second live admin, demotion works and is audited.
		const ok = await call("PATCH", `/api/admin/users/${target.id}`, actor, { isAdmin: false, reason: "role change" });
		expect(ok.statusCode).toBe(200);
		const audit = auditRows(target.id).at(-1);
		expect(audit?.action).toBe("user.revoke_admin");
		expect(JSON.parse(audit?.before_json ?? "{}").isAdmin).toBe(true);
		expect(JSON.parse(audit?.after_json ?? "{}").isAdmin).toBe(false);
		expect(audit?.reason).toBe("role change");
	});

	test("user changes need a reason", async () => {
		const admin = createUser({ isAdmin: true });
		const user = createUser();
		const res = await call("PATCH", `/api/admin/users/${user.id}`, admin, { isActive: false });
		expect(res.statusCode).toBe(400);
		expect(res.json().code).toBe("REASON_REQUIRED");
	});
});

describe("admin hardening: credits", () => {
	test("credit grants must be non-zero integers within ±10,000", async () => {
		const admin = createUser({ isAdmin: true });
		const user = createUser({ credits: 5 });
		for (const amount of [0, 1.5, 10_001, -10_001, "5", null]) {
			const res = await call("POST", `/api/admin/users/${user.id}/credits`, admin, { amount, reason: "test" });
			expect([amount, res.statusCode]).toEqual([amount, 400]);
		}
		expect(creditBalance(user.id)).toBe(5);
	});

	test("a deduction can never take the balance below 0", async () => {
		const admin = createUser({ isAdmin: true });
		const user = createUser({ credits: 5 });
		const res = await call("POST", `/api/admin/users/${user.id}/credits`, admin, { amount: -6, reason: "clawback" });
		expect(res.statusCode).toBe(400);
		expect(res.json().code).toBe("NEGATIVE_BALANCE");
		expect(creditBalance(user.id)).toBe(5);
		const ok = await call("POST", `/api/admin/users/${user.id}/credits`, admin, { amount: -5, reason: "clawback" });
		expect(ok.statusCode).toBe(200);
		expect(creditBalance(user.id)).toBe(0);
	});

	test("a grant updates the balance and writes an audit row with before/after and reason", async () => {
		const admin = createUser({ isAdmin: true });
		const user = createUser({ credits: 3 });
		const res = await call("POST", `/api/admin/users/${user.id}/credits`, admin, { amount: 10_000, reason: "goodwill" });
		expect(res.statusCode).toBe(200);
		expect(res.json().newBalance).toBe(10_003);
		const [row] = auditRows(user.id);
		expect(row.action).toBe("credits.grant");
		expect(row.admin_user_id).toBe(admin.id);
		expect(JSON.parse(row.before_json ?? "{}")).toEqual({ balance: 3 });
		expect(JSON.parse(row.after_json ?? "{}")).toEqual({ balance: 10_003, amount: 10_000 });
		expect(row.reason).toBe("goodwill");
		expect(row.created_at).toBeTruthy();
	});
});

describe("admin hardening: boosts and plans", () => {
	test("boost durations are 1 to 365 whole days", async () => {
		const admin = createUser({ isAdmin: true });
		const user = createUser();
		const productId = makeProduct(`Boost ${randomUUID().slice(0, 6)}`, 0);
		for (const durationDays of [0, 366, 1.5, -3, "30"]) {
			const res = await call("POST", `/api/admin/users/${user.id}/boost`, admin, { productId, durationDays, reason: "comp" });
			expect([durationDays, res.statusCode]).toEqual([durationDays, 400]);
		}
		const ok = await call("POST", `/api/admin/users/${user.id}/boost`, admin, { productId, durationDays: 365, reason: "comp" });
		expect(ok.statusCode).toBe(200);
		expect(auditRows(user.id).at(-1)?.action).toBe("boost.grant");
	});

	test("a Stripe-billed plan cannot be changed from the console", async () => {
		const admin = createUser({ isAdmin: true });
		const user = createUser();
		const starter = makeProduct(`Starter ${randomUUID().slice(0, 6)}`, 9);
		getDb()
			.prepare(
				"INSERT INTO user_subscriptions (id, user_id, product_id, status, stripe_subscription_id) VALUES (?, ?, ?, 'active', ?)",
			)
			.run(randomUUID(), user.id, starter, `sub_${randomUUID().slice(0, 8)}`);
		const res = await call("POST", `/api/admin/users/${user.id}/subscription`, admin, {
			productId: freeProductId(),
			reason: "downgrade",
		});
		expect(res.statusCode).toBe(409);
		expect(res.json().code).toBe("STRIPE_MANAGED");
	});

	test("a plan change is audited and grants no bonus unless asked", async () => {
		const admin = createUser({ isAdmin: true });
		const user = createUser({ credits: 1 });
		const plan = randomUUID();
		getDb()
			.prepare("INSERT INTO subscription_products (id, name, price, bonus_credits, is_active) VALUES (?, ?, 0, 50, 1)")
			.run(plan, `Comp ${plan.slice(0, 6)}`);
		const res = await call("POST", `/api/admin/users/${user.id}/subscription`, admin, { productId: plan, reason: "comp" });
		expect(res.statusCode).toBe(200);
		expect(creditBalance(user.id)).toBe(1);
		expect(auditRows(user.id).at(-1)?.action).toBe("subscription.change");
	});
});

describe("admin sessions and sign-in links", () => {
	test("sign out everywhere revokes the user's sessions", async () => {
		const admin = createUser({ isAdmin: true });
		const user = createUser();
		expect((await call("GET", "/api/me", user)).statusCode).toBe(200);
		const res = await call("POST", `/api/admin/users/${user.id}/sign-out`, admin, { reason: "lost device" });
		expect(res.statusCode).toBe(200);
		expect((await call("GET", "/api/me", user)).statusCode).toBe(401);
		expect(auditRows(user.id).at(-1)?.action).toBe("user.sign_out_everywhere");
	});

	test("creating a user emails a sign-in link and never returns a password", async () => {
		const admin = createUser({ isAdmin: true });
		const email = `made_${randomUUID().slice(0, 8)}@example.com`;
		const res = await call("POST", "/api/admin/users", admin, { username: `made_${randomUUID().slice(0, 6)}`, email });
		expect(res.statusCode).toBe(200);
		const body = res.json();
		expect(body.generatedPassword).toBeUndefined();
		expect(body.linkSent).toBe(true);
		expect(sent).toHaveLength(1);
		expect(sent[0].to).toBe(email);
		expect(sent[0].devLink).toContain("/auth/magic-link?token=");
		expect(auditRows(body.id)[0].action).toBe("user.create");
	});

	test("sign-in links respect the per-recipient email cap", async () => {
		const admin = createUser({ isAdmin: true });
		const user = createUser();
		const codes: number[] = [];
		for (let i = 0; i < 4; i++) {
			codes.push((await call("POST", `/api/admin/users/${user.id}/sign-in-link`, admin, { reason: "support" })).statusCode);
		}
		expect(codes).toEqual([200, 200, 200, 429]);
		expect(sent).toHaveLength(3);
	});
});

describe("credit packages", () => {
	const base = { name: "Pack", credits: 100 };

	test("a SOL pack needs a SOL price above 0", async () => {
		const admin = createUser({ isAdmin: true });
		for (const priceSol of [0, -0.1, null, "0.1"]) {
			const res = await call("POST", "/api/admin/credit-packages", admin, { ...base, availableForSol: true, priceSol });
			expect([priceSol, res.statusCode]).toEqual([priceSol, 400]);
		}
		const ok = await call("POST", "/api/admin/credit-packages", admin, { ...base, availableForSol: true, priceSol: 0.2 });
		expect(ok.statusCode).toBe(201);
		expect(ok.json().availableForSol).toBe(true);
	});

	test("a USD-only pack needs whole cents but no SOL price, and is not sold for SOL", async () => {
		const admin = createUser({ isAdmin: true });
		const bad = await call("POST", "/api/admin/credit-packages", admin, { ...base, availableForUsd: true, priceCents: 9.5 });
		expect(bad.statusCode).toBe(400);
		const res = await call("POST", "/api/admin/credit-packages", admin, { ...base, availableForUsd: true, priceCents: 900 });
		expect(res.statusCode).toBe(201);
		const pkg = res.json();
		expect(pkg.availableForSol).toBe(false);
		const row = getDb()
			.prepare("SELECT available_for_sol, price_sol FROM solana_credit_packages WHERE id = ?")
			.get(pkg.id) as { available_for_sol: number; price_sol: number };
		expect(row.available_for_sol).toBe(0);

		// Turning SOL on later still needs a real SOL price.
		const enable = await call("PATCH", `/api/admin/credit-packages/${pkg.id}`, admin, { availableForSol: true });
		expect(enable.statusCode).toBe(400);
		expect(enable.json().code).toBe("INVALID_PRICE_SOL");
	});

	test("credits must be a positive integer and a SOL pack's price can't be edited to 0", async () => {
		const admin = createUser({ isAdmin: true });
		for (const credits of [0, -5, 2.5]) {
			const res = await call("POST", "/api/admin/credit-packages", admin, { name: "X", credits, availableForSol: true, priceSol: 1 });
			expect([credits, res.statusCode]).toEqual([credits, 400]);
		}
		const created = await call("POST", "/api/admin/credit-packages", admin, { ...base, availableForSol: true, priceSol: 0.3 });
		const id = created.json().id;
		const zero = await call("PATCH", `/api/admin/credit-packages/${id}`, admin, { priceSol: 0 });
		expect(zero.statusCode).toBe(400);
		const row = getDb().prepare("SELECT price_sol FROM solana_credit_packages WHERE id = ?").get(id) as { price_sol: number };
		expect(row.price_sol).toBe(0.3);
		expect(auditRows(id)[0].action).toBe("credit_package.create");
	});
});

describe("model credit-cost overrides", () => {
	const model = "black-forest-labs/flux-2-dev";

	test("only positive integers are accepted", async () => {
		const admin = createUser({ isAdmin: true });
		for (const creditCost of [0, -1, 1.5, "3", null]) {
			const res = await call("PATCH", `/api/admin/model-costs/${encodeURIComponent(model)}`, admin, { creditCost });
			expect([creditCost, res.statusCode]).toEqual([creditCost, 400]);
		}
	});

	test("per-tier keys work, unknown models and tiers are rejected, changes are audited", async () => {
		const admin = createUser({ isAdmin: true });
		const key = `${model}:standard`;
		const ok = await call("PATCH", `/api/admin/model-costs/${encodeURIComponent(key)}`, admin, { creditCost: 3 });
		expect(ok.statusCode).toBe(200);
		const row = getDb().prepare("SELECT credit_cost FROM model_credit_costs WHERE model_id = ?").get(key) as {
			credit_cost: number;
		};
		expect(row.credit_cost).toBe(3);
		expect(auditRows(key)[0].action).toBe("model_cost.set");
		expect(
			(await call("PATCH", `/api/admin/model-costs/${encodeURIComponent("nope/model")}`, admin, { creditCost: 3 })).statusCode,
		).toBe(400);
		expect(
			(await call("PATCH", `/api/admin/model-costs/${encodeURIComponent(`${model}:ultra`)}`, admin, { creditCost: 3 })).json()
				.code,
		).toBe("UNKNOWN_MODEL");
		const reset = await call("DELETE", `/api/admin/model-costs/${encodeURIComponent(key)}`, admin);
		expect(reset.statusCode).toBe(200);
		expect(auditRows(key).at(-1)?.action).toBe("model_cost.reset");
	});
});

describe("moderation and audit log", () => {
	test("removing an image soft-deletes it, revokes share links and is audited", async () => {
		const db = getDb();
		const admin = createUser({ isAdmin: true });
		const owner = createUser();
		const genId = randomUUID();
		db.prepare("INSERT INTO generations (id, prompt, model, image_path, user_id) VALUES (?, 'p', 'm', 'x.png', ?)").run(
			genId,
			owner.id,
		);
		db.prepare("INSERT INTO share_links (slug, generation_id, user_id) VALUES (?, ?, ?)").run(
			`s${genId.slice(0, 10)}`,
			genId,
			owner.id,
		);
		const noReason = await call("POST", `/api/admin/moderation/images/${genId}/remove`, admin, {});
		expect(noReason.statusCode).toBe(400);
		const res = await call("POST", `/api/admin/moderation/images/${genId}/remove`, admin, { reason: "policy" });
		expect(res.statusCode).toBe(200);
		const gen = db.prepare("SELECT deleted_at, moderated_at, moderation_reason FROM generations WHERE id = ?").get(genId) as {
			deleted_at: string | null;
			moderated_at: string | null;
			moderation_reason: string;
		};
		expect(gen.deleted_at).toBeTruthy();
		expect(gen.moderated_at).toBeTruthy();
		expect(gen.moderation_reason).toBe("policy");
		const link = db.prepare("SELECT revoked_at FROM share_links WHERE generation_id = ?").get(genId) as {
			revoked_at: string | null;
		};
		expect(link.revoked_at).toBeTruthy();

		const audit = await call("GET", `/api/admin/audit?targetId=${genId}`, admin);
		expect(audit.statusCode).toBe(200);
		expect(audit.json().entries[0]).toMatchObject({ action: "moderation.remove", reason: "policy", adminUserId: admin.id });
	});

	test("failed webhooks show up on the health page until processed", async () => {
		const admin = createUser({ isAdmin: true });
		const eventId = `evt_${randomUUID().slice(0, 10)}`;
		recordWebhookFailure(eventId, "invoice.paid", new Error("boom"));
		const res = await call("GET", "/api/admin/health", admin);
		const failure = res.json().webhooks.failures.find((f: { eventId: string }) => f.eventId === eventId);
		expect(failure).toMatchObject({ type: "invoice.paid", resolved: false, attempts: 1 });
	});
});

describe("user detail", () => {
	test("returns the ledger, plan and audit trail for a user", async () => {
		const admin = createUser({ isAdmin: true });
		const user = createUser({ credits: 7 });
		await call("POST", `/api/admin/users/${user.id}/credits`, admin, { amount: 3, reason: "thanks" });
		const res = await call("GET", `/api/admin/users/${user.id}`, admin);
		expect(res.statusCode).toBe(200);
		const body = res.json();
		expect(body.balance).toBe(10);
		expect(body.ledger).toHaveLength(2);
		expect(body.current.plan).toBe("Free");
		expect(body.audit[0].action).toBe("credits.grant");
		expect((await call("GET", "/api/admin/users/does-not-exist", admin)).statusCode).toBe(404);
	});

	test("user search matches username and email", async () => {
		const admin = createUser({ isAdmin: true });
		const user = createUser({ email: `findme_${randomUUID().slice(0, 6)}@example.com` });
		const byEmail = await call("GET", `/api/admin/users?search=${encodeURIComponent(user.email.slice(0, 12))}`, admin);
		expect(byEmail.json().users.map((u: { id: string }) => u.id)).toContain(user.id);
		const byName = await call("GET", `/api/admin/users?search=${user.username}`, admin);
		expect(byName.json().users.map((u: { id: string }) => u.id)).toEqual([user.id]);
	});
});
