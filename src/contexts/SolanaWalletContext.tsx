import { WalletAdapterNetwork } from "@solana/wallet-adapter-base";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { PhantomWalletAdapter, SolflareWalletAdapter } from "@solana/wallet-adapter-wallets";
import { clusterApiUrl } from "@solana/web3.js";
import { type ReactNode, useMemo } from "react";

// Import wallet adapter styles
import "@solana/wallet-adapter-react-ui/styles.css";

interface SolanaWalletProviderProps {
	children: ReactNode;
	network?: "mainnet-beta" | "devnet" | "testnet";
	rpcUrl?: string;
}

export function SolanaWalletProvider({
	children,
	network = "mainnet-beta",
	rpcUrl,
}: SolanaWalletProviderProps) {
	// Convert network string to WalletAdapterNetwork
	const walletNetwork = useMemo(() => {
		switch (network) {
			case "devnet":
				return WalletAdapterNetwork.Devnet;
			case "testnet":
				return WalletAdapterNetwork.Testnet;
			default:
				return WalletAdapterNetwork.Mainnet;
		}
	}, [network]);

	// RPC endpoint - use custom URL if provided, otherwise fall back to public RPC
	const endpoint = useMemo(() => rpcUrl || clusterApiUrl(walletNetwork), [rpcUrl, walletNetwork]);

	// Wallet adapters
	const wallets = useMemo(
		() => [new PhantomWalletAdapter(), new SolflareWalletAdapter()],
		[],
	);

	return (
		<ConnectionProvider endpoint={endpoint}>
			<WalletProvider wallets={wallets} autoConnect>
				<WalletModalProvider>{children}</WalletModalProvider>
			</WalletProvider>
		</ConnectionProvider>
	);
}
