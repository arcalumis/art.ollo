import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { useMediaQuery } from "@/lib/useMediaQuery";
import { SignIn } from "./SignIn";

interface SignInDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	title?: string;
	description?: string;
}

/**
 * The sign-in flow over the current page: a dialog on wider screens, a bottom
 * sheet on phones. Outside clicks don't dismiss it, because the wallet picker
 * opens on top of it and a click there would otherwise close the flow.
 */
export function SignInDialog({ open, onOpenChange, title, description }: SignInDialogProps) {
	const wide = useMediaQuery("(min-width: 640px)");

	if (wide) {
		return (
			<Dialog open={open} onOpenChange={onOpenChange} disablePointerDismissal>
				<DialogContent className="rounded-2xl bg-card p-6 sm:max-w-md sm:p-8">
					<DialogTitle className="sr-only">Sign in to ollo</DialogTitle>
					<SignIn title={title} description={description} />
				</DialogContent>
			</Dialog>
		);
	}

	return (
		<Sheet open={open} onOpenChange={onOpenChange} disablePointerDismissal>
			<SheetContent
				side="bottom"
				className="max-h-[92dvh] overflow-y-auto rounded-t-2xl bg-card px-4 pt-6 pb-[max(1.5rem,env(safe-area-inset-bottom))]"
			>
				<SheetTitle className="sr-only">Sign in to ollo</SheetTitle>
				<SignIn title={title} description={description} autoFocus={false} />
			</SheetContent>
		</Sheet>
	);
}
