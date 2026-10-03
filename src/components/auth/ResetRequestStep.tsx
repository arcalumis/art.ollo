import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FieldLabel, QuietLink, StepHeader } from "./fields";

interface ResetRequestStepProps {
	email: string;
	onEmailChange: (value: string) => void;
	sent: boolean;
	loading: boolean;
	onSubmit: () => void;
	onBack: () => void;
}

/** Ask for a password reset link, then confirm it was sent (without revealing whether the account exists). */
export function ResetRequestStep({
	email,
	onEmailChange,
	sent,
	loading,
	onSubmit,
	onBack,
}: ResetRequestStepProps) {
	if (sent) {
		return (
			<div className="space-y-6">
				<StepHeader title="Check your email">
					If an account uses{" "}
					<strong className="font-semibold break-all text-foreground">{email}</strong>, a password
					reset link is on its way. It expires in 1 hour.
				</StepHeader>
				<QuietLink onClick={onBack}>Back to sign in</QuietLink>
			</div>
		);
	}

	return (
		<div className="space-y-6">
			<StepHeader title="Reset your password">
				We'll email you a link to choose a new one.
			</StepHeader>
			<form
				className="space-y-3"
				onSubmit={(e) => {
					e.preventDefault();
					onSubmit();
				}}
			>
				<div>
					<FieldLabel htmlFor="reset-email">Email</FieldLabel>
					<Input
						id="reset-email"
						type="email"
						autoComplete="email"
						value={email}
						onChange={(e) => onEmailChange(e.target.value)}
						required
						disabled={loading}
					/>
				</div>
				<Button type="submit" size="lg" className="w-full" disabled={loading}>
					{loading ? "Sending link…" : "Send reset link"}
				</Button>
			</form>
			<QuietLink onClick={onBack}>Back to sign in</QuietLink>
		</div>
	);
}
