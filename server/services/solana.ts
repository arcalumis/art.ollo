import type { SQLQueryBindings } from "bun:sqlite";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import crypto from "node:crypto";
import { getDb } from "../db";
import { parseDbTime } from "../db/schema";
import { addCredits, assignSubscription } from "./usage";

// Environment configuration
const SOLANA_NETWORK = process.env.SOLANA_NETWORK || "mainnet-beta";
const SOLANA_RPC_URL =
	process.env.SOLANA_RPC_URL ||
	(SOLANA_NETWORK === "devnet"
		? "https://api.devnet.solana.com"
		: "https://api.mainnet-beta.solana.com");
const SOLANA_TREASURY_WALLET = process.env.SOLANA_TREASURY_WALLET || "";

// Custom fetch that adds Origin header for Alchemy
const customFetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
	const headers = new Headers(init?.headers);
	headers.set("Origin", "https://ollo.art");
	headers.set("Referer", "https://ollo.art/");
	return fetch(input, { ...init, headers });
}) as typeof fetch;

/** The subset of Connection used for payment verification (replaceable in tests). */
type VerifyConnection = Pick<Connection, "getSignatureStatus" | "getTransaction">;

// Solana connection instance
let connection: Connection | null = null;
let connectionOverride: VerifyConnection | null = null;
let priceFetcherOverride: (() => Promise<number>) | null = null;
let pollDelayMs = 2000;

/** Test hooks: never touch the network from tests. */
export function setSolanaTestHooks(hooks: {
	connection?: VerifyConnection | null;
	priceFetcher?: (() => Promise<number>) | null;
	pollDelayMs?: number;
}): void {
	if (hooks.connection !== undefined) connectionOverride = hooks.connection;
	if (hooks.priceFetcher !== undefined) priceFetcherOverride = hooks.priceFetcher;
	if (hooks.pollDelayMs !== undefined) pollDelayMs = hooks.pollDelayMs;
}

function getConnection(): VerifyConnection {
	if (connectionOverride) return connectionOverride;
	if (!connection) {
		connection = new Connection(SOLANA_RPC_URL, {
			commitment: "finalized",
			fetch: customFetch,
		});
	}
	return connection;
}

/**
 * Fetch current SOL/USD price from CoinGecko
 */
export async function getSolUsdPrice(): Promise<number> {
	if (priceFetcherOverride) return priceFetcherOverride();
	try {
		const res = await fetch(
			"https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd",
		);
		const data = (await res.json()) as { solana?: { usd?: number } };
		return data.solana?.usd || 250; // fallback to $250
	} catch {
		return 250; // fallback
	}
}

/**
 * Capture current SOL price and store as a snapshot
 */
export async function captureAndGetSolPrice(): Promise<number> {
	const price = await getSolUsdPrice();
	const db = getDb();
	const id = crypto.randomUUID();
	db.prepare(
		"INSERT INTO sol_price_snapshots (id, price_usd, source, captured_at) VALUES (?, ?, 'coingecko', datetime('now'))",
	).run(id, price);
	return price;
}

/**
 * Get SOL price history for admin dashboard
 */
export function getSolPriceHistory(days = 30): Array<{ priceUsd: number; capturedAt: string }> {
	const db = getDb();
	const rows = db
		.prepare(
			`SELECT price_usd, captured_at FROM sol_price_snapshots
			 WHERE captured_at >= datetime('now', '-' || ? || ' days')
			 ORDER BY captured_at ASC`,
		)
		.all(days) as Array<{ price_usd: number; captured_at: string }>;

	return rows.map((r) => ({ priceUsd: r.price_usd, capturedAt: r.captured_at }));
}

/**
 * Get most recent cached SOL price (from snapshots)
 */
export function getLatestSolPrice(): { priceUsd: number; capturedAt: string } | null {
	const db = getDb();
	const row = db
		.prepare(
			"SELECT price_usd, captured_at FROM sol_price_snapshots ORDER BY captured_at DESC LIMIT 1",
		)
		.get() as { price_usd: number; captured_at: string } | undefined;

	if (!row) return null;
	return { priceUsd: row.price_usd, capturedAt: row.captured_at };
}

export interface SolanaCreditPackage {
	id: string;
	name: string;
	credits: number;
	priceSol: number;
	priceCents: number | null;
	stripePriceId: string | null;
	availableForUsd: boolean;
	availableForSol: boolean;
	isActive: boolean;
}

export interface SolanaTransaction {
	id: string;
	userId: string;
	walletAddress: string;
	transactionSignature: string;
	amountLamports: number;
	amountSol: number;
	creditsPurchased: number;
	status: string;
	network: string;
	verifiedAt: string | null;
	createdAt: string;
}

export interface PendingPayment {
	paymentId: string;
	recipientWallet: string;
	/** Solana Pay reference: must be added to the transfer as a read-only, non-signer account. */
	reference: string;
	amountLamports: number;
	amountSol: number;
	credits: number;
	packageName: string;
}

/**
 * Check if Solana payments are configured
 */
export function isSolanaConfigured(): boolean {
	return !!SOLANA_TREASURY_WALLET;
}

/**
 * Get the Solana network being used
 */
export function getSolanaNetwork(): string {
	return SOLANA_NETWORK;
}

/**
 * Get the treasury wallet address
 */
export function getTreasuryWallet(): string {
	return SOLANA_TREASURY_WALLET;
}

/**
 * Get all active credit packages
 */
export function getCreditPackages(): SolanaCreditPackage[] {
	const db = getDb();
	const packages = db
		.prepare(`
			SELECT id, name, credits, price_sol, price_cents, stripe_price_id, available_for_usd, available_for_sol, is_active
			FROM solana_credit_packages
			WHERE is_active = 1
			ORDER BY credits ASC
		`)
		.all() as Array<{
		id: string;
		name: string;
		credits: number;
		price_sol: number;
		price_cents: number | null;
		stripe_price_id: string | null;
		available_for_usd: number;
		available_for_sol: number;
		is_active: number;
	}>;

	return packages.map((pkg) => ({
		id: pkg.id,
		name: pkg.name,
		credits: pkg.credits,
		priceSol: pkg.price_sol,
		priceCents: pkg.price_cents,
		stripePriceId: pkg.stripe_price_id,
		availableForUsd: pkg.available_for_usd === 1,
		availableForSol: pkg.available_for_sol === 1,
		isActive: pkg.is_active === 1,
	}));
}

/**
 * Get a specific credit package by ID
 */
export function getCreditPackage(packageId: string): SolanaCreditPackage | null {
	const db = getDb();
	const pkg = db
		.prepare("SELECT id, name, credits, price_sol, price_cents, stripe_price_id, available_for_usd, available_for_sol, is_active FROM solana_credit_packages WHERE id = ?")
		.get(packageId) as
		| { id: string; name: string; credits: number; price_sol: number; price_cents: number | null; stripe_price_id: string | null; available_for_usd: number; available_for_sol: number; is_active: number }
		| undefined;

	if (!pkg) return null;

	return {
		id: pkg.id,
		name: pkg.name,
		credits: pkg.credits,
		priceSol: pkg.price_sol,
		priceCents: pkg.price_cents,
		stripePriceId: pkg.stripe_price_id,
		availableForUsd: pkg.available_for_usd === 1,
		availableForSol: pkg.available_for_sol === 1,
		isActive: pkg.is_active === 1,
	};
}

/**
 * Initiate a payment - creates a pending transaction record
 */
export function initiatePayment(
	userId: string,
	packageId: string,
	walletAddress: string,
): PendingPayment | null {
	if (!isSolanaConfigured()) {
		return null;
	}

	const pkg = getCreditPackage(packageId);
	// USD-only packs (Stripe) carry price_sol = 0; selling them for SOL would give credits away.
	if (!pkg || !pkg.isActive || !pkg.availableForSol || !(pkg.priceSol > 0)) {
		return null;
	}

	const db = getDb();
	const paymentId = crypto.randomUUID();
	const amountLamports = Math.round(pkg.priceSol * LAMPORTS_PER_SOL);
	const reference = newPaymentReference();

	// Create a placeholder transaction record (signature will be empty until verified)
	// We use the paymentId as a temporary signature to track this pending payment
	db.prepare(`
		INSERT INTO solana_transactions
		(id, user_id, wallet_address, transaction_signature, amount_lamports, amount_sol, credits_purchased, status, network, reference)
		VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
	`).run(
		paymentId,
		userId,
		walletAddress,
		`pending_${paymentId}`, // Temporary placeholder
		amountLamports,
		pkg.priceSol,
		pkg.credits,
		SOLANA_NETWORK,
		reference,
	);

	return {
		paymentId,
		recipientWallet: SOLANA_TREASURY_WALLET,
		reference,
		amountLamports,
		amountSol: pkg.priceSol,
		credits: pkg.credits,
		packageName: pkg.name,
	};
}

// ============================================
// ON-CHAIN VERIFICATION (shared by credits + subscriptions)
// ============================================

/** Allowed clock skew between our pending row's created_at and the chain's blockTime. */
const BLOCKTIME_SKEW_SECONDS = 5 * 60;
/** A pending/expired payment can be satisfied by a transaction up to this long after initiation. */
const LATE_PAYMENT_WINDOW_SECONDS = 24 * 60 * 60;

class PaymentClaimError extends Error {}

interface PendingRow {
	id: string;
	user_id: string;
	wallet_address: string;
	amount_lamports: number;
	status: string;
	created_at: string;
	/** Solana Pay reference. NULL only on rows created before references existed. */
	reference: string | null;
}

/**
 * A fresh random public key that binds one payment request to one on-chain transaction (the
 * Solana Pay "reference" pattern). Nobody holds its private key; it only has to appear in the
 * transaction's account keys, which a third party's unrelated transfer never contains.
 */
function newPaymentReference(): string {
	return Keypair.generate().publicKey.toBase58();
}

/** True when `walletAddress` is linked (wallet login) to a different account. */
export function isWalletLinkedToOtherUser(userId: string, walletAddress: string): boolean {
	return !!getDb().prepare("SELECT 1 FROM users WHERE wallet_address = ? AND id != ?").get(walletAddress, userId);
}

function isSignatureClaimed(signature: string): boolean {
	const db = getDb();
	return !!(
		db.prepare("SELECT 1 FROM solana_claimed_signatures WHERE signature = ?").get(signature) ||
		db.prepare("SELECT 1 FROM solana_transactions WHERE transaction_signature = ?").get(signature) ||
		db.prepare("SELECT 1 FROM solana_subscription_transactions WHERE transaction_signature = ?").get(signature)
	);
}

type FinalizedTx = NonNullable<Awaited<ReturnType<Connection["getTransaction"]>>>;

/** Poll until the transaction is finalized (up to ~60s). */
async function fetchFinalizedTransaction(signature: string): Promise<{ tx: FinalizedTx } | { error: string }> {
	const conn = getConnection();
	const maxRetries = 30;

	for (let attempt = 0; attempt < maxRetries; attempt++) {
		const status = await conn.getSignatureStatus(signature);
		if (status.value?.err) {
			return { error: "Transaction failed on chain" };
		}

		const confirmed = await conn.getTransaction(signature, {
			commitment: "confirmed",
			maxSupportedTransactionVersion: 0,
		});
		if (confirmed) {
			const finalized = await conn.getTransaction(signature, {
				commitment: "finalized",
				maxSupportedTransactionVersion: 0,
			});
			if (finalized) {
				if (finalized.meta?.err) return { error: "Transaction failed on chain" };
				return { tx: finalized };
			}
		}

		if (attempt < maxRetries - 1) {
			await new Promise((resolve) => setTimeout(resolve, pollDelayMs));
		}
	}

	return { error: "Transaction not found or not confirmed. Please wait and try again." };
}

/**
 * Check that `tx` pays the treasury the expected amount, from the wallet that initiated the
 * payment, after the payment was initiated. Returns an error message or null.
 */
function validatePaymentTransaction(tx: FinalizedTx, pending: PendingRow): string | null {
	const message = tx.transaction.message as unknown as { staticAccountKeys?: PublicKey[]; accountKeys?: PublicKey[] };
	const staticKeys = message.staticAccountKeys ?? message.accountKeys ?? [];
	const loaded = tx.meta?.loadedAddresses;
	const keys = [...staticKeys, ...(loaded?.writable ?? []), ...(loaded?.readonly ?? [])].map((k) => k.toBase58());

	// The payment's reference key must be in the transaction. This is what proves the transfer
	// was made for THIS payment request: the wallet address typed at initiate proves nothing, and
	// anyone watching the treasury could otherwise claim someone else's transfer.
	const createdAt = parseDbTime(pending.created_at);
	if (pending.reference) {
		if (!keys.includes(pending.reference)) {
			return "Transaction was not made for this payment request";
		}
	} else if (createdAt === null || Date.now() - createdAt > LATE_PAYMENT_WINDOW_SECONDS * 1000) {
		// Legacy rows (created before references) are honoured only within their original
		// window. TODO: delete this branch once no reference-less pending rows remain.
		return "This payment request has expired";
	}

	// Fee payer (first signer) must be the wallet recorded when the payment was initiated
	if (keys[0] !== pending.wallet_address) {
		return "Transaction was not sent from the wallet that initiated this payment";
	}

	// The transaction must not predate the pending payment (no reusing old transfers)
	if (!tx.blockTime || createdAt === null) {
		return "Unable to determine transaction time";
	}
	const createdSec = Math.floor(createdAt / 1000);
	if (tx.blockTime < createdSec - BLOCKTIME_SKEW_SECONDS) {
		return "Transaction predates this payment request";
	}
	if (tx.blockTime > createdSec + LATE_PAYMENT_WINDOW_SECONDS) {
		return "This payment request has expired";
	}

	const treasuryIndex = keys.indexOf(new PublicKey(SOLANA_TREASURY_WALLET).toBase58());
	if (treasuryIndex === -1) {
		return "Treasury wallet not found in transaction";
	}

	const received = (tx.meta?.postBalances[treasuryIndex] ?? 0) - (tx.meta?.preBalances[treasuryIndex] ?? 0);
	const expectedAmount = pending.amount_lamports;
	if (!(expectedAmount > 0)) {
		return "This payment request has no amount";
	}
	const tolerance = Math.max(expectedAmount * 0.01, 1000); // 1% or 1000 lamports minimum
	if (received < expectedAmount - tolerance) {
		return `Insufficient amount received. Expected ${expectedAmount} lamports, got ${received}`;
	}

	return null;
}

/** Record a signature as claimed. The PRIMARY KEY makes it single-use across both payment kinds. */
function claimSignature(signature: string, kind: "credits" | "subscription", paymentId: string, userId: string): void {
	try {
		getDb()
			.prepare("INSERT INTO solana_claimed_signatures (signature, kind, payment_id, user_id) VALUES (?, ?, ?, ?)")
			.run(signature, kind, paymentId, userId);
	} catch {
		throw new PaymentClaimError("Transaction signature already used");
	}
}

function isConstraintError(err: unknown): boolean {
	return err instanceof Error && /constraint/i.test(err.message);
}

/**
 * Verify a transaction on-chain and credit the user
 */
export async function verifyAndCreditTransaction(
	paymentId: string,
	signature: string,
	userId: string,
): Promise<{ success: boolean; error?: string; credits?: number }> {
	if (!isSolanaConfigured()) {
		return { success: false, error: "Solana payments not configured" };
	}

	const db = getDb();
	const pending = db
		.prepare(`
			SELECT id, user_id, wallet_address, amount_lamports, credits_purchased, status, created_at, reference
			FROM solana_transactions
			WHERE id = ? AND user_id = ?
		`)
		.get(paymentId, userId) as (PendingRow & { credits_purchased: number }) | undefined;

	if (!pending) {
		return { success: false, error: "Payment not found" };
	}
	if (pending.status !== "pending" && pending.status !== "expired") {
		return { success: false, error: "Payment already processed" };
	}
	if (isSignatureClaimed(signature)) {
		return { success: false, error: "Transaction signature already used" };
	}

	try {
		const fetched = await fetchFinalizedTransaction(signature);
		if ("error" in fetched) return { success: false, error: fetched.error };

		const invalid = validatePaymentTransaction(fetched.tx, pending);
		if (invalid) return { success: false, error: invalid };

		const amountSol = pending.amount_lamports / LAMPORTS_PER_SOL;
		const usdCents = Math.round(amountSol * (await getSolUsdPrice()) * 100);

		// Finalize + claim + grant atomically. The conditional UPDATE means only one of several
		// concurrent verifications of the same payment can succeed.
		db.transaction(() => {
			claimSignature(signature, "credits", paymentId, userId);
			const updated = db
				.prepare(`
					UPDATE solana_transactions
					SET transaction_signature = ?, status = 'completed', verified_at = datetime('now')
					WHERE id = ? AND user_id = ? AND status IN ('pending', 'expired')
				`)
				.run(signature, paymentId, userId);
			if (updated.changes !== 1) throw new PaymentClaimError("Payment already processed");

			addCredits(userId, pending.credits_purchased, "purchased", `SOL payment - ${pending.credits_purchased} credits`);
			db.prepare(`
				INSERT INTO revenue_events (id, user_id, event_type, amount_cents, description)
				VALUES (?, ?, 'credit_purchase', ?, ?)
			`).run(crypto.randomUUID(), userId, usdCents, `SOL payment: ${amountSol} SOL`);
		})();

		return { success: true, credits: pending.credits_purchased };
	} catch (error) {
		if (error instanceof PaymentClaimError) return { success: false, error: error.message };
		if (isConstraintError(error)) return { success: false, error: "Transaction signature already used" };
		console.error("Error verifying Solana transaction:", error instanceof Error ? error.message : error);
		return { success: false, error: "Failed to verify transaction" };
	}
}

/**
 * Get user's Solana transaction history
 */
export function getUserTransactions(userId: string, limit = 20): SolanaTransaction[] {
	const db = getDb();
	const transactions = db
		.prepare(`
			SELECT
				id, user_id, wallet_address, transaction_signature,
				amount_lamports, amount_sol, credits_purchased,
				status, network, verified_at, created_at
			FROM solana_transactions
			WHERE user_id = ? AND status = 'completed'
			ORDER BY created_at DESC
			LIMIT ?
		`)
		.all(userId, limit) as Array<{
		id: string;
		user_id: string;
		wallet_address: string;
		transaction_signature: string;
		amount_lamports: number;
		amount_sol: number;
		credits_purchased: number;
		status: string;
		network: string;
		verified_at: string | null;
		created_at: string;
	}>;

	return transactions.map((tx) => ({
		id: tx.id,
		userId: tx.user_id,
		walletAddress: tx.wallet_address,
		transactionSignature: tx.transaction_signature,
		amountLamports: tx.amount_lamports,
		amountSol: tx.amount_sol,
		creditsPurchased: tx.credits_purchased,
		status: tx.status,
		network: tx.network,
		verifiedAt: tx.verified_at,
		createdAt: tx.created_at,
	}));
}

/**
 * Mark pending payments older than 1 hour as expired. They are kept (not deleted): a late
 * on-chain payment can still be verified against an expired row within 24h of initiation.
 */
export function cleanupPendingTransactions(): void {
	const db = getDb();
	db.prepare(`
		UPDATE solana_transactions SET status = 'expired'
		WHERE status = 'pending' AND created_at < datetime('now', '-1 hour')
	`).run();
	db.prepare(`
		UPDATE solana_subscription_transactions SET status = 'expired'
		WHERE status = 'pending' AND created_at < datetime('now', '-1 hour')
	`).run();
}

// ============================================
// SUBSCRIPTION PURCHASES WITH SOL
// ============================================

export interface SolanaSubscriptionProduct {
	id: string;
	name: string;
	description: string | null;
	monthlyImageLimit: number | null;
	monthlyCostLimit: number | null;
	dailyImageLimit: number | null;
	bonusCredits: number;
	priceUsd: number;
	priceSol: number;
	allowedModels: string[] | null;
}

export interface PendingSubscriptionPayment {
	paymentId: string;
	recipientWallet: string;
	/** Solana Pay reference: must be added to the transfer as a read-only, non-signer account. */
	reference: string;
	amountLamports: number;
	amountSol: number;
	productName: string;
	productId: string;
}

/**
 * Get subscription products available for SOL purchase
 */
export function getSolanaSubscriptionProducts(): SolanaSubscriptionProduct[] {
	const db = getDb();
	const products = db
		.prepare(`
			SELECT
				id, name, description,
				monthly_image_limit, monthly_cost_limit, daily_image_limit,
				bonus_credits, price, price_sol, allowed_models
			FROM subscription_products
			WHERE is_active = 1
			AND available_for_sol = 1
			AND price_sol IS NOT NULL
			AND price_sol > 0
			ORDER BY price_sol ASC
		`)
		.all() as Array<{
		id: string;
		name: string;
		description: string | null;
		monthly_image_limit: number | null;
		monthly_cost_limit: number | null;
		daily_image_limit: number | null;
		bonus_credits: number;
		price: number;
		price_sol: number;
		allowed_models: string | null;
	}>;

	return products.map((p) => ({
		id: p.id,
		name: p.name,
		description: p.description,
		monthlyImageLimit: p.monthly_image_limit,
		monthlyCostLimit: p.monthly_cost_limit,
		dailyImageLimit: p.daily_image_limit,
		bonusCredits: p.bonus_credits,
		priceUsd: p.price,
		priceSol: p.price_sol,
		allowedModels: p.allowed_models ? JSON.parse(p.allowed_models) : null,
	}));
}

/**
 * Initiate a subscription payment with SOL
 */
export function initiateSubscriptionPayment(
	userId: string,
	productId: string,
	walletAddress: string,
): PendingSubscriptionPayment | null {
	if (!isSolanaConfigured()) {
		return null;
	}

	const db = getDb();

	// Get product
	const product = db
		.prepare(`
			SELECT id, name, price_sol
			FROM subscription_products
			WHERE id = ?
			AND is_active = 1
			AND available_for_sol = 1
			AND price_sol IS NOT NULL
			AND price_sol > 0
		`)
		.get(productId) as { id: string; name: string; price_sol: number } | undefined;

	if (!product) {
		return null;
	}

	const paymentId = crypto.randomUUID();
	const amountLamports = Math.round(product.price_sol * LAMPORTS_PER_SOL);
	const reference = newPaymentReference();

	// Create pending subscription transaction
	db.prepare(`
		INSERT INTO solana_subscription_transactions
		(id, user_id, product_id, wallet_address, transaction_signature, amount_lamports, amount_sol, status, network, reference)
		VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
	`).run(
		paymentId,
		userId,
		productId,
		walletAddress,
		`pending_${paymentId}`,
		amountLamports,
		product.price_sol,
		SOLANA_NETWORK,
		reference,
	);

	return {
		paymentId,
		recipientWallet: SOLANA_TREASURY_WALLET,
		reference,
		amountLamports,
		amountSol: product.price_sol,
		productName: product.name,
		productId: product.id,
	};
}

/**
 * Verify subscription payment and create subscription
 */
export async function verifyAndCreateSubscription(
	paymentId: string,
	signature: string,
	userId: string,
): Promise<{ success: boolean; error?: string; subscriptionId?: string }> {
	if (!isSolanaConfigured()) {
		return { success: false, error: "Solana payments not configured" };
	}

	const db = getDb();
	const pending = db
		.prepare(`
			SELECT id, user_id, product_id, wallet_address, amount_lamports, status, created_at, reference
			FROM solana_subscription_transactions
			WHERE id = ? AND user_id = ?
		`)
		.get(paymentId, userId) as (PendingRow & { product_id: string }) | undefined;

	if (!pending) {
		return { success: false, error: "Payment not found" };
	}
	if (pending.status !== "pending" && pending.status !== "expired") {
		return { success: false, error: "Payment already processed" };
	}
	if (isSignatureClaimed(signature)) {
		return { success: false, error: "Transaction signature already used" };
	}

	try {
		const fetched = await fetchFinalizedTransaction(signature);
		if ("error" in fetched) return { success: false, error: fetched.error };

		const invalid = validatePaymentTransaction(fetched.tx, pending);
		if (invalid) return { success: false, error: invalid };

		const amountSol = pending.amount_lamports / LAMPORTS_PER_SOL;
		const usdCents = Math.round(amountSol * (await getSolUsdPrice()) * 100);

		const subscriptionId = db.transaction(() => {
			claimSignature(signature, "subscription", paymentId, userId);
			const updated = db
				.prepare(`
					UPDATE solana_subscription_transactions
					SET transaction_signature = ?, status = 'completed', verified_at = datetime('now')
					WHERE id = ? AND user_id = ? AND status IN ('pending', 'expired')
				`)
				.run(signature, paymentId, userId);
			if (updated.changes !== 1) throw new PaymentClaimError("Payment already processed");

			// 30-day subscription; retires the previous active row and grants the bonus once
			const startsAt = new Date().toISOString();
			const endsAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
			const id = assignSubscription(userId, pending.product_id, {
				startsAt,
				endsAt,
				periodStart: startsAt,
				periodEnd: endsAt,
				bonusReason: "Subscription welcome bonus (SOL)",
			});

			db.prepare("UPDATE solana_subscription_transactions SET subscription_id = ? WHERE id = ?").run(id, paymentId);
			db.prepare(`
				INSERT INTO revenue_events (id, user_id, event_type, amount_cents, description)
				VALUES (?, ?, 'sol_subscription', ?, ?)
			`).run(crypto.randomUUID(), userId, usdCents, `SOL subscription: ${amountSol} SOL`);
			return id;
		})();

		return { success: true, subscriptionId };
	} catch (error) {
		if (error instanceof PaymentClaimError) return { success: false, error: error.message };
		if (isConstraintError(error)) return { success: false, error: "Transaction signature already used" };
		console.error("Error verifying Solana subscription transaction:", error instanceof Error ? error.message : error);
		return { success: false, error: "Failed to verify transaction" };
	}
}

// ============================================
// ADMIN CREDIT PACKAGE MANAGEMENT
// ============================================

/**
 * Get all credit packages (including inactive, for admin)
 */
export function getAllCreditPackages(): Array<SolanaCreditPackage & { createdAt: string }> {
	const db = getDb();
	const packages = db
		.prepare(`
			SELECT id, name, credits, price_sol, price_cents, stripe_price_id, available_for_usd, available_for_sol, is_active, created_at
			FROM solana_credit_packages
			ORDER BY credits ASC
		`)
		.all() as Array<{
		id: string;
		name: string;
		credits: number;
		price_sol: number;
		price_cents: number | null;
		stripe_price_id: string | null;
		available_for_usd: number;
		available_for_sol: number;
		is_active: number;
		created_at: string;
	}>;

	return packages.map((pkg) => ({
		id: pkg.id,
		name: pkg.name,
		credits: pkg.credits,
		priceSol: pkg.price_sol,
		priceCents: pkg.price_cents,
		stripePriceId: pkg.stripe_price_id,
		availableForUsd: pkg.available_for_usd === 1,
		availableForSol: pkg.available_for_sol === 1,
		isActive: pkg.is_active === 1,
		createdAt: pkg.created_at,
	}));
}

/**
 * Create a new credit package
 */
export function createCreditPackage(data: {
	name: string;
	credits: number;
	priceSol: number;
	priceCents?: number | null;
	stripePriceId?: string | null;
	availableForUsd?: boolean;
	availableForSol?: boolean;
	isActive?: boolean;
}): SolanaCreditPackage | null {
	const db = getDb();
	const id = crypto.randomUUID();

	db.prepare(`
		INSERT INTO solana_credit_packages (id, name, credits, price_sol, price_cents, stripe_price_id, available_for_usd, available_for_sol, is_active)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
	`).run(
		id,
		data.name,
		data.credits,
		data.priceSol,
		data.priceCents ?? null,
		data.stripePriceId ?? null,
		data.availableForUsd === true ? 1 : 0,
		data.availableForSol !== false ? 1 : 0,
		data.isActive !== false ? 1 : 0,
	);

	return {
		id,
		name: data.name,
		credits: data.credits,
		priceSol: data.priceSol,
		priceCents: data.priceCents ?? null,
		stripePriceId: data.stripePriceId ?? null,
		availableForUsd: data.availableForUsd === true,
		availableForSol: data.availableForSol !== false,
		isActive: data.isActive !== false,
	};
}

/**
 * Update a credit package
 */
export function updateCreditPackage(
	id: string,
	data: {
		name?: string;
		credits?: number;
		priceSol?: number;
		priceCents?: number | null;
		stripePriceId?: string | null;
		availableForUsd?: boolean;
		availableForSol?: boolean;
		isActive?: boolean;
	},
): boolean {
	const db = getDb();

	const updates: string[] = [];
	const params: SQLQueryBindings[] = [];

	if (data.name !== undefined) {
		updates.push("name = ?");
		params.push(data.name);
	}
	if (data.credits !== undefined) {
		updates.push("credits = ?");
		params.push(data.credits);
	}
	if (data.priceSol !== undefined) {
		updates.push("price_sol = ?");
		params.push(data.priceSol);
	}
	if (data.priceCents !== undefined) {
		updates.push("price_cents = ?");
		params.push(data.priceCents);
	}
	if (data.stripePriceId !== undefined) {
		updates.push("stripe_price_id = ?");
		params.push(data.stripePriceId);
	}
	if (data.availableForUsd !== undefined) {
		updates.push("available_for_usd = ?");
		params.push(data.availableForUsd ? 1 : 0);
	}
	if (data.availableForSol !== undefined) {
		updates.push("available_for_sol = ?");
		params.push(data.availableForSol ? 1 : 0);
	}
	if (data.isActive !== undefined) {
		updates.push("is_active = ?");
		params.push(data.isActive ? 1 : 0);
	}

	if (updates.length === 0) {
		return true;
	}

	params.push(id);
	const result = db
		.prepare(`UPDATE solana_credit_packages SET ${updates.join(", ")} WHERE id = ?`)
		.run(...params);

	return result.changes > 0;
}

/**
 * Delete (deactivate) a credit package
 */
export function deleteCreditPackage(id: string): boolean {
	const db = getDb();
	const result = db.prepare("UPDATE solana_credit_packages SET is_active = 0 WHERE id = ?").run(id);
	return result.changes > 0;
}
