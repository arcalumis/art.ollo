import { CheckIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Laurel } from "@/components/brand/Laurel";
import { Button } from "@/components/ui/button";
import { type MagicLinkVerifyResult, useAuth } from "../contexts/AuthContext";
import {
	type LoginRequestInfo,
	approveLoginRequest,
	clearLoginRequest,
	denyLoginRequest,
	fetchLoginRequestInfo,
	isThisDevicesRequest,
} from "../lib/loginRequest";
import { AuthBackdrop } from "./auth/AuthBackdrop";
import { FormError, QuietLink } from "./auth/fields";
import { MatchCode } from "./auth/MatchCode";

type Status =
	| "verifying"
	| "signed-in"
	| "created"
	| "error"
	// Cross-device: the link was opened somewhere other than the device that asked.
	| "confirm"
	| "approved"
	| "denied";

type Busy = "approve" | "here" | "deny" | null;

const EXPIRED = "This link has expired or was already used. Request a new one.";
const OFFLINE = "Couldn't reach ollo. Check your connection and try again.";

/**
 * Landing spot for the emailed sign-in link.
 *
 * Opened on the device that asked for it (or an older link without a request id): verifies the
 * token and opens the app, as before. Opened anywhere else: shows which device asked and the
 * code it displays, and does nothing until a button is pressed, so link scanners and previews
 * can't sign anyone in. A prompt typed on the landing page before sign-up is picked up by the
 * app (see lib/pendingPrompt).
 */
export function MagicLinkVerify() {
	const [searchParams] = useSearchParams();
	const navigate = useNavigate();
	const { verifyMagicLink, signInHereFromRequest } = useAuth();
	const [status, setStatus] = useState<Status>("verifying");
	const [error, setError] = useState("");
	const [info, setInfo] = useState<LoginRequestInfo | null>(null);
	const [busy, setBusy] = useState<Busy>(null);
	// Links work once; StrictMode's double effect must not spend it twice.
	const started = useRef(false);

	const token = searchParams.get("token");
	const rid = searchParams.get("rid");

	// Runs once per link (finishSignIn only uses setters and navigate).
	useEffect(() => {
		if (started.current) return;
		started.current = true;
		if (!token) {
			setStatus("error");
			setError("This link is missing its sign-in code. Request a new link.");
			return;
		}

		// Same device (or a link from before cross-device sign-in): sign in here, as before.
		if (!rid || isThisDevicesRequest(rid)) {
			verifyMagicLink(token).then((result) => {
				if (rid) clearLoginRequest();
				finishSignIn(result);
			});
			return;
		}

		// Another device: read-only lookup, then wait for a click.
		fetchLoginRequestInfo(rid, token).then((result) => {
			if (result === "expired" || result === "network") {
				setStatus("error");
				setError(result === "expired" ? EXPIRED : OFFLINE);
				return;
			}
			setInfo(result);
			setStatus("confirm");
		});
	}, [token, rid, verifyMagicLink]);

	function finishSignIn(result: MagicLinkVerifyResult) {
		if (!result.success) {
			setStatus("error");
			setError(EXPIRED);
			return;
		}
		setStatus(result.isNewUser ? "created" : "signed-in");
		setTimeout(() => navigate("/", { replace: true, state: { isNewUser: result.isNewUser } }), 900);
	}

	async function act(action: Exclude<Busy, null>) {
		if (!token || !rid || busy) return;
		setBusy(action);
		setError("");
		if (action === "here") {
			const result = await signInHereFromRequest(rid, token);
			setBusy(null);
			finishSignIn(result);
			return;
		}
		const result =
			action === "approve"
				? await approveLoginRequest(rid, token)
				: await denyLoginRequest(rid, token);
		setBusy(null);
		if (result.ok) {
			setStatus(action === "approve" ? "approved" : "denied");
			return;
		}
		if (result.error === "expired") {
			setStatus("error");
			setError(EXPIRED);
		} else {
			setError(OFFLINE);
		}
	}

	return (
		<AuthBackdrop>
			<div aria-live="polite" className="space-y-5">
				{status === "verifying" && (
					<>
						<Laurel progress={0.5} className="size-12" />
						<div className="space-y-1.5">
							<h1 className="text-xl font-semibold">Signing you in</h1>
							<p className="text-sm text-muted-foreground">Checking your link.</p>
						</div>
					</>
				)}

				{status === "confirm" && info && (
					<>
						<div className="space-y-1.5">
							<h1 className="text-xl font-semibold">Sign in on your other device?</h1>
							<p className="text-sm text-muted-foreground">
								This link was requested from{" "}
								<strong className="font-semibold text-foreground">{info.device}</strong>. You can
								sign that device in from here.
							</p>
						</div>
						<MatchCode code={info.code} label="Make sure your other device shows" />
						<FormError message={error} />
						<div className="space-y-2">
							<Button
								type="button"
								size="lg"
								className="w-full"
								disabled={busy !== null}
								onClick={() => act("approve")}
							>
								{busy === "approve" ? "Signing in that device…" : "Sign in on that device"}
							</Button>
							<Button
								type="button"
								variant="outline"
								className="w-full"
								disabled={busy !== null}
								onClick={() => act("here")}
							>
								{busy === "here" ? "Signing you in…" : "Sign in here instead"}
							</Button>
							<div className="flex justify-center">
								<QuietLink onClick={() => act("deny")} disabled={busy !== null}>
									{busy === "deny" ? "Cancelling…" : "I didn't ask for this"}
								</QuietLink>
							</div>
						</div>
					</>
				)}

				{status === "approved" && (
					<>
						<span
							className="flex size-11 items-center justify-center rounded-full bg-muted text-verdigris"
							aria-hidden
						>
							<CheckIcon className="size-5" />
						</span>
						<div className="space-y-1.5">
							<h1 className="text-xl font-semibold">Your other device is signing in</h1>
							<p className="text-sm text-muted-foreground">
								{info?.device ?? "Your other device"} opens ollo in a few seconds. You can close
								this tab.
							</p>
						</div>
					</>
				)}

				{status === "denied" && (
					<div className="space-y-1.5">
						<h1 className="text-xl font-semibold">Sign-in cancelled</h1>
						<p className="text-sm text-muted-foreground">
							Nobody was signed in, and this link no longer works. You can close this tab.
						</p>
					</div>
				)}

				{(status === "signed-in" || status === "created") && (
					<>
						<span
							className="flex size-11 items-center justify-center rounded-full bg-muted text-verdigris"
							aria-hidden
						>
							<CheckIcon className="size-5" />
						</span>
						<div className="space-y-1.5">
							<h1 className="text-xl font-semibold">
								{status === "created" ? "Your account is ready" : "You're signed in"}
							</h1>
							<p className="text-sm text-muted-foreground">
								{status === "created" ? "You have 10 free credits. Opening ollo…" : "Opening ollo…"}
							</p>
						</div>
					</>
				)}

				{status === "error" && (
					<>
						<div className="space-y-1.5">
							<h1 className="text-xl font-semibold">This link didn't work</h1>
							<p className="text-sm text-muted-foreground">{error}</p>
						</div>
						<Button
							render={<Link to="/login" />}
							nativeButton={false}
							variant="outline"
							className="w-full"
						>
							Get a new link
						</Button>
					</>
				)}
			</div>
		</AuthBackdrop>
	);
}
