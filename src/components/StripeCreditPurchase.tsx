import { useCallback, useEffect, useState } from "react";
import { API_BASE } from "../config";
import { useAuth } from "../contexts/AuthContext";

interface StripeCreditPackage {
	id: string;
	name: string;
	credits: number;
	priceCents: number;
	stripePriceId: string;
}

interface StripeCreditPurchaseProps {
	onPurchaseComplete?: () => void;
}

export function StripeCreditPurchase(_props: StripeCreditPurchaseProps) {
	const { token } = useAuth();
	const [packages, setPackages] = useState<StripeCreditPackage[]>([]);
	const [loading, setLoading] = useState(true);
	const [checkoutLoading, setCheckoutLoading] = useState<string | null>(null);

	const fetchPackages = useCallback(async () => {
		try {
			const res = await fetch(`${API_BASE}/api/billing/credit-packages`);
			if (res.ok) {
				const data = await res.json();
				setPackages(data.packages || []);
			}
		} catch (err) {
			console.error("Failed to fetch credit packages:", err);
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		fetchPackages();
	}, [fetchPackages]);

	const handleBuy = async (pkg: StripeCreditPackage) => {
		if (!token) return;

		setCheckoutLoading(pkg.id);
		try {
			const response = await fetch(`${API_BASE}/api/billing/credit-checkout`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${token}`,
				},
				body: JSON.stringify({
					packageId: pkg.id,
					successUrl: `${window.location.origin}/billing?credit_success=true`,
					cancelUrl: `${window.location.origin}/billing?credit_canceled=true`,
				}),
			});

			if (response.ok) {
				const data = await response.json();
				if (data.url) {
					window.location.href = data.url;
					return;
				}
			}
		} catch (err) {
			console.error("Failed to create credit checkout:", err);
		}
		setCheckoutLoading(null);
	};

	if (loading) {
		return (
			<div className="text-sm text-[var(--text-secondary)]">Loading credit packages...</div>
		);
	}

	if (packages.length === 0) {
		return null;
	}

	return (
		<div className="grid md:grid-cols-3 gap-4">
			{packages.map((pkg) => (
				<div
					key={pkg.id}
					className="p-4 rounded-lg border border-[var(--border)] hover:border-green-500/50 transition-all"
				>
					<h4 className="text-lg font-bold text-[var(--text-primary)]">{pkg.name}</h4>
					<p className="text-2xl font-bold text-green-400 mt-1">
						${(pkg.priceCents / 100).toFixed(2)}
					</p>
					<p className="text-sm text-[var(--text-secondary)] mt-1">
						{pkg.credits} credits
					</p>
					<p className="text-xs text-[var(--text-secondary)] mt-1">
						${(pkg.priceCents / 100 / pkg.credits).toFixed(3)}/credit
					</p>
					<button
						type="button"
						onClick={() => handleBuy(pkg)}
						disabled={!!checkoutLoading}
						className="mt-4 w-full cyber-button text-xs py-2"
					>
						{checkoutLoading === pkg.id ? "Loading..." : "Buy with Card"}
					</button>
				</div>
			))}
		</div>
	);
}
