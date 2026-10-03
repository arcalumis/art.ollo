import { CheckIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Laurel } from "@/components/brand/Laurel";
import { Button } from "@/components/ui/button";
import { useAuth } from "../contexts/AuthContext";
import { AuthBackdrop } from "./auth/AuthBackdrop";

type Status = "verifying" | "signed-in" | "created" | "error";

/**
 * Landing spot for the emailed sign-in link. Verifies the token, then opens
 * the app; a prompt typed on the landing page before sign-up is picked up
 * there (see lib/pendingPrompt).
 */
export function MagicLinkVerify() {
	const [searchParams] = useSearchParams();
	const navigate = useNavigate();
	const { verifyMagicLink } = useAuth();
	const [status, setStatus] = useState<Status>("verifying");
	const [error, setError] = useState("");
	// Links work once; StrictMode's double effect must not spend it twice.
	const started = useRef(false);

	useEffect(() => {
		if (started.current) return;
		started.current = true;
		const token = searchParams.get("token");
		if (!token) {
			setStatus("error");
			setError("This link is missing its sign-in code. Request a new link.");
			return;
		}

		verifyMagicLink(token).then((result) => {
			if (!result.success) {
				setStatus("error");
				setError("This link has expired or was already used. Request a new one.");
				return;
			}
			setStatus(result.isNewUser ? "created" : "signed-in");
			setTimeout(
				() => navigate("/", { replace: true, state: { isNewUser: result.isNewUser } }),
				900,
			);
		});
	}, [searchParams, verifyMagicLink, navigate]);

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
