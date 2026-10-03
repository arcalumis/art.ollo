import { Button } from "@/components/ui/button";
import { useAuth } from "@/contexts/AuthContext";
import { useWallet } from "@solana/wallet-adapter-react";
import { useState } from "react";
import { SolanaWalletButton } from "../SolanaWalletButton";

/*
 * "Confirm it's you" with the account's wallet: sign a fresh challenge. Loaded lazily inside a
 * <SolanaBoundary> (it imports the wallet adapter).
 */
export default function WalletReauth({
	onSigned,
}: {
	/** Receives the signed challenge; the caller sends it to /api/account/reauth. */
	onSigned: (proof: { challenge: string; signature: string }) => Promise<string | null>;
}) {
	const { publicKey, signMessage } = useWallet();
	const { requestWalletChallenge } = useAuth();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const sign = async () => {
		if (!publicKey || !signMessage) {
			setError("This wallet can't sign messages. Try another wallet.");
			return;
		}
		setError(null);
		setBusy(true);
		try {
			const challenge = await requestWalletChallenge(publicKey.toBase58());
			if (!challenge) throw new Error("challenge");
			const bytes = await signMessage(new TextEncoder().encode(challenge.message));
			const bs58 = await import("bs58");
			const problem = await onSigned({ challenge: challenge.challenge, signature: bs58.default.encode(bytes) });
			if (problem) setError(problem);
		} catch {
			setError("The signature was cancelled or failed. Try again.");
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="flex flex-col gap-2">
			<div className="flex flex-wrap gap-2">
				<SolanaWalletButton />
				{publicKey && (
					<Button type="button" onClick={sign} disabled={busy}>
						{busy ? "Waiting for wallet…" : "Sign with wallet"}
					</Button>
				)}
			</div>
			<p className="text-xs text-muted-foreground">Use the wallet you sign in with. Signing is free.</p>
			{error && (
				<p role="alert" className="text-sm text-destructive">
					{error}
				</p>
			)}
		</div>
	);
}
