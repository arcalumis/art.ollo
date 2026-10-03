import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { API_BASE } from "../../config";
import { fmtAgo, fmtInt, useAdminCall, useAdminQuery } from "./api";
import {
	DataTable,
	EmptyState,
	ErrorState,
	LoadingBlock,
	PageHeader,
	Panel,
	ReasonDialog,
	Td,
	Th,
	Thumb,
} from "./parts";

interface ModImage {
	id: string;
	prompt: string;
	model: string;
	imageUrl: string | null;
	width: number | null;
	height: number | null;
	createdAt: string | null;
	userId: string | null;
	username: string | null;
	removed: boolean;
	moderated: boolean;
	moderationReason: string | null;
}

interface ModerationData {
	total: number;
	page: number;
	limit: number;
	images: ModImage[];
	topUsers: Array<{ userId: string; username: string | null; images: number; last7: number }>;
}

const LIMIT = 48;
const src = (url: string) => (url.startsWith("http") ? url : `${API_BASE}${url}`);

export default function AdminModeration() {
	const call = useAdminCall();
	const [page, setPage] = useState(1);
	const { data, error, loading, reload } = useAdminQuery<ModerationData>(
		`/api/admin/moderation/images?page=${page}&limit=${LIMIT}`,
	);
	const [target, setTarget] = useState<ModImage | null>(null);
	const images = data?.images ?? [];
	const pages = data ? Math.max(1, Math.ceil(data.total / LIMIT)) : 1;

	return (
		<div className="flex flex-col gap-6">
			<PageHeader
				title="Moderation"
				description="Recent images from every account, newest first. Removing one moves it out of the owner's library and revokes its share links."
			/>
			{error && <ErrorState message={error} onRetry={reload} />}

			<div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_18rem]">
				<Panel
					title="Recent images"
					description={data ? `${fmtInt(data.total)} images` : undefined}
					actions={
						pages > 1 ? (
							<div className="flex items-center gap-2 text-xs tabular-nums text-muted-foreground">
								<Button
									size="sm"
									variant="outline"
									disabled={page <= 1}
									onClick={() => setPage((p) => p - 1)}
								>
									Previous
								</Button>
								<span>
									Page {page} of {pages}
								</span>
								<Button
									size="sm"
									variant="outline"
									disabled={page >= pages}
									onClick={() => setPage((p) => p + 1)}
								>
									Next
								</Button>
							</div>
						) : undefined
					}
				>
					{loading && !data ? (
						<LoadingBlock rows={6} />
					) : images.length === 0 ? (
						<EmptyState title="No images yet">
							Every image people make appears here, newest first, so you can review and remove it.
						</EmptyState>
					) : (
						<ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-6">
							{images.map((img) => (
								<li key={img.id} className="flex min-w-0 flex-col gap-1.5">
									<div className="relative overflow-hidden rounded-xl bg-muted">
										{img.imageUrl ? (
											<Thumb
												src={src(img.imageUrl)}
												alt={img.prompt.slice(0, 120)}
												title={img.prompt}
												className="aspect-square w-full object-cover"
											/>
										) : (
											<div className="grid aspect-square place-items-center text-xs text-muted-foreground">
												No file
											</div>
										)}
										{img.moderated && (
											<Badge variant="destructive" className="absolute top-2 left-2">
												Removed
											</Badge>
										)}
									</div>
									<div className="flex items-start justify-between gap-1">
										<div className="min-w-0 text-xs">
											{img.userId ? (
												<Link
													to={`/admin/users/${img.userId}`}
													className="block truncate font-medium text-foreground hover:underline"
												>
													{img.username ?? "Unknown user"}
												</Link>
											) : (
												<span className="block truncate text-muted-foreground">No owner</span>
											)}
											<span className="text-muted-foreground">{fmtAgo(img.createdAt)}</span>
										</div>
										{!img.moderated && (
											<Button
												size="sm"
												variant="ghost"
												className="text-destructive"
												onClick={() => setTarget(img)}
											>
												Remove
											</Button>
										)}
									</div>
								</li>
							))}
						</ul>
					)}
				</Panel>

				<Panel title="Top users, last 30 days" bodyClassName="pt-0 pb-0">
					{!data ? (
						<div className="py-4">
							<LoadingBlock rows={3} />
						</div>
					) : data.topUsers.length === 0 ? (
						<EmptyState title="Nobody generated this month">
							The ten busiest accounts of the last 30 days appear here.
						</EmptyState>
					) : (
						<DataTable className="min-w-0">
							<thead>
								<tr>
									<Th>User</Th>
									<Th right>30 days</Th>
									<Th right>7 days</Th>
								</tr>
							</thead>
							<tbody>
								{data.topUsers.map((u) => (
									<tr key={u.userId}>
										<Td>
											<Link to={`/admin/users/${u.userId}`} className="hover:underline">
												{u.username ?? "Unknown user"}
											</Link>
										</Td>
										<Td num>{fmtInt(u.images)}</Td>
										<Td num>{fmtInt(u.last7)}</Td>
									</tr>
								))}
							</tbody>
						</DataTable>
					)}
				</Panel>
			</div>

			<ReasonDialog
				open={target !== null}
				onOpenChange={(open) => !open && setTarget(null)}
				title="Remove this image?"
				description="It leaves the owner's library and its public share links stop working. The record is kept."
				confirmLabel="Remove image"
				destructive
				onConfirm={async (reason) => {
					if (!target) return null;
					const res = await call("POST", `/api/admin/moderation/images/${target.id}/remove`, {
						reason,
					});
					if (!res.ok) return res.data.error ?? "Couldn't remove the image.";
					toast.success("Image removed");
					void reload();
					return null;
				}}
			>
				{target?.imageUrl && (
					<Thumb
						src={src(target.imageUrl)}
						alt=""
						className="max-h-48 w-full rounded-xl object-contain"
					/>
				)}
			</ReasonDialog>
		</div>
	);
}
