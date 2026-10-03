import { useEffect, useState } from "react";
import { CheckIcon } from "lucide-react";
import { Link, useSearchParams } from "react-router-dom";
import { Laurel } from "@/components/brand/Laurel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAuth } from "../contexts/AuthContext";
import { AuthBackdrop } from "./auth/AuthBackdrop";
import { FieldLabel, FormError } from "./auth/fields";

export function ResetPasswordPage() {
	const [searchParams] = useSearchParams();
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
			setError("This link is missing its reset code. Request a new link.");
			return;
		}

		async function checkToken() {
			const result = await verifyResetToken(token as string);

			if (result.valid) {
				setStatus("valid");
				setEmail(result.email || "");
			} else {
				setStatus("invalid");
				setError("This reset link has expired or was already used. Request a new one.");
			}
		}

		checkToken();
	}, [token, verifyResetToken]);

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		setError("");

		if (password.length < 6) {
			setError("Use at least 6 characters.");
			return;
		}

		if (password !== confirmPassword) {
			setError("The two passwords don't match.");
			return;
		}

		setLoading(true);
		const success = await resetPassword(token as string, password);
		setLoading(false);

		if (success) {
			setStatus("success");
		} else {
			setError("The password wasn't changed. The link may have expired; request a new one.");
		}
	};

	return (
		<AuthBackdrop>
			<div aria-live="polite" className="space-y-5">
				{status === "loading" && (
					<>
						<Laurel progress={0.5} className="size-12" />
						<p className="text-sm text-muted-foreground">Checking your reset link.</p>
					</>
				)}

				{status === "invalid" && (
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
							Back to sign in
						</Button>
					</>
				)}

				{status === "valid" && (
					<form onSubmit={handleSubmit} className="space-y-4">
						<div className="space-y-1.5">
							<h1 className="text-xl font-semibold">Choose a new password</h1>
							{email && <p className="text-sm break-all text-muted-foreground">For {email}</p>}
						</div>
						<div>
							<FieldLabel htmlFor="new-password">New password</FieldLabel>
							<Input
								id="new-password"
								type="password"
								autoComplete="new-password"
								value={password}
								onChange={(e) => setPassword(e.target.value)}
								placeholder="At least 6 characters"
								required
								disabled={loading}
							/>
						</div>
						<div>
							<FieldLabel htmlFor="confirm-password">Confirm new password</FieldLabel>
							<Input
								id="confirm-password"
								type="password"
								autoComplete="new-password"
								value={confirmPassword}
								onChange={(e) => setConfirmPassword(e.target.value)}
								required
								disabled={loading}
							/>
						</div>
						<FormError message={error} />
						<Button type="submit" size="lg" className="w-full" disabled={loading}>
							{loading ? "Saving…" : "Save new password"}
						</Button>
					</form>
				)}

				{status === "success" && (
					<>
						<span
							className="flex size-11 items-center justify-center rounded-full bg-muted text-verdigris"
							aria-hidden
						>
							<CheckIcon className="size-5" />
						</span>
						<div className="space-y-1.5">
							<h1 className="text-xl font-semibold">Password saved</h1>
							<p className="text-sm text-muted-foreground">Sign in with your new password.</p>
						</div>
						<Button
							render={<Link to="/login" />}
							nativeButton={false}
							variant="outline"
							className="w-full"
						>
							Sign in
						</Button>
					</>
				)}
			</div>
		</AuthBackdrop>
	);
}
