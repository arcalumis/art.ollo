import { createContext, useCallback, useContext, useMemo, useState } from "react";

export type PaywallReason = "insufficient_credits" | "model_not_allowed" | "low_balance" | "top_up" | "upgrade";

export interface PaywallRequest {
	/** Credits the action needs (total, not per image). */
	needed?: number;
	/** The balance when the paywall opened. */
	balance?: number | null;
	reason: PaywallReason;
	/** For model_not_allowed: the model the user tried to use. */
	modelId?: string;
}

interface PaywallContextValue {
	request: PaywallRequest | null;
	isOpen: boolean;
	open: (request: PaywallRequest) => void;
	close: () => void;
	/** Bumps whenever credits may have changed (purchase finished); watch it to refetch balance. */
	creditsVersion: number;
	notifyCreditsChanged: () => void;
}

const PaywallContext = createContext<PaywallContextValue | null>(null);

/**
 * Paywall state. It holds no auth or data of its own, so it can sit at the
 * root; the sheet itself (`<PaywallSheet />`) renders inside the signed-in app.
 */
export function PaywallProvider({ children }: { children: React.ReactNode }) {
	const [request, setRequest] = useState<PaywallRequest | null>(null);
	const [isOpen, setIsOpen] = useState(false);
	const [creditsVersion, setCreditsVersion] = useState(0);

	const open = useCallback((next: PaywallRequest) => {
		setRequest(next);
		setIsOpen(true);
	}, []);
	// Keep the request through the closing animation; the next open replaces it.
	const close = useCallback(() => setIsOpen(false), []);
	const notifyCreditsChanged = useCallback(() => setCreditsVersion((v) => v + 1), []);

	const value = useMemo(
		() => ({ request, isOpen, open, close, creditsVersion, notifyCreditsChanged }),
		[request, isOpen, open, close, creditsVersion, notifyCreditsChanged],
	);
	return <PaywallContext.Provider value={value}>{children}</PaywallContext.Provider>;
}

const noop = () => {};
const fallback: PaywallContextValue = {
	request: null,
	isOpen: false,
	open: noop,
	close: noop,
	creditsVersion: 0,
	notifyCreditsChanged: noop,
};

export function usePaywall(): PaywallContextValue {
	return useContext(PaywallContext) ?? fallback;
}
