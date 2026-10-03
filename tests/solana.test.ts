import "./inject-bun-fix";
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { Keypair, PublicKey } from "@solana/web3.js";
import { getDb } from "../server/db";
import {
	cleanupPendingTransactions,
	getCreditPackages,
	getTreasuryWallet,
	initiatePayment,
	initiateSubscriptionPayment,
	setSolanaTestHooks,
	verifyAndCreateSubscription,
	verifyAndCreditTransaction,
} from "../server/services/solana";
import { authHeader, createUser, creditBalance, getApp } from "./helpers";

interface FakeTx {
	payer: string;
	lamports: number;
	blockTime: number;
}

const chain = new Map<string, FakeTx>();
let fetchSpy: ReturnType<typeof spyOn>;

function toResponse(t: FakeTx) {
	const treasury = new PublicKey(getTreasuryWallet());
	return {
		slot: 1,
		blockTime: t.blockTime,
		meta: {
			err: null,
			fee: 5000,
			preBalances: [10_000_000_000, 0],
			postBalances: [10_000_000_000 - t.lamports - 5000, t.lamports],
			loadedAddresses: { writable: [], readonly: [] },
		},
		transaction: { signatures: [], message: { staticAccountKeys: [new PublicKey(t.payer), treasury] } },
	};
}

beforeAll(() => {
	fetchSpy = spyOn(globalThis, "fetch").mockImplementation((() => {
		throw new Error("network access in tests");
	}) as unknown as typeof fetch);
	setSolanaTestHooks({
		pollDelayMs: 1,
		priceFetcher: async () => 100,
		connection: {
			getSignatureStatus: (async () => ({ context: { slot: 1 }, value: { err: null } })) as never,
			getTransaction: (async (sig: string) => {
				// Yield so concurrent verifications genuinely interleave
				await new Promise((r) => setTimeout(r, 5));
				const t = chain.get(sig);
				return t ? toResponse(t) : null;
			}) as never,
		},
	});
	// Enable a product for SOL subscriptions
	getDb()
		.prepare(
			"INSERT INTO subscription_products (id, name, bonus_credits, price, price_sol, available_for_sol, is_active) VALUES ('sol-plan', 'SOL Plan', 25, 10, 0.05, 1, 1)",
		)
		.run();
});

afterAll(() => {
	fetchSpy.mockRestore();
	setSolanaTestHooks({ connection: null, priceFetcher: null, pollDelayMs: 2000 });
});

let sigSeq = 0;
function fakeSignature(): string {
	sigSeq++;
	return `sig${sigSeq}${"1".repeat(84)}`.slice(0, 88);
}

function now(): number {
	return Math.floor(Date.now() / 1000);
}

function setupCreditPayment() {
	const user = createUser();
	const wallet = Keypair.generate().publicKey.toBase58();
	const pkg = getCreditPackages()[0];
	const payment = initiatePayment(user.id, pkg.id, wallet);
	if (!payment) throw new Error("initiate failed");
	return { user, wallet, payment };
}

describe("solana credit purchases", () => {
	test("a valid payment credits the user", async () => {
		const { user, wallet, payment } = setupCreditPayment();
		const sig = fakeSignature();
		chain.set(sig, { payer: wallet, lamports: payment.amountLamports, blockTime: now() });
		const result = await verifyAndCreditTransaction(payment.paymentId, sig, user.id);
		expect(result).toEqual({ success: true, credits: payment.credits });
		expect(creditBalance(user.id)).toBe(payment.credits);
	});

	test("concurrent verification of one payment credits once", async () => {
		const { user, wallet, payment } = setupCreditPayment();
		const sig = fakeSignature();
		chain.set(sig, { payer: wallet, lamports: payment.amountLamports, blockTime: now() });
		const results = await Promise.all([
			verifyAndCreditTransaction(payment.paymentId, sig, user.id),
			verifyAndCreditTransaction(payment.paymentId, sig, user.id),
			verifyAndCreditTransaction(payment.paymentId, sig, user.id),
		]);
		expect(results.filter((r) => r.success)).toHaveLength(1);
		expect(creditBalance(user.id)).toBe(payment.credits);
	});

	test("one signature can't pay for two pending payments", async () => {
		const { user, wallet, payment } = setupCreditPayment();
		const second = initiatePayment(user.id, getCreditPackages()[0].id, wallet);
		const sig = fakeSignature();
		chain.set(sig, { payer: wallet, lamports: payment.amountLamports, blockTime: now() });
		const [a, b] = await Promise.all([
			verifyAndCreditTransaction(payment.paymentId, sig, user.id),
			verifyAndCreditTransaction(second!.paymentId, sig, user.id),
		]);
		expect([a.success, b.success].filter(Boolean)).toHaveLength(1);
		expect(creditBalance(user.id)).toBe(payment.credits);
	});

	test("a transaction from a different wallet (sender mismatch) is rejected", async () => {
		const { user, payment } = setupCreditPayment();
		const sig = fakeSignature();
		chain.set(sig, { payer: Keypair.generate().publicKey.toBase58(), lamports: payment.amountLamports, blockTime: now() });
		const result = await verifyAndCreditTransaction(payment.paymentId, sig, user.id);
		expect(result.success).toBe(false);
		expect(result.error).toContain("wallet that initiated");
		expect(creditBalance(user.id)).toBe(0);
	});

	test("a transaction older than the payment request is rejected", async () => {
		const { user, wallet, payment } = setupCreditPayment();
		const sig = fakeSignature();
		chain.set(sig, { payer: wallet, lamports: payment.amountLamports, blockTime: now() - 3600 });
		const result = await verifyAndCreditTransaction(payment.paymentId, sig, user.id);
		expect(result.success).toBe(false);
		expect(result.error).toContain("predates");
	});

	test("an underpayment is rejected", async () => {
		const { user, wallet, payment } = setupCreditPayment();
		const sig = fakeSignature();
		chain.set(sig, { payer: wallet, lamports: Math.floor(payment.amountLamports / 2), blockTime: now() });
		expect((await verifyAndCreditTransaction(payment.paymentId, sig, user.id)).success).toBe(false);
	});

	test("cleanup marks stale pending rows expired (not deleted) and a late payment still verifies", async () => {
		const { user, wallet, payment } = setupCreditPayment();
		getDb()
			.prepare("UPDATE solana_transactions SET created_at = datetime('now', '-2 hours') WHERE id = ?")
			.run(payment.paymentId);
		cleanupPendingTransactions();
		const row = getDb().prepare("SELECT status FROM solana_transactions WHERE id = ?").get(payment.paymentId) as { status: string };
		expect(row.status).toBe("expired");

		const sig = fakeSignature();
		chain.set(sig, { payer: wallet, lamports: payment.amountLamports, blockTime: now() - 3600 });
		const result = await verifyAndCreditTransaction(payment.paymentId, sig, user.id);
		expect(result.success).toBe(true);
	});

	test("another user's linked wallet can't be used to initiate", async () => {
		const app = await getApp();
		const owner = createUser();
		const wallet = Keypair.generate().publicKey.toBase58();
		getDb().prepare("UPDATE users SET wallet_address = ? WHERE id = ?").run(wallet, owner.id);
		const attacker = createUser();
		const res = await app.inject({
			method: "POST",
			url: "/api/billing/solana/initiate",
			headers: authHeader(attacker),
			payload: { packageId: getCreditPackages()[0].id, walletAddress: wallet },
		});
		expect(res.statusCode).toBe(400);
	});
});

describe("solana subscriptions", () => {
	test("a signature can't be claimed for both credits and a subscription", async () => {
		const { user, wallet, payment } = setupCreditPayment();
		const sub = initiateSubscriptionPayment(user.id, "sol-plan", wallet);
		const sig = fakeSignature();
		// Large enough to satisfy either payment
		chain.set(sig, { payer: wallet, lamports: Math.max(payment.amountLamports, sub!.amountLamports), blockTime: now() });

		const credits = await verifyAndCreditTransaction(payment.paymentId, sig, user.id);
		expect(credits.success).toBe(true);
		const subscription = await verifyAndCreateSubscription(sub!.paymentId, sig, user.id);
		expect(subscription.success).toBe(false);
		expect(subscription.error).toContain("already used");
	});

	test("a valid SOL subscription retires the old row and grants the bonus once", async () => {
		const user = createUser();
		const wallet = Keypair.generate().publicKey.toBase58();
		const sub = initiateSubscriptionPayment(user.id, "sol-plan", wallet);
		const sig = fakeSignature();
		chain.set(sig, { payer: wallet, lamports: sub!.amountLamports, blockTime: now() });
		const results = await Promise.all([
			verifyAndCreateSubscription(sub!.paymentId, sig, user.id),
			verifyAndCreateSubscription(sub!.paymentId, sig, user.id),
		]);
		expect(results.filter((r) => r.success)).toHaveLength(1);
		expect(creditBalance(user.id)).toBe(25);
		const active = getDb()
			.prepare("SELECT product_id FROM user_subscriptions WHERE user_id = ? AND status = 'active'")
			.all(user.id);
		expect(active).toEqual([{ product_id: "sol-plan" }]);
	});
});

describe("open endpoints", () => {
	test("rpc proxy refuses methods outside the allowlist without calling upstream", async () => {
		const app = await getApp();
		const calls = fetchSpy.mock.calls.length;
		const res = await app.inject({
			method: "POST",
			url: "/api/solana/rpc",
			headers: { "x-forwarded-for": "203.0.113.90" },
			payload: { jsonrpc: "2.0", id: 1, method: "getProgramAccounts", params: [] },
		});
		expect(res.statusCode).toBe(403);
		const batch = await app.inject({
			method: "POST",
			url: "/api/solana/rpc",
			headers: { "x-forwarded-for": "203.0.113.90" },
			payload: [
				{ jsonrpc: "2.0", id: 1, method: "getBalance", params: [] },
				{ jsonrpc: "2.0", id: 2, method: "requestAirdrop", params: [] },
			],
		});
		expect(batch.statusCode).toBe(403);
		expect(fetchSpy.mock.calls.length).toBe(calls);
	});

	test("rpc proxy forwards allowlisted methods", async () => {
		const app = await getApp();
		fetchSpy.mockImplementationOnce((async () =>
			new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { value: 5 } }), { status: 200 })) as unknown as typeof fetch);
		const res = await app.inject({
			method: "POST",
			url: "/api/solana/rpc",
			headers: { "x-forwarded-for": "203.0.113.91" },
			payload: { jsonrpc: "2.0", id: 1, method: "getBalance", params: ["x"] },
		});
		expect(res.statusCode).toBe(200);
		expect(res.json().result.value).toBe(5);
	});

	test("solana cleanup is admin-only", async () => {
		const app = await getApp();
		const user = createUser();
		const admin = createUser({ isAdmin: true });
		expect((await app.inject({ method: "POST", url: "/api/billing/solana/cleanup" })).statusCode).toBe(401);
		expect((await app.inject({ method: "POST", url: "/api/billing/solana/cleanup", headers: authHeader(user) })).statusCode).toBe(403);
		expect((await app.inject({ method: "POST", url: "/api/billing/solana/cleanup", headers: authHeader(admin) })).statusCode).toBe(200);
	});
});
