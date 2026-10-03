import { API_BASE } from "@/config";

export type { CreditCosts, CreditPack, FreePlan, Plan } from "./plans";
import { type CreditCosts, type CreditPack, type FreePlan, type Plan, purchasablePlans } from "./plans";

/** The token AuthContext keeps; read directly where the auth context isn't mounted. */
export function storedToken(): string | null {
	try {
		return localStorage.getItem("token");
	} catch {
		return null;
	}
}

function authHeaders(token: string | null): HeadersInit {
	return token ? { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } : { "Content-Type": "application/json" };
}

async function getJson<T>(path: string, token?: string | null): Promise<T | null> {
	try {
		const res = await fetch(`${API_BASE}${path}`, token ? { headers: authHeaders(token) } : undefined);
		if (!res.ok) return null;
		return (await res.json()) as T;
	} catch {
		return null;
	}
}

export async function fetchPlans(): Promise<{ plans: Plan[]; free: FreePlan | null }> {
	const data = await getJson<{ products: Plan[]; free?: FreePlan | null }>("/api/billing/products");
	return { plans: purchasablePlans(data?.products ?? []), free: data?.free ?? null };
}

export async function fetchCreditPacks(): Promise<CreditPack[]> {
	const data = await getJson<{ packages: CreditPack[] }>("/api/billing/credit-packages");
	return data?.packages ?? [];
}

export async function fetchCreditCosts(): Promise<CreditCosts | null> {
	return getJson<CreditCosts>("/api/models/credit-costs");
}

export async function fetchStripeEnabled(): Promise<boolean> {
	const data = await getJson<{ enabled: boolean }>("/api/billing/status");
	return !!data?.enabled;
}

export async function fetchSolanaEnabled(): Promise<boolean> {
	const data = await getJson<{ enabled: boolean }>("/api/billing/solana/status");
	return !!data?.enabled;
}

/** The plan the user is on right now (boost-aware), by product id. */
export async function fetchCurrentPlan(token: string): Promise<{ id: string; name: string; price: number } | null> {
	const data = await getJson<{ subscription: { id: string; name: string; price: number } | null }>(
		"/api/user/subscription",
		token,
	);
	return data?.subscription ?? null;
}

export type RedirectResult = { ok: true } | { ok: false; reason: string; usePortal?: boolean };

/** Plain-language reason for a failed billing call; never the raw server string. */
function reasonFor(status: number, code?: string): string {
	if (code === "SUBSCRIPTION_EXISTS") return "You already have a plan. Change it from Manage subscription.";
	if (status === 401) return "Your session ended. Sign in again to continue.";
	if (status === 400) return "That option isn't available right now. Refresh the page and try again.";
	return "Payment couldn't start. Try again in a moment.";
}

async function postForRedirect(path: string, token: string, body: Record<string, unknown>): Promise<RedirectResult> {
	try {
		const res = await fetch(`${API_BASE}${path}`, { method: "POST", headers: authHeaders(token), body: JSON.stringify(body) });
		const data = (await res.json().catch(() => ({}))) as { url?: string; code?: string; usePortal?: boolean };
		if (res.ok && data.url) {
			window.location.assign(data.url);
			return { ok: true };
		}
		return { ok: false, reason: reasonFor(res.status, data.code), usePortal: data.usePortal };
	} catch {
		return { ok: false, reason: "Couldn't reach ollo. Check your connection and try again." };
	}
}

const absolute = (path: string) => `${window.location.origin}${path}`;

/**
 * Stripe Checkout for a plan. `returnPath` is where Stripe sends the user back;
 * `?success=true` / `?canceled=true` is appended for the toast. A 409 (already
 * subscribed) falls through to the billing portal.
 */
export async function startPlanCheckout(token: string, priceId: string, returnPath = "/billing"): Promise<RedirectResult> {
	const sep = returnPath.includes("?") ? "&" : "?";
	const result = await postForRedirect("/api/billing/checkout", token, {
		priceId,
		successUrl: absolute(`${returnPath}${sep}success=true`),
		cancelUrl: absolute(`${returnPath}${sep}canceled=true`),
	});
	if (!result.ok && result.usePortal) return openPortal(token, returnPath);
	return result;
}

export async function startPackCheckout(token: string, packageId: string, returnPath = "/billing"): Promise<RedirectResult> {
	const sep = returnPath.includes("?") ? "&" : "?";
	return postForRedirect("/api/billing/credit-checkout", token, {
		packageId,
		successUrl: absolute(`${returnPath}${sep}credit_success=true`),
		cancelUrl: absolute(`${returnPath}${sep}credit_canceled=true`),
	});
}

export async function openPortal(token: string, returnPath = "/billing"): Promise<RedirectResult> {
	const result = await postForRedirect("/api/billing/portal", token, { returnUrl: absolute(returnPath) });
	if (!result.ok && !result.usePortal) {
		return { ok: false, reason: "There's no subscription to manage yet. Pick a plan first." };
	}
	return result;
}
