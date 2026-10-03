import { WalletIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FieldLabel, FormError, QuietLink, StepHeader } from "./fields";

export type WalletMode = "connect" | "signing" | "username";

interface WalletStepProps {
	mode: WalletMode;
	/** Connected wallet address, if any. */
	address: string | null;
	connecting: boolean;
	loading: boolean;
	error: string;
	username: string;
	onUsernameChange: (value: string) => void;
	onConnect: () => void;
	onDisconnect: () => void;
	onSign: () => void;
	onCreateAccount: () => void;
	onBack: () => void;
}

const short = (address: string) => `${address.slice(0, 4)}…${address.slice(-4)}`;

/** Solana wallet sign-in: connect, sign a one-time message, and pick a username on first use. */
export function WalletStep({
	mode,
	address,
	connecting,
	loading,
	error,
	username,
	onUsernameChange,
	onConnect,
	onDisconnect,
	onSign,
	onCreateAccount,
	onBack,
}: WalletStepProps) {
	if (mode === "signing") {
		return (
			<div className="space-y-6">
				<StepHeader title="Approve in your wallet">
					Your wallet is asking you to sign a one-time message. Signing proves the wallet is yours.
					It doesn't send a transaction or cost anything.
				</StepHeader>
				<FormError message={error} />
				<QuietLink onClick={onBack}>Cancel</QuietLink>
			</div>
		);
	}

	if (mode === "username") {
		return (
			<div className="space-y-6">
				<StepHeader title="Choose a username">
					This wallet is new to ollo. Pick a name for your account.
				</StepHeader>
				<form
					className="space-y-3"
					onSubmit={(e) => {
						e.preventDefault();
						onCreateAccount();
					}}
				>
					<div>
						<FieldLabel htmlFor="wallet-username">Username</FieldLabel>
						<Input
							id="wallet-username"
							value={username}
							onChange={(e) => onUsernameChange(e.target.value)}
							required
							disabled={loading}
							minLength={3}
							maxLength={30}
							pattern="[a-zA-Z0-9_\-]+"
							autoCapitalize="none"
							spellCheck={false}
							aria-describedby="wallet-username-hint"
							autoFocus
						/>
						<p id="wallet-username-hint" className="mt-1.5 text-sm text-muted-foreground">
							3 to 30 characters: letters, numbers, underscores and hyphens.
						</p>
					</div>
					<FormError message={error} />
					<Button type="submit" size="lg" className="w-full" disabled={loading}>
						{loading ? "Creating account…" : "Create account"}
					</Button>
				</form>
				<QuietLink onClick={onBack}>Cancel</QuietLink>
			</div>
		);
	}

	return (
		<div className="space-y-6">
			<StepHeader title="Continue with wallet">
				Sign in with a Solana wallet such as Phantom or Solflare. New wallets get an account on
				first sign-in.
			</StepHeader>
			<div className="space-y-2">
				{address ? (
					<>
						<Button type="button" size="lg" className="w-full" onClick={onSign} disabled={loading}>
							<WalletIcon />
							Continue as {short(address)}
						</Button>
						<div className="flex justify-center">
							<QuietLink onClick={onDisconnect}>Use another wallet</QuietLink>
						</div>
					</>
				) : (
					<Button type="button" size="lg" variant="outline" className="w-full" onClick={onConnect}>
						<WalletIcon />
						{connecting ? "Connecting…" : "Connect wallet"}
					</Button>
				)}
			</div>
			<FormError message={error} />
			<div className="border-t border-border pt-3">
				<QuietLink onClick={onBack}>Use email instead</QuietLink>
			</div>
		</div>
	);
}
