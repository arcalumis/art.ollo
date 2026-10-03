import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { useState } from "react";
import type { Thread } from "../types";

interface ThreadDeleteDialogProps {
	isOpen: boolean;
	onClose: () => void;
	thread: Thread | null;
	/** true: delete the series and its images for good; false: move the series to Archive. */
	onConfirm: (deletePhotos: boolean) => void | Promise<void>;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Remove a series from the list: archive it (images kept) or delete it with its images. */
export function ThreadDeleteDialog({
	isOpen,
	onClose,
	thread,
	onConfirm,
}: ThreadDeleteDialogProps) {
	const [deletePhotos, setDeletePhotos] = useState(false);
	const [confirming, setConfirming] = useState(false);

	const close = () => {
		if (confirming) return;
		setDeletePhotos(false);
		onClose();
	};

	const confirm = async () => {
		setConfirming(true);
		try {
			await onConfirm(deletePhotos);
		} finally {
			setConfirming(false);
			setDeletePhotos(false);
		}
	};

	const count = thread?.generationCount ?? 0;
	const options = [
		{
			value: false,
			title: "Archive the series",
			detail:
				count > 0
					? `Keeps its ${plural(count, "image")}. You can open or restore it from Archive.`
					: "You can open or restore it from Archive.",
		},
		{
			value: true,
			title: "Delete the series and its images",
			detail: "This can't be undone.",
		},
	];

	return (
		<Dialog open={isOpen && !!thread} onOpenChange={(open) => !open && close()}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle className="font-sans text-lg font-semibold">Remove this series?</DialogTitle>
					<DialogDescription className="truncate">{thread?.title}</DialogDescription>
				</DialogHeader>

				<fieldset className="flex flex-col gap-2">
					<legend className="sr-only">What to do with the series</legend>
					{options.map((option) => {
						const checked = deletePhotos === option.value;
						return (
							<label
								key={String(option.value)}
								className={cn(
									"flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors has-focus-visible:ring-3 has-focus-visible:ring-ring/50",
									checked
										? option.value
											? "border-destructive/60"
											: "border-verdigris/60"
										: "border-border hover:border-foreground/30",
								)}
							>
								<input
									type="radio"
									name="series-remove"
									checked={checked}
									onChange={() => setDeletePhotos(option.value)}
									className={cn(
										"mt-1 size-4",
										option.value ? "accent-destructive" : "accent-verdigris",
									)}
								/>
								<span className="min-w-0">
									<span
										className={cn("block text-sm font-medium", option.value && "text-destructive")}
									>
										{option.title}
									</span>
									<span className="mt-0.5 block text-sm text-muted-foreground">
										{option.detail}
									</span>
								</span>
							</label>
						);
					})}
				</fieldset>

				<DialogFooter>
					<Button variant="outline" onClick={close} disabled={confirming}>
						Cancel
					</Button>
					<Button
						variant={deletePhotos ? "destructive" : "secondary"}
						onClick={confirm}
						disabled={confirming}
					>
						{deletePhotos ? "Delete series and images" : "Archive series"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
