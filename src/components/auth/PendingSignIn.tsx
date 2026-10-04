import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { type LoginRequestPoll, useAuth } from "@/contexts/AuthContext";
import { useLoginRequestPoll } from "@/hooks/useLoginRequestPoll";
import {
	clearLoginRequest,
	isInboxScreenOpen,
	type LoginRequest,
	readStoredLoginRequest,
	subscribeInboxScreen,
} from "@/lib/loginRequest";

/**
 * Finishes a cross-device sign-in after this tab was reloaded or left.
 *
 * iPad and iPhone Safari often reload a tab when you switch to Mail to tap the link on another
 * device, which drops the sign-in screen and its polling. The request itself is saved in this
 * browser, so whenever the app opens signed out with an unfinished request, this keeps waiting
 * for the approval and signs in when it arrives.
 */
export function PendingSignIn() {
	const { user, adoptSession, adoptToken } = useAuth();
	const navigate = useNavigate();
	const location = useLocation();
	const inboxOpen = useSyncExternalStore(subscribeInboxScreen, isInboxScreenOpen, () => false);
	// Read once per mount; cleared when the request finishes or the person cancels.
	const [request, setRequest] = useState<LoginRequest | null>(() => readStoredLoginRequest());

	// Pick up a request saved after mount: the sign-in screen closed without a reload, or the
	// tab came back from another app.
	useEffect(() => {
		if (user || inboxOpen) return;
		const refresh = () => setRequest((cur) => cur ?? readStoredLoginRequest());
		refresh();
		window.addEventListener("focus", refresh);
		window.addEventListener("pageshow", refresh);
		return () => {
			window.removeEventListener("focus", refresh);
			window.removeEventListener("pageshow", refresh);
		};
	}, [user, inboxOpen]);

	// The approval page itself (this browser may be the device that opens the link) and the
	// sign-in screen's own inbox step handle their own flows.
	const active =
		!user && !!request && !inboxOpen && !location.pathname.startsWith("/auth/magic-link");

	const finish = useCallback(() => {
		clearLoginRequest();
		setRequest(null);
	}, []);

	const onApproved = useCallback(
		(session: Extract<LoginRequestPoll, { status: "approved" }>) => {
			finish();
			navigate("/", { replace: true, state: { isNewUser: session.isNewUser } });
			adoptSession(session.token, session.user);
		},
		[finish, navigate, adoptSession],
	);
	const onSignedInOtherTab = useCallback(
		(token: string) => {
			finish();
			adoptToken(token);
		},
		[finish, adoptToken],
	);

	const wait = useLoginRequestPoll(active ? request : null, onApproved, onSignedInOtherTab);

	if (!active) return null;
	if (wait === "denied" || wait === "elsewhere" || wait === "expired" || wait === "used") {
		const message =
			wait === "expired"
				? "That sign-in link expired. Send a new one."
				: wait === "elsewhere"
					? "The link was used to sign in on your other device."
					: wait === "denied"
						? "Sign-in was cancelled from your email."
						: "That sign-in link was already used.";
		// Defer so the toast isn't raised during render.
		queueMicrotask(() => {
			toast(message);
			finish();
		});
		return null;
	}

	return (
		<output
			className="fixed inset-x-3 bottom-3 z-50 mx-auto flex max-w-md items-center gap-3 rounded-2xl border border-border bg-card px-4 py-3 text-sm shadow-lg [padding-bottom:max(0.75rem,env(safe-area-inset-bottom))]"
		>
			<div className="min-w-0 flex-1">
				<p className="font-medium text-foreground">Waiting for you to approve the sign-in</p>
				<p className="text-muted-foreground">
					Open the email on your other device and tap “Sign in on that device”.
					{request?.code ? (
						<>
							{" "}
							Code <b className="tabular-nums text-foreground">{request.code}</b>
						</>
					) : null}
				</p>
			</div>
			<Button variant="ghost" size="sm" onClick={finish}>
				Cancel
			</Button>
		</output>
	);
}
