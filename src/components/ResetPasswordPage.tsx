import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../contexts/AuthContext";

export function ResetPasswordPage() {
	const [searchParams] = useSearchParams();
	const navigate = useNavigate();
	const { verifyResetToken, resetPassword } = useAuth();
	const [status, setStatus] = useState<"loading" | "valid" | "invalid" | "success">("loading");
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [confirmPassword, setConfirmPassword] = useState("");
	const [error, setError] = useState("");
	const [loading, setLoading] = useState(false);

	const token = searchParams.get("token");

	useEffect(() => {
		if (!token) {
			setStatus("invalid");
			setError("Invalid reset link - no token provided");
			return;
		}

		async function checkToken() {
			const result = await verifyResetToken(token as string);

			if (result.valid) {
				setStatus("valid");
				setEmail(result.email || "");
			} else {
				setStatus("invalid");
				setError("This reset link is invalid or has expired. Please request a new one.");
			}
		}

		checkToken();
	}, [token, verifyResetToken]);

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		setError("");

		if (password.length < 6) {
			setError("Password must be at least 6 characters");
			return;
		}

		if (password !== confirmPassword) {
			setError("Passwords do not match");
			return;
		}

		setLoading(true);
		const success = await resetPassword(token as string, password);
		setLoading(false);

		if (success) {
			setStatus("success");
		} else {
			setError("Failed to reset password. The link may have expired.");
		}
	};

	return (
		<div className="min-h-screen flex items-center justify-center p-4">
			<div className="w-full max-w-sm">
				<div className="cyber-card rounded-lg p-6 shadow-2xl">
					<h1 className="text-3xl font-bold text-center mb-2 gradient-text">ollo.art</h1>
					<p className="text-cyan-400/70 text-center text-sm mb-6">build with divine inspiration</p>

					{status === "loading" && (
						<div className="text-center py-8">
							<div className="w-12 h-12 mx-auto mb-4 border-2 border-cyan-500 border-t-transparent rounded-full animate-spin" />
							<p className="text-gray-400">Verifying reset link...</p>
						</div>
					)}

					{status === "invalid" && (
						<div className="text-center py-8">
							<div className="w-16 h-16 mx-auto mb-4 rounded-full bg-red-500/20 flex items-center justify-center">
								<svg className="w-8 h-8 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
									<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
								</svg>
							</div>
							<h2 className="text-lg font-medium text-white mb-2">Link expired</h2>
							<p className="text-gray-400 text-sm mb-6">{error}</p>
							<button
								type="button"
								onClick={() => navigate("/", { replace: true })}
								className="cyber-button px-6 py-2 rounded font-medium text-white text-sm"
							>
								Back to login
							</button>
						</div>
					)}

					{status === "valid" && (
						<form onSubmit={handleSubmit} className="space-y-4">
							<div className="text-center mb-4">
								<h2 className="text-lg font-medium text-white">Set new password</h2>
								{email && <p className="text-sm text-gray-400 mt-1">for {email}</p>}
							</div>

							<div>
								<label htmlFor="password" className="block text-xs font-medium mb-1 text-gray-400">
									New password
								</label>
								<input
									id="password"
									type="password"
									value={password}
									onChange={(e) => setPassword(e.target.value)}
									className="cyber-input w-full px-3 py-2 rounded text-white text-sm"
									placeholder="At least 6 characters"
									required
									disabled={loading}
									autoFocus
								/>
							</div>

							<div>
								<label htmlFor="confirmPassword" className="block text-xs font-medium mb-1 text-gray-400">
									Confirm password
								</label>
								<input
									id="confirmPassword"
									type="password"
									value={confirmPassword}
									onChange={(e) => setConfirmPassword(e.target.value)}
									className="cyber-input w-full px-3 py-2 rounded text-white text-sm"
									placeholder="Re-enter password"
									required
									disabled={loading}
								/>
							</div>

							{error && (
								<div className="p-2 bg-red-900/30 border border-red-500/30 rounded">
									<p className="text-red-400 text-xs">{error}</p>
								</div>
							)}

							<button
								type="submit"
								disabled={loading}
								className="cyber-button w-full py-2.5 rounded font-medium text-white text-sm"
							>
								{loading ? "Resetting..." : "Reset password"}
							</button>
						</form>
					)}

					{status === "success" && (
						<div className="text-center py-8">
							<div className="w-16 h-16 mx-auto mb-4 rounded-full bg-green-500/20 flex items-center justify-center">
								<svg className="w-8 h-8 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
									<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
								</svg>
							</div>
							<h2 className="text-lg font-medium text-white mb-2">Password reset!</h2>
							<p className="text-gray-400 text-sm mb-6">You can now sign in with your new password.</p>
							<button
								type="button"
								onClick={() => navigate("/", { replace: true })}
								className="cyber-button px-6 py-2 rounded font-medium text-white text-sm"
							>
								Sign in
							</button>
						</div>
					)}
				</div>
			</div>
		</div>
	);
}
