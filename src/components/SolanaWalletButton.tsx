import { Button } from "@/components/ui/button";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { WalletIcon } from "lucide-react";
import { useCallback } from "react";

interface SolanaWalletButtonProps {
	className?: string;
}

const short = (address: string) => `${address.slice(0, 4)}…${address.slice(-4)}`;

/** Connect or disconnect a Solana wallet. Secondary styling: connecting spends nothing. */
export function SolanaWalletButton({ className }: SolanaWalletButtonProps) {
	const { publicKey, wallet, disconnect, connecting } = useWallet();
	const { setVisible } = useWalletModal();

	const handleClick = useCallback(() => {
		// While connecting, a click cancels a stuck connection.
		if (connecting || publicKey) disconnect();
		else setVisible(true);
	}, [publicKey, connecting, disconnect, setVisible]);

	return (
		<Button type="button" variant="outline" onClick={handleClick} className={className}>
			{connecting ? (
				"Connecting… (select to cancel)"
			) : publicKey ? (
				<>
					{wallet?.adapter.icon && <img src={wallet.adapter.icon} alt="" className="size-4" />}
					<span className="tabular-nums">{short(publicKey.toBase58())}</span>
					<span className="sr-only">connected. Select to disconnect</span>
				</>
			) : (
				<>
					<WalletIcon />
					Connect wallet
				</>
			)}
		</Button>
	);
}
