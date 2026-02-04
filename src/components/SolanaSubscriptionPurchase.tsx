import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { useCallback, useEffect, useState } from "react";
import {
	type SolanaStatus,
	type SolanaSubscriptionProduct,
	useSolanaBilling,
} from "../hooks/useSolanaBilling";
import { SolanaWalletButton } from "./SolanaWalletButton";

type PurchaseStep = "select" | "confirm" | "signing" | "verifying" | "success" | "error";

export function SolanaSubscriptionPurchase() {
	const { connection } = useConnection();
	const { publicKey, sendTransaction, connected } = useWallet();
	const {
		loading,
		error,
		getStatus,
		getSubscriptionProducts,
		initiateSubscription,
		verifySubscription,
		clearError,
	} = useSolanaBilling();

	const [status, setStatus] = useState<SolanaStatus | null>(null);
	const [products, setProducts] = useState<SolanaSubscriptionProduct[]>([]);
	const [treasuryWallet, setTreasuryWallet] = useState<string | null>(null);
	const [selectedProduct, setSelectedProduct] = useState<SolanaSubscriptionProduct | null>(null);
	const [step, setStep] = useState<PurchaseStep>("select");
	const [purchaseError, setPurchaseError] = useState<string | null>(null);

	// Fetch status and products on mount
	useEffect(() => {
		async function fetchData() {
			const statusData = await getStatus();
			setStatus(statusData);

			if (statusData?.enabled) {
				const productsData = await getSubscriptionProducts();
				if (productsData) {
					setProducts(productsData.products);
					setTreasuryWallet(productsData.treasuryWallet);
				}
			}
		}
		fetchData();
	}, [getStatus, getSubscriptionProducts]);

	const handlePurchase = useCallback(
		(product: SolanaSubscriptionProduct) => {
			if (!publicKey || !connected) {
				return;
			}

			setSelectedProduct(product);
			setStep("confirm");
			setPurchaseError(null);
		},
		[publicKey, connected],
	);

	const confirmPurchase = useCallback(async () => {
		if (!publicKey || !selectedProduct || !treasuryWallet) {
			return;
		}

		setStep("signing");
		setPurchaseError(null);
		clearError();

		try {
			// 1. Initiate payment on backend
			const payment = await initiateSubscription(
				selectedProduct.id,
				publicKey.toBase58(),
			);

			if (!payment) {
				throw new Error(error || "Failed to initiate subscription");
			}

			// 2. Build and send transaction
			const treasuryPubkey = new PublicKey(payment.recipientWallet);
			const transaction = new Transaction().add(
				SystemProgram.transfer({
					fromPubkey: publicKey,
					toPubkey: treasuryPubkey,
					lamports: payment.amountLamports,
				}),
			);

			const { blockhash } = await connection.getLatestBlockhash("finalized");
			transaction.recentBlockhash = blockhash;
			transaction.feePayer = publicKey;

			// 3. Request signature from wallet
			const signature = await sendTransaction(transaction, connection, {
				skipPreflight: false,
				preflightCommitment: "confirmed",
			});

			setStep("verifying");

			// 4. Verify with backend
			const result = await verifySubscription(payment.paymentId, signature);

			if (result.success) {
				setStep("success");
			} else {
				throw new Error(result.error || "Failed to verify subscription");
			}
		} catch (err) {
			console.error("Subscription purchase failed:", err);
			setPurchaseError(
				err instanceof Error ? err.message : "Purchase failed. Please try again.",
			);
			setStep("error");
		}
	}, [
		publicKey,
		selectedProduct,
		treasuryWallet,
		connection,
		sendTransaction,
		initiateSubscription,
		verifySubscription,
		clearError,
		error,
	]);

	const resetPurchase = useCallback(() => {
		setSelectedProduct(null);
		setStep("select");
		setPurchaseError(null);
		clearError();
	}, [clearError]);

	if (!status?.enabled) {
		return null; // Don't render if Solana is not enabled
	}

	if (products.length === 0) {
		return null; // No products available for SOL purchase
	}

	return (
		<div className="space-y-4">
			<div className="flex items-center justify-between">
				<div>
					<h3 className="text-sm font-semibold text-[var(--text-primary)]">
						Upgrade with SOL
					</h3>
					<p className="text-xs text-[var(--text-secondary)]">
						{connected
							? "Select a plan to upgrade"
							: "Connect your wallet to upgrade"}
					</p>
				</div>
				<SolanaWalletButton />
			</div>

			{status.network === "devnet" && (
				<p className="text-xs text-yellow-400">Using Devnet - for testing only</p>
			)}

			{connected && (
				<>
					{step === "select" && (
						<div className="grid md:grid-cols-2 gap-4">
							{products.map((product) => (
								<div
									key={product.id}
									className="p-4 rounded-lg border border-[var(--border)] hover:border-purple-500/50 transition-all"
								>
									<h4 className="text-lg font-bold text-[var(--text-primary)]">
										{product.name}
									</h4>
									<div className="flex items-baseline gap-2 mt-1">
										<span className="text-2xl font-bold text-purple-400">
											{product.priceSol} SOL
										</span>
										<span className="text-xs text-[var(--text-secondary)]">
											(~${product.priceUsd}/mo)
										</span>
									</div>
									{product.description && (
										<p className="text-xs text-[var(--text-secondary)] mt-2">
											{product.description}
										</p>
									)}
									<ul className="mt-3 space-y-1 text-xs text-[var(--text-secondary)]">
										{product.monthlyImageLimit && (
											<li>{product.monthlyImageLimit} images/month</li>
										)}
										{product.dailyImageLimit && (
											<li>{product.dailyImageLimit} images/day</li>
										)}
										{product.bonusCredits > 0 && (
											<li>{product.bonusCredits} bonus credits</li>
										)}
									</ul>
									<button
										type="button"
										onClick={() => handlePurchase(product)}
										disabled={loading}
										className="mt-4 w-full cyber-button text-xs py-2 bg-purple-600 hover:bg-purple-500"
									>
										Upgrade with SOL
									</button>
								</div>
							))}
						</div>
					)}

					{step === "confirm" && selectedProduct && (
						<div className="cyber-card p-4">
							<h3 className="text-sm font-semibold text-[var(--text-primary)] mb-3">
								Confirm Upgrade
							</h3>
							<div className="space-y-3">
								<div className="flex justify-between text-sm">
									<span className="text-[var(--text-secondary)]">Plan</span>
									<span className="text-[var(--text-primary)]">
										{selectedProduct.name}
									</span>
								</div>
								<div className="flex justify-between text-sm">
									<span className="text-[var(--text-secondary)]">Duration</span>
									<span className="text-[var(--text-primary)]">30 days</span>
								</div>
								<div className="flex justify-between text-sm">
									<span className="text-[var(--text-secondary)]">Amount</span>
									<span className="text-purple-400 font-bold">
										{selectedProduct.priceSol} SOL
									</span>
								</div>
								<div className="pt-3 border-t border-[var(--border)] flex gap-3">
									<button
										type="button"
										onClick={resetPurchase}
										className="flex-1 cyber-button text-xs py-2"
									>
										Cancel
									</button>
									<button
										type="button"
										onClick={confirmPurchase}
										disabled={loading}
										className="flex-1 cyber-button text-xs py-2 bg-purple-600 hover:bg-purple-500"
									>
										Confirm & Sign
									</button>
								</div>
							</div>
						</div>
					)}

					{(step === "signing" || step === "verifying") && (
						<div className="cyber-card p-4 text-center">
							<div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-purple-500 mx-auto mb-4" />
							<p className="text-[var(--text-primary)] font-semibold">
								{step === "signing"
									? "Please sign the transaction in your wallet..."
									: "Verifying transaction..."}
							</p>
							<p className="text-xs text-[var(--text-secondary)] mt-2">
								{step === "signing"
									? "A popup should appear from your wallet"
									: "Waiting for blockchain confirmation"}
							</p>
						</div>
					)}

					{step === "success" && (
						<div className="cyber-card p-4 text-center">
							<div className="text-green-400 text-4xl mb-4">&#10003;</div>
							<p className="text-[var(--text-primary)] font-semibold">
								Upgrade Complete!
							</p>
							<p className="text-[var(--text-secondary)] text-sm mt-2">
								Your premium access is now active for 30 days
							</p>
							<a
								href="/"
								className="mt-4 inline-block cyber-button text-xs py-2 px-6 bg-purple-600 hover:bg-purple-500"
							>
								Start Creating
							</a>
						</div>
					)}

					{step === "error" && (
						<div className="cyber-card p-4 text-center">
							<div className="text-red-400 text-4xl mb-4">&#10007;</div>
							<p className="text-[var(--text-primary)] font-semibold">
								Upgrade Failed
							</p>
							<p className="text-red-400 text-sm mt-2">
								{purchaseError || error || "Unknown error"}
							</p>
							<button
								type="button"
								onClick={resetPurchase}
								className="mt-4 cyber-button text-xs py-2 px-6"
							>
								Try Again
							</button>
						</div>
					)}
				</>
			)}
		</div>
	);
}
