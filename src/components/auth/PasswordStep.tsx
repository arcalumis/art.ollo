import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FieldLabel, FormError, QuietLink, RememberMe, StepHeader } from "./fields";

interface PasswordStepProps {
	identifier: string;
	onIdentifierChange: (value: string) => void;
	password: string;
	onPasswordChange: (value: string) => void;
	rememberMe: boolean;
	onRememberMeChange: (value: boolean) => void;
	loading: boolean;
	error: string;
	onSubmit: () => void;
	onBack: () => void;
	onForgot: () => void;
}

/**
 * Password sign-in for accounts that set one. Accepts an email or, for older
 * accounts created before email sign-in, a username.
 */
export function PasswordStep({
	identifier,
	onIdentifierChange,
	password,
	onPasswordChange,
	rememberMe,
	onRememberMeChange,
	loading,
	error,
	onSubmit,
	onBack,
	onForgot,
}: PasswordStepProps) {
	return (
		<div className="space-y-6">
			<StepHeader title="Sign in with password" />
			<form
				className="space-y-3"
				onSubmit={(e) => {
					e.preventDefault();
					onSubmit();
				}}
			>
				<div>
					<FieldLabel htmlFor="signin-identifier">Email or username</FieldLabel>
					<Input
						id="signin-identifier"
						type="text"
						autoComplete="username"
						autoCapitalize="none"
						spellCheck={false}
						value={identifier}
						onChange={(e) => onIdentifierChange(e.target.value)}
						required
						disabled={loading}
					/>
				</div>
				<div>
					<FieldLabel htmlFor="signin-password">Password</FieldLabel>
					<Input
						id="signin-password"
						type="password"
						autoComplete="current-password"
						value={password}
						onChange={(e) => onPasswordChange(e.target.value)}
						required
						disabled={loading}
						autoFocus
					/>
				</div>
				<RememberMe
					id="signin-remember-password"
					checked={rememberMe}
					onChange={onRememberMeChange}
				/>
				<FormError message={error} />
				<Button type="submit" size="lg" className="w-full" disabled={loading}>
					{loading ? "Signing in…" : "Sign in"}
				</Button>
			</form>
			<div className="flex items-center justify-between gap-4 border-t border-border pt-3">
				<QuietLink onClick={onBack}>Email me a link instead</QuietLink>
				<QuietLink onClick={onForgot}>Forgot password?</QuietLink>
			</div>
		</div>
	);
}
