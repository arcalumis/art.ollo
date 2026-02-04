import { useCallback, useEffect, useState } from "react";
import { SolanaCreditPurchase } from "../components/SolanaCreditPurchase";
import { SolanaSubscriptionPurchase } from "../components/SolanaSubscriptionPurchase";
import { API_BASE } from "../config";
import { useAuth } from "../contexts/AuthContext";

interface BillingInfo {
	subscription: {
		id: string;
		status: string;
		planName: string;
		price: number;
		monthlyImageLimit: number | null;
		monthlyCostLimit: number | null;
		periodStart: string | null;
		periodEnd: string | null;
	} | null;
	usage: {
		imageCount: number;
		totalCost: number;
	};
	availableCredits: number;
	totalSpentCents: number;
	recentPayments: Array<{
		id: string;
		amount: number;
		currency: string;
		status: string;
		type: string;
		description: string | null;
		date: string;
	}>;
	hasStripeCustomer: boolean;
}

interface Product {
	id: string;
	name: string;
	description: string | null;
	monthlyImageLimit: number | null;
	monthlyCostLimit: number | null;
	bonusCredits: number;
	price: number;
	stripePriceId: string | null;
	overagePriceCents: number;
}

interface Invoice {
	id: string;
	number: string | null;
	amount: number;
	currency: string;
	status: string | null;
	date: string | null;
	pdfUrl: string | null;
	hostedUrl: string | null;
}

interface BillingProps {
	embedded?: boolean;
	onBack?: () => void;
}

export function Billing({ embedded = false, onBack }: BillingProps) {
	const { token } = useAuth();
	const [billing, setBilling] = useState<BillingInfo | null>(null);
	const [products, setProducts] = useState<Product[]>([]);
	const [invoices, setInvoices] = useState<Invoice[]>([]);
	const [stripeEnabled, setStripeEnabled] = useState(false);
	const [solanaEnabled, setSolanaEnabled] = useState(false);
	const [loading, setLoading] = useState(true);
	const [checkoutLoading, setCheckoutLoading] = useState<string | null>(null);

	const fetchData = useCallback(async () => {
		if (!token) return;

		setLoading(true);
		try {
			const headers = { Authorization: `Bearer ${token}` };

			const [statusRes, solanaStatusRes, billingRes, productsRes, invoicesRes] = await Promise.all([
				fetch(`${API_BASE}/api/billing/status`),
				fetch(`${API_BASE}/api/billing/solana/status`),
				fetch(`${API_BASE}/api/billing`, { headers }),
				fetch(`${API_BASE}/api/billing/products`),
				fetch(`${API_BASE}/api/billing/invoices`, { headers }).catch(() => null),
			]);

			if (statusRes.ok) {
				const data = await statusRes.json();
				setStripeEnabled(data.enabled);
			}

			if (solanaStatusRes.ok) {
				const data = await solanaStatusRes.json();
				setSolanaEnabled(data.enabled);
			}

			if (billingRes.ok) {
				const data = await billingRes.json();
				setBilling(data);
			}

			if (productsRes.ok) {
				const data = await productsRes.json();
				setProducts(data.products || []);
			}

			if (invoicesRes?.ok) {
				const data = await invoicesRes.json();
				setInvoices(data.invoices || []);
			}
		} catch (err) {
			console.error("Failed to fetch billing data:", err);
		} finally {
			setLoading(false);
		}
	}, [token]);

	useEffect(() => {
		fetchData();
	}, [fetchData]);

	const handleCheckout = async (priceId: string, productId: string) => {
		if (!token || !priceId) return;

		setCheckoutLoading(productId);
		try {
			const response = await fetch(`${API_BASE}/api/billing/checkout`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${token}`,
				},
				body: JSON.stringify({
					priceId,
					successUrl: `${window.location.origin}/billing?success=true`,
					cancelUrl: `${window.location.origin}/billing?canceled=true`,
				}),
			});

			if (response.ok) {
				const data = await response.json();
				if (data.url) {
					window.location.href = data.url;
				}
			}
		} catch (err) {
			console.error("Failed to create checkout:", err);
		} finally {
			setCheckoutLoading(null);
		}
	};

	const handleManageBilling = async () => {
		if (!token) return;

		try {
			const response = await fetch(`${API_BASE}/api/billing/portal`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${token}`,
				},
				body: JSON.stringify({
					returnUrl: `${window.location.origin}/billing`,
				}),
			});

			if (response.ok) {
				const data = await response.json();
				if (data.url) {
					window.location.href = data.url;
				}
			}
		} catch (err) {
			console.error("Failed to open billing portal:", err);
		}
	};

	const formatCurrency = (value: number) => {
		return new Intl.NumberFormat("en-US", {
			style: "currency",
			currency: "USD",
		}).format(value);
	};

	const formatDate = (dateStr: string | null) => {
		if (!dateStr) return "N/A";
		return new Date(dateStr).toLocaleDateString("en-US", {
			year: "numeric",
			month: "short",
			day: "numeric",
		});
	};

	if (loading) {
		return (
			<div className="flex items-center justify-center h-64">
				<div className="animate-spin rounded-full h-8 w-8 border-t-2 border-b-2 border-[var(--accent)]" />
			</div>
		);
	}

	const usagePercent = billing?.subscription?.monthlyImageLimit
		? Math.min(100, (billing.usage.imageCount / billing.subscription.monthlyImageLimit) * 100)
		: 0;

	return (
		<div className="p-4 max-w-4xl mx-auto space-y-6">
			{/* Header */}
			<div className="flex items-center justify-between">
				<div>
					<h1 className="text-xl font-bold text-[var(--text-primary)]">Credits & Billing</h1>
					<p className="text-xs text-[var(--text-secondary)]">Purchase credits to generate images</p>
				</div>
				{embedded && onBack && (
					<button
						type="button"
						onClick={onBack}
						className="cyber-button text-xs py-2 px-4 flex items-center gap-2"
					>
						<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
							<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
						</svg>
						Back to Create
					</button>
				)}
			</div>

			{/* Credit Balance */}
			<div className="cyber-card p-4 border-[var(--accent)] border">
				<div className="flex items-center justify-between">
					<div>
						<h2 className="text-sm font-semibold text-[var(--text-primary)]">Available Credits</h2>
						<p className="text-3xl font-bold text-[var(--accent)]">{billing?.availableCredits || 0}</p>
						<p className="text-xs text-[var(--text-secondary)]">Credits can be used when your monthly limit is reached</p>
					</div>
					<div className="text-6xl opacity-20">⚡</div>
				</div>
			</div>

			{/* Current Subscription */}
			<div className="cyber-card p-4">
				<h2 className="text-sm font-semibold text-[var(--text-primary)] mb-3">Current Plan</h2>
				{billing?.subscription ? (
					<div className="space-y-4">
						<div className="flex items-center justify-between">
							<div>
								<p className="text-lg font-bold text-[var(--accent)]">{billing.subscription.planName}</p>
								<p className="text-xs text-[var(--text-secondary)]">
									{formatCurrency(billing.subscription.price)}/month
								</p>
							</div>
							<span
								className={`px-2 py-1 text-xs rounded ${
									billing.subscription.status === "active"
										? "bg-green-500/20 text-green-400"
										: billing.subscription.status === "past_due"
											? "bg-yellow-500/20 text-yellow-400"
											: "bg-gray-500/20 text-gray-400"
								}`}
							>
								{billing.subscription.status}
							</span>
						</div>

						{billing.subscription.periodStart && billing.subscription.periodEnd && (
							<p className="text-xs text-[var(--text-secondary)]">
								Current period: {formatDate(billing.subscription.periodStart)} -{" "}
								{formatDate(billing.subscription.periodEnd)}
							</p>
						)}

						{billing.hasStripeCustomer && stripeEnabled && (
							<button
								type="button"
								onClick={handleManageBilling}
								className="cyber-button text-xs py-2 px-4"
							>
								Manage Subscription
							</button>
						)}
					</div>
				) : (
					<div className="text-center py-4">
						<p className="text-[var(--text-secondary)]">No active subscription</p>
						<p className="text-xs text-[var(--text-secondary)] mt-1">Purchase credits below to get started</p>
					</div>
				)}
			</div>

			{/* Usage */}
			<div className="cyber-card p-4">
				<h2 className="text-sm font-semibold text-[var(--text-primary)] mb-3">This Month's Usage</h2>
				<div>
					<p className="text-[10px] text-[var(--text-secondary)] uppercase">Images Generated</p>
					<p className="text-2xl font-bold text-[var(--text-primary)]">{billing?.usage.imageCount || 0}</p>
					{billing?.subscription?.monthlyImageLimit && (
						<>
							<p className="text-xs text-[var(--text-secondary)]">
								of {billing.subscription.monthlyImageLimit} included
							</p>
							<div className="mt-2 h-2 bg-[var(--bg-tertiary)] rounded-full overflow-hidden">
								<div
									className={`h-full rounded-full transition-all ${
										usagePercent >= 90
											? "bg-red-500"
											: usagePercent >= 70
												? "bg-yellow-500"
												: "bg-[var(--accent)]"
									}`}
									style={{ width: `${usagePercent}%` }}
								/>
							</div>
						</>
					)}
				</div>
			</div>

			{/* Subscription Plans */}
			{stripeEnabled && products.length > 0 && (
				<div className="cyber-card p-4">
					<h2 className="text-sm font-semibold text-[var(--text-primary)] mb-3">Available Plans</h2>
					<div className="grid md:grid-cols-3 gap-4">
						{products.map((product) => {
							const isCurrentPlan = billing?.subscription?.planName === product.name;
							return (
								<div
									key={product.id}
									className={`p-4 rounded-lg border transition-all ${
										isCurrentPlan
											? "border-[var(--accent)] bg-[var(--accent)]/10"
											: "border-[var(--border)] hover:border-[var(--accent)]/50"
									}`}
								>
									<h3 className="text-lg font-bold text-[var(--text-primary)]">{product.name}</h3>
									<p className="text-2xl font-bold text-[var(--accent)] mt-1">
										{product.price === 0 ? "Free" : formatCurrency(product.price)}
										{product.price > 0 && <span className="text-xs text-[var(--text-secondary)]">/mo</span>}
									</p>
									{product.description && (
										<p className="text-xs text-[var(--text-secondary)] mt-2">{product.description}</p>
									)}
									<ul className="mt-3 space-y-1 text-xs text-[var(--text-secondary)]">
										{product.monthlyImageLimit && (
											<li>{product.monthlyImageLimit} images/month</li>
										)}
										{product.bonusCredits > 0 && <li>{product.bonusCredits} bonus credits</li>}
									</ul>
									{isCurrentPlan ? (
										<div className="mt-4 py-2 text-center text-xs text-[var(--accent)]">
											Current Plan
										</div>
									) : product.stripePriceId ? (
										<button
											type="button"
											onClick={() => handleCheckout(product.stripePriceId!, product.id)}
											disabled={!!checkoutLoading}
											className="mt-4 w-full cyber-button text-xs py-2"
										>
											{checkoutLoading === product.id ? "Loading..." : "Subscribe"}
										</button>
									) : (
										<div className="mt-4 py-2 text-center text-xs text-[var(--text-secondary)]">
											Contact support
										</div>
									)}
								</div>
							);
						})}
					</div>
				</div>
			)}

			{/* Upgrade with SOL */}
			{solanaEnabled && (
				<div className="cyber-card p-4">
					<h2 className="text-sm font-semibold text-[var(--text-primary)] mb-3">Upgrade with SOL</h2>
					<p className="text-xs text-[var(--text-secondary)] mb-4">
						Get premium access by paying with Solana. 30-day access activated instantly.
					</p>
					<SolanaSubscriptionPurchase />
				</div>
			)}

			{/* Buy Credits with SOL */}
			<div className="cyber-card p-4">
				<h2 className="text-sm font-semibold text-[var(--text-primary)] mb-3">Buy Credits with SOL</h2>
				<p className="text-xs text-[var(--text-secondary)] mb-4">
					Purchase credits instantly using Solana. Connect your wallet to get started.
				</p>
				<SolanaCreditPurchase />
			</div>

			{/* Payment History */}
			{billing?.recentPayments && billing.recentPayments.length > 0 && (
				<div className="cyber-card p-4">
					<h2 className="text-sm font-semibold text-[var(--text-primary)] mb-3">Recent Payments</h2>
					<div className="space-y-2">
						{billing.recentPayments.map((payment) => (
							<div
								key={payment.id}
								className="flex items-center justify-between p-2 bg-[var(--bg-tertiary)] rounded text-sm"
							>
								<div>
									<p className="text-[var(--text-primary)]">{payment.description || payment.type}</p>
									<p className="text-[10px] text-[var(--text-secondary)]">{formatDate(payment.date)}</p>
								</div>
								<span className="text-green-400 font-medium">
									{formatCurrency(payment.amount)}
								</span>
							</div>
						))}
					</div>
				</div>
			)}

			{/* Invoices */}
			{invoices.length > 0 && (
				<div className="cyber-card p-4">
					<h2 className="text-sm font-semibold text-[var(--text-primary)] mb-3">Invoices</h2>
					<div className="space-y-2">
						{invoices.map((invoice) => (
							<div
								key={invoice.id}
								className="flex items-center justify-between p-2 bg-[var(--bg-tertiary)] rounded text-sm"
							>
								<div>
									<p className="text-[var(--text-primary)]">{invoice.number || invoice.id}</p>
									<p className="text-[10px] text-[var(--text-secondary)]">{formatDate(invoice.date)}</p>
								</div>
								<div className="flex items-center gap-3">
									<span className="text-[var(--accent)]">{formatCurrency(invoice.amount)}</span>
									{invoice.pdfUrl && (
										<a
											href={invoice.pdfUrl}
											target="_blank"
											rel="noopener noreferrer"
											className="text-xs text-[var(--text-secondary)] hover:text-[var(--accent)]"
										>
											PDF
										</a>
									)}
								</div>
							</div>
						))}
					</div>
				</div>
			)}

			{/* Billing not enabled notice - only show if NEITHER Stripe nor Solana is enabled */}
			{!stripeEnabled && !solanaEnabled && (
				<div className="cyber-card p-4 text-center">
					<p className="text-[var(--text-secondary)]">Billing is not yet configured for this instance.</p>
					<p className="text-xs text-[var(--text-secondary)] mt-1">Contact the administrator for more information.</p>
				</div>
			)}
		</div>
	);
}
