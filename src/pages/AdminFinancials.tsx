import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { API_BASE } from "../config";
import { useAuth } from "../contexts/AuthContext";

interface FinancialOverview {
	period: {
		start: string;
		end: string;
	};
	revenue: {
		total: number;
		subscription: number;
		overage: number;
		credits: number;
	};
	costs: {
		platform: number;
		estimated: number;
		actual: number;
	};
	profit: {
		gross: number;
		margin: number;
	};
	subscribers: {
		active: number;
		new: number;
		churned: number;
		churnRate: number;
	};
	mrr: number;
	arr: number;
	ltv: number;
	generations: number;
	avgCostPerGeneration: number;
}

interface TrendData {
	period: string;
	revenue: number;
	costs: number;
	profit: number;
	subscribers: number;
}

interface AllTimeStats {
	totalRevenue: number;
	totalCosts: number;
	totalProfit: number;
	totalGenerations: number;
	totalUsers: number;
	payingCustomers: number;
}

type PeriodOption = "mtd" | "qtd" | "ytd" | "last30" | "last90";

export default function AdminFinancials() {
	const { token } = useAuth();
	const [period, setPeriod] = useState<PeriodOption>("mtd");
	const [overview, setOverview] = useState<FinancialOverview | null>(null);
	const [trend, setTrend] = useState<TrendData[]>([]);
	const [allTime, setAllTime] = useState<AllTimeStats | null>(null);
	const [loading, setLoading] = useState(true);

	const fetchData = useCallback(async () => {
		if (!token) return;

		setLoading(true);
		try {
			const headers = { Authorization: `Bearer ${token}` };

			const [overviewRes, trendRes, allTimeRes] = await Promise.all([
				fetch(`${API_BASE}/api/admin/financials/overview?period=${period}`, { headers }),
				fetch(`${API_BASE}/api/admin/financials/trend?type=monthly&count=6`, { headers }),
				fetch(`${API_BASE}/api/admin/financials/all-time`, { headers }),
			]);

			if (overviewRes.ok) {
				const data = await overviewRes.json();
				setOverview(data);
			}

			if (trendRes.ok) {
				const data = await trendRes.json();
				setTrend(data.data || []);
			}

			if (allTimeRes.ok) {
				const data = await allTimeRes.json();
				setAllTime(data);
			}
		} catch (err) {
			console.error("Failed to fetch financial data:", err);
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
					<h1 className="text-xl font-bold text-white">Financial Dashboard</h1>
					<p className="text-xs text-gray-400">Revenue, costs, and profitability metrics</p>
				</div>
				<div className="flex gap-2">
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
			</div>

			{loading ? (
				<div className="flex items-center justify-center h-64">
					<div className="animate-spin rounded-full h-8 w-8 border-t-2 border-b-2 border-cyan-500" />
				</div>
			) : (
				<>
					{/* Key Metrics Cards */}
					<div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
						{/* Revenue */}
						<div className="cyber-card p-3">
							<p className="text-[10px] text-gray-400 uppercase tracking-wider">Revenue</p>
							<p className="text-xl font-bold text-green-400">{formatCurrency(overview?.revenue.total || 0)}</p>
							<div className="flex gap-2 mt-1 text-[10px] text-gray-500">
								<span>Sub: {formatCurrency(overview?.revenue.subscription || 0)}</span>
								<span>Overage: {formatCurrency(overview?.revenue.overage || 0)}</span>
								<span>Credits: {formatCurrency(overview?.revenue.credits || 0)}</span>
							</div>
						</div>

						{/* Costs */}
						<div className="cyber-card p-3">
							<p className="text-[10px] text-gray-400 uppercase tracking-wider">Platform Costs</p>
							<p className="text-xl font-bold text-red-400">{formatCurrency(overview?.costs.platform || 0)}</p>
							<p className="text-[10px] text-gray-500 mt-1">
								Avg/gen: {formatCurrency(overview?.avgCostPerGeneration || 0)}
							</p>
						</div>

						{/* Profit */}
						<div className="cyber-card p-3">
							<p className="text-[10px] text-gray-400 uppercase tracking-wider">Gross Profit</p>
							<p className={`text-xl font-bold ${(overview?.profit.gross || 0) >= 0 ? "text-green-400" : "text-red-400"}`}>
								{formatCurrency(overview?.profit.gross || 0)}
							</p>
							<p className="text-[10px] text-gray-500 mt-1">
								Margin: {(overview?.profit.margin || 0).toFixed(1)}%
							</p>
						</div>

						{/* MRR */}
						<div className="cyber-card p-3">
							<p className="text-[10px] text-gray-400 uppercase tracking-wider">MRR / ARR</p>
							<p className="text-xl font-bold text-cyan-400">{formatCurrency(overview?.mrr || 0)}</p>
							<p className="text-[10px] text-gray-500 mt-1">
								ARR: {formatCurrency(overview?.arr || 0)}
							</p>
						</div>
					</div>

					{/* Second Row Metrics */}
					<div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
						{/* Subscribers */}
						<div className="cyber-card p-3">
							<p className="text-[10px] text-gray-400 uppercase tracking-wider">Active Subscribers</p>
							<p className="text-xl font-bold text-white">{overview?.subscribers.active || 0}</p>
							<div className="flex gap-2 mt-1 text-[10px]">
								<span className="text-green-400">+{overview?.subscribers.new || 0} new</span>
								<span className="text-red-400">-{overview?.subscribers.churned || 0} churned</span>
							</div>
						</div>

						{/* Churn Rate */}
						<div className="cyber-card p-3">
							<p className="text-[10px] text-gray-400 uppercase tracking-wider">Churn Rate</p>
							<p className={`text-xl font-bold ${(overview?.subscribers.churnRate || 0) > 5 ? "text-red-400" : "text-green-400"}`}>
								{(overview?.subscribers.churnRate || 0).toFixed(1)}%
							</p>
							<p className="text-[10px] text-gray-500 mt-1">Period churn</p>
						</div>

						{/* LTV */}
						<div className="cyber-card p-3">
							<p className="text-[10px] text-gray-400 uppercase tracking-wider">Customer LTV</p>
							<p className="text-xl font-bold text-purple-400">{formatCurrency(overview?.ltv || 0)}</p>
							<p className="text-[10px] text-gray-500 mt-1">Lifetime value</p>
						</div>

						{/* Generations */}
						<div className="cyber-card p-3">
							<p className="text-[10px] text-gray-400 uppercase tracking-wider">Generations</p>
							<p className="text-xl font-bold text-white">{overview?.generations?.toLocaleString() || 0}</p>
							<p className="text-[10px] text-gray-500 mt-1">This period</p>
						</div>
					</div>

					{/* Revenue Trend Chart */}
					<div className="cyber-card p-4">
						<h2 className="text-sm font-semibold text-white mb-3">Revenue Trend (6 Months)</h2>
						{trend.length > 0 ? (
							<div className="h-40">
								<div className="flex items-end justify-between h-32 gap-2">
									{trend.map((d, i) => {
										const maxRevenue = Math.max(...trend.map((t) => t.revenue), 1);
										const height = (d.revenue / maxRevenue) * 100;
										return (
											<div key={i} className="flex-1 flex flex-col items-center gap-1">
												<div
													className="w-full bg-gradient-to-t from-cyan-500/50 to-cyan-400/80 rounded-t transition-all"
													style={{ height: `${height}%`, minHeight: "4px" }}
													title={formatCurrency(d.revenue)}
												/>
												<span className="text-[9px] text-gray-500 truncate w-full text-center">
													{d.period.slice(0, 7)}
												</span>
											</div>
										);
									})}
								</div>
								<div className="flex justify-between mt-2 text-[10px] text-gray-400">
									<span>Revenue</span>
									<span>Max: {formatCurrency(Math.max(...trend.map((t) => t.revenue)))}</span>
								</div>
							</div>
						) : (
							<p className="text-gray-500 text-sm">No trend data available</p>
						)}
					</div>

					{/* All Time Stats */}
					{allTime && (
						<div className="cyber-card p-4">
							<h2 className="text-sm font-semibold text-white mb-3">All-Time Statistics</h2>
							<div className="grid grid-cols-3 lg:grid-cols-6 gap-3 text-center">
								<div>
									<p className="text-[10px] text-gray-400">Total Revenue</p>
									<p className="text-sm font-bold text-green-400">{formatCurrency(allTime.totalRevenue)}</p>
								</div>
								<div>
									<p className="text-[10px] text-gray-400">Total Costs</p>
									<p className="text-sm font-bold text-red-400">{formatCurrency(allTime.totalCosts)}</p>
								</div>
								<div>
									<p className="text-[10px] text-gray-400">Total Profit</p>
									<p className={`text-sm font-bold ${allTime.totalProfit >= 0 ? "text-green-400" : "text-red-400"}`}>
										{formatCurrency(allTime.totalProfit)}
									</p>
								</div>
								<div>
									<p className="text-[10px] text-gray-400">Generations</p>
									<p className="text-sm font-bold text-white">{allTime.totalGenerations.toLocaleString()}</p>
								</div>
								<div>
									<p className="text-[10px] text-gray-400">Total Users</p>
									<p className="text-sm font-bold text-white">{allTime.totalUsers.toLocaleString()}</p>
								</div>
								<div>
									<p className="text-[10px] text-gray-400">Paying Customers</p>
									<p className="text-sm font-bold text-cyan-400">{allTime.payingCustomers.toLocaleString()}</p>
								</div>
							</div>
						</div>
					)}

					{/* Quick Links */}
					<div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
						<Link
							to="/admin/financials/revenue"
							className="cyber-card p-3 hover:border-cyan-400/50 transition-all group"
						>
							<p className="text-sm font-medium text-white group-hover:text-cyan-400">Revenue Details</p>
							<p className="text-[10px] text-gray-500">Breakdown by tier & customer</p>
						</Link>
						<Link
							to="/admin/financials/costs"
							className="cyber-card p-3 hover:border-cyan-400/50 transition-all group"
						>
							<p className="text-sm font-medium text-white group-hover:text-cyan-400">Cost Analysis</p>
							<p className="text-[10px] text-gray-500">Platform costs by model</p>
						</Link>
						<Link
							to="/admin/financials/metrics"
							className="cyber-card p-3 hover:border-cyan-400/50 transition-all group"
						>
							<p className="text-sm font-medium text-white group-hover:text-cyan-400">Business Metrics</p>
							<p className="text-[10px] text-gray-500">MRR, churn, LTV analysis</p>
						</Link>
						<Link
							to="/admin/financials/pnl"
							className="cyber-card p-3 hover:border-cyan-400/50 transition-all group"
						>
							<p className="text-sm font-medium text-white group-hover:text-cyan-400">P&L Statement</p>
							<p className="text-[10px] text-gray-500">Profit & loss report</p>
						</Link>
					</div>
				</>
			)}
		</div>
	);
}
