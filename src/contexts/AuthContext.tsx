import { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { API_BASE } from "../config";
import type { User } from "../types";

interface CheckEmailResponse {
	exists: boolean;
	hasPassword: boolean;
	username?: string;
}

interface WalletChallengeResponse {
	challenge: string;
	message: string;
	isRegistered: boolean;
	username?: string;
}

interface WalletVerifyRequest {
	walletAddress: string;
	challenge: string;
	signature: string;
	username?: string;
}

interface WalletVerifyResponse {
	token?: string;
	user?: {
		id: string;
		username: string;
		isAdmin: boolean;
	};
	needsUsername?: boolean;
	error?: string;
}

interface AuthContextType {
	user: User | null;
	token: string | null;
	loading: boolean;
	login: (username: string, password: string) => Promise<boolean>;
	loginWithEmail: (email: string, password: string, rememberMe: boolean) => Promise<boolean>;
	checkEmail: (email: string) => Promise<CheckEmailResponse | null>;
	requestMagicLink: (email: string, rememberMe: boolean) => Promise<boolean>;
	verifyMagicLink: (token: string) => Promise<boolean>;
	requestPasswordReset: (email: string) => Promise<boolean>;
	resetPassword: (token: string, newPassword: string) => Promise<boolean>;
	verifyResetToken: (token: string) => Promise<{ valid: boolean; email?: string }>;
	requestWalletChallenge: (walletAddress: string) => Promise<WalletChallengeResponse | null>;
	verifyWalletSignature: (data: WalletVerifyRequest) => Promise<WalletVerifyResponse | null>;
	logout: () => void;
}

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
	const [user, setUser] = useState<User | null>(null);
	const [token, setToken] = useState<string | null>(() => localStorage.getItem("token"));
	const [loading, setLoading] = useState(true);

	// Verify token on mount
	useEffect(() => {
		async function verifyToken() {
			if (!token) {
				setLoading(false);
				return;
			}

			try {
				const response = await fetch(`${API_BASE}/api/me`, {
					headers: { Authorization: `Bearer ${token}` },
				});

				if (response.ok) {
					const data = await response.json();
					setUser(data.user);
				} else {
					// Token invalid, clear it
					localStorage.removeItem("token");
					setToken(null);
				}
			} catch {
				// Network error, keep token but mark as not verified
			} finally {
				setLoading(false);
			}
		}

		verifyToken();
	}, [token]);

	// Legacy login with username/password
	const login = useCallback(async (username: string, password: string): Promise<boolean> => {
		try {
			const response = await fetch(`${API_BASE}/api/login`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ username, password }),
			});

			if (!response.ok) {
				return false;
			}

			const data = await response.json();
			localStorage.setItem("token", data.token);
			setToken(data.token);
			setUser(data.user);
			return true;
		} catch {
			return false;
		}
	}, []);

	// Check if email exists and has password
	const checkEmail = useCallback(async (email: string): Promise<CheckEmailResponse | null> => {
		try {
			const response = await fetch(`${API_BASE}/api/auth/check-email`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ email }),
			});

			if (!response.ok) {
				return null;
			}

			return await response.json();
		} catch {
			return null;
		}
	}, []);

	// Login with email and password
	const loginWithEmail = useCallback(async (email: string, password: string, rememberMe: boolean): Promise<boolean> => {
		try {
			const response = await fetch(`${API_BASE}/api/auth/login-email`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ email, password, rememberMe }),
			});

			if (!response.ok) {
				return false;
			}

			const data = await response.json();
			localStorage.setItem("token", data.token);
			setToken(data.token);
			setUser(data.user);
			return true;
		} catch {
			return false;
		}
	}, []);

	// Request magic link email
	const requestMagicLink = useCallback(async (email: string, rememberMe: boolean): Promise<boolean> => {
		try {
			const response = await fetch(`${API_BASE}/api/auth/magic-link`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ email, rememberMe }),
			});

			return response.ok;
		} catch {
			return false;
		}
	}, []);

	// Verify magic link token and log in
	const verifyMagicLink = useCallback(async (magicToken: string): Promise<boolean> => {
		try {
			const response = await fetch(`${API_BASE}/api/auth/magic-link/verify?token=${encodeURIComponent(magicToken)}`);

			if (!response.ok) {
				return false;
			}

			const data = await response.json();
			localStorage.setItem("token", data.token);
			setToken(data.token);
			setUser(data.user);
			return true;
		} catch {
			return false;
		}
	}, []);

	// Request password reset email
	const requestPasswordReset = useCallback(async (email: string): Promise<boolean> => {
		try {
			const response = await fetch(`${API_BASE}/api/auth/forgot-password`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ email }),
			});

			return response.ok;
		} catch {
			return false;
		}
	}, []);

	// Verify password reset token
	const verifyResetToken = useCallback(async (resetToken: string): Promise<{ valid: boolean; email?: string }> => {
		try {
			const response = await fetch(`${API_BASE}/api/auth/verify-reset-token?token=${encodeURIComponent(resetToken)}`);
			return await response.json();
		} catch {
			return { valid: false };
		}
	}, []);

	// Reset password with token
	const resetPassword = useCallback(async (resetToken: string, newPassword: string): Promise<boolean> => {
		try {
			const response = await fetch(`${API_BASE}/api/auth/reset-password`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ token: resetToken, newPassword }),
			});

			return response.ok;
		} catch {
			return false;
		}
	}, []);

	// Request wallet challenge for signing
	const requestWalletChallenge = useCallback(async (walletAddress: string): Promise<WalletChallengeResponse | null> => {
		try {
			const response = await fetch(`${API_BASE}/api/auth/wallet/challenge`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ walletAddress }),
			});

			if (!response.ok) {
				return null;
			}

			return await response.json();
		} catch {
			return null;
		}
	}, []);

	// Verify wallet signature and login/register
	const verifyWalletSignature = useCallback(async (data: WalletVerifyRequest): Promise<WalletVerifyResponse | null> => {
		try {
			const response = await fetch(`${API_BASE}/api/auth/wallet/verify`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(data),
			});

			const result = await response.json();

			if (response.ok && result.token) {
				localStorage.setItem("token", result.token);
				setToken(result.token);
				setUser(result.user);
			}

			return result;
		} catch {
			return null;
		}
	}, []);

	const logout = useCallback(() => {
		localStorage.removeItem("token");
		setToken(null);
		setUser(null);
	}, []);

	return (
		<AuthContext.Provider
			value={{
				user,
				token,
				loading,
				login,
				loginWithEmail,
				checkEmail,
				requestMagicLink,
				verifyMagicLink,
				requestPasswordReset,
				resetPassword,
				verifyResetToken,
				requestWalletChallenge,
				verifyWalletSignature,
				logout,
			}}
		>
			{children}
		</AuthContext.Provider>
	);
}

export function useAuth() {
	const context = useContext(AuthContext);
	if (!context) {
		throw new Error("useAuth must be used within an AuthProvider");
	}
	return context;
}
