import { Connection, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import crypto from "node:crypto";
import { getDb } from "../db";
import { addCredits } from "./usage";

// Environment configuration
const SOLANA_NETWORK = process.env.SOLANA_NETWORK || "mainnet-beta";
const SOLANA_RPC_URL =
	process.env.SOLANA_RPC_URL ||
	(SOLANA_NETWORK === "devnet"
		? "https://api.devnet.solana.com"
		: "https://api.mainnet-beta.solana.com");
const SOLANA_TREASURY_WALLET = process.env.SOLANA_TREASURY_WALLET || "";

// Custom fetch that adds Origin header for Alchemy
const customFetch: typeof fetch = (input, init) => {
	const headers = new Headers(init?.headers);
	headers.set("Origin", "https://ollo.art");
	headers.set("Referer", "https://ollo.art/");
	return fetch(input, { ...init, headers });
};

// Solana connection instance
let connection: Connection | null = null;

function getConnection(): Connection {
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
async function getSolUsdPrice(): Promise<number> {
	try {
		const res = await fetch(
			"https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd",
		);
		const data = await res.json();
		return data.solana?.usd || 250; // fallback to $250
	} catch {
		return 250; // fallback
	}
}

export interface SolanaCreditPackage {
	id: string;
	name: string;
	credits: number;
	priceSol: number;
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
			SELECT id, name, credits, price_sol, is_active
			FROM solana_credit_packages
			WHERE is_active = 1
			ORDER BY credits ASC
		`)
		.all() as Array<{
		id: string;
		name: string;
		credits: number;
		price_sol: number;
		is_active: number;
	}>;

	return packages.map((pkg) => ({
		id: pkg.id,
		name: pkg.name,
		credits: pkg.credits,
		priceSol: pkg.price_sol,
		isActive: pkg.is_active === 1,
	}));
}

/**
 * Get a specific credit package by ID
 */
export function getCreditPackage(packageId: string): SolanaCreditPackage | null {
	const db = getDb();
	const pkg = db
		.prepare("SELECT id, name, credits, price_sol, is_active FROM solana_credit_packages WHERE id = ?")
		.get(packageId) as
		| { id: string; name: string; credits: number; price_sol: number; is_active: number }
		| undefined;

	if (!pkg) return null;

	return {
		id: pkg.id,
		name: pkg.name,
		credits: pkg.credits,
		priceSol: pkg.price_sol,
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
	if (!pkg || !pkg.isActive) {
		return null;
	}

	const db = getDb();
	const paymentId = crypto.randomUUID();
	const amountLamports = Math.round(pkg.priceSol * LAMPORTS_PER_SOL);

	// Create a placeholder transaction record (signature will be empty until verified)
	// We use the paymentId as a temporary signature to track this pending payment
	db.prepare(`
		INSERT INTO solana_transactions
		(id, user_id, wallet_address, transaction_signature, amount_lamports, amount_sol, credits_purchased, status, network)
		VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
	`).run(
		paymentId,
		userId,
		walletAddress,
		`pending_${paymentId}`, // Temporary placeholder
		amountLamports,
		pkg.priceSol,
		pkg.credits,
		SOLANA_NETWORK,
	);

	return {
		paymentId,
		recipientWallet: SOLANA_TREASURY_WALLET,
		amountLamports,
		amountSol: pkg.priceSol,
		credits: pkg.credits,
		packageName: pkg.name,
	};
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

	// Get the pending payment
	const pending = db
		.prepare(`
			SELECT id, user_id, amount_lamports, credits_purchased, status
			FROM solana_transactions
			WHERE id = ? AND user_id = ?
		`)
		.get(paymentId, userId) as
		| {
				id: string;
				user_id: string;
				amount_lamports: number;
				credits_purchased: number;
				status: string;
		  }
		| undefined;

	if (!pending) {
		return { success: false, error: "Payment not found" };
	}

	if (pending.status === "completed") {
		return { success: false, error: "Payment already processed" };
	}

	// Check if signature was already used
	const existingWithSignature = db
		.prepare("SELECT id FROM solana_transactions WHERE transaction_signature = ? AND id != ?")
		.get(signature, paymentId) as { id: string } | undefined;

	if (existingWithSignature) {
		return { success: false, error: "Transaction signature already used" };
	}

	try {
		const conn = getConnection();

		// Poll for transaction confirmation with retries
		// Transaction may take a few seconds to be finalized
		const maxRetries = 30; // 30 retries * 2 seconds = 60 seconds max wait
		const retryDelay = 2000; // 2 seconds between retries

		let tx = null;
		for (let attempt = 0; attempt < maxRetries; attempt++) {
			// First check if transaction is confirmed at all
			const status = await conn.getSignatureStatus(signature);

			if (status.value?.err) {
				return { success: false, error: "Transaction failed on chain" };
			}

			// Try to get transaction details
			tx = await conn.getTransaction(signature, {
				commitment: "confirmed", // Use confirmed first, then verify finalized
				maxSupportedTransactionVersion: 0,
			});

			if (tx) {
				// Transaction found, verify it's finalized for safety
				const finalizedTx = await conn.getTransaction(signature, {
					commitment: "finalized",
					maxSupportedTransactionVersion: 0,
				});

				if (finalizedTx) {
					tx = finalizedTx;
					break;
				}
				// If not finalized yet but confirmed, wait a bit more
			}

			// Wait before retrying
			if (attempt < maxRetries - 1) {
				await new Promise((resolve) => setTimeout(resolve, retryDelay));
			}
		}

		if (!tx) {
			return { success: false, error: "Transaction not found or not confirmed. Please wait and try again." };
		}

		// Double-check for transaction errors
		if (tx.meta?.err) {
			return { success: false, error: "Transaction failed on chain" };
		}

		// Verify the transaction details
		const treasuryPubkey = new PublicKey(SOLANA_TREASURY_WALLET);
		const accountKeys = tx.transaction.message.staticAccountKeys || tx.transaction.message.accountKeys;

		// Find the treasury wallet in the account keys
		const treasuryIndex = accountKeys.findIndex(
			(key) => key.toBase58() === treasuryPubkey.toBase58(),
		);

		if (treasuryIndex === -1) {
			return { success: false, error: "Treasury wallet not found in transaction" };
		}

		// Check pre/post balance change for the treasury
		const preBalance = tx.meta?.preBalances[treasuryIndex] || 0;
		const postBalance = tx.meta?.postBalances[treasuryIndex] || 0;
		const received = postBalance - preBalance;

		// Allow 1% tolerance for rounding
		const expectedAmount = pending.amount_lamports;
		const tolerance = Math.max(expectedAmount * 0.01, 1000); // 1% or 1000 lamports minimum

		if (received < expectedAmount - tolerance) {
			return {
				success: false,
				error: `Insufficient amount received. Expected ${expectedAmount} lamports, got ${received}`,
			};
		}

		// Update transaction record with verified signature
		db.prepare(`
			UPDATE solana_transactions
			SET transaction_signature = ?, status = 'completed', verified_at = datetime('now')
			WHERE id = ?
		`).run(signature, paymentId);

		// Add credits to user
		addCredits(
			userId,
			pending.credits_purchased,
			"purchased",
			`SOL payment - ${pending.credits_purchased} credits`,
		);

		// Record revenue event for financials
		const amountSol = pending.amount_lamports / LAMPORTS_PER_SOL;
		const solPrice = await getSolUsdPrice();
		const usdCents = Math.round(amountSol * solPrice * 100);
		db.prepare(`
			INSERT INTO revenue_events (id, user_id, event_type, amount_cents, description)
			VALUES (?, ?, 'credit_purchase', ?, ?)
		`).run(crypto.randomUUID(), userId, usdCents, `SOL payment: ${amountSol} SOL`);

		return { success: true, credits: pending.credits_purchased };
	} catch (error) {
		console.error("Error verifying Solana transaction:", error);
		return {
			success: false,
			error: error instanceof Error ? error.message : "Failed to verify transaction",
		};
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
 * Clean up old pending transactions (older than 1 hour)
 */
export function cleanupPendingTransactions(): void {
	const db = getDb();
	db.prepare(`
		DELETE FROM solana_transactions
		WHERE status = 'pending' AND created_at < datetime('now', '-1 hour')
	`).run();
	// Also clean up pending subscription transactions
	db.prepare(`
		DELETE FROM solana_subscription_transactions
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

	// Create pending subscription transaction
	db.prepare(`
		INSERT INTO solana_subscription_transactions
		(id, user_id, product_id, wallet_address, transaction_signature, amount_lamports, amount_sol, status, network)
		VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
	`).run(
		paymentId,
		userId,
		productId,
		walletAddress,
		`pending_${paymentId}`,
		amountLamports,
		product.price_sol,
		SOLANA_NETWORK,
	);

	return {
		paymentId,
		recipientWallet: SOLANA_TREASURY_WALLET,
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

	// Get pending payment
	const pending = db
		.prepare(`
			SELECT id, user_id, product_id, amount_lamports, status
			FROM solana_subscription_transactions
			WHERE id = ? AND user_id = ?
		`)
		.get(paymentId, userId) as
		| {
				id: string;
				user_id: string;
				product_id: string;
				amount_lamports: number;
				status: string;
		  }
		| undefined;

	if (!pending) {
		return { success: false, error: "Payment not found" };
	}

	if (pending.status === "completed") {
		return { success: false, error: "Payment already processed" };
	}

	// Check if signature already used
	const existingWithSignature = db
		.prepare(
			"SELECT id FROM solana_subscription_transactions WHERE transaction_signature = ? AND id != ?",
		)
		.get(signature, paymentId) as { id: string } | undefined;

	if (existingWithSignature) {
		return { success: false, error: "Transaction signature already used" };
	}

	try {
		const conn = getConnection();

		// Poll for transaction confirmation
		const maxRetries = 30;
		const retryDelay = 2000;

		let tx = null;
		for (let attempt = 0; attempt < maxRetries; attempt++) {
			const status = await conn.getSignatureStatus(signature);

			if (status.value?.err) {
				return { success: false, error: "Transaction failed on chain" };
			}

			tx = await conn.getTransaction(signature, {
				commitment: "confirmed",
				maxSupportedTransactionVersion: 0,
			});

			if (tx) {
				const finalizedTx = await conn.getTransaction(signature, {
					commitment: "finalized",
					maxSupportedTransactionVersion: 0,
				});

				if (finalizedTx) {
					tx = finalizedTx;
					break;
				}
			}

			if (attempt < maxRetries - 1) {
				await new Promise((resolve) => setTimeout(resolve, retryDelay));
			}
		}

		if (!tx) {
			return {
				success: false,
				error: "Transaction not found or not confirmed. Please wait and try again.",
			};
		}

		if (tx.meta?.err) {
			return { success: false, error: "Transaction failed on chain" };
		}

		// Verify treasury received the payment
		const treasuryPubkey = new PublicKey(SOLANA_TREASURY_WALLET);
		const accountKeys =
			tx.transaction.message.staticAccountKeys || tx.transaction.message.accountKeys;

		const treasuryIndex = accountKeys.findIndex(
			(key) => key.toBase58() === treasuryPubkey.toBase58(),
		);

		if (treasuryIndex === -1) {
			return { success: false, error: "Treasury wallet not found in transaction" };
		}

		const preBalance = tx.meta?.preBalances[treasuryIndex] || 0;
		const postBalance = tx.meta?.postBalances[treasuryIndex] || 0;
		const received = postBalance - preBalance;

		const expectedAmount = pending.amount_lamports;
		const tolerance = Math.max(expectedAmount * 0.01, 1000);

		if (received < expectedAmount - tolerance) {
			return {
				success: false,
				error: `Insufficient amount received. Expected ${expectedAmount} lamports, got ${received}`,
			};
		}

		// End existing subscriptions
		db.prepare(`
			UPDATE user_subscriptions
			SET ends_at = datetime('now')
			WHERE user_id = ? AND (ends_at IS NULL OR ends_at > datetime('now'))
		`).run(userId);

		// Create new subscription (30 days)
		const subscriptionId = crypto.randomUUID();
		const startsAt = new Date().toISOString();
		const endsAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

		db.prepare(`
			INSERT INTO user_subscriptions (id, user_id, product_id, starts_at, ends_at, status, current_period_start, current_period_end)
			VALUES (?, ?, ?, ?, ?, 'active', ?, ?)
		`).run(subscriptionId, userId, pending.product_id, startsAt, endsAt, startsAt, endsAt);

		// Add bonus credits from the product
		const product = db
			.prepare("SELECT bonus_credits FROM subscription_products WHERE id = ?")
			.get(pending.product_id) as { bonus_credits: number } | undefined;

		if (product && product.bonus_credits > 0) {
			addCredits(userId, product.bonus_credits, "bonus", "Subscription welcome bonus (SOL)");
		}

		// Update transaction record
		db.prepare(`
			UPDATE solana_subscription_transactions
			SET transaction_signature = ?, status = 'completed', verified_at = datetime('now'), subscription_id = ?
			WHERE id = ?
		`).run(signature, subscriptionId, paymentId);

		// Record revenue event
		const amountSol = pending.amount_lamports / LAMPORTS_PER_SOL;
		const solPrice = await getSolUsdPrice();
		const usdCents = Math.round(amountSol * solPrice * 100);

		db.prepare(`
			INSERT INTO revenue_events (id, user_id, event_type, amount_cents, description)
			VALUES (?, ?, 'sol_subscription', ?, ?)
		`).run(crypto.randomUUID(), userId, usdCents, `SOL subscription: ${amountSol} SOL`);

		return { success: true, subscriptionId };
	} catch (error) {
		console.error("Error verifying Solana subscription transaction:", error);
		return {
			success: false,
			error: error instanceof Error ? error.message : "Failed to verify transaction",
		};
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
			SELECT id, name, credits, price_sol, is_active, created_at
			FROM solana_credit_packages
			ORDER BY credits ASC
		`)
		.all() as Array<{
		id: string;
		name: string;
		credits: number;
		price_sol: number;
		is_active: number;
		created_at: string;
	}>;

	return packages.map((pkg) => ({
		id: pkg.id,
		name: pkg.name,
		credits: pkg.credits,
		priceSol: pkg.price_sol,
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
	isActive?: boolean;
}): SolanaCreditPackage | null {
	const db = getDb();
	const id = crypto.randomUUID();

	db.prepare(`
		INSERT INTO solana_credit_packages (id, name, credits, price_sol, is_active)
		VALUES (?, ?, ?, ?, ?)
	`).run(id, data.name, data.credits, data.priceSol, data.isActive !== false ? 1 : 0);

	return {
		id,
		name: data.name,
		credits: data.credits,
		priceSol: data.priceSol,
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
		isActive?: boolean;
	},
): boolean {
	const db = getDb();

	const updates: string[] = [];
	const params: unknown[] = [];

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
