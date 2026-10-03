/**
 * Cross-device sign-in, browser side.
 *
 * Requesting a link returns a login request. This browser keeps it so that when the emailed
 * link is opened here, the verify page knows it is the same device and signs in directly.
 * Opened anywhere else, the link asks before doing anything, and this device polls for the
 * session (see hooks/useLoginRequestPoll).
 */
import { API_BASE } from "../config";

const KEY = "ollo:login-request";
/** Matches the magic-link expiry, with a little slack. */
const MAX_AGE_MS = 16 * 60 * 1000;

export interface LoginRequest {
	requestId: string;
	pollSecret: string;
	code: string;
}

interface Stored extends LoginRequest {
	savedAt: number;
}

export function saveLoginRequest(request: LoginRequest): void {
	try {
		const stored: Stored = { ...request, savedAt: Date.now() };
		localStorage.setItem(KEY, JSON.stringify(stored));
	} catch {
		// Storage blocked: polling still works in this tab; the link then asks before signing in.
	}
}

function readStored(): Stored | null {
	try {
		const raw = localStorage.getItem(KEY);
		if (!raw) return null;
		const data = JSON.parse(raw) as Partial<Stored>;
		if (
			typeof data.requestId !== "string" ||
			typeof data.savedAt !== "number" ||
			Date.now() - data.savedAt > MAX_AGE_MS
		) {
			localStorage.removeItem(KEY);
			return null;
		}
		return data as Stored;
	} catch {
		return null;
	}
}

/** True when this browser asked for the link with this request id. */
export function isThisDevicesRequest(requestId: string): boolean {
	return readStored()?.requestId === requestId;
}

export function clearLoginRequest(): void {
	try {
		localStorage.removeItem(KEY);
	} catch {
		// nothing stored
	}
}

// ---- The approval page (the device where the link was opened) ----

export interface LoginRequestInfo {
	device: string;
	code: string;
}

export type LinkActionResult = { ok: true } | { ok: false; error: "expired" | "network" };

function linkError(response: Response): LinkActionResult {
	// 401: the link is spent or expired (or its account can't sign in): all mean "get a new link".
	return {
		ok: false,
		error: response.status === 401 || response.status === 404 ? "expired" : "network",
	};
}

/** Read-only: what to show before asking. "expired" when the link is used, expired or invalid. */
export async function fetchLoginRequestInfo(
	requestId: string,
	token: string,
): Promise<LoginRequestInfo | "expired" | "network"> {
	try {
		const response = await fetch(
			`${API_BASE}/api/auth/login-request/info?rid=${encodeURIComponent(requestId)}&token=${encodeURIComponent(token)}`,
		);
		if (response.status === 404) return "expired";
		if (!response.ok) return "network";
		const data = await response.json();
		return { device: String(data.device), code: String(data.code) };
	} catch {
		return "network";
	}
}

async function linkAction(path: "approve" | "deny", requestId: string, token: string) {
	try {
		const response = await fetch(`${API_BASE}/api/auth/login-request/${path}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ requestId, token }),
		});
		return response.ok ? ({ ok: true } as const) : linkError(response);
	} catch {
		return { ok: false, error: "network" } as const;
	}
}

/** "Sign in on that device". */
export function approveLoginRequest(requestId: string, token: string): Promise<LinkActionResult> {
	return linkAction("approve", requestId, token);
}

/** "I didn't ask for this". */
export function denyLoginRequest(requestId: string, token: string): Promise<LinkActionResult> {
	return linkAction("deny", requestId, token);
}
