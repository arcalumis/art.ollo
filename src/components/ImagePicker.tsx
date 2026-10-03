import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { CheckIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { API_BASE } from "../config";
import type { Upload } from "../types";

interface ImagePickerProps {
	token: string;
	isOpen: boolean;
	onClose: () => void;
	onSelect: (urls: string[]) => void;
	selectedUrls: string[];
	maxImages?: number;
}

/** Pick reference images from your uploads. */
export function ImagePicker({
	token,
	isOpen,
	onClose,
	onSelect,
	selectedUrls,
	maxImages = 14,
}: ImagePickerProps) {
	const [uploads, setUploads] = useState<Upload[]>([]);
	const [loading, setLoading] = useState(false);
	const [failed, setFailed] = useState(false);
	const [selected, setSelected] = useState<Set<string>>(new Set(selectedUrls));

	const fetchUploads = useCallback(async () => {
		setLoading(true);
		setFailed(false);
		try {
			const response = await fetch(`${API_BASE}/api/uploads?trash=false`, {
				headers: { Authorization: `Bearer ${token}` },
			});
			if (!response.ok) throw new Error(String(response.status));
			const data = (await response.json()) as { uploads: Upload[] };
			setUploads(data.uploads);
		} catch {
			setFailed(true);
		} finally {
			setLoading(false);
		}
	}, [token]);

	useEffect(() => {
		if (isOpen) {
			setSelected(new Set(selectedUrls));
			fetchUploads();
		}
	}, [isOpen, fetchUploads, selectedUrls]);

	const toggle = (url: string) => {
		setSelected((prev) => {
			const next = new Set(prev);
			if (next.has(url)) next.delete(url);
			else if (next.size < maxImages) next.add(url);
			return next;
		});
	};

	return (
		<Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
			<DialogContent className="flex max-h-[85dvh] flex-col sm:max-w-2xl">
				<DialogHeader>
					<DialogTitle className="font-sans text-lg font-semibold">Your uploads</DialogTitle>
					<DialogDescription>
						Pick up to {maxImages} images to use as references. {selected.size} selected.
					</DialogDescription>
				</DialogHeader>

				<div className="-mx-4 min-h-0 flex-1 overflow-y-auto px-4">
					{loading ? (
						<div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
							{Array.from({ length: 10 }, (_, i) => (
								// biome-ignore lint/suspicious/noArrayIndexKey: static placeholders
								<Skeleton key={i} className="aspect-square rounded-xl" />
							))}
						</div>
					) : failed ? (
						<div className="flex flex-col items-center gap-3 py-10 text-center">
							<p className="text-sm text-muted-foreground">Couldn't load your uploads.</p>
							<Button variant="outline" onClick={fetchUploads}>
								Try again
							</Button>
						</div>
					) : uploads.length === 0 ? (
						<p className="py-10 text-center text-sm text-muted-foreground">
							No uploads yet. Drop an image on the prompt bar to add one.
						</p>
					) : (
						<ul className="m-0 grid list-none grid-cols-3 gap-2 p-0 sm:grid-cols-5">
							{uploads.map((u) => {
								const isSelected = selected.has(u.imageUrl);
								const canSelect = isSelected || selected.size < maxImages;
								return (
									<li key={u.id}>
										<button
											type="button"
											onClick={() => canSelect && toggle(u.imageUrl)}
											disabled={!canSelect}
											aria-pressed={isSelected}
											aria-label={u.originalName}
											className={cn(
												"relative block aspect-square w-full overflow-hidden rounded-xl bg-muted outline-2 outline-offset-2 outline-transparent focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-40",
												isSelected && "outline-verdigris",
											)}
										>
											<img
												src={`${API_BASE}${u.imageUrl}`}
												alt=""
												loading="lazy"
												className="h-full w-full object-cover"
											/>
											{isSelected && (
												<span className="absolute top-1.5 right-1.5 grid size-6 place-items-center rounded-full bg-verdigris text-background">
													<CheckIcon className="size-3.5" />
												</span>
											)}
										</button>
									</li>
								);
							})}
						</ul>
					)}
				</div>

				<DialogFooter>
					<Button variant="outline" onClick={onClose}>
						Cancel
					</Button>
					<Button
						variant="secondary"
						onClick={() => {
							onSelect(Array.from(selected));
							onClose();
						}}
					>
						{selected.size === 1 ? "Use 1 image" : `Use ${selected.size} images`}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
