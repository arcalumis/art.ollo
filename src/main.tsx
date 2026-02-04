import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.tsx";
import { ThemeProvider } from "./contexts/ThemeContext";
import { SolanaWalletProvider } from "./contexts/SolanaWalletContext";
import { API_BASE } from "./config";

const root = document.getElementById("root");
if (!root) throw new Error("Root element not found");

// Get Solana config from env
const solanaNetwork = (import.meta.env.VITE_SOLANA_NETWORK || "mainnet-beta") as
	| "mainnet-beta"
	| "devnet"
	| "testnet";
// Use backend proxy to hide Alchemy API key
// Solana Connection requires absolute URL, so use window.location.origin in production
const solanaRpcUrl = import.meta.env.PROD
	? `${window.location.origin}/api/solana/rpc`
	: `${API_BASE}/api/solana/rpc`;

createRoot(root).render(
	<StrictMode>
		<ThemeProvider>
			<SolanaWalletProvider network={solanaNetwork} rpcUrl={solanaRpcUrl}>
				<App />
			</SolanaWalletProvider>
		</ThemeProvider>
	</StrictMode>,
);
