import { MailIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FormError, QuietLink, StepHeader } from "./fields";

interface CheckInboxStepProps {
	email: string;
	/** Seconds until another link may be requested. */
	resendIn: number;
	loading: boolean;
	error: string;
	onResend: () => void;
	onChangeEmail: () => void;
}

/** After the link is sent: where it went, a timed resend, and a way back. */
export function CheckInboxStep({
	email,
	resendIn,
	loading,
	error,
	onResend,
	onChangeEmail,
}: CheckInboxStepProps) {
	return (
		<div className="space-y-6">
			<span
				className="flex size-11 items-center justify-center rounded-full bg-muted text-verdigris"
				aria-hidden
			>
				<MailIcon className="size-5" />
			</span>
			<StepHeader title="Check your inbox">
				We sent a sign-in link to{" "}
				<strong className="font-semibold break-all text-foreground">{email}</strong>. It works once
				and expires in 15 minutes. You can open it on this device or another one.
			</StepHeader>

			<FormError message={error} />

			<div className="space-y-2">
				<Button
					type="button"
					variant="outline"
					className="w-full"
					onClick={onResend}
					disabled={loading || resendIn > 0}
				>
					{loading
						? "Sending link…"
						: resendIn > 0
							? `Send another link in ${resendIn}s`
							: "Send another link"}
				</Button>
				<div className="flex justify-center">
					<QuietLink onClick={onChangeEmail}>Use a different email</QuietLink>
				</div>
			</div>
		</div>
	);
}
