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
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { SolanaWalletButton } from "./SolanaWalletButton";

type PurchaseStep = "select" | "confirm" | "signing" | "verifying" | "success" | "error";

interface SolanaCreditPurchaseProps {
	/** Called after a verified purchase, with the credits added. */
	onPurchaseComplete?: (credits: number) => void;
	/** Hide payment history (used inside the paywall sheet). */
	compact?: boolean;
}

/** Wallet errors are noisy; keep the message human and short. */
function friendlySolError(message: string | null): string {
	if (!message) return "The payment didn't go through. Nothing was charged.";
	if (/reject|denied|cancel/i.test(message)) return "The wallet request was declined. Nothing was charged.";
	if (/insufficient|balance/i.test(message)) return "Your wallet doesn't have enough SOL for this pack and the network fee.";
	if (/verify|confirm|timeout/i.test(message))
		return "We couldn't confirm the payment yet. If SOL left your wallet, your credits arrive once it confirms. Contact support if they don't.";
	return "The payment didn't go through. Try again, or pay by card instead.";
}

export function SolanaCreditPurchase({ onPurchaseComplete, compact = false }: SolanaCreditPurchaseProps = {}) {
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
				const added = result.credits || selectedPackage.credits;
				setCreditsReceived(added);
				setStep("success");
				onPurchaseComplete?.(added);

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
		onPurchaseComplete,
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

	if (status === null) {
		return <Skeleton className="h-24 w-full rounded-2xl" />;
	}

	if (!status.enabled) {
		return <p className="text-sm text-muted-foreground">Paying with SOL isn't available right now.</p>;
	}

	return (
		<div className="flex flex-col gap-4">
			<div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border p-4">
				<div className="min-w-0">
					<p className="text-sm font-medium text-foreground">Solana wallet</p>
					<p className="text-xs text-muted-foreground">
						{connected ? "Connected. Pick a pack below." : "Connect a wallet to pay with SOL."}
					</p>
					{status.network === "devnet" && <p className="mt-1 text-xs text-muted-foreground">Devnet: test payments only.</p>}
				</div>
				<SolanaWalletButton />
			</div>

			{connected && step === "select" && (
				<ul className="flex flex-col gap-2">
					{packages.map((pkg) => (
						<li key={pkg.id} className="flex items-center justify-between gap-3 rounded-xl bg-muted px-4 py-3">
							<div className="min-w-0">
								<p className="text-sm font-medium text-foreground">{pkg.credits} credits</p>
								<p className="text-xs text-muted-foreground">{pkg.priceSol} SOL</p>
							</div>
							<Button variant="outline" size="sm" onClick={() => handlePurchase(pkg)} disabled={loading}>
								Choose
							</Button>
						</li>
					))}
				</ul>
			)}

			{connected && step === "confirm" && selectedPackage && (
				<div className="flex flex-col gap-3 rounded-2xl border border-border p-4">
					<dl className="grid grid-cols-2 gap-y-2 text-sm">
						<dt className="text-muted-foreground">Credits</dt>
						<dd className="text-right tabular-nums text-foreground">{selectedPackage.credits}</dd>
						<dt className="text-muted-foreground">You pay</dt>
						<dd className="text-right tabular-nums text-foreground">{selectedPackage.priceSol} SOL</dd>
					</dl>
					<div className="flex gap-2">
						<Button variant="ghost" className="flex-1" onClick={resetPurchase}>
							Back
						</Button>
						<Button className="flex-1" onClick={confirmPurchase} disabled={loading}>
							Sign in wallet
						</Button>
					</div>
				</div>
			)}

			{connected && (step === "signing" || step === "verifying") && (
				<div className="rounded-2xl border border-border p-4" aria-live="polite">
					<p className="text-sm font-medium text-foreground">
						{step === "signing" ? "Approve the payment in your wallet." : "Confirming the payment on Solana."}
					</p>
					<p className="mt-1 text-xs text-muted-foreground">
						{step === "signing" ? "Your wallet opens a window for this." : "This usually takes under a minute."}
					</p>
				</div>
			)}

			{connected && step === "success" && (
				<div className="rounded-2xl border border-border p-4" aria-live="polite">
					<p className="text-sm font-medium text-verdigris">{creditsReceived} credits added</p>
					<p className="mt-1 text-xs text-muted-foreground">They're ready to use now.</p>
				</div>
			)}

			{connected && step === "error" && (
				<div className="flex flex-col gap-3 rounded-2xl border border-border p-4" role="alert">
					<p className="text-sm text-destructive">{friendlySolError(purchaseError || error)}</p>
					<Button variant="outline" size="sm" className="self-start" onClick={resetPurchase}>
						Try again
					</Button>
				</div>
			)}

			{!compact && transactions.length > 0 && (
				<div>
					<p className="mb-2 text-sm font-medium text-foreground">SOL payments</p>
					<ul className="divide-y divide-border">
						{transactions.map((tx) => (
							<li key={tx.id} className="flex items-center justify-between gap-3 py-2 text-sm">
								<div>
									<p className="text-foreground">+{tx.credits} credits</p>
									<p className="text-xs text-muted-foreground">{formatDate(tx.date)}</p>
								</div>
								<div className="text-right">
									<p className="tabular-nums text-foreground">{tx.amountSol} SOL</p>
									<a
										href={`https://solscan.io/tx/${tx.signature}${status.network === "devnet" ? "?cluster=devnet" : ""}`}
										target="_blank"
										rel="noopener noreferrer"
										className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
									>
										View on Solscan
									</a>
								</div>
							</li>
						))}
					</ul>
				</div>
			)}
		</div>
	);
}
