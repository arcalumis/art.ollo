import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { PhantomWalletAdapter, SolflareWalletAdapter } from "@solana/wallet-adapter-wallets";
import type { ReactNode } from "react";
import { API_BASE } from "../config";

// Import wallet adapter styles
import "@solana/wallet-adapter-react-ui/styles.css";

/*
 * Loaded on demand only (see components/solana/SolanaBoundary): the wallet
 * libraries are large and most visitors never open a wallet feature. Don't
 * import this module statically.
 */

// The backend proxy hides the RPC provider's key. Connection needs an absolute URL.
const RPC_URL = import.meta.env.PROD
	? `${window.location.origin}/api/solana/rpc`
	: `${API_BASE}/api/solana/rpc`;

// One set of adapters for the whole page, so a wallet connected in the upgrade
// sheet is still connected on the billing page (each boundary has its own provider).
let sharedWallets: (PhantomWalletAdapter | SolflareWalletAdapter)[] | null = null;
function wallets() {
	if (!sharedWallets) sharedWallets = [new PhantomWalletAdapter(), new SolflareWalletAdapter()];
	return sharedWallets;
}

interface SolanaWalletProviderProps {
	children: ReactNode;
	rpcUrl?: string;
}

export function SolanaWalletProvider({ children, rpcUrl = RPC_URL }: SolanaWalletProviderProps) {
	return (
		<ConnectionProvider endpoint={rpcUrl}>
			<WalletProvider wallets={wallets()} autoConnect>
				<WalletModalProvider>{children}</WalletModalProvider>
			</WalletProvider>
		</ConnectionProvider>
	);
}

export default SolanaWalletProvider;
