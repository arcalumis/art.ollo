import { ThemeSwitcher } from "@/components/ThemeSwitcher";
import { CreditPill } from "@/components/brand/CreditPill";
import { Wordmark } from "@/components/brand/Laurel";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { CreditCardIcon, LogOutIcon, MenuIcon, SettingsIcon, ShieldIcon } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import { BILLING_PATH, CREATE_PATH, SETTINGS_PATH } from "./routes";

interface AppHeaderProps {
	username: string;
	isAdmin?: boolean;
	credits: number | null;
	/** The dot on the credit pill turns bronze below this balance. */
	lowAt: number;
	onOpenNav: () => void;
	onSignOut: () => void;
}

/** Quiet top bar: the mark, the balance, appearance and the account menu. */
export function AppHeader({
	username,
	isAdmin,
	credits,
	lowAt,
	onOpenNav,
	onSignOut,
}: AppHeaderProps) {
	const navigate = useNavigate();
	const initial = username.trim().charAt(0).toUpperCase() || "?";

	return (
		<header className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-2 sm:px-4">
			<Button
				variant="ghost"
				size="icon"
				className="md:hidden"
				onClick={onOpenNav}
				aria-label="Open series and library"
			>
				<MenuIcon />
			</Button>
			<Link
				to={CREATE_PATH}
				className="rounded-lg px-1 py-1 outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
				aria-label="ollo, new series"
			>
				<Wordmark />
			</Link>

			<div className="ml-auto flex items-center gap-1 sm:gap-2">
				<CreditPill
					credits={credits}
					lowAt={lowAt}
					onClick={() => navigate(BILLING_PATH)}
					compact
					className="sm:hidden"
				/>
				<CreditPill
					credits={credits}
					lowAt={lowAt}
					onClick={() => navigate(BILLING_PATH)}
					className="hidden sm:inline-flex"
				/>
				<ThemeSwitcher />
				<DropdownMenu>
					<DropdownMenuTrigger
						className="inline-flex size-10 items-center justify-center rounded-lg outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 aria-expanded:bg-muted"
						aria-label="Account"
					>
						<span className="inline-flex size-7 items-center justify-center rounded-full bg-stone-2 text-xs font-semibold text-foreground">
							{initial}
						</span>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end" className="w-56">
						<DropdownMenuGroup>
							<DropdownMenuLabel className="truncate">Signed in as {username}</DropdownMenuLabel>
						</DropdownMenuGroup>
						<DropdownMenuItem onClick={() => navigate(SETTINGS_PATH)} className="min-h-9">
							<SettingsIcon />
							Settings
						</DropdownMenuItem>
						<DropdownMenuItem onClick={() => navigate(BILLING_PATH)} className="min-h-9">
							<CreditCardIcon />
							Billing and credits
						</DropdownMenuItem>
						{isAdmin && (
							<DropdownMenuItem onClick={() => navigate("/admin")} className="min-h-9">
								<ShieldIcon />
								Admin
							</DropdownMenuItem>
						)}
						<DropdownMenuSeparator />
						<DropdownMenuItem onClick={onSignOut} className="min-h-9">
							<LogOutIcon />
							Sign out
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			</div>
		</header>
	);
}
