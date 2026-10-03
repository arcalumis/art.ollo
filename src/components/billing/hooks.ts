import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
	type CreditCosts,
	type CreditPack,
	type FreePlan,
	fetchCreditCosts,
	fetchCreditPacks,
	fetchPlans,
	fetchSolanaEnabled,
	fetchStripeEnabled,
	type Plan,
} from "./api";

export function useMediaQuery(query: string): boolean {
	const [matches, setMatches] = useState(() =>
		typeof window !== "undefined" && window.matchMedia ? window.matchMedia(query).matches : false,
	);
	useEffect(() => {
		if (!window.matchMedia) return;
		const mql = window.matchMedia(query);
		const onChange = () => setMatches(mql.matches);
		onChange();
		mql.addEventListener("change", onChange);
		return () => mql.removeEventListener("change", onChange);
	}, [query]);
	return matches;
}

export interface BillingCatalog {
	plans: Plan[];
	free: FreePlan | null;
	packs: CreditPack[];
	costs: CreditCosts | null;
	stripeEnabled: boolean;
	solanaEnabled: boolean;
}

// Plans, packs and costs change rarely: share one fetch across the sheet, pricing and billing.
let catalogPromise: Promise<BillingCatalog> | null = null;

export function loadCatalog(force = false): Promise<BillingCatalog> {
	if (!catalogPromise || force) {
		catalogPromise = Promise.all([
			fetchPlans(),
			fetchCreditPacks(),
			fetchCreditCosts(),
			fetchStripeEnabled(),
			fetchSolanaEnabled(),
		]).then(([{ plans, free }, packs, costs, stripeEnabled, solanaEnabled]) => ({
			plans,
			free,
			packs,
			costs,
			stripeEnabled,
			solanaEnabled,
		}));
		// A failed load shouldn't stick for the whole session.
		catalogPromise.catch(() => {
			catalogPromise = null;
		});
	}
	return catalogPromise;
}

export function useBillingCatalog(enabled = true): BillingCatalog | null {
	const [catalog, setCatalog] = useState<BillingCatalog | null>(null);
	useEffect(() => {
		if (!enabled) return;
		let alive = true;
		loadCatalog().then((c) => alive && setCatalog(c));
		return () => {
			alive = false;
		};
	}, [enabled]);
	return catalog;
}

const RETURN_PARAMS = ["success", "canceled", "credit_success", "credit_canceled"] as const;

/**
 * Stripe sends people back with ?success / ?canceled (plans) or ?credit_success /
 * ?credit_canceled (packs). Show one toast, strip the params, and let the caller
 * refetch. The webhook may land a moment after the redirect, so `onReturn` is
 * called again a few seconds later for successes.
 */
export function useCheckoutReturn(onReturn: () => void): void {
	const handled = useRef(false);
	const callback = useRef(onReturn);
	callback.current = onReturn;

	useEffect(() => {
		if (handled.current) return;
		const params = new URLSearchParams(window.location.search);
		const hit = RETURN_PARAMS.find((p) => params.get(p) === "true");
		if (!hit) return;
		handled.current = true;

		const url = new URL(window.location.href);
		for (const p of RETURN_PARAMS) url.searchParams.delete(p);
		window.history.replaceState(window.history.state, "", url.toString());

		if (hit === "success") toast.success("Payment received. Your plan is active and the credits are in your balance.");
		if (hit === "credit_success") toast.success("Payment received. The credits are in your balance.");
		if (hit === "canceled" || hit === "credit_canceled") toast("Checkout canceled. You weren't charged.");

		callback.current();
		if (hit === "success" || hit === "credit_success") {
			// Not cleared on unmount on purpose: StrictMode's re-run would drop them.
			for (const ms of [2500, 7000]) setTimeout(() => callback.current(), ms);
		}
	}, []);
}
