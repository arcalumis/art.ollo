import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { useCallback } from "react";

interface SolanaWalletButtonProps {
	className?: string;
}

export function SolanaWalletButton({ className = "" }: SolanaWalletButtonProps) {
	const { publicKey, wallet, disconnect, connecting } = useWallet();
	const { setVisible } = useWalletModal();

	const handleClick = useCallback(() => {
		if (connecting) {
			// Allow canceling a stuck connection
			disconnect();
		} else if (publicKey) {
			disconnect();
		} else {
			setVisible(true);
		}
	}, [publicKey, connecting, disconnect, setVisible]);

	const truncateAddress = (address: string) => {
		return `${address.slice(0, 4)}...${address.slice(-4)}`;
	};

	return (
		<button
			type="button"
			onClick={handleClick}
			className={`cyber-button px-4 py-2 text-sm flex items-center gap-2 ${className}`}
		>
			{connecting ? (
				<>
					<span className="animate-spin rounded-full h-4 w-4 border-t-2 border-b-2 border-cyan-500" />
					Connecting... (click to cancel)
				</>
			) : publicKey ? (
				<>
					{wallet?.adapter.icon && (
						<img
							src={wallet.adapter.icon}
							alt={wallet.adapter.name}
							className="w-4 h-4"
						/>
					)}
					{truncateAddress(publicKey.toBase58())}
				</>
			) : (
				<>
					<svg
						className="w-4 h-4"
						fill="none"
						stroke="currentColor"
						viewBox="0 0 24 24"
					>
						<path
							strokeLinecap="round"
							strokeLinejoin="round"
							strokeWidth={2}
							d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z"
						/>
					</svg>
					Connect Wallet
				</>
			)}
		</button>
	);
}
