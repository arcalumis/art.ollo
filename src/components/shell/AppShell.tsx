import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { type ReactNode, useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { AppHeader } from "./AppHeader";

interface AppShellProps {
	username: string;
	isAdmin?: boolean;
	credits: number | null;
	lowAt: number;
	onSignOut: () => void;
	/** The series list and library. Gets a callback that closes the phone drawer. */
	renderNav: (onNavigate?: () => void) => ReactNode;
	children: ReactNode;
}

/**
 * Signed-in layout: header across the top, the series rail on the left from
 * md up, and the same rail in a left drawer on phones. The children fill the
 * rest (the work area, with the prompt bar docked at its bottom).
 */
export function AppShell({
	username,
	isAdmin,
	credits,
	lowAt,
	onSignOut,
	renderNav,
	children,
}: AppShellProps) {
	const [navOpen, setNavOpen] = useState(false);
	const location = useLocation();

	// Any navigation (back button included) closes the drawer.
	// biome-ignore lint/correctness/useExhaustiveDependencies: runs on route change by design
	useEffect(() => setNavOpen(false), [location.pathname]);

	return (
		<div className="flex h-dvh flex-col overflow-hidden bg-background text-foreground">
			<AppHeader
				username={username}
				isAdmin={isAdmin}
				credits={credits}
				lowAt={lowAt}
				onOpenNav={() => setNavOpen(true)}
				onSignOut={onSignOut}
			/>
			<div className="flex min-h-0 flex-1">
				<aside className="hidden w-72 shrink-0 flex-col border-r border-border md:flex">
					{renderNav()}
				</aside>
				<main className="flex min-w-0 flex-1 flex-col">{children}</main>
			</div>

			<Sheet open={navOpen} onOpenChange={setNavOpen}>
				<SheetContent side="left" className="w-[86vw] max-w-xs gap-0 bg-card p-0 pt-12">
					<SheetTitle className="sr-only">Series and library</SheetTitle>
					{renderNav(() => setNavOpen(false))}
				</SheetContent>
			</Sheet>
		</div>
	);
}
