import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../contexts/AuthContext";

export function MagicLinkVerify() {
	const [searchParams] = useSearchParams();
	const navigate = useNavigate();
	const { verifyMagicLink } = useAuth();
	const [status, setStatus] = useState<"verifying" | "success" | "error">("verifying");
	const [error, setError] = useState("");

	useEffect(() => {
		const token = searchParams.get("token");

		if (!token) {
			setStatus("error");
			setError("Invalid magic link - no token provided");
			return;
		}

		async function verify() {
			const success = await verifyMagicLink(token as string);

			if (success) {
				setStatus("success");
				// Redirect to home after short delay
				setTimeout(() => {
					navigate("/", { replace: true });
				}, 1500);
			} else {
				setStatus("error");
				setError("This link is invalid or has expired. Please request a new one.");
			}
		}

		verify();
	}, [searchParams, verifyMagicLink, navigate]);

	return (
		<div className="min-h-screen flex items-center justify-center p-4">
			<div className="w-full max-w-sm">
				<div className="cyber-card rounded-lg p-6 shadow-2xl text-center">
					<h1 className="text-3xl font-bold mb-2 gradient-text">ollo.art</h1>

					{status === "verifying" && (
						<div className="mt-8">
							<div className="w-12 h-12 mx-auto mb-4 border-2 border-cyan-500 border-t-transparent rounded-full animate-spin" />
							<p className="text-gray-400">Verifying your magic link...</p>
						</div>
					)}

					{status === "success" && (
						<div className="mt-8">
							<div className="w-16 h-16 mx-auto mb-4 rounded-full bg-green-500/20 flex items-center justify-center">
								<svg className="w-8 h-8 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
									<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
								</svg>
							</div>
							<h2 className="text-lg font-medium text-white mb-2">You're in!</h2>
							<p className="text-gray-400 text-sm">Redirecting to the app...</p>
						</div>
					)}

					{status === "error" && (
						<div className="mt-8">
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
				</div>
			</div>
		</div>
	);
}
