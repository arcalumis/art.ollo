import { useAuth } from "@/contexts/AuthContext";
import { useCallback, useEffect, useRef, useState } from "react";
import { API_BASE } from "../../config";

export interface ApiResult<T> {
	ok: boolean;
	status: number;
	data: T & { error?: string; code?: string };
}

export async function adminCall<T = Record<string, unknown>>(
	token: string | null,
	method: string,
	path: string,
	body?: unknown,
): Promise<ApiResult<T>> {
	try {
		const res = await fetch(`${API_BASE}${path}`, {
			method,
			headers: {
				...(token ? { Authorization: `Bearer ${token}` } : {}),
				...(body !== undefined ? { "Content-Type": "application/json" } : {}),
			},
			body: body !== undefined ? JSON.stringify(body) : undefined,
		});
		const data = (await res.json().catch(() => ({}))) as ApiResult<T>["data"];
		return { ok: res.ok, status: res.status, data };
	} catch {
		return {
			ok: false,
			status: 0,
			data: { error: "Couldn't reach the server. Check your connection." } as ApiResult<T>["data"],
		};
	}
}

/** The admin's token-bound caller. */
export function useAdminCall() {
	const { token } = useAuth();
	return useCallback(
		<T = Record<string, unknown>>(method: string, path: string, body?: unknown) =>
			adminCall<T>(token, method, path, body),
		[token],
	);
}

/** GET `path` (re-fetched when it changes); `reload()` refetches. `path = null` skips. */
export function useAdminQuery<T>(path: string | null) {
	const call = useAdminCall();
	const [data, setData] = useState<T | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(path !== null);
	const seq = useRef(0);

	const load = useCallback(async () => {
		if (!path) return;
		const mine = ++seq.current;
		setLoading(true);
		const res = await call<T>("GET", path);
		if (mine !== seq.current) return; // a newer request superseded this one
		if (res.ok) {
			setData(res.data);
			setError(null);
		} else {
			setError(res.data.error ?? "Couldn't load this view.");
		}
		setLoading(false);
	}, [call, path]);

	useEffect(() => {
		void load();
	}, [load]);

	return { data, error, loading, reload: load };
}

// ---- Shared types (mirror the server's read models) ------------------------------

export type PlanSource = "stripe" | "sol" | "admin" | "free" | "boost";

export interface SubscriptionItem {
	userId: string;
	username: string;
	email: string | null;
	subscriptionId: string | null;
	plan: string;
	productId: string | null;
	source: PlanSource;
	status: string;
	startedAt: string | null;
	renewsAt: string | null;
	endsAt: string | null;
	pastDue: boolean;
	stale: boolean;
	mrrCents: number;
	stripeSubscriptionId: string | null;
	basePlan: string | null;
}

export interface Overview {
	asOf: string;
	mrr: { cents: number; stripeCents: number; solCents: number };
	paidSubscribers: number;
	paidByPlan: Array<{ plan: string; subscribers: number; mrrCents: number }>;
	pastDue: number;
	stale: number;
	revenueThisMonth: { total: number; stripe: number; sol: number };
	costThisMonth: { total: number; backfilled: number };
	grossMargin: number | null;
	grossProfit: number;
	signups: { last7: number; last30: number; total: number };
	activation: { users: number; activated: number; users30: number; activated30: number };
	failedPayments30d: number;
	revenueByPlan: Array<{ tier: string; revenue: number; subscribers: number }>;
	ltv: number | null;
	trend: Array<{ date: string; revenue: number; signups: number }>;
}

export interface PaymentItem {
	id: string;
	userId: string;
	username: string | null;
	method: "card" | "sol";
	kind: string;
	amountCents: number | null;
	amountSol: number | null;
	currency: string;
	status: string;
	description: string | null;
	stripePaymentIntentId: string | null;
	stripeInvoiceId: string | null;
	signature: string | null;
	createdAt: string | null;
}

export interface AuditEntry {
	id: string;
	adminUserId: string | null;
	adminUsername: string | null;
	action: string;
	targetType: string;
	targetId: string | null;
	targetLabel: string | null;
	before: unknown;
	after: unknown;
	reason: string | null;
	createdAt: string | null;
}

export interface Product {
	id: string;
	name: string;
	description: string | null;
	monthlyImageLimit: number | null;
	monthlyCostLimit: number | null;
	dailyImageLimit: number | null;
	bonusCredits: number;
	price: number;
	priceSol: number | null;
	availableForUsd: boolean;
	availableForSol: boolean;
	isActive: boolean;
	allowedModels: string[] | null;
	creditRefillAmount: number;
	topoffIntervalHours: number;
	stripePriceId: string | null;
	createdAt: string;
	activeUsers: number;
}

// ---- Formatting ------------------------------------------------------------------

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const usdPrecise = new Intl.NumberFormat("en-US", {
	style: "currency",
	currency: "USD",
	minimumFractionDigits: 2,
	maximumFractionDigits: 4,
});

export const fmtUsd = (dollars: number | null | undefined) =>
	dollars == null ? "—" : usd.format(dollars);
export const fmtCents = (cents: number | null | undefined) =>
	cents == null ? "—" : usd.format(cents / 100);
/** Small costs (Replicate) keep up to 4 decimals. */
export const fmtCost = (dollars: number | null | undefined) =>
	dollars == null
		? "—"
		: Math.abs(dollars) < 1 && dollars !== 0
			? usdPrecise.format(dollars)
			: usd.format(dollars);
export const fmtPct = (pct: number | null | undefined, digits = 0) =>
	pct == null ? "—" : `${pct.toFixed(digits)}%`;
export const fmtInt = (n: number | null | undefined) =>
	n == null ? "—" : n.toLocaleString("en-US");

export function fmtDate(iso: string | null | undefined, withTime = false): string {
	if (!iso) return "—";
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return "—";
	return d.toLocaleString("en-US", {
		year: "numeric",
		month: "short",
		day: "numeric",
		...(withTime ? { hour: "numeric", minute: "2-digit" } : {}),
	});
}

export function fmtAgo(iso: string | null | undefined): string {
	if (!iso) return "never";
	const ms = Date.now() - new Date(iso).getTime();
	if (Number.isNaN(ms)) return "—";
	const min = Math.round(ms / 60000);
	if (min < 1) return "just now";
	if (min < 60) return `${min} min ago`;
	const h = Math.round(min / 60);
	if (h < 48) return `${h} h ago`;
	return `${Math.round(h / 24)} days ago`;
}

export const SOURCE_LABEL: Record<PlanSource, string> = {
	stripe: "Stripe",
	sol: "SOL",
	admin: "Admin",
	free: "Free",
	boost: "Boost",
};

export const stripeSubscriptionUrl = (id: string) =>
	`https://dashboard.stripe.com/subscriptions/${id}`;
export const stripeInvoiceUrl = (id: string) => `https://dashboard.stripe.com/invoices/${id}`;
export const stripePaymentUrl = (id: string) => `https://dashboard.stripe.com/payments/${id}`;
export const stripeCustomerUrl = (id: string) => `https://dashboard.stripe.com/customers/${id}`;
export const solanaTxUrl = (sig: string) => `https://solscan.io/tx/${sig}`;
