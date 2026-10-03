import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FieldLabel, FormError, QuietLink, RememberMe, StepHeader } from "./fields";

interface EmailStepProps {
	title: string;
	description: string;
	email: string;
	onEmailChange: (email: string) => void;
	rememberMe: boolean;
	onRememberMeChange: (value: boolean) => void;
	loading: boolean;
	error: string;
	autoFocus?: boolean;
	onSubmit: () => void;
	onUsePassword: () => void;
	onUseWallet: () => void;
}

/** First step: email in, sign-in link out. The same link creates new accounts. */
export function EmailStep({
	title,
	description,
	email,
	onEmailChange,
	rememberMe,
	onRememberMeChange,
	loading,
	error,
	autoFocus,
	onSubmit,
	onUsePassword,
	onUseWallet,
}: EmailStepProps) {
	return (
		<div className="space-y-6">
			<StepHeader title={title}>{description}</StepHeader>

			<form
				className="space-y-3"
				onSubmit={(e) => {
					e.preventDefault();
					onSubmit();
				}}
			>
				<div>
					<FieldLabel htmlFor="signin-email">Email</FieldLabel>
					<Input
						id="signin-email"
						type="email"
						autoComplete="email"
						inputMode="email"
						value={email}
						onChange={(e) => onEmailChange(e.target.value)}
						placeholder="you@example.com"
						required
						disabled={loading}
						autoFocus={autoFocus}
					/>
				</div>
				<RememberMe id="signin-remember" checked={rememberMe} onChange={onRememberMeChange} />
				<FormError message={error} />
				<Button type="submit" size="lg" className="w-full" disabled={loading}>
					{loading ? "Sending link…" : "Email me a sign-in link"}
				</Button>
				<p className="text-center text-sm text-muted-foreground">
					New here? The same link creates your account.
				</p>
			</form>

			<div className="flex flex-wrap items-center justify-center gap-x-5 border-t border-border pt-3">
				<QuietLink onClick={onUsePassword}>Sign in with password</QuietLink>
				<QuietLink onClick={onUseWallet}>Continue with wallet</QuietLink>
			</div>
		</div>
	);
}
