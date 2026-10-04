import { useEffect, useRef, useState } from "react";
import { type LoginRequestPoll, useAuth } from "../contexts/AuthContext";
import type { LoginRequest } from "../lib/loginRequest";

/** What the "Check your inbox" step shows while it waits for the emailed link. */
export type InboxWait = "waiting" | "approved" | "denied" | "elsewhere" | "expired" | "used";

const FAST_MS = 2000;
const SLOW_MS = 5000;
/** Poll fast for the first minute, then back off. */
const FAST_FOR_MS = 60_000;
/** The link expires after 15 minutes; stop a little after that. */
const GIVE_UP_AFTER_MS = 15.5 * 60_000;

/** Pure: the next delay (ms), or null to stop. Exported for tests. */
export function nextPollDelay(elapsedMs: number): number | null {
	if (elapsedMs >= GIVE_UP_AFTER_MS) return null;
	return elapsedMs < FAST_FOR_MS ? FAST_MS : SLOW_MS;
}

/** Pure: the waiting state after one poll result (approved is handled by the caller). */
export function waitStateFor(poll: LoginRequestPoll, hasLocalSession: boolean): InboxWait | null {
	switch (poll.status) {
		case "pending":
		case "retry":
			return null;
		case "denied":
			return poll.reason === "elsewhere" ? "elsewhere" : "denied";
		case "expired":
			return "expired";
		case "consumed":
			// The link was opened in another tab of this browser, which signed in there.
			return hasLocalSession ? "approved" : "used";
		case "approved":
			return "approved";
	}
}

/**
 * Device A's side of a cross-device sign-in: poll the login request until the emailed link
 * approves, denies or outlives it. On approval the session arrives exactly once and is handed
 * to `onApproved`. Polling pauses while the tab is hidden and resumes (immediately) when it
 * comes back.
 */
export function useLoginRequestPoll(
	request: LoginRequest | null,
	onApproved: (session: Extract<LoginRequestPoll, { status: "approved" }>) => void,
	onSignedInElsewhereTab: (token: string) => void,
): InboxWait {
	const { pollLoginRequest } = useAuth();
	const [state, setState] = useState<InboxWait>("waiting");
	const approvedRef = useRef(onApproved);
	const tabRef = useRef(onSignedInElsewhereTab);
	approvedRef.current = onApproved;
	tabRef.current = onSignedInElsewhereTab;

	useEffect(() => {
		setState("waiting");
		if (!request) return;

		const startedAt = Date.now();
		let timer: ReturnType<typeof setTimeout> | null = null;
		let inFlight = false;
		let done = false;

		const schedule = (delay: number) => {
			if (timer) clearTimeout(timer);
			timer = setTimeout(tick, delay);
		};

		const finish = (next: InboxWait) => {
			done = true;
			if (timer) clearTimeout(timer);
			setState(next);
		};

		async function tick() {
			if (done || inFlight) return;
			if (document.hidden) return; // resumes on visibilitychange
			const delay = nextPollDelay(Date.now() - startedAt);
			if (delay === null) return finish("expired");

			inFlight = true;
			const result = await pollLoginRequest(request as LoginRequest);
			inFlight = false;
			if (done) return;

			if (result.status === "approved") {
				finish("approved");
				approvedRef.current(result);
				return;
			}
			let localToken: string | null = null;
			if (result.status === "consumed") {
				try {
					localToken = localStorage.getItem("token");
				} catch {
					localToken = null;
				}
			}
			const next = waitStateFor(result, !!localToken);
			if (next) {
				finish(next);
				if (next === "approved" && localToken) tabRef.current(localToken);
				return;
			}
			schedule(delay);
		}

		const onVisibility = () => {
			if (!document.hidden && !done) schedule(0);
		};
		document.addEventListener("visibilitychange", onVisibility);
		// iPadOS/iOS Safari may restore the page from the back-forward cache or just refocus it
		// without a visibilitychange after a trip to the Mail app.
		window.addEventListener("pageshow", onVisibility);
		window.addEventListener("focus", onVisibility);
		schedule(FAST_MS);

		return () => {
			done = true;
			if (timer) clearTimeout(timer);
			document.removeEventListener("visibilitychange", onVisibility);
			window.removeEventListener("pageshow", onVisibility);
			window.removeEventListener("focus", onVisibility);
		};
	}, [request, pollLoginRequest]);

	return state;
}
