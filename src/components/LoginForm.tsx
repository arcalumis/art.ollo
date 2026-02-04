import { useWallet } from "@solana/wallet-adapter-react";
import { useState, useEffect, useRef } from "react";
import { useAuth } from "../contexts/AuthContext";
import { SolanaWalletButton } from "./SolanaWalletButton";
import treasureCrowRight from "../assets/treasure_crow_right.png";

type Step = "email" | "options" | "password" | "magic-link-sent" | "forgot-password" | "forgot-password-sent" | "wallet-signing" | "wallet-username";

export function LoginForm() {
	const { checkEmail, loginWithEmail, requestMagicLink, requestPasswordReset, login, requestWalletChallenge, verifyWalletSignature } = useAuth();
	const { publicKey, signMessage, connected, connecting, disconnect } = useWallet();
	const [step, setStep] = useState<Step>("email");
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [rememberMe, setRememberMe] = useState(false);
	const [hasPassword, setHasPassword] = useState(false);
	const [error, setError] = useState("");
	const [loading, setLoading] = useState(false);

	// For legacy username login
	const [useLegacyLogin, setUseLegacyLogin] = useState(false);
	const [username, setUsername] = useState("");

	// For wallet login
	const [walletUsername, setWalletUsername] = useState("");

	// Track if user initiated wallet connection (to auto-trigger login)
	const wasConnectingRef = useRef(false);
	const hasAutoTriggeredRef = useRef(false);

	// Track when connecting starts (user-initiated)
	useEffect(() => {
		if (connecting) {
			wasConnectingRef.current = true;
			hasAutoTriggeredRef.current = false;
		}
	}, [connecting]);

	// Auto-trigger wallet login when connection completes after user initiated
	useEffect(() => {
		if (connected && wasConnectingRef.current && !hasAutoTriggeredRef.current && step === "email" && !loading) {
			hasAutoTriggeredRef.current = true;
			wasConnectingRef.current = false;
			// Small delay to ensure wallet state is fully ready
			setTimeout(() => {
				handleWalletLogin();
			}, 100);
		}
	}, [connected, step, loading]);

	const handleEmailSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		setError("");
		setLoading(true);

		const result = await checkEmail(email);
		setLoading(false);

		if (!result) {
			setError("Unable to check email. Please try again.");
			return;
		}

		if (!result.exists) {
			setError("No account found with this email address");
			return;
		}

		setHasPassword(result.hasPassword);
		setStep("options");
	};

	const handleMagicLink = async () => {
		setError("");
		setLoading(true);

		const success = await requestMagicLink(email, rememberMe);
		setLoading(false);

		if (success) {
			setStep("magic-link-sent");
		} else {
			setError("Failed to send magic link. Please try again.");
		}
	};

	const handlePasswordSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		setError("");
		setLoading(true);

		const success = await loginWithEmail(email, password, rememberMe);
		setLoading(false);

		if (!success) {
			setError("Invalid email or password");
		}
	};

	const handleForgotPassword = async () => {
		setError("");
		setLoading(true);

		await requestPasswordReset(email);
		setLoading(false);
		setStep("forgot-password-sent");
	};

	const handleLegacyLogin = async (e: React.FormEvent) => {
		e.preventDefault();
		setError("");
		setLoading(true);

		const success = await login(username, password);
		setLoading(false);

		if (!success) {
			setError("Invalid username or password");
		}
	};

	const resetToEmail = () => {
		setStep("email");
		setPassword("");
		setError("");
		setWalletUsername("");
	};

	const handleWalletLogin = async () => {
		if (!publicKey || !signMessage) {
			setError("Wallet not connected or does not support signing");
			return;
		}

		setError("");
		setLoading(true);
		setStep("wallet-signing");

		const walletAddress = publicKey.toBase58();

		// Request challenge from server
		const challengeResponse = await requestWalletChallenge(walletAddress);
		if (!challengeResponse) {
			setError("Failed to get authentication challenge");
			setLoading(false);
			setStep("email");
			return;
		}

		try {
			// Sign the message with wallet
			const messageBytes = new TextEncoder().encode(challengeResponse.message);
			const signatureBytes = await signMessage(messageBytes);

			// Convert signature to base58
			const bs58 = await import("bs58");
			const signature = bs58.default.encode(signatureBytes);

			// Verify signature with server
			const verifyResponse = await verifyWalletSignature({
				walletAddress,
				challenge: challengeResponse.challenge,
				signature,
			});

			if (!verifyResponse) {
				setError("Failed to verify signature");
				setLoading(false);
				setStep("email");
				return;
			}

			if (verifyResponse.needsUsername) {
				// New wallet, needs username
				setStep("wallet-username");
				setLoading(false);
				return;
			}

			if (verifyResponse.error) {
				setError(verifyResponse.error);
				setLoading(false);
				setStep("email");
				return;
			}

			// Successfully logged in - AuthContext handles setting user/token
			setLoading(false);
		} catch (err) {
			setError("Failed to sign message. Please try again.");
			setLoading(false);
			setStep("email");
		}
	};

	const handleWalletUsernameSubmit = async (e: React.FormEvent) => {
		e.preventDefault();

		if (!publicKey || !signMessage) {
			setError("Wallet not connected");
			return;
		}

		if (!walletUsername.trim()) {
			setError("Username is required");
			return;
		}

		setError("");
		setLoading(true);

		const walletAddress = publicKey.toBase58();

		// Request new challenge since previous one might be used
		const challengeResponse = await requestWalletChallenge(walletAddress);
		if (!challengeResponse) {
			setError("Failed to get authentication challenge");
			setLoading(false);
			return;
		}

		try {
			// Sign the message with wallet
			const messageBytes = new TextEncoder().encode(challengeResponse.message);
			const signatureBytes = await signMessage(messageBytes);

			// Convert signature to base58
			const bs58 = await import("bs58");
			const signature = bs58.default.encode(signatureBytes);

			// Verify signature with username
			const verifyResponse = await verifyWalletSignature({
				walletAddress,
				challenge: challengeResponse.challenge,
				signature,
				username: walletUsername.trim(),
			});

			if (!verifyResponse) {
				setError("Failed to create account");
				setLoading(false);
				return;
			}

			if (verifyResponse.error) {
				setError(verifyResponse.error);
				setLoading(false);
				return;
			}

			// Successfully created account and logged in
			setLoading(false);
		} catch (err) {
			setError("Failed to sign message. Please try again.");
			setLoading(false);
		}
	};

	const backgroundStyle = {
		backgroundImage: `url(${treasureCrowRight})`,
		backgroundPosition: 'top right',
		backgroundRepeat: 'no-repeat',
	};

	// Legacy username/password login form
	if (useLegacyLogin) {
		return (
			<div className="min-h-screen flex items-center justify-center p-4" style={backgroundStyle}>
				<div className="w-full max-w-sm">
					<div className="cyber-card rounded-lg p-6 shadow-2xl">
						<h1 className="text-3xl font-bold text-center mb-2 gradient-text">ollo.art</h1>
						<p className="text-cyan-400/70 text-center text-sm mb-6">build with divine inspiration</p>

						<form onSubmit={handleLegacyLogin} className="space-y-4">
							<div>
								<label htmlFor="username" className="block text-xs font-medium mb-1 text-gray-400">
									Username
								</label>
								<input
									id="username"
									type="text"
									value={username}
									onChange={(e) => setUsername(e.target.value)}
									className="cyber-input w-full px-3 py-2 rounded text-white text-sm"
									required
									disabled={loading}
								/>
							</div>

							<div>
								<label htmlFor="password" className="block text-xs font-medium mb-1 text-gray-400">
									Password
								</label>
								<input
									id="password"
									type="password"
									value={password}
									onChange={(e) => setPassword(e.target.value)}
									className="cyber-input w-full px-3 py-2 rounded text-white text-sm"
									required
									disabled={loading}
								/>
							</div>

							{error && (
								<div className="p-2 bg-red-900/30 border border-red-500/30 rounded">
									<p className="text-red-400 text-xs">{error}</p>
								</div>
							)}

							<button type="submit" disabled={loading} className="cyber-button w-full py-2.5 rounded font-medium text-white text-sm">
								{loading ? "Connecting..." : "Enter"}
							</button>
						</form>

						<button
							type="button"
							onClick={() => setUseLegacyLogin(false)}
							className="w-full mt-4 text-xs text-gray-500 hover:text-cyan-400 transition-colors"
						>
							Use email login instead
						</button>
					</div>
				</div>
			</div>
		);
	}

	return (
		<div className="min-h-screen flex items-center justify-center p-4" style={backgroundStyle}>
			<div className="w-full max-w-sm">
				<div className="cyber-card rounded-lg p-6 shadow-2xl">
					<h1 className="text-3xl font-bold text-center mb-2 gradient-text">ollo.art</h1>
					<p className="text-cyan-400/70 text-center text-sm mb-6">build with divine inspiration</p>

					{/* Step 1: Email Input */}
					{step === "email" && (
						<form onSubmit={handleEmailSubmit} className="space-y-4">
							<div>
								<label htmlFor="email" className="block text-xs font-medium mb-1 text-gray-400">
									Email address
								</label>
								<input
									id="email"
									type="email"
									value={email}
									onChange={(e) => setEmail(e.target.value)}
									className="cyber-input w-full px-3 py-2 rounded text-white text-sm"
									placeholder="you@example.com"
									required
									disabled={loading}
									autoFocus
								/>
							</div>

							{error && (
								<div className="p-2 bg-red-900/30 border border-red-500/30 rounded">
									<p className="text-red-400 text-xs">{error}</p>
								</div>
							)}

							<button type="submit" disabled={loading} className="cyber-button w-full py-2.5 rounded font-medium text-white text-sm">
								{loading ? "Checking..." : "Continue"}
							</button>

							<div className="relative my-4">
								<div className="absolute inset-0 flex items-center">
									<div className="w-full border-t border-gray-700" />
								</div>
								<div className="relative flex justify-center text-xs">
									<span className="bg-gray-900 px-2 text-gray-500">or</span>
								</div>
							</div>

							{connected && publicKey ? (
								<div className="space-y-2">
									<button
										type="button"
										onClick={handleWalletLogin}
										disabled={loading}
										className="w-full py-2.5 rounded font-medium text-sm cyber-card hover:neon-border transition-all flex items-center justify-center gap-2"
									>
										<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
											<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" />
										</svg>
										Continue with {publicKey.toBase58().slice(0, 4)}...{publicKey.toBase58().slice(-4)}
									</button>
									<button
										type="button"
										onClick={() => disconnect()}
										className="w-full text-xs text-gray-500 hover:text-pink-400 transition-colors"
									>
										Disconnect wallet
									</button>
								</div>
							) : (
								<SolanaWalletButton className="w-full justify-center" />
							)}

							<button
								type="button"
								onClick={() => setUseLegacyLogin(true)}
								className="w-full text-xs text-gray-500 hover:text-cyan-400 transition-colors"
							>
								Use username instead
							</button>
						</form>
					)}

					{/* Step 2: Login Options */}
					{step === "options" && (
						<div className="space-y-4">
							<div className="text-center mb-4">
								<p className="text-sm text-gray-400">Signing in as</p>
								<p className="text-cyan-400 font-medium">{email}</p>
							</div>

							<div className="flex items-center gap-2 mb-4">
								<input
									id="rememberMe"
									type="checkbox"
									checked={rememberMe}
									onChange={(e) => setRememberMe(e.target.checked)}
									className="w-4 h-4 rounded border-gray-600 bg-gray-800 text-cyan-500 focus:ring-cyan-500"
								/>
								<label htmlFor="rememberMe" className="text-xs text-gray-400">
									Remember me for 30 days
								</label>
							</div>

							{error && (
								<div className="p-2 bg-red-900/30 border border-red-500/30 rounded">
									<p className="text-red-400 text-xs">{error}</p>
								</div>
							)}

							<button
								type="button"
								onClick={handleMagicLink}
								disabled={loading}
								className="cyber-button w-full py-2.5 rounded font-medium text-white text-sm"
							>
								{loading ? "Sending..." : "Send me a magic link"}
							</button>

							{hasPassword && (
								<button
									type="button"
									onClick={() => setStep("password")}
									disabled={loading}
									className="w-full py-2.5 rounded font-medium text-sm cyber-card hover:neon-border transition-all"
								>
									Enter my password
								</button>
							)}

							<button type="button" onClick={resetToEmail} className="w-full text-xs text-gray-500 hover:text-cyan-400 transition-colors">
								Use a different email
							</button>
						</div>
					)}

					{/* Step 3: Password Entry */}
					{step === "password" && (
						<form onSubmit={handlePasswordSubmit} className="space-y-4">
							<div className="text-center mb-4">
								<p className="text-sm text-gray-400">Signing in as</p>
								<p className="text-cyan-400 font-medium">{email}</p>
							</div>

							<div>
								<label htmlFor="password" className="block text-xs font-medium mb-1 text-gray-400">
									Password
								</label>
								<input
									id="password"
									type="password"
									value={password}
									onChange={(e) => setPassword(e.target.value)}
									className="cyber-input w-full px-3 py-2 rounded text-white text-sm"
									required
									disabled={loading}
									autoFocus
								/>
							</div>

							<div className="flex items-center gap-2">
								<input
									id="rememberMePassword"
									type="checkbox"
									checked={rememberMe}
									onChange={(e) => setRememberMe(e.target.checked)}
									className="w-4 h-4 rounded border-gray-600 bg-gray-800 text-cyan-500 focus:ring-cyan-500"
								/>
								<label htmlFor="rememberMePassword" className="text-xs text-gray-400">
									Remember me for 30 days
								</label>
							</div>

							{error && (
								<div className="p-2 bg-red-900/30 border border-red-500/30 rounded">
									<p className="text-red-400 text-xs">{error}</p>
								</div>
							)}

							<button type="submit" disabled={loading} className="cyber-button w-full py-2.5 rounded font-medium text-white text-sm">
								{loading ? "Signing in..." : "Sign in"}
							</button>

							<div className="flex justify-between text-xs">
								<button type="button" onClick={() => setStep("options")} className="text-gray-500 hover:text-cyan-400 transition-colors">
									Back
								</button>
								<button
									type="button"
									onClick={() => setStep("forgot-password")}
									className="text-gray-500 hover:text-pink-400 transition-colors"
								>
									Forgot password?
								</button>
							</div>
						</form>
					)}

					{/* Magic Link Sent */}
					{step === "magic-link-sent" && (
						<div className="text-center space-y-4">
							<div className="w-16 h-16 mx-auto mb-4 rounded-full bg-cyan-500/20 flex items-center justify-center">
								<svg className="w-8 h-8 text-cyan-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
									<path
										strokeLinecap="round"
										strokeLinejoin="round"
										strokeWidth={2}
										d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
									/>
								</svg>
							</div>
							<h2 className="text-lg font-medium text-white">Check your email</h2>
							<p className="text-sm text-gray-400">
								We sent a login link to <span className="text-cyan-400">{email}</span>
							</p>
							<p className="text-xs text-gray-500">The link will expire in 15 minutes</p>

							<button
								type="button"
								onClick={handleMagicLink}
								disabled={loading}
								className="w-full py-2 text-sm text-gray-400 hover:text-cyan-400 transition-colors"
							>
								{loading ? "Sending..." : "Didn't get it? Resend"}
							</button>

							<button type="button" onClick={resetToEmail} className="w-full text-xs text-gray-500 hover:text-cyan-400 transition-colors">
								Use a different email
							</button>
						</div>
					)}

					{/* Forgot Password */}
					{step === "forgot-password" && (
						<div className="space-y-4">
							<div className="text-center mb-4">
								<h2 className="text-lg font-medium text-white">Reset password</h2>
								<p className="text-sm text-gray-400 mt-1">We'll send a reset link to {email}</p>
							</div>

							<button
								type="button"
								onClick={handleForgotPassword}
								disabled={loading}
								className="cyber-button w-full py-2.5 rounded font-medium text-white text-sm"
							>
								{loading ? "Sending..." : "Send reset link"}
							</button>

							<button type="button" onClick={() => setStep("password")} className="w-full text-xs text-gray-500 hover:text-cyan-400 transition-colors">
								Back to password
							</button>
						</div>
					)}

					{/* Forgot Password Sent */}
					{step === "forgot-password-sent" && (
						<div className="text-center space-y-4">
							<div className="w-16 h-16 mx-auto mb-4 rounded-full bg-pink-500/20 flex items-center justify-center">
								<svg className="w-8 h-8 text-pink-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
									<path
										strokeLinecap="round"
										strokeLinejoin="round"
										strokeWidth={2}
										d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z"
									/>
								</svg>
							</div>
							<h2 className="text-lg font-medium text-white">Check your email</h2>
							<p className="text-sm text-gray-400">
								If an account exists for <span className="text-pink-400">{email}</span>, we sent a password reset link.
							</p>
							<p className="text-xs text-gray-500">The link will expire in 1 hour</p>

							<button type="button" onClick={resetToEmail} className="w-full text-xs text-gray-500 hover:text-cyan-400 transition-colors mt-4">
								Back to login
							</button>
						</div>
					)}

					{/* Wallet Signing */}
					{step === "wallet-signing" && (
						<div className="text-center space-y-4">
							<div className="w-16 h-16 mx-auto mb-4 rounded-full bg-purple-500/20 flex items-center justify-center">
								<svg className="w-8 h-8 text-purple-400 animate-pulse" fill="none" stroke="currentColor" viewBox="0 0 24 24">
									<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" />
								</svg>
							</div>
							<h2 className="text-lg font-medium text-white">Sign message in wallet</h2>
							<p className="text-sm text-gray-400">
								Please approve the signature request in your wallet to authenticate.
							</p>

							{error && (
								<div className="p-2 bg-red-900/30 border border-red-500/30 rounded">
									<p className="text-red-400 text-xs">{error}</p>
								</div>
							)}

							<button type="button" onClick={resetToEmail} className="w-full text-xs text-gray-500 hover:text-cyan-400 transition-colors mt-4">
								Cancel
							</button>
						</div>
					)}

					{/* Wallet Username */}
					{step === "wallet-username" && (
						<form onSubmit={handleWalletUsernameSubmit} className="space-y-4">
							<div className="text-center mb-4">
								<h2 className="text-lg font-medium text-white">Welcome to ollo.art</h2>
								<p className="text-sm text-gray-400 mt-1">Choose a username for your account</p>
							</div>

							<div>
								<label htmlFor="walletUsername" className="block text-xs font-medium mb-1 text-gray-400">
									Username
								</label>
								<input
									id="walletUsername"
									type="text"
									value={walletUsername}
									onChange={(e) => setWalletUsername(e.target.value)}
									className="cyber-input w-full px-3 py-2 rounded text-white text-sm"
									placeholder="Choose a username"
									required
									disabled={loading}
									autoFocus
									minLength={3}
									maxLength={30}
									pattern="[a-zA-Z0-9_-]+"
								/>
								<p className="text-xs text-gray-500 mt-1">3-30 characters, letters, numbers, underscores, hyphens</p>
							</div>

							{error && (
								<div className="p-2 bg-red-900/30 border border-red-500/30 rounded">
									<p className="text-red-400 text-xs">{error}</p>
								</div>
							)}

							<button type="submit" disabled={loading} className="cyber-button w-full py-2.5 rounded font-medium text-white text-sm">
								{loading ? "Creating account..." : "Create Account"}
							</button>

							<button type="button" onClick={resetToEmail} className="w-full text-xs text-gray-500 hover:text-cyan-400 transition-colors">
								Cancel
							</button>
						</form>
					)}
				</div>
			</div>
		</div>
	);
}
