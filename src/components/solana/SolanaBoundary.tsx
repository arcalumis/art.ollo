import { type ReactNode, Suspense, createContext, lazy, useContext } from "react";

/*
 * The Solana wallet adapter and @solana/* libraries load only when a wallet
 * feature mounts (wallet sign-in, SOL purchase). Wrap such a feature, or the
 * lazily imported module that contains it, in <SolanaBoundary>. This file must
 * not import anything from @solana/*.
 */

const SolanaWalletProvider = lazy(() => import("@/contexts/SolanaWalletContext"));

const InsideBoundary = createContext(false);

interface SolanaBoundaryProps {
	children: ReactNode;
	/** Shown while the wallet libraries (and the lazy children) load. */
	fallback?: ReactNode;
}

export function SolanaBoundary({ children, fallback = null }: SolanaBoundaryProps) {
	// Nested boundaries share the outer provider.
	if (useContext(InsideBoundary)) return <Suspense fallback={fallback}>{children}</Suspense>;
	return (
		<Suspense fallback={fallback}>
			<SolanaWalletProvider>
				<InsideBoundary.Provider value>{children}</InsideBoundary.Provider>
			</SolanaWalletProvider>
		</Suspense>
	);
}
