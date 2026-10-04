import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { type LoginRequestPoll, useAuth } from "../../contexts/AuthContext";
import { useLoginRequestPoll } from "../../hooks/useLoginRequestPoll";
import { type LoginRequest, clearLoginRequest, markInboxScreen, saveLoginRequest } from "../../lib/loginRequest";
import { CheckInboxStep } from "./CheckInboxStep";
import { EmailStep } from "./EmailStep";
import { PasswordStep } from "./PasswordStep";
import { ResetRequestStep } from "./ResetRequestStep";
import { type WalletMode, WalletStep } from "./WalletStep";

type Step = "email" | "inbox" | "password" | "reset" | "reset-sent" | "wallet";

const RESEND_COOLDOWN_SECONDS = 60;

interface SignInProps {
	/** Heading on the first step. */
	title?: string;
	description?: string;
	/** Focus the email field on mount (off inside the phone sheet, so the keyboard doesn't jump up). */
	autoFocus?: boolean;
}

/**
 * The whole sign-in / sign-up flow. Email-first: one link signs existing
 * accounts in and creates new ones. Password and wallet are quieter
 * alternatives. Used on /login and inside the landing page's dialog.
 * Success needs no callback: AuthContext gets the user and the app takes over.
 */
export function SignIn({
	title = "Sign in or create an account",
	description = "Enter your email and we'll send you a link. No password needed.",
	autoFocus = true,
}: SignInProps) {
	const {
		loginWithEmail,
		login,
		requestMagicLink,
		requestPasswordReset,
		requestWalletChallenge,
		verifyWalletSignature,
		adoptSession,
		adoptToken,
	} = useAuth();
	const navigate = useNavigate();
	const { publicKey, signMessage, connected, connecting, disconnect } = useWallet();
	const { setVisible: openWalletPicker } = useWalletModal();

	const [step, setStep] = useState<Step>("email");
	const [email, setEmail] = useState("");
	const [identifier, setIdentifier] = useState("");
	const [password, setPassword] = useState("");
	const [rememberMe, setRememberMe] = useState(false);
	const [error, setError] = useState("");
	const [loading, setLoading] = useState(false);
	const [resendIn, setResendIn] = useState(0);
	const [walletMode, setWalletMode] = useState<WalletMode>("connect");
	const [walletUsername, setWalletUsername] = useState("");
	// The login request behind the link just sent; this device polls it (cross-device sign-in).
	const [loginRequest, setLoginRequest] = useState<LoginRequest | null>(null);

	const onApproved = useCallback(
		(session: Extract<LoginRequestPoll, { status: "approved" }>) => {
			clearLoginRequest();
			// Same hand-off as the verify page: isNewUser rides in router state, and the pending
			// prompt (lib/pendingPrompt) saved on this device is picked up by the app.
			navigate("/", { replace: true, state: { isNewUser: session.isNewUser } });
			adoptSession(session.token, session.user);
		},
		[navigate, adoptSession],
	);
	// The link was opened in another tab of this browser and signed in there.
	const onSignedInOtherTab = useCallback(
		(token: string) => {
			clearLoginRequest();
			adoptToken(token);
		},
		[adoptToken],
	);
	const wait = useLoginRequestPoll(
		step === "inbox" ? loginRequest : null,
		onApproved,
		onSignedInOtherTab,
	);
	const inboxPolling = step === "inbox" && !!loginRequest;
	useEffect(() => {
		if (!inboxPolling) return;
		markInboxScreen(true);
		return () => markInboxScreen(false);
	}, [inboxPolling]);

	// Only auto-sign after the user connected a wallet from this screen, not on
	// the adapter's silent reconnect from an earlier session.
	const userInitiatedConnect = useRef(false);

	useEffect(() => {
		if (resendIn <= 0) return;
		const t = setTimeout(() => setResendIn((s) => s - 1), 1000);
		return () => clearTimeout(t);
	}, [resendIn]);

	const go = (next: Step) => {
		setError("");
		setStep(next);
	};

	const sendLink = async () => {
		setError("");
		setLoading(true);
		const result = await requestMagicLink(email.trim(), rememberMe, loginRequest ?? undefined);
		setLoading(false);
		if (result.success) {
			setLoginRequest(result.request ?? null);
			if (result.request) saveLoginRequest(result.request);
			setStep("inbox");
			setResendIn(RESEND_COOLDOWN_SECONDS);
		} else {
			setError(result.error || "The sign-in link wasn't sent. Try again in a moment.");
		}
	};

	const signInWithPassword = async () => {
		setError("");
		setLoading(true);
		const id = identifier.trim();
		// Accounts from before email sign-in only have a username.
		const ok = id.includes("@")
			? await loginWithEmail(id, password, rememberMe)
			: await login(id, password);
		setLoading(false);
		if (!ok) setError("That email or username and password don't match.");
	};

	const sendReset = async () => {
		setLoading(true);
		await requestPasswordReset(email.trim());
		setLoading(false);
		go("reset-sent");
	};

	/** Challenge → signature → session. `username` is set when creating a wallet account. */
	const signWithWallet = useCallback(
		async (username?: string) => {
			if (!publicKey || !signMessage) {
				setError("This wallet can't sign messages. Try another wallet.");
				return;
			}
			setError("");
			setLoading(true);
			if (!username) setWalletMode("signing");
			const walletAddress = publicKey.toBase58();
			const fail = (message: string) => {
				setError(message);
				setLoading(false);
				if (!username) setWalletMode("connect");
			};

			const challenge = await requestWalletChallenge(walletAddress);
			if (!challenge) return fail("Couldn't start wallet sign-in. Try again.");

			try {
				const signatureBytes = await signMessage(new TextEncoder().encode(challenge.message));
				const bs58 = await import("bs58");
				const result = await verifyWalletSignature({
					walletAddress,
					challenge: challenge.challenge,
					signature: bs58.default.encode(signatureBytes),
					username,
				});
				if (!result) return fail("Couldn't verify the signature. Try again.");
				if (result.needsUsername) {
					setLoading(false);
					setWalletMode("username");
					return;
				}
				if (result.error) return fail(result.error);
				// Signed in: AuthContext now has the user.
				setLoading(false);
			} catch {
				fail("The signature was cancelled or failed. Try again.");
			}
		},
		[publicKey, signMessage, requestWalletChallenge, verifyWalletSignature],
	);

	useEffect(() => {
		if (
			connected &&
			userInitiatedConnect.current &&
			step === "wallet" &&
			walletMode === "connect" &&
			!loading
		) {
			userInitiatedConnect.current = false;
			signWithWallet();
		}
	}, [connected, step, walletMode, loading, signWithWallet]);

	const createWalletAccount = () => {
		if (!walletUsername.trim()) {
			setError("Choose a username.");
			return;
		}
		signWithWallet(walletUsername.trim());
	};

	switch (step) {
		case "inbox":
			return (
				<CheckInboxStep
					email={email.trim()}
					code={loginRequest?.code ?? ""}
					wait={wait}
					resendIn={resendIn}
					loading={loading}
					error={error}
					onResend={sendLink}
					onChangeEmail={() => go("email")}
				/>
			);
		case "password":
			return (
				<PasswordStep
					identifier={identifier}
					onIdentifierChange={setIdentifier}
					password={password}
					onPasswordChange={setPassword}
					rememberMe={rememberMe}
					onRememberMeChange={setRememberMe}
					loading={loading}
					error={error}
					onSubmit={signInWithPassword}
					onBack={() => go("email")}
					onForgot={() => {
						if (identifier.includes("@")) setEmail(identifier.trim());
						go("reset");
					}}
				/>
			);
		case "reset":
		case "reset-sent":
			return (
				<ResetRequestStep
					email={email}
					onEmailChange={setEmail}
					sent={step === "reset-sent"}
					loading={loading}
					onSubmit={sendReset}
					onBack={() => go("password")}
				/>
			);
		case "wallet":
			return (
				<WalletStep
					mode={walletMode}
					address={connected && publicKey ? publicKey.toBase58() : null}
					connecting={connecting}
					loading={loading}
					error={error}
					username={walletUsername}
					onUsernameChange={setWalletUsername}
					onConnect={() => {
						userInitiatedConnect.current = true;
						openWalletPicker(true);
					}}
					onDisconnect={() => {
						disconnect();
						userInitiatedConnect.current = true;
						openWalletPicker(true);
					}}
					onSign={() => signWithWallet()}
					onCreateAccount={createWalletAccount}
					onBack={() => {
						setWalletMode("connect");
						setLoading(false);
						go("email");
					}}
				/>
			);
		default:
			return (
				<EmailStep
					title={title}
					description={description}
					email={email}
					onEmailChange={setEmail}
					rememberMe={rememberMe}
					onRememberMeChange={setRememberMe}
					loading={loading}
					error={error}
					autoFocus={autoFocus}
					onSubmit={sendLink}
					onUsePassword={() => {
						if (!identifier && email) setIdentifier(email.trim());
						go("password");
					}}
					onUseWallet={() => {
						setWalletMode("connect");
						go("wallet");
					}}
				/>
			);
	}
}
