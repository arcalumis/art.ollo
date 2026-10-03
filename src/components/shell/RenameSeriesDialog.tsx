import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { Thread } from "@/types";
import { useEffect, useState } from "react";

interface RenameSeriesDialogProps {
	thread: Thread | null;
	onClose: () => void;
	onRename: (thread: Thread, title: string) => Promise<boolean>;
}

export function RenameSeriesDialog({ thread, onClose, onRename }: RenameSeriesDialogProps) {
	const [title, setTitle] = useState("");
	const [saving, setSaving] = useState(false);

	useEffect(() => {
		if (thread) setTitle(thread.title);
	}, [thread]);

	const trimmed = title.trim();
	const save = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!thread || !trimmed || saving) return;
		if (trimmed === thread.title) return onClose();
		setSaving(true);
		const ok = await onRename(thread, trimmed);
		setSaving(false);
		if (ok) onClose();
	};

	return (
		<Dialog open={!!thread} onOpenChange={(open) => !open && onClose()}>
			<DialogContent className="sm:max-w-sm">
				<form onSubmit={save} className="contents">
					<DialogHeader>
						<DialogTitle className="font-sans text-lg font-semibold">Rename series</DialogTitle>
					</DialogHeader>
					<div className="flex flex-col gap-1.5 text-sm">
						<label htmlFor="series-name" className="text-muted-foreground">
							Name
						</label>
						<Input
							id="series-name"
							value={title}
							onChange={(e) => setTitle(e.target.value)}
							maxLength={120}
							autoFocus
						/>
					</div>
					<DialogFooter>
						<Button type="button" variant="outline" onClick={onClose}>
							Cancel
						</Button>
						<Button type="submit" variant="secondary" disabled={!trimmed || saving}>
							Save name
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
