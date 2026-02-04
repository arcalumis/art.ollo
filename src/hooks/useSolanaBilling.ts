import { useCallback, useState } from "react";
import { API_BASE } from "../config";
import { useAuth } from "../contexts/AuthContext";

export interface SolanaCreditPackage {
	id: string;
	name: string;
	credits: number;
	priceSol: number;
}

export interface SolanaTransaction {
	id: string;
	walletAddress: string;
	signature: string;
	amountSol: number;
	credits: number;
	status: string;
	network: string;
	date: string;
}

export interface SolanaStatus {
	enabled: boolean;
	network: string;
}

export interface InitiatePaymentResponse {
	paymentId: string;
	recipientWallet: string;
	amountLamports: number;
	amountSol: number;
	credits: number;
	packageName: string;
}

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

export interface InitiateSubscriptionResponse {
	paymentId: string;
	recipientWallet: string;
	amountLamports: number;
	amountSol: number;
	productName: string;
	productId: string;
}

export function useSolanaBilling() {
	const { token } = useAuth();
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const getStatus = useCallback(async (): Promise<SolanaStatus | null> => {
		try {
			const response = await fetch(`${API_BASE}/api/billing/solana/status`);
			if (!response.ok) return null;
			return await response.json();
		} catch {
			return null;
		}
	}, []);

	const getPackages = useCallback(async (): Promise<{
		packages: SolanaCreditPackage[];
		treasuryWallet: string | null;
	} | null> => {
		try {
			const response = await fetch(`${API_BASE}/api/billing/solana/packages`);
			if (!response.ok) return null;
			return await response.json();
		} catch {
			return null;
		}
	}, []);

	const initiatePayment = useCallback(
		async (
			packageId: string,
			walletAddress: string,
		): Promise<InitiatePaymentResponse | null> => {
			if (!token) {
				setError("Not authenticated");
				return null;
			}

			setLoading(true);
			setError(null);

			try {
				const response = await fetch(`${API_BASE}/api/billing/solana/initiate`, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${token}`,
					},
					body: JSON.stringify({ packageId, walletAddress }),
				});

				const data = await response.json();

				if (!response.ok) {
					setError(data.error || "Failed to initiate payment");
					return null;
				}

				return data;
			} catch (err) {
				setError(err instanceof Error ? err.message : "Failed to initiate payment");
				return null;
			} finally {
				setLoading(false);
			}
		},
		[token],
	);

	const verifyPayment = useCallback(
		async (
			paymentId: string,
			signature: string,
		): Promise<{ success: boolean; credits?: number; error?: string }> => {
			if (!token) {
				return { success: false, error: "Not authenticated" };
			}

			setLoading(true);
			setError(null);

			try {
				const response = await fetch(`${API_BASE}/api/billing/solana/verify`, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${token}`,
					},
					body: JSON.stringify({ paymentId, signature }),
				});

				const data = await response.json();

				if (!response.ok) {
					setError(data.error || "Failed to verify payment");
					return { success: false, error: data.error };
				}

				return { success: true, credits: data.credits };
			} catch (err) {
				const errorMsg = err instanceof Error ? err.message : "Failed to verify payment";
				setError(errorMsg);
				return { success: false, error: errorMsg };
			} finally {
				setLoading(false);
			}
		},
		[token],
	);

	const getTransactions = useCallback(async (): Promise<SolanaTransaction[]> => {
		if (!token) return [];

		try {
			const response = await fetch(`${API_BASE}/api/billing/solana/transactions`, {
				headers: {
					Authorization: `Bearer ${token}`,
				},
			});

			if (!response.ok) return [];

			const data = await response.json();
			return data.transactions || [];
		} catch {
			return [];
		}
	}, [token]);

	// ============================================
	// SUBSCRIPTION PURCHASES
	// ============================================

	const getSubscriptionProducts = useCallback(async (): Promise<{
		products: SolanaSubscriptionProduct[];
		treasuryWallet: string | null;
	} | null> => {
		try {
			const response = await fetch(`${API_BASE}/api/billing/solana/subscription-products`);
			if (!response.ok) return null;
			return await response.json();
		} catch {
			return null;
		}
	}, []);

	const initiateSubscription = useCallback(
		async (
			productId: string,
			walletAddress: string,
		): Promise<InitiateSubscriptionResponse | null> => {
			if (!token) {
				setError("Not authenticated");
				return null;
			}

			setLoading(true);
			setError(null);

			try {
				const response = await fetch(`${API_BASE}/api/billing/solana/subscribe/initiate`, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${token}`,
					},
					body: JSON.stringify({ productId, walletAddress }),
				});

				const data = await response.json();

				if (!response.ok) {
					setError(data.error || "Failed to initiate subscription");
					return null;
				}

				return data;
			} catch (err) {
				setError(err instanceof Error ? err.message : "Failed to initiate subscription");
				return null;
			} finally {
				setLoading(false);
			}
		},
		[token],
	);

	const verifySubscription = useCallback(
		async (
			paymentId: string,
			signature: string,
		): Promise<{ success: boolean; subscriptionId?: string; error?: string }> => {
			if (!token) {
				return { success: false, error: "Not authenticated" };
			}

			setLoading(true);
			setError(null);

			try {
				const response = await fetch(`${API_BASE}/api/billing/solana/subscribe/verify`, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${token}`,
					},
					body: JSON.stringify({ paymentId, signature }),
				});

				const data = await response.json();

				if (!response.ok) {
					setError(data.error || "Failed to verify subscription");
					return { success: false, error: data.error };
				}

				return { success: true, subscriptionId: data.subscriptionId };
			} catch (err) {
				const errorMsg = err instanceof Error ? err.message : "Failed to verify subscription";
				setError(errorMsg);
				return { success: false, error: errorMsg };
			} finally {
				setLoading(false);
			}
		},
		[token],
	);

	return {
		loading,
		error,
		getStatus,
		getPackages,
		initiatePayment,
		verifyPayment,
		getTransactions,
		getSubscriptionProducts,
		initiateSubscription,
		verifySubscription,
		clearError: () => setError(null),
	};
}
