import { CheckIcon, MailIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { InboxWait } from "@/hooks/useLoginRequestPoll";
import { FormError, QuietLink, StepHeader } from "./fields";
import { MatchCode } from "./MatchCode";

interface CheckInboxStepProps {
	email: string;
	/** Code to match on the device where the link is opened. Empty when there is none. */
	code: string;
	/** Where the cross-device sign-in stands. */
	wait: InboxWait;
	/** Seconds until another link may be requested. */
	resendIn: number;
	loading: boolean;
	error: string;
	onResend: () => void;
	onChangeEmail: () => void;
}

/** Why waiting stopped, in the user's words. */
const ENDED: Partial<Record<InboxWait, string>> = {
	denied: "Sign-in was cancelled from your email.",
	elsewhere: "The link was used to sign in on the other device instead.",
	expired: "This sign-in link expired. Send a new one.",
	used: "This link was already used. Send a new one to sign in here.",
};

/**
 * After the link is sent: where it went, the code to match if it's opened on another device,
 * a timed resend, and a way back. This device signs in by itself once the link is approved.
 */
export function CheckInboxStep({
	email,
	code,
	wait,
	resendIn,
	loading,
	error,
	onResend,
	onChangeEmail,
}: CheckInboxStepProps) {
	if (wait === "approved") {
		return (
			<div className="space-y-6" aria-live="polite">
				<span
					className="flex size-11 items-center justify-center rounded-full bg-muted text-verdigris"
					aria-hidden
				>
					<CheckIcon className="size-5" />
				</span>
				<StepHeader title="You're signed in">Opening ollo…</StepHeader>
			</div>
		);
	}

	const ended = ENDED[wait];

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
				and expires in 15 minutes. Open it here or on another device; this screen signs in by
				itself.
			</StepHeader>

			{/* One live region: the code while waiting, then why waiting stopped. */}
			{(code || ended) && (
				<div aria-live="polite">
					{ended ? (
						<p className="rounded-xl bg-muted px-4 py-3 text-sm text-foreground">{ended}</p>
					) : (
						<div className="space-y-2">
							<MatchCode code={code} label="Your code" />
							<p className="text-sm text-muted-foreground">
								If you open the link on another device, check that it shows this code.
							</p>
						</div>
					)}
				</div>
			)}

			<FormError message={error} />

			<div className="space-y-2">
				<Button
					type="button"
					variant="outline"
					className="w-full"
					onClick={onResend}
					disabled={loading || (resendIn > 0 && !ended)}
				>
					{loading
						? "Sending link…"
						: resendIn > 0 && !ended
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
