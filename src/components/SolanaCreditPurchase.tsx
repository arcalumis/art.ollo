import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import {
	PublicKey,
	SystemProgram,
	Transaction,
} from "@solana/web3.js";
import { useCallback, useEffect, useState } from "react";
import {
	type SolanaCreditPackage,
	type SolanaStatus,
	type SolanaTransaction,
	useSolanaBilling,
} from "../hooks/useSolanaBilling";
import { SolanaWalletButton } from "./SolanaWalletButton";

type PurchaseStep = "select" | "confirm" | "signing" | "verifying" | "success" | "error";

export function SolanaCreditPurchase() {
	const { connection } = useConnection();
	const { publicKey, sendTransaction, connected } = useWallet();
	const {
		loading,
		error,
		getStatus,
		getPackages,
		initiatePayment,
		verifyPayment,
		getTransactions,
		clearError,
	} = useSolanaBilling();

	const [status, setStatus] = useState<SolanaStatus | null>(null);
	const [packages, setPackages] = useState<SolanaCreditPackage[]>([]);
	const [treasuryWallet, setTreasuryWallet] = useState<string | null>(null);
	const [transactions, setTransactions] = useState<SolanaTransaction[]>([]);
	const [selectedPackage, setSelectedPackage] = useState<SolanaCreditPackage | null>(null);
	const [step, setStep] = useState<PurchaseStep>("select");
	const [purchaseError, setPurchaseError] = useState<string | null>(null);
	const [creditsReceived, setCreditsReceived] = useState<number | null>(null);

	// Fetch status and packages on mount
	useEffect(() => {
		async function fetchData() {
			const statusData = await getStatus();
			setStatus(statusData);

			if (statusData?.enabled) {
				const packagesData = await getPackages();
				if (packagesData) {
					setPackages(packagesData.packages);
					setTreasuryWallet(packagesData.treasuryWallet);
				}

				const txHistory = await getTransactions();
				setTransactions(txHistory);
			}
		}
		fetchData();
	}, [getStatus, getPackages, getTransactions]);

	const handlePurchase = useCallback(
		async (pkg: SolanaCreditPackage) => {
			if (!publicKey || !connected) {
				return;
			}

			setSelectedPackage(pkg);
			setStep("confirm");
			setPurchaseError(null);
		},
		[publicKey, connected],
	);

	const confirmPurchase = useCallback(async () => {
		if (!publicKey || !selectedPackage || !treasuryWallet) {
			return;
		}

		setStep("signing");
		setPurchaseError(null);
		clearError();

		try {
			// 1. Initiate payment on backend
			const payment = await initiatePayment(
				selectedPackage.id,
				publicKey.toBase58(),
			);

			if (!payment) {
				throw new Error(error || "Failed to initiate payment");
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

			// 4. Verify with backend (backend will poll for confirmation)
			// Skip client-side confirmTransaction since it uses WebSocket subscriptions
			// that may not be available on all RPC providers
			const result = await verifyPayment(payment.paymentId, signature);

			if (result.success) {
				setCreditsReceived(result.credits || selectedPackage.credits);
				setStep("success");

				// Refresh transaction history
				const txHistory = await getTransactions();
				setTransactions(txHistory);
			} else {
				throw new Error(result.error || "Failed to verify payment");
			}
		} catch (err) {
			console.error("Purchase failed:", err);
			setPurchaseError(
				err instanceof Error ? err.message : "Purchase failed. Please try again.",
			);
			setStep("error");
		}
	}, [
		publicKey,
		selectedPackage,
		treasuryWallet,
		connection,
		sendTransaction,
		initiatePayment,
		verifyPayment,
		getTransactions,
		clearError,
		error,
	]);

	const resetPurchase = useCallback(() => {
		setSelectedPackage(null);
		setStep("select");
		setPurchaseError(null);
		setCreditsReceived(null);
		clearError();
	}, [clearError]);

	const formatDate = (dateStr: string) => {
		return new Date(dateStr).toLocaleDateString("en-US", {
			year: "numeric",
			month: "short",
			day: "numeric",
		});
	};

	if (!status?.enabled) {
		return (
			<div className="cyber-card p-4 text-center">
				<p className="text-gray-400">Solana payments are not configured.</p>
			</div>
		);
	}

	return (
		<div className="space-y-6">
			{/* Wallet Connection */}
			<div className="cyber-card p-4">
				<div className="flex items-center justify-between">
					<div>
						<h3 className="text-sm font-semibold text-white">Solana Wallet</h3>
						<p className="text-xs text-gray-400">
							{connected
								? "Connected - ready to purchase"
								: "Connect your wallet to buy credits"}
						</p>
					</div>
					<SolanaWalletButton />
				</div>
				{status.network === "devnet" && (
					<p className="mt-2 text-xs text-yellow-400">
						Using Devnet - for testing only
					</p>
				)}
			</div>

			{/* Purchase Flow */}
			{connected && (
				<>
					{step === "select" && (
						<div className="cyber-card p-4">
							<h3 className="text-sm font-semibold text-white mb-3">
								Credit Packages
							</h3>
							<div className="grid md:grid-cols-3 gap-4">
								{packages.map((pkg) => (
									<div
										key={pkg.id}
										className="p-4 rounded-lg border border-gray-700 hover:border-purple-500/50 transition-all"
									>
										<h4 className="text-lg font-bold text-white">{pkg.name}</h4>
										<p className="text-2xl font-bold text-purple-400 mt-1">
											{pkg.priceSol} SOL
										</p>
										<p className="text-sm text-gray-400 mt-1">
											{pkg.credits} credits
										</p>
										<p className="text-xs text-gray-500 mt-1">
											{(pkg.priceSol / pkg.credits).toFixed(4)} SOL/credit
										</p>
										<button
											type="button"
											onClick={() => handlePurchase(pkg)}
											disabled={loading}
											className="mt-4 w-full cyber-button text-xs py-2 bg-purple-600 hover:bg-purple-500"
										>
											Buy with SOL
										</button>
									</div>
								))}
							</div>
						</div>
					)}

					{step === "confirm" && selectedPackage && (
						<div className="cyber-card p-4">
							<h3 className="text-sm font-semibold text-white mb-3">
								Confirm Purchase
							</h3>
							<div className="space-y-3">
								<div className="flex justify-between text-sm">
									<span className="text-gray-400">Package</span>
									<span className="text-white">{selectedPackage.name}</span>
								</div>
								<div className="flex justify-between text-sm">
									<span className="text-gray-400">Credits</span>
									<span className="text-white">{selectedPackage.credits}</span>
								</div>
								<div className="flex justify-between text-sm">
									<span className="text-gray-400">Amount</span>
									<span className="text-purple-400 font-bold">
										{selectedPackage.priceSol} SOL
									</span>
								</div>
								<div className="pt-3 border-t border-gray-700 flex gap-3">
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
							<p className="text-white font-semibold">
								{step === "signing"
									? "Please sign the transaction in your wallet..."
									: "Verifying transaction..."}
							</p>
							<p className="text-xs text-gray-400 mt-2">
								{step === "signing"
									? "A popup should appear from your wallet"
									: "Waiting for blockchain confirmation"}
							</p>
						</div>
					)}

					{step === "success" && (
						<div className="cyber-card p-4 text-center">
							<div className="text-green-400 text-4xl mb-4">&#10003;</div>
							<p className="text-white font-semibold">Purchase Successful!</p>
							<p className="text-purple-400 text-lg mt-2">
								+{creditsReceived} credits
							</p>
							<div className="mt-4">
								<a
									href="/"
									className="cyber-button text-xs py-2 px-6 bg-purple-600 hover:bg-purple-500 inline-block"
								>
									Start Creating
								</a>
							</div>
						</div>
					)}

					{step === "error" && (
						<div className="cyber-card p-4 text-center">
							<div className="text-red-400 text-4xl mb-4">✕</div>
							<p className="text-white font-semibold">Purchase Failed</p>
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

			{/* Transaction History */}
			{transactions.length > 0 && (
				<div className="cyber-card p-4">
					<h3 className="text-sm font-semibold text-white mb-3">
						SOL Payment History
					</h3>
					<div className="space-y-2">
						{transactions.map((tx) => (
							<div
								key={tx.id}
								className="flex items-center justify-between p-2 bg-black/30 rounded text-sm"
							>
								<div>
									<p className="text-white">+{tx.credits} credits</p>
									<p className="text-[10px] text-gray-500">
										{formatDate(tx.date)}
									</p>
								</div>
								<div className="text-right">
									<span className="text-purple-400 font-medium">
										{tx.amountSol} SOL
									</span>
									<a
										href={`https://solscan.io/tx/${tx.signature}${status.network === "devnet" ? "?cluster=devnet" : ""}`}
										target="_blank"
										rel="noopener noreferrer"
										className="block text-[10px] text-gray-500 hover:text-cyan-400"
									>
										View on Solscan
									</a>
								</div>
							</div>
						))}
					</div>
				</div>
			)}
		</div>
	);
}
