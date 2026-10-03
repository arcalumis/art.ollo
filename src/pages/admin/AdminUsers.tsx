import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { PlusIcon, SearchIcon } from "lucide-react";
import { type FormEvent, useEffect, useId, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { type PlanSource, fmtAgo, fmtDate, fmtInt, useAdminCall, useAdminQuery } from "./api";
import {
	DataTable,
	EmptyState,
	ErrorState,
	FilterSelect,
	LoadingBlock,
	PageHeader,
	Panel,
	SourceBadge,
	Td,
	Th,
} from "./parts";

interface UserRow {
	id: string;
	username: string;
	email: string | null;
	hasWallet: boolean;
	isAdmin: boolean;
	isActive: boolean;
	deleted: boolean;
	createdAt: string | null;
	lastLogin: string | null;
	lastGeneration: string | null;
	balance: number;
	generations: number;
	plan: string;
	planSource: PlanSource;
	pastDue: boolean;
}

interface Response {
	users: UserRow[];
	total: number;
	page: number;
	totalPages: number;
}

function CreateUserDialog({
	open,
	onOpenChange,
}: { open: boolean; onOpenChange: (o: boolean) => void }) {
	const id = useId();
	const call = useAdminCall();
	const navigate = useNavigate();
	const [username, setUsername] = useState("");
	const [email, setEmail] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	const submit = async (e: FormEvent) => {
		e.preventDefault();
		setBusy(true);
		const res = await call<{ id: string; linkSent: boolean; linkError?: string }>(
			"POST",
			"/api/admin/users",
			{
				username: username.trim(),
				email: email.trim(),
				sendLink: true,
			},
		);
		setBusy(false);
		if (!res.ok) {
			setError(res.data.error ?? "The account couldn't be created.");
			return;
		}
		toast.success(
			res.data.linkSent
				? `Account created. Sign-in link sent to ${email.trim()}.`
				: "Account created.",
			{
				description: res.data.linkSent ? undefined : res.data.linkError,
			},
		);
		onOpenChange(false);
		setUsername("");
		setEmail("");
		navigate(`/admin/users/${res.data.id}`);
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-md">
				<form onSubmit={submit} className="grid gap-4">
					<DialogHeader>
						<DialogTitle>Create an account</DialogTitle>
						<DialogDescription>
							They get the Free plan and an email with a sign-in link. No password is set or shown.
						</DialogDescription>
					</DialogHeader>
					<div className="grid gap-1.5">
						<label htmlFor={`${id}-u`} className="text-sm font-medium">
							Username
						</label>
						<Input
							id={`${id}-u`}
							value={username}
							onChange={(e) => setUsername(e.target.value)}
							required
							maxLength={50}
						/>
					</div>
					<div className="grid gap-1.5">
						<label htmlFor={`${id}-e`} className="text-sm font-medium">
							Email
						</label>
						<Input
							id={`${id}-e`}
							type="email"
							value={email}
							onChange={(e) => setEmail(e.target.value)}
							required
						/>
					</div>
					{error && (
						<p role="alert" className="text-sm text-destructive">
							{error}
						</p>
					)}
					<DialogFooter>
						<Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
							Cancel
						</Button>
						<Button
							type="submit"
							variant="outline"
							disabled={busy || !username.trim() || !email.trim()}
						>
							{busy ? "Creating…" : "Create and send link"}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

export default function AdminUsers() {
	const [params, setParams] = useSearchParams();
	const q = params.get("q") ?? "";
	const filter = params.get("filter") ?? "";
	const page = Math.max(1, Number(params.get("page") ?? "1") || 1);
	const [draft, setDraft] = useState(q);
	const [creating, setCreating] = useState(false);

	const update = (changes: Record<string, string>) => {
		const next = new URLSearchParams(params);
		for (const [k, v] of Object.entries(changes)) {
			if (v) next.set(k, v);
			else next.delete(k);
		}
		setParams(next, { replace: true });
	};

	// Search as you type, once typing pauses.
	// biome-ignore lint/correctness/useExhaustiveDependencies: only the draft drives this
	useEffect(() => {
		if (draft.trim() === q) return;
		const t = setTimeout(() => update({ q: draft.trim(), page: "" }), 300);
		return () => clearTimeout(t);
	}, [draft]);

	const qs = new URLSearchParams({ page: String(page), limit: "25" });
	if (q) qs.set("search", q);
	if (filter) qs.set("filter", filter);
	const { data, error, loading, reload } = useAdminQuery<Response>(`/api/admin/users?${qs}`);

	return (
		<div>
			<PageHeader
				title="Users"
				description="Find an account to see its credits, images, payments and plan history."
				actions={
					<Button variant="outline" onClick={() => setCreating(true)}>
						<PlusIcon />
						Create account
					</Button>
				}
			/>
			<CreateUserDialog open={creating} onOpenChange={setCreating} />
			{error && <ErrorState message={error} onRetry={reload} />}
			<Panel
				bodyClassName="pt-0"
				title={
					data ? `${fmtInt(data.total)} ${data.total === 1 ? "account" : "accounts"}` : "Accounts"
				}
				actions={
					<form
						className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row"
						onSubmit={(e) => {
							e.preventDefault();
							update({ q: draft.trim(), page: "" });
						}}
					>
						<div className="relative">
							<SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
							<Input
								type="search"
								value={draft}
								onChange={(e) => setDraft(e.target.value)}
								placeholder="Username, email or wallet"
								aria-label="Search users"
								className="pl-9 sm:w-72"
							/>
						</div>
						<FilterSelect
							label="Accounts"
							value={filter}
							options={[
								{ value: "admins", label: "Admins" },
								{ value: "inactive", label: "Deactivated" },
							]}
							onChange={(v) => update({ filter: v, page: "" })}
						/>
					</form>
				}
			>
				{loading && !data && <LoadingBlock />}
				{data && data.users.length === 0 && (
					<EmptyState title={q ? `No accounts match "${q}"` : "No accounts yet"}>
						{q
							? "Search matches part of a username, email or wallet address."
							: "Accounts appear here as people sign up."}
					</EmptyState>
				)}
				{data && data.users.length > 0 && (
					<>
						<DataTable className="min-w-[52rem]">
							<thead>
								<tr>
									<Th>User</Th>
									<Th>Plan</Th>
									<Th right>Credits</Th>
									<Th right>Images</Th>
									<Th>Last image</Th>
									<Th>Joined</Th>
								</tr>
							</thead>
							<tbody>
								{data.users.map((u) => (
									<tr key={u.id}>
										<Td>
											<div className="flex flex-wrap items-center gap-1.5">
												<Link
													to={`/admin/users/${u.id}`}
													className="font-medium underline-offset-4 hover:underline"
												>
													{u.username}
												</Link>
												{u.isAdmin && <Badge variant="outline">Admin</Badge>}
												{!u.isActive && (
													<Badge variant="destructive">
														{u.deleted ? "Deleted" : "Deactivated"}
													</Badge>
												)}
											</div>
											<div className="text-xs text-muted-foreground">
												{u.email ?? (u.hasWallet ? "Wallet sign-in" : "No email")}
											</div>
										</Td>
										<Td>
											<div className="flex flex-wrap items-center gap-1.5">
												{u.plan}
												{u.planSource !== "free" && <SourceBadge source={u.planSource} />}
												{u.pastDue && <Badge variant="destructive">Past due</Badge>}
											</div>
										</Td>
										<Td num>{fmtInt(u.balance)}</Td>
										<Td num>{fmtInt(u.generations)}</Td>
										<Td className="whitespace-nowrap text-muted-foreground">
											{fmtAgo(u.lastGeneration)}
										</Td>
										<Td className="whitespace-nowrap tabular-nums">{fmtDate(u.createdAt)}</Td>
									</tr>
								))}
							</tbody>
						</DataTable>
						{data.totalPages > 1 && (
							<div className="flex items-center justify-between pt-4 text-sm text-muted-foreground">
								<span>
									Page {data.page} of {data.totalPages}
								</span>
								<div className="flex gap-2">
									<Button
										variant="outline"
										size="sm"
										disabled={page <= 1}
										onClick={() => update({ page: String(page - 1) })}
									>
										Previous
									</Button>
									<Button
										variant="outline"
										size="sm"
										disabled={page >= data.totalPages}
										onClick={() => update({ page: String(page + 1) })}
									>
										Next
									</Button>
								</div>
							</div>
						)}
					</>
				)}
			</Panel>
		</div>
	);
}
