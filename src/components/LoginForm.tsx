import { useState } from "react";
import { useAuth } from "../contexts/AuthContext";

type Step = "email" | "options" | "password" | "magic-link-sent" | "forgot-password" | "forgot-password-sent";

export function LoginForm() {
	const { checkEmail, loginWithEmail, requestMagicLink, requestPasswordReset, login } = useAuth();
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
	};

	// Legacy username/password login form
	if (useLegacyLogin) {
		return (
			<div className="min-h-screen flex items-center justify-center p-4">
				<div className="w-full max-w-sm">
					<div className="cyber-card rounded-lg p-6 shadow-2xl">
						<h1 className="text-3xl font-bold text-center mb-2 gradient-text">ollo.art</h1>
						<p className="text-cyan-400/70 text-center text-sm mb-6">neural image synthesis</p>

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
		<div className="min-h-screen flex items-center justify-center p-4">
			<div className="w-full max-w-sm">
				<div className="cyber-card rounded-lg p-6 shadow-2xl">
					<h1 className="text-3xl font-bold text-center mb-2 gradient-text">ollo.art</h1>
					<p className="text-cyan-400/70 text-center text-sm mb-6">neural image synthesis</p>

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
				</div>
			</div>
		</div>
	);
}
