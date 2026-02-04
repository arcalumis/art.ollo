import { useEffect, useRef, useState } from "react";
import { API_BASE } from "../config";
import type { Generation, QueuedGeneration, Upload } from "../types";
import { GenerationProgressBar } from "./GenerationProgressBar";
import { IconCheck, IconClose, IconPlus, IconRestore, IconTrash, IconArchive } from "./Icons";

interface ImageGalleryProps {
	generations: Generation[];
	uploads?: Upload[];
	queuedItems?: QueuedGeneration[];
	onTrash?: (id: string) => void;
	onRestore?: (id: string) => void;
	onDelete?: (id: string) => void;
	onArchive?: (id: string) => void;
	onUnarchive?: (id: string) => void;
	onArchiveUpload?: (id: string) => void;
	onUnarchiveUpload?: (id: string) => void;
	onDeleteUpload?: (id: string) => void;
	onDismissQueueItem?: (id: string) => void;
	onAddToInputs?: (imageUrl: string) => void;
	selectedInputUrls?: string[];
	onLoadMore?: () => void;
	hasMore?: boolean;
	loading?: boolean;
	showTrash?: boolean;
	showArchived?: boolean;
}

function getTimeRemaining(deletedAt: string): string {
	const deletedTime = new Date(deletedAt).getTime();
	const expiresAt = deletedTime + 60 * 60 * 1000; // 1 hour after deletion
	const now = Date.now();
	const remaining = expiresAt - now;

	if (remaining <= 0) return "Deleting soon...";

	const minutes = Math.floor(remaining / (60 * 1000));
	if (minutes < 1) return "Less than 1 min";
	return `${minutes} min`;
}

export function ImageGallery({
	generations,
	uploads = [],
	queuedItems = [],
	onTrash,
	onRestore,
	onDelete,
	onArchive,
	onUnarchive,
	onArchiveUpload,
	onUnarchiveUpload,
	onDeleteUpload,
	onDismissQueueItem,
	onAddToInputs,
	selectedInputUrls = [],
	onLoadMore,
	hasMore,
	loading,
	showTrash = false,
	showArchived = false,
}: ImageGalleryProps) {
	const [selectedImage, setSelectedImage] = useState<Generation | null>(null);
	const [selectedUpload, setSelectedUpload] = useState<Upload | null>(null);
	const sentinelRef = useRef<HTMLDivElement>(null);

	// Infinite scroll using IntersectionObserver
	useEffect(() => {
		if (!hasMore || loading || !onLoadMore) return;

		const observer = new IntersectionObserver(
			(entries) => {
				if (entries[0].isIntersecting && hasMore && !loading) {
					onLoadMore();
				}
			},
			{ threshold: 0.1, rootMargin: "100px" }
		);

		const sentinel = sentinelRef.current;
		if (sentinel) {
			observer.observe(sentinel);
		}

		return () => {
			if (sentinel) {
				observer.unobserve(sentinel);
			}
		};
	}, [hasMore, loading, onLoadMore]);

	const hasQueuedItems = queuedItems.length > 0;
	const hasGenerations = generations.length > 0;
	const hasUploads = uploads.length > 0;

	if (!hasQueuedItems && !hasGenerations && !hasUploads && !loading) {
		return (
			<div className="text-center py-8 text-gray-500">
				{showTrash ? (
					<p className="text-sm">Trash is empty</p>
				) : showArchived ? (
					<p className="text-sm">No archived images</p>
				) : (
					<p className="text-sm">No images yet</p>
				)}
			</div>
		);
	}

	return (
		<>
			<div className="grid grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-1.5">
				{/* Queued/Generating items */}
				{!showTrash &&
					queuedItems.map((item) => (
						<div
							key={item.id}
							className={`group relative aspect-square rounded overflow-hidden cyber-card ${
								item.status === "failed" ? "border-red-500/50" : item.status === "generating" ? "pulse-glow" : ""
							}`}
						>
							{/* Placeholder content */}
							<div className="absolute inset-0 flex flex-col items-center justify-center p-2">
								{item.status === "queued" && (
									<span className="text-xs text-gray-500">queued</span>
								)}
								{item.status === "generating" && (
									<div className="flex flex-col items-center w-full px-2">
										<div className="w-6 h-6 mb-2 border-2 border-cyan-500 border-t-transparent rounded-full animate-spin" />
										<span className="text-xs text-cyan-400 mb-2">generating</span>
										{item.startedAt && (
											<GenerationProgressBar
												startedAt={item.startedAt}
												estimatedDuration={item.estimatedDuration || 30}
												status={item.status}
											/>
										)}
									</div>
								)}
								{item.status === "failed" && (
									<span className="text-xs text-red-400">failed</span>
								)}
							</div>

							{/* Prompt overlay */}
							<div className="absolute bottom-0 left-0 right-0 p-1.5 bg-gradient-to-t from-black/90 to-transparent">
								<p className="text-[10px] text-white/70 line-clamp-1">{item.prompt}</p>
							</div>

							{/* Dismiss button for failed items */}
							{item.status === "failed" && onDismissQueueItem && (
								<button
									type="button"
									onClick={() => onDismissQueueItem(item.id)}
									className="absolute top-1 right-1 p-1 bg-gray-800/80 rounded hover:bg-red-900/80 transition-colors"
									title="Dismiss"
								>
									<IconClose className="w-3 h-3" />
								</button>
							)}
						</div>
					))}

				{/* Actual generations */}
				{generations.map((gen) => {
					const isTrashed = !!gen.deletedAt;

					return (
						<div
							key={gen.id}
							role="button"
							tabIndex={0}
							className={`group relative aspect-square rounded overflow-hidden cyber-card cursor-pointer hover:neon-border transition-all ${
								isTrashed ? "opacity-50" : ""
							}`}
							onClick={() => setSelectedImage(gen)}
							onKeyDown={(e) => e.key === "Enter" && setSelectedImage(gen)}
						>
							<img
								src={`${API_BASE}${gen.imageUrl}`}
								alt={gen.prompt}
								className={`w-full h-full object-cover transition-transform group-hover:scale-105 ${
									isTrashed ? "grayscale" : ""
								}`}
								loading="lazy"
							/>

							{/* Add to inputs button */}
							{onAddToInputs && !isTrashed && (
								<button
									type="button"
									onClick={(e) => { e.stopPropagation(); onAddToInputs(gen.imageUrl || ""); }}
									className={`absolute top-1 left-1 p-1 rounded transition-all ${
										selectedInputUrls.includes(gen.imageUrl || "")
											? "bg-cyan-500 opacity-100"
											: "bg-gray-800/80 opacity-0 group-hover:opacity-100 hover:bg-cyan-600"
									}`}
									title={selectedInputUrls.includes(gen.imageUrl || "") ? "Remove from inputs" : "Add to inputs"}
								>
									{selectedInputUrls.includes(gen.imageUrl || "") ? (
									<IconCheck className="w-3 h-3" />
								) : (
									<IconPlus className="w-3 h-3" />
								)}
								</button>
							)}

							{/* Trash indicator */}
							{isTrashed && (
								<div className="absolute top-1 left-1 px-1 py-0.5 bg-red-900/80 rounded text-[10px]">
									{getTimeRemaining(gen.deletedAt as string)}
								</div>
							)}

							<div className="absolute inset-0 bg-gradient-to-t from-black/90 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-0">
								<div className="absolute bottom-0 left-0 right-0 p-1.5">
									<p className="text-[10px] text-white line-clamp-2">{gen.prompt}</p>
								</div>
							</div>

							{/* Action buttons */}
							<div className="absolute top-1 right-1 flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity z-10">
								{isTrashed ? (
									<>
										{onRestore && (
											<button
												type="button"
												onClick={(e) => { e.stopPropagation(); onRestore(gen.id); }}
												className="p-1 bg-cyan-600/80 rounded hover:bg-cyan-500"
												title="Restore"
											>
												<IconRestore className="w-3 h-3" />
											</button>
										)}
										{onDelete && (
											<button
												type="button"
												onClick={(e) => { e.stopPropagation(); onDelete(gen.id); }}
												className="p-1 bg-red-600/80 rounded hover:bg-red-500"
												title="Delete permanently"
											>
												<IconClose className="w-3 h-3" />
											</button>
										)}
									</>
								) : showArchived ? (
									onUnarchive && (
										<button
											type="button"
											onClick={(e) => { e.stopPropagation(); onUnarchive(gen.id); }}
											className="p-1 bg-cyan-600/80 rounded hover:bg-cyan-500"
											title="Unarchive"
										>
											<IconRestore className="w-3 h-3" />
										</button>
									)
								) : (
									<>
										{onArchive && (
											<button
												type="button"
												onClick={(e) => { e.stopPropagation(); onArchive(gen.id); }}
												className="p-1 bg-gray-800/80 rounded hover:bg-yellow-600/80"
												title="Archive"
											>
												<IconArchive className="w-3 h-3" />
											</button>
										)}
										{onTrash && (
											<button
												type="button"
												onClick={(e) => { e.stopPropagation(); onTrash(gen.id); }}
												className="p-1 bg-gray-800/80 rounded hover:bg-pink-600/80"
												title="Trash"
											>
												<IconTrash className="w-3 h-3" />
											</button>
										)}
									</>
								)}
							</div>
						</div>
					);
				})}

				{/* Uploads section - display after generations */}
				{!showTrash && uploads.map((upload) => (
						<div
							key={`upload-${upload.id}`}
							role="button"
							tabIndex={0}
							className="group relative aspect-square rounded overflow-hidden cyber-card cursor-pointer hover:neon-border transition-all"
							onClick={() => setSelectedUpload(upload)}
							onKeyDown={(e) => e.key === "Enter" && setSelectedUpload(upload)}
						>
							<img
								src={`${API_BASE}${upload.imageUrl}`}
								alt={upload.originalName}
								className="w-full h-full object-cover transition-transform group-hover:scale-105"
								loading="lazy"
							/>

							{/* Upload badge */}
							<div className="absolute top-1 left-1 px-1 py-0.5 bg-purple-600/80 rounded text-[10px]">
								Upload
							</div>

							{/* Add to inputs button */}
							{onAddToInputs && (
								<button
									type="button"
									onClick={(e) => { e.stopPropagation(); onAddToInputs(upload.imageUrl); }}
									className={`absolute bottom-1 left-1 p-1 rounded transition-all ${
										selectedInputUrls.includes(upload.imageUrl)
											? "bg-cyan-500 opacity-100"
											: "bg-gray-800/80 opacity-0 group-hover:opacity-100 hover:bg-cyan-600"
									}`}
									title={selectedInputUrls.includes(upload.imageUrl) ? "Remove from inputs" : "Add to inputs"}
								>
									{selectedInputUrls.includes(upload.imageUrl) ? (
										<IconCheck className="w-3 h-3" />
									) : (
										<IconPlus className="w-3 h-3" />
									)}
								</button>
							)}

							<div className="absolute inset-0 bg-gradient-to-t from-black/90 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-0">
								<div className="absolute bottom-0 left-0 right-0 p-1.5">
									<p className="text-[10px] text-white line-clamp-2">{upload.originalName}</p>
								</div>
							</div>

							{/* Action buttons */}
							<div className="absolute top-1 right-1 flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity z-10">
								{showArchived ? (
									onUnarchiveUpload && (
										<button
											type="button"
											onClick={(e) => { e.stopPropagation(); onUnarchiveUpload(upload.id); }}
											className="p-1 bg-cyan-600/80 rounded hover:bg-cyan-500"
											title="Unarchive"
										>
											<IconRestore className="w-3 h-3" />
										</button>
									)
								) : (
									<>
										{onArchiveUpload && (
											<button
												type="button"
												onClick={(e) => { e.stopPropagation(); onArchiveUpload(upload.id); }}
												className="p-1 bg-gray-800/80 rounded hover:bg-yellow-600/80"
												title="Archive"
											>
												<IconArchive className="w-3 h-3" />
											</button>
										)}
										{onDeleteUpload && (
											<button
												type="button"
												onClick={(e) => { e.stopPropagation(); onDeleteUpload(upload.id); }}
												className="p-1 bg-gray-800/80 rounded hover:bg-pink-600/80"
												title="Delete"
											>
												<IconTrash className="w-3 h-3" />
											</button>
										)}
									</>
								)}
							</div>
						</div>
					))}
			</div>

			{/* Infinite scroll sentinel */}
			{hasMore && (
				<div ref={sentinelRef} className="flex justify-center py-6 col-span-full">
					{loading && (
						<div className="flex items-center gap-2 text-[var(--text-secondary)]">
							<div className="w-4 h-4 border-2 border-[var(--accent)] border-t-transparent rounded-full animate-spin" />
							<span className="text-xs mono">Loading more...</span>
						</div>
					)}
				</div>
			)}

			{/* Lightbox Modal */}
			{selectedImage && (
				<div
					className="fixed inset-0 bg-black/90 z-50 overflow-y-auto"
					onClick={() => setSelectedImage(null)}
					onKeyDown={(e) => e.key === "Escape" && setSelectedImage(null)}
				>
					{/* Close button - fixed position */}
					<button
						type="button"
						onClick={() => setSelectedImage(null)}
						className="fixed top-4 right-4 z-[60] p-2 bg-gray-800/80 hover:bg-gray-700 rounded-full transition-colors"
						title="Close"
					>
						<IconClose className="w-6 h-6" />
					</button>
					<div className="min-h-full flex items-center justify-center p-4 py-12">
						<div
							className="max-w-4xl w-full bg-gray-900 rounded-lg overflow-hidden"
							onClick={(e) => e.stopPropagation()}
							onKeyDown={() => {}}
						>
							<img
								src={`${API_BASE}${selectedImage.imageUrl}`}
								alt={selectedImage.prompt}
								className={`w-full object-contain ${selectedImage.deletedAt ? "grayscale opacity-60" : ""}`}
							/>
							<div className="p-4">
								<p className="text-white mb-2">{selectedImage.prompt}</p>
								{selectedImage.deletedAt && (
									<p className="text-red-400 text-sm mb-2">
										In trash - deletes in {getTimeRemaining(selectedImage.deletedAt)}
									</p>
								)}
								<div className="flex items-center justify-between text-sm text-gray-400">
									<span>{selectedImage.model}</span>
									<span>{new Date(selectedImage.createdAt).toLocaleString()}</span>
								</div>
								<div className="flex flex-wrap gap-2 mt-4">
									<a
										href={`${API_BASE}${selectedImage.imageUrl}`}
										download
										className="px-4 py-2 cyber-button rounded-lg text-sm"
									>
										Download
									</a>
									{onAddToInputs && !selectedImage.deletedAt && (
										<button
											type="button"
											onClick={() => onAddToInputs(selectedImage.imageUrl || "")}
											className={`px-4 py-2 rounded-lg text-sm transition-colors ${
												selectedInputUrls.includes(selectedImage.imageUrl || "")
													? "bg-cyan-600 hover:bg-cyan-500"
													: "bg-gray-600 hover:bg-cyan-600"
											}`}
										>
											{selectedInputUrls.includes(selectedImage.imageUrl || "") ? "Added" : "Add to Inputs"}
										</button>
									)}
									{selectedImage.deletedAt ? (
										<>
											{onRestore && (
												<button
													type="button"
													onClick={() => {
														onRestore(selectedImage.id);
														setSelectedImage(null);
													}}
													className="px-4 py-2 bg-green-600 hover:bg-green-700 rounded-lg text-sm transition-colors"
												>
													Restore
												</button>
											)}
											{onDelete && (
												<button
													type="button"
													onClick={() => {
														onDelete(selectedImage.id);
														setSelectedImage(null);
													}}
													className="px-4 py-2 bg-red-600 hover:bg-red-700 rounded-lg text-sm transition-colors"
												>
													Delete Now
												</button>
											)}
										</>
									) : showArchived ? (
										onUnarchive && (
											<button
												type="button"
												onClick={() => {
													onUnarchive(selectedImage.id);
													setSelectedImage(null);
												}}
												className="px-4 py-2 bg-cyan-600 hover:bg-cyan-500 rounded-lg text-sm transition-colors"
											>
												Unarchive
											</button>
										)
									) : (
										<>
											{onArchive && (
												<button
													type="button"
													onClick={() => {
														onArchive(selectedImage.id);
														setSelectedImage(null);
													}}
													className="px-4 py-2 bg-yellow-600 hover:bg-yellow-500 rounded-lg text-sm transition-colors"
												>
													Archive
												</button>
											)}
											{onTrash && (
												<button
													type="button"
													onClick={() => {
														onTrash(selectedImage.id);
														setSelectedImage(null);
													}}
													className="px-4 py-2 bg-gray-600 hover:bg-gray-500 rounded-lg text-sm transition-colors"
												>
													Move to Trash
												</button>
											)}
										</>
									)}
								</div>
							</div>
						</div>
					</div>
				</div>
			)}

			{/* Upload Lightbox Modal */}
			{selectedUpload && (
				<div
					className="fixed inset-0 bg-black/90 z-50 overflow-y-auto"
					onClick={() => setSelectedUpload(null)}
					onKeyDown={(e) => e.key === "Escape" && setSelectedUpload(null)}
				>
					{/* Close button - fixed position */}
					<button
						type="button"
						onClick={() => setSelectedUpload(null)}
						className="fixed top-4 right-4 z-[60] p-2 bg-gray-800/80 hover:bg-gray-700 rounded-full transition-colors"
						title="Close"
					>
						<IconClose className="w-6 h-6" />
					</button>
					<div className="min-h-full flex items-center justify-center p-4 py-12">
						<div
							className="max-w-4xl w-full bg-gray-900 rounded-lg overflow-hidden"
							onClick={(e) => e.stopPropagation()}
							onKeyDown={() => {}}
						>
							<img
								src={`${API_BASE}${selectedUpload.imageUrl}`}
								alt={selectedUpload.originalName}
								className="w-full object-contain"
							/>
							<div className="p-4">
								<p className="text-white mb-2">{selectedUpload.originalName}</p>
								<div className="flex items-center justify-between text-sm text-gray-400 mb-4">
									<span className="px-2 py-0.5 bg-purple-600/40 rounded text-purple-300">Uploaded</span>
									{selectedUpload.createdAt && (
										<span>{new Date(selectedUpload.createdAt).toLocaleString()}</span>
									)}
								</div>
								<div className="flex flex-wrap gap-2">
									<a
										href={`${API_BASE}${selectedUpload.imageUrl}`}
										download
										className="px-4 py-2 cyber-button rounded-lg text-sm"
									>
										Download
									</a>
									{onAddToInputs && (
										<button
											type="button"
											onClick={() => onAddToInputs(selectedUpload.imageUrl)}
											className={`px-4 py-2 rounded-lg text-sm transition-colors ${
												selectedInputUrls.includes(selectedUpload.imageUrl)
													? "bg-cyan-600 hover:bg-cyan-500"
													: "bg-gray-600 hover:bg-cyan-600"
											}`}
										>
											{selectedInputUrls.includes(selectedUpload.imageUrl) ? "Added" : "Add to Inputs"}
										</button>
									)}
									{showArchived ? (
										onUnarchiveUpload && (
											<button
												type="button"
												onClick={() => {
													onUnarchiveUpload(selectedUpload.id);
													setSelectedUpload(null);
												}}
												className="px-4 py-2 bg-cyan-600 hover:bg-cyan-500 rounded-lg text-sm transition-colors"
											>
												Unarchive
											</button>
										)
									) : (
										<>
											{onArchiveUpload && (
												<button
													type="button"
													onClick={() => {
														onArchiveUpload(selectedUpload.id);
														setSelectedUpload(null);
													}}
													className="px-4 py-2 bg-yellow-600 hover:bg-yellow-500 rounded-lg text-sm transition-colors"
												>
													Archive
												</button>
											)}
											{onDeleteUpload && (
												<button
													type="button"
													onClick={() => {
														onDeleteUpload(selectedUpload.id);
														setSelectedUpload(null);
													}}
													className="px-4 py-2 bg-red-600 hover:bg-red-500 rounded-lg text-sm transition-colors"
												>
													Delete
												</button>
											)}
										</>
									)}
								</div>
							</div>
						</div>
					</div>
				</div>
			)}
		</>
	);
}
