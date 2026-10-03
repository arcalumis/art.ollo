import { Navigate } from "react-router-dom";
import { useAuth } from "../../contexts/AuthContext";
import { AuthBackdrop } from "./AuthBackdrop";
import { SignIn } from "./SignIn";

/** Standalone /login. Signed-in visitors go straight to the app. */
export function LoginPage() {
	const { user } = useAuth();
	if (user) return <Navigate to="/" replace />;

	return (
		<AuthBackdrop>
			<SignIn />
		</AuthBackdrop>
	);
}
