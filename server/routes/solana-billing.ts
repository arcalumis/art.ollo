import type { FastifyInstance } from "fastify";
import { authMiddleware } from "../middleware/auth";
import {
	cleanupPendingTransactions,
	getCreditPackages,
	getSolanaNetwork,
	getSolanaSubscriptionProducts,
	getTreasuryWallet,
	getUserTransactions,
	initiatePayment,
	initiateSubscriptionPayment,
	isSolanaConfigured,
	verifyAndCreditTransaction,
	verifyAndCreateSubscription,
} from "../services/solana";

interface InitiateBody {
	packageId: string;
	walletAddress: string;
}

interface VerifyBody {
	paymentId: string;
	signature: string;
}

interface SubscriptionInitiateBody {
	productId: string;
	walletAddress: string;
}

interface SubscriptionVerifyBody {
	paymentId: string;
	signature: string;
}

export async function solanaBillingRoutes(fastify: FastifyInstance): Promise<void> {
	// Check if Solana payments are enabled
	fastify.get("/api/billing/solana/status", async () => {
		return {
			enabled: isSolanaConfigured(),
			network: getSolanaNetwork(),
		};
	});

	// Get available credit packages
	fastify.get("/api/billing/solana/packages", async () => {
		const packages = getCreditPackages();
		return {
			packages: packages.map((pkg) => ({
				id: pkg.id,
				name: pkg.name,
				credits: pkg.credits,
				priceSol: pkg.priceSol,
			})),
			treasuryWallet: isSolanaConfigured() ? getTreasuryWallet() : null,
		};
	});

	// Initiate a payment
	fastify.post<{ Body: InitiateBody }>(
		"/api/billing/solana/initiate",
		{ preHandler: authMiddleware },
		async (request, reply) => {
			fastify.log.info({ body: request.body }, "Solana initiate request received");

			if (!isSolanaConfigured()) {
				return reply.status(400).send({ error: "Solana payments not configured" });
			}

			const userId = request.user?.userId;
			if (!userId) {
				return reply.status(401).send({ error: "Unauthorized" });
			}

			const { packageId, walletAddress } = request.body;

			if (!packageId || !walletAddress) {
				return reply.status(400).send({ error: "Missing packageId or walletAddress" });
			}

			// Basic wallet address validation
			if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(walletAddress)) {
				return reply.status(400).send({ error: "Invalid wallet address format" });
			}

			const payment = initiatePayment(userId, packageId, walletAddress);

			if (!payment) {
				fastify.log.error({ packageId, userId }, "Failed to initiate payment");
				return reply.status(400).send({ error: "Failed to initiate payment. Package may not exist." });
			}

			fastify.log.info({ paymentId: payment.paymentId, userId, credits: payment.credits }, "Payment initiated");
			return {
				paymentId: payment.paymentId,
				recipientWallet: payment.recipientWallet,
				amountLamports: payment.amountLamports,
				amountSol: payment.amountSol,
				credits: payment.credits,
				packageName: payment.packageName,
			};
		},
	);

	// Verify transaction and credit user
	fastify.post<{ Body: VerifyBody }>(
		"/api/billing/solana/verify",
		{
			preHandler: authMiddleware,
			config: {
				rateLimit: {
					max: 10, // Limit verification attempts
					timeWindow: "1 minute",
				},
			},
		},
		async (request, reply) => {
			fastify.log.info({ body: request.body }, "Solana verify request received");

			if (!isSolanaConfigured()) {
				fastify.log.warn("Solana payments not configured");
				return reply.status(400).send({ error: "Solana payments not configured" });
			}

			const userId = request.user?.userId;
			if (!userId) {
				fastify.log.warn("Unauthorized verify attempt");
				return reply.status(401).send({ error: "Unauthorized" });
			}

			const { paymentId, signature } = request.body;

			if (!paymentId || !signature) {
				fastify.log.warn({ paymentId, signature }, "Missing paymentId or signature");
				return reply.status(400).send({ error: "Missing paymentId or signature" });
			}

			// Basic signature validation (base58, 87-88 chars)
			if (!/^[1-9A-HJ-NP-Za-km-z]{87,88}$/.test(signature)) {
				fastify.log.warn({ signature }, "Invalid signature format");
				return reply.status(400).send({ error: "Invalid transaction signature format" });
			}

			fastify.log.info({ paymentId, signature, userId }, "Starting verification");
			const result = await verifyAndCreditTransaction(paymentId, signature, userId);
			fastify.log.info({ result }, "Verification result");

			if (!result.success) {
				fastify.log.error({ error: result.error, paymentId }, "Verification failed");
				return reply.status(400).send({ error: result.error });
			}

			fastify.log.info({ credits: result.credits, userId }, "Credits added successfully");
			return {
				success: true,
				credits: result.credits,
				message: `Successfully added ${result.credits} credits to your account`,
			};
		},
	);

	// Get user's Solana transaction history
	fastify.get(
		"/api/billing/solana/transactions",
		{ preHandler: authMiddleware },
		async (request, reply) => {
			const userId = request.user?.userId;
			if (!userId) {
				return reply.status(401).send({ error: "Unauthorized" });
			}

			const transactions = getUserTransactions(userId);

			return {
				transactions: transactions.map((tx) => ({
					id: tx.id,
					walletAddress: tx.walletAddress,
					signature: tx.transactionSignature,
					amountSol: tx.amountSol,
					credits: tx.creditsPurchased,
					status: tx.status,
					network: tx.network,
					date: tx.createdAt,
				})),
			};
		},
	);

	// ============================================
	// SUBSCRIPTION PURCHASES WITH SOL
	// ============================================

	// Get subscription products available for SOL purchase
	fastify.get("/api/billing/solana/subscription-products", async () => {
		const products = getSolanaSubscriptionProducts();
		return {
			products,
			treasuryWallet: isSolanaConfigured() ? getTreasuryWallet() : null,
		};
	});

	// Initiate subscription payment
	fastify.post<{ Body: SubscriptionInitiateBody }>(
		"/api/billing/solana/subscribe/initiate",
		{ preHandler: authMiddleware },
		async (request, reply) => {
			fastify.log.info({ body: request.body }, "Solana subscription initiate request received");

			if (!isSolanaConfigured()) {
				return reply.status(400).send({ error: "Solana payments not configured" });
			}

			const userId = request.user?.userId;
			if (!userId) {
				return reply.status(401).send({ error: "Unauthorized" });
			}

			const { productId, walletAddress } = request.body;

			if (!productId || !walletAddress) {
				return reply.status(400).send({ error: "Missing productId or walletAddress" });
			}

			// Basic wallet address validation
			if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(walletAddress)) {
				return reply.status(400).send({ error: "Invalid wallet address format" });
			}

			const payment = initiateSubscriptionPayment(userId, productId, walletAddress);

			if (!payment) {
				fastify.log.error({ productId, userId }, "Failed to initiate subscription payment");
				return reply
					.status(400)
					.send({ error: "Failed to initiate payment. Product may not be available for SOL." });
			}

			fastify.log.info(
				{ paymentId: payment.paymentId, userId, product: payment.productName },
				"Subscription payment initiated",
			);
			return {
				paymentId: payment.paymentId,
				recipientWallet: payment.recipientWallet,
				amountLamports: payment.amountLamports,
				amountSol: payment.amountSol,
				productName: payment.productName,
				productId: payment.productId,
			};
		},
	);

	// Verify subscription transaction and create subscription
	fastify.post<{ Body: SubscriptionVerifyBody }>(
		"/api/billing/solana/subscribe/verify",
		{
			preHandler: authMiddleware,
			config: {
				rateLimit: {
					max: 10,
					timeWindow: "1 minute",
				},
			},
		},
		async (request, reply) => {
			fastify.log.info({ body: request.body }, "Solana subscription verify request received");

			if (!isSolanaConfigured()) {
				fastify.log.warn("Solana payments not configured");
				return reply.status(400).send({ error: "Solana payments not configured" });
			}

			const userId = request.user?.userId;
			if (!userId) {
				fastify.log.warn("Unauthorized verify attempt");
				return reply.status(401).send({ error: "Unauthorized" });
			}

			const { paymentId, signature } = request.body;

			if (!paymentId || !signature) {
				fastify.log.warn({ paymentId, signature }, "Missing paymentId or signature");
				return reply.status(400).send({ error: "Missing paymentId or signature" });
			}

			// Basic signature validation (base58, 87-88 chars)
			if (!/^[1-9A-HJ-NP-Za-km-z]{87,88}$/.test(signature)) {
				fastify.log.warn({ signature }, "Invalid signature format");
				return reply.status(400).send({ error: "Invalid transaction signature format" });
			}

			fastify.log.info({ paymentId, signature, userId }, "Starting subscription verification");
			const result = await verifyAndCreateSubscription(paymentId, signature, userId);
			fastify.log.info({ result }, "Subscription verification result");

			if (!result.success) {
				fastify.log.error({ error: result.error, paymentId }, "Subscription verification failed");
				return reply.status(400).send({ error: result.error });
			}

			fastify.log.info(
				{ subscriptionId: result.subscriptionId, userId },
				"Subscription created successfully",
			);
			return {
				success: true,
				subscriptionId: result.subscriptionId,
				message: "Subscription activated successfully!",
			};
		},
	);

	// Cleanup endpoint (can be called by cron or admin)
	fastify.post("/api/billing/solana/cleanup", async () => {
		cleanupPendingTransactions();
		return { success: true };
	});
}
