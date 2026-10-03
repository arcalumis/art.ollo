import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import App from "./App.tsx";
import { PaywallProvider } from "./contexts/PaywallContext";
import { ThemeProvider } from "./contexts/ThemeContext";

const root = document.getElementById("root");
if (!root) throw new Error("Root element not found");

// The Solana wallet provider is not mounted here: it loads with the features
// that use it (components/solana/SolanaBoundary).
createRoot(root).render(
	<StrictMode>
		<ThemeProvider>
			<TooltipProvider>
				<PaywallProvider>
					<App />
				</PaywallProvider>
				<Toaster position="bottom-center" />
			</TooltipProvider>
		</ThemeProvider>
	</StrictMode>,
);
