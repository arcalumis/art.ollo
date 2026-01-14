import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { API_BASE } from "../config";
import { useAuth } from "../contexts/AuthContext";

interface PnLData {
	period: {
		start: string;
		end: string;
	};
	revenue: {
		subscriptions: number;
		overage: number;
		credits: number;
		total: number;
	};
	costOfRevenue: {
		platformCosts: number;
		total: number;
	};
	grossProfit: number;
	grossMargin: number;
	metrics: {
		generations: number;
		activeSubscribers: number;
		avgRevenuePerUser: number;
	};
}

type PeriodOption = "mtd" | "qtd" | "ytd" | "last30" | "last90";

export default function AdminPnL() {
	const { token } = useAuth();
	const [period, setPeriod] = useState<PeriodOption>("mtd");
	const [pnl, setPnl] = useState<PnLData | null>(null);
	const [loading, setLoading] = useState(true);

	const fetchData = useCallback(async () => {
		if (!token) return;

		setLoading(true);
		try {
			const response = await fetch(`${API_BASE}/api/admin/financials/pnl?period=${period}`, {
				headers: { Authorization: `Bearer ${token}` },
			});

			if (response.ok) {
				const data = await response.json();
				setPnl(data);
			}
		} catch (err) {
			console.error("Failed to fetch P&L data:", err);
		} finally {
			setLoading(false);
		}
	}, [token, period]);

	useEffect(() => {
		fetchData();
	}, [fetchData]);

	const formatCurrency = (value: number) => {
		return new Intl.NumberFormat("en-US", {
			style: "currency",
			currency: "USD",
		}).format(value);
	};

	const formatDate = (dateStr: string) => {
		return new Date(dateStr).toLocaleDateString("en-US", {
			year: "numeric",
			month: "short",
			day: "numeric",
		});
	};

	const periodLabels: Record<PeriodOption, string> = {
		mtd: "Month to Date",
		qtd: "Quarter to Date",
		ytd: "Year to Date",
		last30: "Last 30 Days",
		last90: "Last 90 Days",
	};

	return (
		<div className="p-4 space-y-4">
			{/* Header */}
			<div className="flex justify-between items-center">
				<div>
					<div className="flex items-center gap-2">
						<Link to="/admin/financials" className="text-gray-400 hover:text-cyan-400">
							Financials
						</Link>
						<span className="text-gray-600">/</span>
						<h1 className="text-xl font-bold text-white">Profit & Loss Statement</h1>
					</div>
					<p className="text-xs text-gray-400">Income statement for the selected period</p>
				</div>
				<select
					value={period}
					onChange={(e) => setPeriod(e.target.value as PeriodOption)}
					className="cyber-input text-xs py-1 px-2"
				>
					{Object.entries(periodLabels).map(([value, label]) => (
						<option key={value} value={value}>
							{label}
						</option>
					))}
				</select>
			</div>

			{loading ? (
				<div className="flex items-center justify-center h-64">
					<div className="animate-spin rounded-full h-8 w-8 border-t-2 border-b-2 border-cyan-500" />
				</div>
			) : pnl ? (
				<div className="cyber-card p-6 max-w-2xl mx-auto">
					{/* Statement Header */}
					<div className="text-center mb-6 pb-4 border-b border-cyan-500/20">
						<h2 className="text-lg font-bold text-white">ollo.art</h2>
						<p className="text-sm text-cyan-400">Profit & Loss Statement</p>
						<p className="text-xs text-gray-500 mt-1">
							{formatDate(pnl.period.start)} - {formatDate(pnl.period.end)}
						</p>
					</div>

					{/* Revenue Section */}
					<div className="mb-6">
						<h3 className="text-sm font-semibold text-green-400 uppercase tracking-wider mb-3">
							Revenue
						</h3>
						<div className="space-y-2 ml-4">
							<div className="flex justify-between text-sm">
								<span className="text-gray-400">Subscription Revenue</span>
								<span className="text-white">{formatCurrency(pnl.revenue.subscriptions)}</span>
							</div>
							<div className="flex justify-between text-sm">
								<span className="text-gray-400">Overage Charges</span>
								<span className="text-white">{formatCurrency(pnl.revenue.overage)}</span>
							</div>
							<div className="flex justify-between text-sm">
								<span className="text-gray-400">Credit Sales</span>
								<span className="text-white">{formatCurrency(pnl.revenue.credits)}</span>
							</div>
						</div>
						<div className="flex justify-between text-sm font-bold mt-3 pt-2 border-t border-cyan-500/20">
							<span className="text-white">Total Revenue</span>
							<span className="text-green-400">{formatCurrency(pnl.revenue.total)}</span>
						</div>
					</div>

					{/* Cost of Revenue Section */}
					<div className="mb-6">
						<h3 className="text-sm font-semibold text-red-400 uppercase tracking-wider mb-3">
							Cost of Revenue
						</h3>
						<div className="space-y-2 ml-4">
							<div className="flex justify-between text-sm">
								<span className="text-gray-400">Platform Costs (Replicate)</span>
								<span className="text-white">({formatCurrency(pnl.costOfRevenue.platformCosts)})</span>
							</div>
						</div>
						<div className="flex justify-between text-sm font-bold mt-3 pt-2 border-t border-cyan-500/20">
							<span className="text-white">Total Cost of Revenue</span>
							<span className="text-red-400">({formatCurrency(pnl.costOfRevenue.total)})</span>
						</div>
					</div>

					{/* Gross Profit */}
					<div className="mb-6 p-4 bg-gradient-to-r from-cyan-500/10 to-pink-500/10 rounded-lg">
						<div className="flex justify-between items-center">
							<div>
								<h3 className="text-sm font-semibold text-white uppercase tracking-wider">
									Gross Profit
								</h3>
								<p className="text-xs text-gray-500">Revenue - Cost of Revenue</p>
							</div>
							<div className="text-right">
								<p className={`text-2xl font-bold ${pnl.grossProfit >= 0 ? "text-green-400" : "text-red-400"}`}>
									{formatCurrency(pnl.grossProfit)}
								</p>
								<p className={`text-xs ${pnl.grossMargin >= 0 ? "text-green-400" : "text-red-400"}`}>
									{pnl.grossMargin.toFixed(1)}% margin
								</p>
							</div>
						</div>
					</div>

					{/* Operating Metrics */}
					<div className="pt-4 border-t border-cyan-500/20">
						<h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">
							Operating Metrics
						</h3>
						<div className="grid grid-cols-3 gap-4 text-center">
							<div>
								<p className="text-[10px] text-gray-500 uppercase">Generations</p>
								<p className="text-lg font-bold text-white">{pnl.metrics.generations.toLocaleString()}</p>
							</div>
							<div>
								<p className="text-[10px] text-gray-500 uppercase">Active Subs</p>
								<p className="text-lg font-bold text-white">{pnl.metrics.activeSubscribers}</p>
							</div>
							<div>
								<p className="text-[10px] text-gray-500 uppercase">ARPU</p>
								<p className="text-lg font-bold text-white">{formatCurrency(pnl.metrics.avgRevenuePerUser)}</p>
							</div>
						</div>
					</div>

					{/* Footer */}
					<div className="mt-6 pt-4 border-t border-cyan-500/20 text-center">
						<p className="text-[10px] text-gray-600">
							Generated on {new Date().toLocaleDateString("en-US", {
								year: "numeric",
								month: "long",
								day: "numeric",
								hour: "2-digit",
								minute: "2-digit",
							})}
						</p>
					</div>
				</div>
			) : (
				<div className="text-center text-gray-500 py-8">
					No P&L data available for this period
				</div>
			)}
		</div>
	);
}
