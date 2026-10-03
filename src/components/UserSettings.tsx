import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from "@/components/ui/sheet";
import { AccountSettings } from "@/pages/Settings";
import { Link } from "react-router-dom";

interface UserSettingsProps {
	isOpen: boolean;
	onClose: () => void;
	/** Kept for compatibility; the plan section links to /billing itself. */
	onOpenBilling?: () => void;
	onRelaunchTutorial?: () => void;
}

/**
 * Settings in a side sheet: the same sections as the /settings page (AccountSettings), so the
 * two can never disagree. Once the app routes to /settings this can be dropped.
 */
export function UserSettings({ isOpen, onClose }: UserSettingsProps) {
	return (
		<Sheet open={isOpen} onOpenChange={(open) => !open && onClose()}>
			<SheetContent
				side="right"
				className="w-full gap-0 overflow-y-auto sm:max-w-xl data-[side=right]:sm:max-w-xl"
			>
				<SheetHeader className="px-4 pt-4 pb-2 sm:px-6">
					<SheetTitle className="font-display text-2xl font-normal">Settings</SheetTitle>
					<SheetDescription>
						<Link
							to="/settings"
							onClick={onClose}
							className="text-foreground underline underline-offset-4 hover:text-verdigris"
						>
							Open as a page
						</Link>
					</SheetDescription>
				</SheetHeader>
				<div className="px-4 pb-8 sm:px-6 [&_section]:md:grid-cols-1 [&_section]:md:gap-4">
					<AccountSettings onNavigateAway={onClose} />
				</div>
			</SheetContent>
		</Sheet>
	);
}
