import { useCallback, useState } from "react";
import { API_BASE } from "../config";
import type { UserApiKeyInfo, UserCredits, UserSubscriptionInfo, UserUsageInfo } from "../types";

export function useUserSubscription(token: string | null) {
	const [subscription, setSubscription] = useState<UserSubscriptionInfo | null>(null);
	const [loading, setLoading] = useState(false);

	const fetchSubscription = useCallback(async () => {
		if (!token) return;
		setLoading(true);
		try {
			const response = await fetch(`${API_BASE}/api/user/subscription`, {
				headers: { Authorization: `Bearer ${token}` },
			});
			if (!response.ok) return;
			const data = (await response.json()) as UserSubscriptionInfo;
			setSubscription(data);
		} catch (err) {
			console.error("Failed to fetch subscription:", err);
		} finally {
			setLoading(false);
		}
	}, [token]);

	return { subscription, loading, fetchSubscription };
}

export function useUserUsage(token: string | null) {
	const [usage, setUsage] = useState<UserUsageInfo | null>(null);
	const [loading, setLoading] = useState(false);

	const fetchUsage = useCallback(async () => {
		if (!token) return;
		setLoading(true);
		try {
			const response = await fetch(`${API_BASE}/api/user/usage`, {
				headers: { Authorization: `Bearer ${token}` },
			});
			if (!response.ok) return;
			const data = (await response.json()) as UserUsageInfo;
			setUsage(data);
		} catch (err) {
			console.error("Failed to fetch usage:", err);
		} finally {
			setLoading(false);
		}
	}, [token]);

	return { usage, loading, fetchUsage };
}

export function useUserCredits(token: string | null) {
	const [credits, setCredits] = useState<UserCredits | null>(null);
	const [loading, setLoading] = useState(false);

	const fetchCredits = useCallback(async () => {
		if (!token) return;
		setLoading(true);
		try {
			const response = await fetch(`${API_BASE}/api/user/credits`, {
				headers: { Authorization: `Bearer ${token}` },
			});
			const data = (await response.json()) as UserCredits;
			setCredits(data);
		} catch (err) {
			console.error("Failed to fetch credits:", err);
		} finally {
			setLoading(false);
		}
	}, [token]);

	return { credits, loading, fetchCredits };
}

export function useTutorial(token: string | null) {
	const [loading, setLoading] = useState(false);

	const completeTutorial = useCallback(async () => {
		if (!token) return false;
		setLoading(true);
		try {
			const response = await fetch(`${API_BASE}/api/user/tutorial-complete`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${token}`,
					"Content-Type": "application/json",
				},
			});
			return response.ok;
		} catch (err) {
			console.error("Failed to complete tutorial:", err);
			return false;
		} finally {
			setLoading(false);
		}
	}, [token]);

	const resetTutorial = useCallback(async () => {
		if (!token) return false;
		setLoading(true);
		try {
			const response = await fetch(`${API_BASE}/api/user/tutorial-reset`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${token}`,
					"Content-Type": "application/json",
				},
			});
			return response.ok;
		} catch (err) {
			console.error("Failed to reset tutorial:", err);
			return false;
		} finally {
			setLoading(false);
		}
	}, [token]);

	return { loading, completeTutorial, resetTutorial };
}

export function useUserApiKey(token: string | null) {
	const [apiKeyInfo, setApiKeyInfo] = useState<UserApiKeyInfo | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const fetchApiKey = useCallback(async () => {
		if (!token) return;
		setLoading(true);
		try {
			const response = await fetch(`${API_BASE}/api/user/api-key`, {
				headers: { Authorization: `Bearer ${token}` },
			});
			const data = (await response.json()) as UserApiKeyInfo;
			setApiKeyInfo(data);
		} catch (err) {
			console.error("Failed to fetch API key info:", err);
		} finally {
			setLoading(false);
		}
	}, [token]);

	const saveApiKey = useCallback(
		async (apiKey: string): Promise<boolean> => {
			if (!token) return false;
			setLoading(true);
			setError(null);
			try {
				const response = await fetch(`${API_BASE}/api/user/api-key`, {
					method: "POST",
					headers: {
						Authorization: `Bearer ${token}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({ apiKey }),
				});

				if (response.ok) {
					const data = (await response.json()) as { success: boolean; maskedKey: string };
					setApiKeyInfo({ hasKey: true, maskedKey: data.maskedKey });
					return true;
				}
				const errorData = (await response.json()) as { error: string };
				setError(errorData.error || "Failed to save API key");
				return false;
			} catch (err) {
				console.error("Failed to save API key:", err);
				setError("Failed to save API key");
				return false;
			} finally {
				setLoading(false);
			}
		},
		[token],
	);

	const deleteApiKey = useCallback(async (): Promise<boolean> => {
		if (!token) return false;
		setLoading(true);
		try {
			const response = await fetch(`${API_BASE}/api/user/api-key`, {
				method: "DELETE",
				headers: { Authorization: `Bearer ${token}` },
			});

			if (response.ok) {
				setApiKeyInfo({ hasKey: false });
				return true;
			}
			return false;
		} catch (err) {
			console.error("Failed to delete API key:", err);
			return false;
		} finally {
			setLoading(false);
		}
	}, [token]);

	return { apiKeyInfo, loading, error, fetchApiKey, saveApiKey, deleteApiKey };
}
