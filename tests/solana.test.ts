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
	/** Extra read-only account keys (the Solana Pay reference). */
	refs?: string[];
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
		transaction: { signatures: [], message: { staticAccountKeys: [new PublicKey(t.payer), treasury, ...(t.refs ?? []).map((r) => new PublicKey(r))] } },
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
	// Fixed-width counter: "sig1" + 1s and "sig11" + 1s used to collide after truncation.
	return `sig${String(sigSeq).padStart(6, "2")}${"1".repeat(79)}`;
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
		chain.set(sig, { payer: wallet, lamports: payment.amountLamports, blockTime: now(), refs: [payment.reference] });
		const result = await verifyAndCreditTransaction(payment.paymentId, sig, user.id);
		expect(result).toEqual({ success: true, credits: payment.credits });
		expect(creditBalance(user.id)).toBe(payment.credits);
	});

	test("concurrent verification of one payment credits once", async () => {
		const { user, wallet, payment } = setupCreditPayment();
		const sig = fakeSignature();
		chain.set(sig, { payer: wallet, lamports: payment.amountLamports, blockTime: now(), refs: [payment.reference] });
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
		chain.set(sig, { payer: wallet, lamports: payment.amountLamports, blockTime: now(), refs: [payment.reference] });
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
		chain.set(sig, { payer: Keypair.generate().publicKey.toBase58(), lamports: payment.amountLamports, blockTime: now(), refs: [payment.reference] });
		const result = await verifyAndCreditTransaction(payment.paymentId, sig, user.id);
		expect(result.success).toBe(false);
		expect(result.error).toContain("wallet that initiated");
		expect(creditBalance(user.id)).toBe(0);
	});

	test("a transaction older than the payment request is rejected", async () => {
		const { user, wallet, payment } = setupCreditPayment();
		const sig = fakeSignature();
		chain.set(sig, { payer: wallet, lamports: payment.amountLamports, blockTime: now() - 3600, refs: [payment.reference] });
		const result = await verifyAndCreditTransaction(payment.paymentId, sig, user.id);
		expect(result.success).toBe(false);
		expect(result.error).toContain("predates");
	});

	test("an underpayment is rejected", async () => {
		const { user, wallet, payment } = setupCreditPayment();
		const sig = fakeSignature();
		chain.set(sig, { payer: wallet, lamports: Math.floor(payment.amountLamports / 2), blockTime: now(), refs: [payment.reference] });
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
		chain.set(sig, { payer: wallet, lamports: payment.amountLamports, blockTime: now() - 3600, refs: [payment.reference] });
		const result = await verifyAndCreditTransaction(payment.paymentId, sig, user.id);
		expect(result.success).toBe(true);
	});

	test("a transfer without the payment's reference key is rejected", async () => {
		const { user, wallet, payment } = setupCreditPayment();
		expect(payment.reference).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
		const sig = fakeSignature();
		chain.set(sig, { payer: wallet, lamports: payment.amountLamports, blockTime: now() });
		const result = await verifyAndCreditTransaction(payment.paymentId, sig, user.id);
		expect(result.success).toBe(false);
		expect(result.error).toContain("not made for this payment");
		expect(creditBalance(user.id)).toBe(0);
	});

	test("a transfer made for payment A can't verify payment B (even from the same wallet)", async () => {
		const { user, wallet, payment } = setupCreditPayment();
		const other = createUser();
		const b = initiatePayment(other.id, getCreditPackages()[0].id, wallet);
		expect(b!.reference).not.toBe(payment.reference);
		const sig = fakeSignature();
		chain.set(sig, { payer: wallet, lamports: payment.amountLamports, blockTime: now(), refs: [payment.reference] });
		const stolen = await verifyAndCreditTransaction(b!.paymentId, sig, other.id);
		expect(stolen.success).toBe(false);
		expect(creditBalance(other.id)).toBe(0);
		// The rightful payer can still claim it
		expect((await verifyAndCreditTransaction(payment.paymentId, sig, user.id)).success).toBe(true);
	});

	test("a legacy pending row without a reference verifies only within its window", async () => {
		const { user, wallet, payment } = setupCreditPayment();
		getDb().prepare("UPDATE solana_transactions SET reference = NULL WHERE id = ?").run(payment.paymentId);
		const sig = fakeSignature();
		chain.set(sig, { payer: wallet, lamports: payment.amountLamports, blockTime: now() });
		expect((await verifyAndCreditTransaction(payment.paymentId, sig, user.id)).success).toBe(true);

		const old = setupCreditPayment();
		getDb()
			.prepare("UPDATE solana_transactions SET reference = NULL, created_at = datetime('now', '-25 hours') WHERE id = ?")
			.run(old.payment.paymentId);
		const sig2 = fakeSignature();
		chain.set(sig2, { payer: old.wallet, lamports: old.payment.amountLamports, blockTime: now() });
		const result = await verifyAndCreditTransaction(old.payment.paymentId, sig2, old.user.id);
		expect(result.success).toBe(false);
		expect(result.error).toContain("expired");
	});

	test("initiate returns the reference key", async () => {
		const app = await getApp();
		const user = createUser();
		const res = await app.inject({
			method: "POST",
			url: "/api/billing/solana/initiate",
			headers: authHeader(user),
			payload: { packageId: getCreditPackages()[0].id, walletAddress: Keypair.generate().publicKey.toBase58() },
		});
		expect(res.statusCode).toBe(200);
		const body = res.json();
		const row = getDb().prepare("SELECT reference FROM solana_transactions WHERE id = ?").get(body.paymentId) as { reference: string };
		expect(body.reference).toBe(row.reference);
		expect(() => new PublicKey(body.reference)).not.toThrow();
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
		chain.set(sig, { payer: wallet, lamports: Math.max(payment.amountLamports, sub!.amountLamports), blockTime: now(), refs: [payment.reference, sub!.reference] });

		const credits = await verifyAndCreditTransaction(payment.paymentId, sig, user.id);
		expect(credits.success).toBe(true);
		const subscription = await verifyAndCreateSubscription(sub!.paymentId, sig, user.id);
		expect(subscription.success).toBe(false);
		expect(subscription.error).toContain("already used");
	});

	test("a subscription transfer without its reference is rejected", async () => {
		const user = createUser();
		const wallet = Keypair.generate().publicKey.toBase58();
		const sub = initiateSubscriptionPayment(user.id, "sol-plan", wallet);
		const sig = fakeSignature();
		chain.set(sig, { payer: wallet, lamports: sub!.amountLamports, blockTime: now() });
		const result = await verifyAndCreateSubscription(sub!.paymentId, sig, user.id);
		expect(result.success).toBe(false);
		expect(result.error).toContain("not made for this payment");
	});

	test("a valid SOL subscription retires the old row and grants the bonus once", async () => {
		const user = createUser();
		const wallet = Keypair.generate().publicKey.toBase58();
		const sub = initiateSubscriptionPayment(user.id, "sol-plan", wallet);
		const sig = fakeSignature();
		chain.set(sig, { payer: wallet, lamports: sub!.amountLamports, blockTime: now(), refs: [sub!.reference] });
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
		const user = createUser();
		const calls = fetchSpy.mock.calls.length;
		for (const method of ["getProgramAccounts", "getBalance", "getAccountInfo", "simulateTransaction"]) {
			const res = await app.inject({
				method: "POST",
				url: "/api/solana/rpc",
				headers: { ...authHeader(user), "x-forwarded-for": "203.0.113.90" },
				payload: { jsonrpc: "2.0", id: 1, method, params: [] },
			});
			expect(res.statusCode).toBe(403);
		}
		const batch = await app.inject({
			method: "POST",
			url: "/api/solana/rpc",
			headers: { ...authHeader(user), "x-forwarded-for": "203.0.113.90" },
			payload: [
				{ jsonrpc: "2.0", id: 1, method: "getLatestBlockhash", params: [] },
				{ jsonrpc: "2.0", id: 2, method: "requestAirdrop", params: [] },
			],
		});
		expect(batch.statusCode).toBe(403);
		expect(fetchSpy.mock.calls.length).toBe(calls);
	});

	test("rpc proxy requires a session and caps batches at 3", async () => {
		const app = await getApp();
		const calls = fetchSpy.mock.calls.length;
		const anon = await app.inject({
			method: "POST",
			url: "/api/solana/rpc",
			headers: { "x-forwarded-for": "203.0.113.92" },
			payload: { jsonrpc: "2.0", id: 1, method: "getLatestBlockhash", params: [] },
		});
		expect(anon.statusCode).toBe(401);
		const big = await app.inject({
			method: "POST",
			url: "/api/solana/rpc",
			headers: { ...authHeader(createUser()), "x-forwarded-for": "203.0.113.92" },
			payload: Array.from({ length: 4 }, (_, i) => ({ jsonrpc: "2.0", id: i, method: "getLatestBlockhash", params: [] })),
		});
		expect(big.statusCode).toBe(400);
		expect(fetchSpy.mock.calls.length).toBe(calls);
	});

	test("rpc proxy forwards allowlisted methods", async () => {
		const app = await getApp();
		fetchSpy.mockImplementationOnce((async () =>
			new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { value: { blockhash: "abc" } } }), {
				status: 200,
			})) as unknown as typeof fetch);
		const res = await app.inject({
			method: "POST",
			url: "/api/solana/rpc",
			headers: { ...authHeader(createUser()), "x-forwarded-for": "203.0.113.91" },
			payload: { jsonrpc: "2.0", id: 1, method: "getLatestBlockhash", params: [] },
		});
		expect(res.statusCode).toBe(200);
		expect(res.json().result.value.blockhash).toBe("abc");
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

describe("frontend transfer builder", () => {
	test("puts the reference on the transfer as a read-only, non-signer key the verifier accepts", async () => {
		const { buildPaymentTransaction } = await import("../src/lib/solanaPay");
		const { user, wallet, payment } = setupCreditPayment();
		const tx = buildPaymentTransaction(new PublicKey(wallet), payment);
		tx.recentBlockhash = Keypair.generate().publicKey.toBase58();
		tx.feePayer = new PublicKey(wallet);
		const message = tx.compileMessage();
		const keys = message.accountKeys.map((k) => k.toBase58());
		const index = keys.indexOf(payment.reference);
		expect(index).toBeGreaterThan(0);
		expect(message.isAccountSigner(index)).toBe(false);
		expect(message.isAccountWritable(index)).toBe(false);
		expect(message.header.numRequiredSignatures).toBe(1);

		// The verifier accepts a transaction carrying exactly these account keys
		const sig = fakeSignature();
		chain.set(sig, {
			payer: wallet,
			lamports: payment.amountLamports,
			blockTime: now(),
			refs: keys.filter((k) => k !== wallet && k !== getTreasuryWallet()),
		});
		expect((await verifyAndCreditTransaction(payment.paymentId, sig, user.id)).success).toBe(true);
	});
});
