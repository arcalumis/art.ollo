import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useCallback, useEffect, useState } from "react";
import {
	type SolanaStatus,
	type SolanaSubscriptionProduct,
	buildPaymentTransaction,
	useSolanaBilling,
} from "../hooks/useSolanaBilling";
import { Button } from "@/components/ui/button";
import { SolanaWalletButton } from "./SolanaWalletButton";

type PurchaseStep = "select" | "confirm" | "signing" | "verifying" | "success" | "error";

interface SolanaSubscriptionPurchaseProps {
	/** Called after a verified 30-day plan purchase. */
	onPurchaseComplete?: () => void;
}

export function SolanaSubscriptionPurchase({ onPurchaseComplete }: SolanaSubscriptionPurchaseProps = {}) {
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
			const transaction = buildPaymentTransaction(publicKey, payment);

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
				onPurchaseComplete?.();
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
		onPurchaseComplete,
	]);

	const resetPurchase = useCallback(() => {
		setSelectedProduct(null);
		setStep("select");
		setPurchaseError(null);
		clearError();
	}, [clearError]);

	if (!status?.enabled || products.length === 0) {
		return null;
	}

	return (
		<div className="flex flex-col gap-3">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<div className="min-w-0">
					<p className="text-sm font-medium text-foreground">Pay for a plan with SOL</p>
					<p className="text-xs text-muted-foreground">
						30 days of the plan, paid once. It doesn't renew on its own.
					</p>
				</div>
				<SolanaWalletButton />
			</div>

			{connected && step === "select" && (
				<ul className="flex flex-col gap-2">
					{products.map((product) => (
						<li key={product.id} className="flex items-center justify-between gap-3 rounded-xl bg-muted px-4 py-3">
							<div className="min-w-0">
								<p className="text-sm font-medium text-foreground">{product.name}</p>
								<p className="text-xs text-muted-foreground">
									{product.priceSol} SOL for 30 days
									{product.creditRefillAmount ? `, ${product.creditRefillAmount} credits` : ""}
								</p>
							</div>
							<Button variant="outline" size="sm" onClick={() => handlePurchase(product)} disabled={loading}>
								Choose
							</Button>
						</li>
					))}
				</ul>
			)}

			{connected && step === "confirm" && selectedProduct && (
				<div className="flex flex-col gap-3 rounded-2xl border border-border p-4">
					<dl className="grid grid-cols-2 gap-y-2 text-sm">
						<dt className="text-muted-foreground">Plan</dt>
						<dd className="text-right text-foreground">{selectedProduct.name}, 30 days</dd>
						<dt className="text-muted-foreground">You pay</dt>
						<dd className="text-right tabular-nums text-foreground">{selectedProduct.priceSol} SOL</dd>
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
				<p className="text-sm text-foreground" aria-live="polite">
					{step === "signing" ? "Approve the payment in your wallet." : "Confirming the payment on Solana."}
				</p>
			)}

			{connected && step === "success" && (
				<p className="text-sm text-verdigris" aria-live="polite">
					{selectedProduct?.name ?? "Your plan"} is active for the next 30 days.
				</p>
			)}

			{connected && step === "error" && (
				<div className="flex flex-col gap-2" role="alert">
					<p className="text-sm text-destructive">
						{/reject|denied|cancel/i.test(purchaseError || error || "")
							? "The wallet request was declined. Nothing was charged."
							: "The payment didn't go through. Try again, or pay by card instead."}
					</p>
					<Button variant="outline" size="sm" className="self-start" onClick={resetPurchase}>
						Try again
					</Button>
				</div>
			)}
		</div>
	);
}
