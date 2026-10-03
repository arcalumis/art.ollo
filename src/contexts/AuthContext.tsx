import { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { API_BASE } from "../config";
import type { LoginRequest } from "../lib/loginRequest";
import type { User } from "../types";

interface WalletChallengeResponse {
	challenge: string;
	message: string;
}

export interface MagicLinkResult {
	success: boolean;
	error?: string;
	/** The login request this device polls for a cross-device sign-in. */
	request?: LoginRequest;
}

/** One poll of a login request. "approved" carries the session, exactly once. */
export type LoginRequestPoll =
	| { status: "pending" | "consumed" | "expired" | "retry" }
	| { status: "denied"; reason: "denied" | "elsewhere" }
	| { status: "approved"; token: string; user: User; isNewUser: boolean };

export interface MagicLinkVerifyResult {
	success: boolean;
	/** True when this link created the account (first sign-in). */
	isNewUser: boolean;
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
	/** `replaces`: the request a "Send another link" supersedes. */
	requestMagicLink: (email: string, rememberMe: boolean, replaces?: LoginRequest) => Promise<MagicLinkResult>;
	verifyMagicLink: (token: string) => Promise<MagicLinkVerifyResult>;
	/** Ask whether the emailed link approved this device's request. Doesn't sign in by itself. */
	pollLoginRequest: (request: LoginRequest) => Promise<LoginRequestPoll>;
	/** On the device where the link was opened: spend it and sign in here instead. */
	signInHereFromRequest: (requestId: string, token: string) => Promise<MagicLinkVerifyResult>;
	/** Store a session the server just issued (e.g. collected by pollLoginRequest). */
	adoptSession: (token: string, user: User) => void;
	requestPasswordReset: (email: string) => Promise<boolean>;
	resetPassword: (token: string, newPassword: string) => Promise<boolean>;
	verifyResetToken: (token: string) => Promise<{ valid: boolean; email?: string }>;
	requestWalletChallenge: (walletAddress: string) => Promise<WalletChallengeResponse | null>;
	verifyWalletSignature: (data: WalletVerifyRequest) => Promise<WalletVerifyResponse | null>;
	updateUser: (updates: Partial<User>) => void;
	/** Switch to a token the server just issued (e.g. after the email changed and sessions reset). */
	adoptToken: (token: string) => void;
	/** Signs out this device; `{ everywhere: true }` also ends every other session. */
	logout: (opts?: { everywhere?: boolean }) => void;
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

	// Request a magic link. Also the sign-up path: new emails get a "create your account" link.
	const requestMagicLink = useCallback(
		async (email: string, rememberMe: boolean, replaces?: LoginRequest): Promise<MagicLinkResult> => {
			try {
				const response = await fetch(`${API_BASE}/api/auth/magic-link`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						email,
						rememberMe,
						replaces: replaces ? { requestId: replaces.requestId, pollSecret: replaces.pollSecret } : undefined,
					}),
				});

				const data = await response.json().catch(() => ({}));
				if (response.ok) {
					const request =
						typeof data.requestId === "string" && typeof data.pollSecret === "string"
							? { requestId: data.requestId, pollSecret: data.pollSecret, code: String(data.code ?? "") }
							: undefined;
					return { success: true, request };
				}
				if (response.status === 429) {
					return { success: false, error: "Too many requests. Wait a minute, then try again." };
				}
				return { success: false, error: data.error || "The sign-in link wasn't sent. Try again in a moment." };
			} catch {
				return { success: false, error: "Couldn't reach ollo. Check your connection and try again." };
			}
		},
		[],
	);

	const adoptSession = useCallback((next: string, nextUser: User) => {
		try {
			localStorage.setItem("token", next);
		} catch {
			// storage blocked: the session lasts for this page only
		}
		setToken(next);
		setUser(nextUser);
	}, []);

	const pollLoginRequest = useCallback(async (request: LoginRequest): Promise<LoginRequestPoll> => {
		try {
			const response = await fetch(`${API_BASE}/api/auth/login-request/status`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ requestId: request.requestId, pollSecret: request.pollSecret }),
			});
			// Unknown request (or cleaned up): treat it as over.
			if (response.status === 404) return { status: "expired" };
			if (!response.ok) return { status: "retry" };
			const data = await response.json();
			if (data.status === "approved" && typeof data.token === "string" && data.user) {
				return { status: "approved", token: data.token, user: data.user, isNewUser: data.isNewUser === true };
			}
			if (data.status === "denied") {
				return { status: "denied", reason: data.reason === "elsewhere" ? "elsewhere" : "denied" };
			}
			if (data.status === "pending" || data.status === "consumed" || data.status === "expired") {
				return { status: data.status };
			}
			return { status: "retry" };
		} catch {
			return { status: "retry" };
		}
	}, []);

	const signInHereFromRequest = useCallback(
		async (requestId: string, magicToken: string): Promise<MagicLinkVerifyResult> => {
			try {
				const response = await fetch(`${API_BASE}/api/auth/login-request/here`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ requestId, token: magicToken }),
				});
				if (!response.ok) return { success: false, isNewUser: false };
				const data = await response.json();
				localStorage.setItem("token", data.token);
				setToken(data.token);
				setUser(data.user);
				return { success: true, isNewUser: data.isNewUser === true };
			} catch {
				return { success: false, isNewUser: false };
			}
		},
		[],
	);

	// Verify magic link token and log in
	const verifyMagicLink = useCallback(async (magicToken: string): Promise<MagicLinkVerifyResult> => {
		try {
			const response = await fetch(`${API_BASE}/api/auth/magic-link/verify?token=${encodeURIComponent(magicToken)}`);

			if (!response.ok) {
				return { success: false, isNewUser: false };
			}

			const data = await response.json();
			localStorage.setItem("token", data.token);
			setToken(data.token);
			setUser(data.user);
			return { success: true, isNewUser: data.isNewUser === true };
		} catch {
			return { success: false, isNewUser: false };
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

	const updateUser = useCallback((updates: Partial<User>) => {
		setUser((prev) => (prev ? { ...prev, ...updates } : null));
	}, []);

	const adoptToken = useCallback((next: string) => {
		try {
			localStorage.setItem("token", next);
		} catch {
			// storage blocked: the session lasts for this page only
		}
		setToken(next);
	}, []);

	// "Everywhere" ends every session on the server (best effort: local state clears regardless,
	// e.g. offline, or after account deletion when the token is already revoked).
	const logout = useCallback((opts?: { everywhere?: boolean }) => {
		const current = localStorage.getItem("token");
		if (current && opts?.everywhere) {
			void fetch(`${API_BASE}/api/auth/logout`, {
				method: "POST",
				headers: { Authorization: `Bearer ${current}` },
				keepalive: true,
			}).catch(() => {});
		}
		localStorage.removeItem("token");
		try {
			localStorage.removeItem("ollo:sudo");
		} catch {
			// nothing stored
		}
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
				requestMagicLink,
				verifyMagicLink,
				pollLoginRequest,
				signInHereFromRequest,
				adoptSession,
				requestPasswordReset,
				resetPassword,
				verifyResetToken,
				requestWalletChallenge,
				verifyWalletSignature,
				updateUser,
				adoptToken,
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
