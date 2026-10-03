import { formatUsd, refillCadence } from "@/components/billing/plans";
import { Button, buttonVariants } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { SolanaBoundary } from "@/components/solana/SolanaBoundary";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/contexts/AuthContext";
import { type Finish, useTheme } from "@/contexts/ThemeContext";
import { useUserSubscription, useUserUsage } from "@/hooks/useUserSettings";
import { cn } from "@/lib/utils";
import { ArrowLeftIcon, DownloadIcon } from "lucide-react";
import {
	type FormEvent,
	type ReactNode,
	lazy,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { Link, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { API_BASE } from "../config";

const WalletReauth = lazy(() => import("@/components/solana/WalletReauth"));

interface Account {
	username: string;
	email: string | null;
	pendingEmail: string | null;
	hasPassword: boolean;
	hasWallet: boolean;
	isAdmin: boolean;
	createdAt: string | null;
}

interface ApiResult<T> {
	ok: boolean;
	status: number;
	data: T & { error?: string; code?: string };
}

async function call<T = Record<string, unknown>>(
	token: string | null,
	method: string,
	path: string,
	body?: unknown,
): Promise<ApiResult<T>> {
	try {
		const res = await fetch(`${API_BASE}${path}`, {
			method,
			headers: {
				...(token ? { Authorization: `Bearer ${token}` } : {}),
				...(body ? { "Content-Type": "application/json" } : {}),
			},
			body: body ? JSON.stringify(body) : undefined,
		});
		const data = (await res.json().catch(() => ({}))) as ApiResult<T>["data"];
		return { ok: res.ok, status: res.status, data };
	} catch {
		return {
			ok: false,
			status: 0,
			data: { error: "Couldn't reach ollo. Check your connection." } as ApiResult<T>["data"],
		};
	}
}

const errorText = (r: ApiResult<unknown>, fallback: string) =>
	r.status === 429 && !r.data.code
		? "Too many tries. Wait a minute and try again."
		: (r.data.error ?? fallback);

/** A settings section: what it is on the left (above on phones), the controls on the right. */
function Section({
	id,
	title,
	hint,
	children,
}: { id: string; title: string; hint?: ReactNode; children: ReactNode }) {
	return (
		<section
			aria-labelledby={id}
			className="grid gap-4 border-t border-border py-7 md:grid-cols-[15rem_minmax(0,1fr)] md:gap-10"
		>
			<div className="flex flex-col gap-1">
				<h2 id={id} className="text-base font-semibold text-foreground">
					{title}
				</h2>
				{hint && <p className="text-sm text-muted-foreground">{hint}</p>}
			</div>
			<div className="flex min-w-0 flex-col gap-3">{children}</div>
		</section>
	);
}

function Field({
	label,
	children,
	help,
}: { label: string; children: ReactNode; help?: ReactNode }) {
	return (
		// biome-ignore lint/a11y/noLabelWithoutControl: the control is passed as children
		<label className="flex max-w-md flex-col gap-1.5">
			<span className="text-sm font-medium text-foreground">{label}</span>
			{children}
			{help && <span className="text-xs text-muted-foreground">{help}</span>}
		</label>
	);
}

const FINISHES: { value: Finish; label: string; hint: string }[] = [
	{ value: "system", label: "Match system", hint: "Follows your device" },
	{ value: "night", label: "Night", hint: "Dark slate" },
	{ value: "plaster", label: "Plaster", hint: "Light stone" },
];

const PASSWORD_SAVED_FLAG = "ollo:password-saved";

// ---- "Confirm it's you" (recent re-authentication) ----
//
// Changing the email or password needs a short-lived sudo token from the server. It lives in
// localStorage so a link opened in another tab (from the email) finishes the step here too.

type ReauthMethod = "password" | "email" | "wallet";
const SUDO_KEY = "ollo:sudo";

function readSudo(): string | null {
	try {
		const raw = localStorage.getItem(SUDO_KEY);
		if (!raw) return null;
		const { token, expiresAt } = JSON.parse(raw) as { token: string; expiresAt: number };
		if (typeof token !== "string" || !(expiresAt > Date.now())) {
			localStorage.removeItem(SUDO_KEY);
			return null;
		}
		return token;
	} catch {
		return null;
	}
}

function saveSudo(token: string, expiresInSeconds: number): void {
	try {
		// A little early, so we never send one the server is about to reject.
		const expiresAt = Date.now() + Math.max(0, expiresInSeconds - 30) * 1000;
		localStorage.setItem(SUDO_KEY, JSON.stringify({ token, expiresAt }));
	} catch {
		// storage blocked: the caller still has the token in memory
	}
}

export function clearSudo(): void {
	try {
		localStorage.removeItem(SUDO_KEY);
	} catch {
		// nothing stored
	}
}

interface SudoGrant {
	sudoToken: string;
	expiresInSeconds: number;
}

function ReauthDialog({
	open,
	onOpenChange,
	methods,
	email,
	token,
	onConfirmed,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	methods: ReauthMethod[];
	email: string | null;
	token: string | null;
	onConfirmed: (sudoToken: string) => void;
}) {
	const [password, setPassword] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [linkSentTo, setLinkSentTo] = useState<string | null>(null);

	useEffect(() => {
		if (open) {
			setPassword("");
			setError(null);
			setLinkSentTo(null);
		}
	}, [open]);

	const finish = (grant: SudoGrant) => {
		saveSudo(grant.sudoToken, grant.expiresInSeconds);
		onConfirmed(grant.sudoToken);
	};

	const confirmPassword = async (e: FormEvent) => {
		e.preventDefault();
		setError(null);
		setBusy(true);
		const r = await call<SudoGrant>(token, "POST", "/api/account/reauth", { method: "password", password });
		setBusy(false);
		if (!r.ok) return setError(errorText(r, "Couldn't check your password."));
		finish(r.data);
	};

	const sendLink = async () => {
		setError(null);
		setBusy(true);
		const r = await call<{ email: string }>(token, "POST", "/api/account/reauth", { method: "email" });
		setBusy(false);
		if (!r.ok) return setError(errorText(r, "Couldn't send the link."));
		setLinkSentTo(r.data.email);
	};

	const confirmWallet = async (proof: { challenge: string; signature: string }) => {
		const r = await call<SudoGrant>(token, "POST", "/api/account/reauth", { method: "wallet", ...proof });
		if (!r.ok) return errorText(r, "Couldn't check the signature.");
		finish(r.data);
		return null;
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle className="font-sans text-lg font-semibold">Confirm it's you</DialogTitle>
					<DialogDescription>
						Changing your email or password needs a fresh check, so nobody using a lost or shared
						device can take over your account.
					</DialogDescription>
				</DialogHeader>
				<div className="flex flex-col gap-5">
					{methods.includes("password") && (
						<form onSubmit={confirmPassword} className="flex flex-col gap-3">
							<Field label="Current password">
								<Input
									type="password"
									autoComplete="current-password"
									value={password}
									onChange={(e) => setPassword(e.target.value)}
									className="h-10"
									required
								/>
							</Field>
							<div>
								<Button type="submit" disabled={busy || !password}>
									{busy ? "Checking…" : "Confirm"}
								</Button>
							</div>
						</form>
					)}
					{methods.includes("email") &&
						(linkSentTo ? (
							<p aria-live="polite" className="rounded-lg border border-border bg-muted px-3 py-2 text-sm">
								We sent a link to <span className="font-medium">{linkSentTo}</span>. Open it on this
								device and this step finishes on its own. The link expires in 15 minutes.
							</p>
						) : (
							<div className="flex flex-col gap-2">
								<p className="text-sm text-muted-foreground">
									{methods.includes("password") ? "Or get" : "Get"} a link at{" "}
									<span className="font-medium text-foreground">{email}</span>.
								</p>
								<div>
									<Button type="button" variant="outline" onClick={sendLink} disabled={busy}>
										{busy ? "Sending…" : "Email me a link"}
									</Button>
								</div>
							</div>
						))}
					{methods.includes("wallet") && (
						<SolanaBoundary fallback={<Skeleton className="h-10 max-w-xs" />}>
							<WalletReauth onSigned={confirmWallet} />
						</SolanaBoundary>
					)}
					{methods.length === 0 && (
						<p className="text-sm text-muted-foreground">
							This account has no password, email or wallet to confirm with. Write to
							support@matahari.dev and we'll help.
						</p>
					)}
					{error && (
						<p role="alert" className="text-sm text-destructive">
							{error}
						</p>
					)}
				</div>
				<DialogFooter>
					<Button variant="outline" onClick={() => onOpenChange(false)}>
						Cancel
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

/**
 * Account settings: profile, email, password, appearance, plan, export and delete.
 * Used by the /settings page and by the settings sheet (UserSettings).
 */
export function AccountSettings({ onNavigateAway }: { onNavigateAway?: () => void }) {
	const { token, user, logout, updateUser } = useAuth();
	const navigate = useNavigate();
	const { finish, setFinish } = useTheme();
	const { subscription, fetchSubscription } = useUserSubscription(token);
	const { usage, fetchUsage } = useUserUsage(token);
	const [account, setAccount] = useState<Account | null>(null);
	const [loadFailed, setLoadFailed] = useState(false);

	const [username, setUsername] = useState("");
	const [usernameError, setUsernameError] = useState<string | null>(null);
	const [newEmail, setNewEmail] = useState("");
	const [emailError, setEmailError] = useState<string | null>(null);
	const [currentPassword, setCurrentPassword] = useState("");
	const [newPassword, setNewPassword] = useState("");
	const [passwordError, setPasswordError] = useState<string | null>(null);
	const [busy, setBusy] = useState<string | null>(null);
	const [deleteOpen, setDeleteOpen] = useState(false);
	const [deleteConfirm, setDeleteConfirm] = useState("");
	const [deleteError, setDeleteError] = useState<string | null>(null);
	const [reauthMethods, setReauthMethods] = useState<ReauthMethod[] | null>(null);
	// The change to retry once the user has confirmed it's them.
	const pendingChange = useRef<((sudoToken: string) => void) | null>(null);

	const loadAccount = useCallback(async () => {
		if (!token) return;
		const r = await call<Account>(token, "GET", "/api/account");
		if (r.ok) {
			setAccount(r.data);
			setUsername(r.data.username);
			setLoadFailed(false);
		} else setLoadFailed(true);
	}, [token]);

	useEffect(() => {
		loadAccount();
		fetchSubscription();
		fetchUsage();
	}, [loadAccount, fetchSubscription, fetchUsage]);

	// After a password change the page reloads with the new session; say it worked.
	useEffect(() => {
		try {
			if (sessionStorage.getItem(PASSWORD_SAVED_FLAG)) {
				sessionStorage.removeItem(PASSWORD_SAVED_FLAG);
				toast.success("Password saved. Other devices were signed out.");
			}
		} catch {
			// storage blocked: nothing to show
		}
	}, []);

	const saveUsername = async (e: FormEvent) => {
		e.preventDefault();
		setUsernameError(null);
		const next = username.trim();
		if (!account || next === account.username) return;
		setBusy("username");
		const r = await call<{ username: string }>(token, "PATCH", "/api/account/profile", {
			username: next,
		});
		setBusy(null);
		if (!r.ok) return setUsernameError(errorText(r, "Couldn't save your username."));
		setAccount({ ...account, username: r.data.username });
		updateUser({ username: r.data.username });
		toast.success("Username saved");
	};

	/** True (and opens "Confirm it's you") when the server wants a fresh check first. */
	const needsReauth = (
		r: ApiResult<{ methods?: ReauthMethod[] }>,
		retry: (sudoToken: string) => void,
	): boolean => {
		if (r.status !== 403 || r.data.code !== "REAUTH_REQUIRED") return false;
		clearSudo();
		pendingChange.current = retry;
		setReauthMethods(r.data.methods ?? []);
		return true;
	};

	const onReauthConfirmed = useCallback((sudoToken: string) => {
		setReauthMethods(null);
		const retry = pendingChange.current;
		pendingChange.current = null;
		retry?.(sudoToken);
	}, []);

	// The link from the email may be opened in another tab; pick up its confirmation here.
	useEffect(() => {
		if (!reauthMethods) return;
		const onStorage = (e: StorageEvent) => {
			if (e.key !== SUDO_KEY) return;
			const sudo = readSudo();
			if (sudo) onReauthConfirmed(sudo);
		};
		window.addEventListener("storage", onStorage);
		return () => window.removeEventListener("storage", onStorage);
	}, [reauthMethods, onReauthConfirmed]);

	const sendEmailLink = async (e?: FormEvent, sudoToken = readSudo()) => {
		e?.preventDefault();
		setEmailError(null);
		setBusy("email");
		const r = await call<{ pendingEmail: string; methods?: ReauthMethod[] }>(
			token,
			"POST",
			"/api/account/email",
			{ email: newEmail, sudoToken: sudoToken ?? undefined },
		);
		setBusy(null);
		if (needsReauth(r, (sudo) => void sendEmailLink(undefined, sudo))) return;
		if (!r.ok) return setEmailError(errorText(r, "Couldn't send the link."));
		setAccount((a) => (a ? { ...a, pendingEmail: r.data.pendingEmail } : a));
		setNewEmail("");
		toast.success(`Link sent to ${r.data.pendingEmail}`, {
			description: "Open it from that inbox to switch. Your current email works until then.",
		});
	};

	const savePassword = async (e?: FormEvent, sudoToken = readSudo()) => {
		e?.preventDefault();
		setPasswordError(null);
		setBusy("password");
		const r = await call<{ token: string; methods?: ReauthMethod[] }>(
			token,
			"PUT",
			"/api/account/password",
			{
				currentPassword: account?.hasPassword ? currentPassword : undefined,
				sudoToken: sudoToken ?? undefined,
				newPassword,
			},
		);
		setBusy(null);
		if (needsReauth(r, (sudo) => void savePassword(undefined, sudo))) return;
		if (!r.ok) return setPasswordError(errorText(r, "Couldn't save your password."));
		clearSudo();
		// Every session was revoked, this one included: continue with the fresh token.
		try {
			localStorage.setItem("token", r.data.token);
			sessionStorage.setItem(PASSWORD_SAVED_FLAG, "1");
		} catch {
			// storage blocked: the reload below will ask to sign in again
		}
		window.location.reload();
	};

	const exportData = async () => {
		if (!token) return;
		setBusy("export");
		try {
			const res = await fetch(`${API_BASE}/api/account/export`, {
				headers: { Authorization: `Bearer ${token}` },
			});
			if (!res.ok) throw new Error(String(res.status));
			const blob = await res.blob();
			const name =
				res.headers.get("Content-Disposition")?.match(/filename="([^"]+)"/)?.[1] ??
				"ollo-export.json";
			const url = URL.createObjectURL(blob);
			const a = document.createElement("a");
			a.href = url;
			a.download = name;
			a.click();
			setTimeout(() => URL.revokeObjectURL(url), 10_000);
			toast.success("Your data is downloading");
		} catch {
			toast.error("Couldn't prepare your export. Try again in a minute.");
		} finally {
			setBusy(null);
		}
	};

	const deleteAccount = async () => {
		setDeleteError(null);
		setBusy("delete");
		const r = await call(token, "POST", "/api/account/delete", { confirm: deleteConfirm.trim() });
		setBusy(null);
		if (!r.ok) return setDeleteError(errorText(r, "Couldn't delete your account."));
		setDeleteOpen(false);
		onNavigateAway?.();
		logout();
		navigate("/", { replace: true });
		toast("Your account was deleted", {
			description: "Your images will be removed within the hour.",
		});
	};

	const plan = subscription?.subscription ?? null;
	const balance = usage?.availableCredits ?? null;
	const refillAmount = plan?.creditRefillAmount ?? usage?.creditRefillAmount ?? 0;

	if (loadFailed) {
		return (
			<div className="flex flex-col items-start gap-3 border-t border-border py-8">
				<p className="text-sm text-muted-foreground">Couldn't load your account.</p>
				<Button variant="outline" onClick={loadAccount}>
					Try again
				</Button>
			</div>
		);
	}

	if (!account) {
		return (
			<div className="flex flex-col gap-6 border-t border-border py-8">
				<Skeleton className="h-10 max-w-md" />
				<Skeleton className="h-10 max-w-md" />
				<Skeleton className="h-24 max-w-md" />
			</div>
		);
	}

	const passwordForm = (
		<form onSubmit={savePassword} className="flex flex-col gap-3">
			{account.hasPassword && (
				<Field label="Current password">
					<Input
						type="password"
						autoComplete="current-password"
						value={currentPassword}
						onChange={(e) => setCurrentPassword(e.target.value)}
						className="h-10"
						required
					/>
				</Field>
			)}
			<Field
				label={account.hasPassword ? "New password" : "Password"}
				help="At least 8 characters, with an uppercase letter, a lowercase letter and a number."
			>
				<Input
					type="password"
					autoComplete="new-password"
					value={newPassword}
					onChange={(e) => setNewPassword(e.target.value)}
					className="h-10"
					aria-invalid={!!passwordError}
					required
					minLength={8}
				/>
			</Field>
			{passwordError && (
				<p role="alert" className="text-sm text-destructive">
					{passwordError}
				</p>
			)}
			<div>
				<Button type="submit" variant="outline" disabled={busy === "password" || !newPassword}>
					{busy === "password"
						? "Saving…"
						: account.hasPassword
							? "Change password"
							: "Add password"}
				</Button>
			</div>
		</form>
	);

	return (
		<div className="flex flex-col">
			<Section
				id="profile-title"
				title="Profile"
				hint="Your username appears in the sidebar and on receipts."
			>
				<form onSubmit={saveUsername} className="flex flex-col gap-3">
					<Field label="Username">
						<Input
							value={username}
							onChange={(e) => setUsername(e.target.value)}
							autoComplete="username"
							className="h-10"
							aria-invalid={!!usernameError}
							maxLength={30}
						/>
					</Field>
					{usernameError && (
						<p role="alert" className="text-sm text-destructive">
							{usernameError}
						</p>
					)}
					<div>
						<Button
							type="submit"
							variant="outline"
							disabled={
								busy === "username" || username.trim() === account.username || !username.trim()
							}
						>
							{busy === "username" ? "Saving…" : "Save username"}
						</Button>
					</div>
				</form>
			</Section>

			<Section
				id="email-title"
				title="Email"
				hint="Sign-in links, receipts and account notices go here. Changing it asks you to confirm it's you, and signs you out on other devices."
			>
				<p className="text-sm text-foreground">
					{account.email ? (
						<>
							Signed in as <span className="font-medium">{account.email}</span>
						</>
					) : (
						"No email on this account yet."
					)}
				</p>
				{account.pendingEmail && (
					<p className="max-w-md rounded-lg border border-border bg-muted px-3 py-2 text-sm text-foreground">
						We sent a confirmation link to{" "}
						<span className="font-medium">{account.pendingEmail}</span>. Open it to switch. Until
						then, your current email stays in place.
					</p>
				)}
				<form onSubmit={sendEmailLink} className="flex flex-col gap-3">
					<Field label={account.email ? "New email" : "Email"}>
						<Input
							type="email"
							autoComplete="email"
							value={newEmail}
							onChange={(e) => setNewEmail(e.target.value)}
							className="h-10"
							aria-invalid={!!emailError}
							required
						/>
					</Field>
					{emailError && (
						<p role="alert" className="text-sm text-destructive">
							{emailError}
						</p>
					)}
					<div>
						<Button type="submit" variant="outline" disabled={busy === "email" || !newEmail.trim()}>
							{busy === "email" ? "Sending…" : "Send confirmation link"}
						</Button>
					</div>
				</form>
			</Section>

			<Section
				id="password-title"
				title="Password"
				hint={
					account.hasPassword
						? "Changing it signs you out everywhere else."
						: "You sign in with an email link. A password is optional, for when email is slow. Adding one asks you to confirm it's you first."
				}
			>
				{passwordForm}
			</Section>

			<Section
				id="sessions-title"
				title="Sessions"
				hint="Lost a device or signed in somewhere shared? End every session, this one included."
			>
				<div>
					<Button
						variant="outline"
						onClick={() => {
							onNavigateAway?.();
							navigate("/", { replace: true });
							logout({ everywhere: true });
							toast("Signed out everywhere", {
								description: "Every device needs to sign in again.",
							});
						}}
					>
						Sign out everywhere
					</Button>
				</div>
			</Section>

			<Section
				id="appearance-title"
				title="Appearance"
				hint="Night and Plaster are two finishes of the same ollo."
			>
				<fieldset className="m-0 grid max-w-md grid-cols-3 gap-2 border-0 p-0">
					<legend className="sr-only">Appearance</legend>
					{FINISHES.map((f) => (
						<label
							key={f.value}
							className={cn(
								"flex min-h-14 cursor-pointer flex-col items-start justify-center gap-0.5 rounded-lg border px-3 py-2 has-focus-visible:ring-3 has-focus-visible:ring-ring/50",
								finish === f.value
									? "border-verdigris bg-muted"
									: "border-border hover:border-foreground/30",
							)}
						>
							<input
								type="radio"
								name="finish"
								value={f.value}
								checked={finish === f.value}
								onChange={() => setFinish(f.value)}
								className="sr-only"
							/>
							<span className="text-sm font-medium text-foreground">{f.label}</span>
							<span className="text-xs text-muted-foreground">{f.hint}</span>
						</label>
					))}
				</fieldset>
			</Section>

			<Section
				id="plan-title"
				title="Plan and credits"
				hint="Change plans, buy credits and see receipts on Billing."
			>
				<dl className="grid max-w-md grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
					<dt className="text-muted-foreground">Plan</dt>
					<dd className="m-0 text-foreground">
						{plan?.name ?? "Free"}
						{plan && plan.price > 0 ? (
							<span className="text-muted-foreground">, {formatUsd(plan.price)} a month</span>
						) : null}
					</dd>
					<dt className="text-muted-foreground">Balance</dt>
					<dd className="m-0 text-foreground tabular-nums">
						{balance === null ? "–" : `${balance} credits`}
					</dd>
					<dt className="text-muted-foreground">Top-up</dt>
					<dd className="m-0 text-foreground">
						{refillAmount > 0
							? `Up to ${refillAmount} credits ${refillCadence(plan?.topoffIntervalHours)}`
							: "None"}
					</dd>
				</dl>
				<div>
					<Link
						to="/billing"
						onClick={onNavigateAway}
						className={cn(buttonVariants({ variant: "outline" }))}
					>
						Billing and credits
					</Link>
				</div>
			</Section>

			<Section
				id="export-title"
				title="Export my data"
				hint="A JSON file with every prompt, the links to its images, your uploads and your credit history."
			>
				<div>
					<Button variant="outline" onClick={exportData} disabled={busy === "export"}>
						<DownloadIcon />
						{busy === "export" ? "Preparing…" : "Download my data"}
					</Button>
				</div>
			</Section>

			<Section id="delete-title" title="Delete account" hint="This can't be undone.">
				<p className="max-w-md text-sm text-muted-foreground">
					Your plan is canceled with no further charges, you're signed out everywhere, and your
					images, uploads and share links are removed. Unused credits are lost.
				</p>
				<div>
					<Button
						variant="destructive"
						onClick={() => {
							setDeleteConfirm("");
							setDeleteError(null);
							setDeleteOpen(true);
						}}
						disabled={account.isAdmin}
					>
						Delete account
					</Button>
					{account.isAdmin && (
						<p className="mt-2 text-xs text-muted-foreground">
							Admin accounts can't be deleted here.
						</p>
					)}
				</div>
			</Section>

			<ReauthDialog
				open={reauthMethods !== null}
				onOpenChange={(open) => {
					if (!open) {
						setReauthMethods(null);
						pendingChange.current = null;
					}
				}}
				methods={reauthMethods ?? []}
				email={account.email}
				token={token}
				onConfirmed={onReauthConfirmed}
			/>

			<Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
				<DialogContent className="sm:max-w-md">
					<DialogHeader>
						<DialogTitle className="font-sans text-lg font-semibold">
							Delete your account?
						</DialogTitle>
						<DialogDescription>
							Your subscription is canceled, every image is deleted and this can't be undone. Type{" "}
							<span className="font-medium text-foreground">{account.username}</span> to confirm.
						</DialogDescription>
					</DialogHeader>
					<form
						id="delete-account-form"
						onSubmit={(e) => {
							e.preventDefault();
							void deleteAccount();
						}}
						className="flex flex-col gap-2"
					>
						<Input
							value={deleteConfirm}
							onChange={(e) => setDeleteConfirm(e.target.value)}
							aria-label="Your username"
							autoComplete="off"
							autoCapitalize="off"
							spellCheck={false}
							className="h-10"
						/>
						{deleteError && (
							<p role="alert" className="text-sm text-destructive">
								{deleteError}
							</p>
						)}
					</form>
					<DialogFooter>
						<Button variant="outline" onClick={() => setDeleteOpen(false)}>
							Cancel
						</Button>
						<Button
							type="submit"
							form="delete-account-form"
							variant="destructive"
							disabled={deleteConfirm.trim() !== account.username || busy === "delete"}
						>
							{busy === "delete" ? "Deleting…" : "Delete my account"}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
			{user && <span className="sr-only">Signed in as {user.username}</span>}
		</div>
	);
}

/** Opens from the link in the "confirm your new email" message: /settings?confirmEmail=… */
function useEmailConfirmation(onConfirmed: () => void) {
	const { token: session, adoptToken, loading } = useAuth();
	const [state, setState] = useState<"idle" | "working" | "done" | "failed">("idle");
	const [message, setMessage] = useState<string | null>(null);
	// biome-ignore lint/correctness/useExhaustiveDependencies: runs once for the link in the URL, after the session loads
	useEffect(() => {
		if (loading) return;
		const params = new URLSearchParams(window.location.search);
		const token = params.get("confirmEmail");
		if (!token) return;
		params.delete("confirmEmail");
		const rest = params.toString();
		window.history.replaceState(null, "", `${window.location.pathname}${rest ? `?${rest}` : ""}`);
		setState("working");
		// Sent with this browser's session (if any) so it gets a new token: the change signs
		// every session out.
		call<{ email: string; token?: string }>(session, "POST", "/api/account/email/confirm", {
			token,
		}).then((r) => {
			if (r.ok) {
				setState("done");
				setMessage(`Your email is now ${r.data.email}. Other devices were signed out.`);
				clearSudo();
				if (r.data.token) adoptToken(r.data.token);
				onConfirmed();
			} else {
				setState("failed");
				setMessage(r.data.error ?? "This link is invalid or has expired.");
			}
		});
	}, [loading]);
	return { state, message };
}

/** Opens from the "confirm it's you" email: /settings?reauth=… (needs this browser's session). */
function useReauthLink() {
	const { token: session, loading } = useAuth();
	const [state, setState] = useState<"idle" | "working" | "done" | "failed">("idle");
	const [message, setMessage] = useState<string | null>(null);
	// biome-ignore lint/correctness/useExhaustiveDependencies: runs once for the link in the URL, after the session loads
	useEffect(() => {
		if (loading) return;
		const params = new URLSearchParams(window.location.search);
		const link = params.get("reauth");
		if (!link) return;
		params.delete("reauth");
		const rest = params.toString();
		window.history.replaceState(null, "", `${window.location.pathname}${rest ? `?${rest}` : ""}`);
		if (!session) {
			setState("failed");
			setMessage("Sign in on this device first, then open the link again.");
			return;
		}
		setState("working");
		call<SudoGrant>(session, "POST", "/api/account/reauth/confirm", { token: link }).then((r) => {
			if (r.ok) {
				saveSudo(r.data.sudoToken, r.data.expiresInSeconds);
				setState("done");
				setMessage(
					"Confirmed. If you started in another tab, it continues there. Otherwise, make the change below in the next few minutes.",
				);
			} else {
				setState("failed");
				setMessage(
					r.status === 400
						? "This link is invalid or has expired, or it was opened on a different device or account."
						: errorText(r, "Couldn't confirm it's you."),
				);
			}
		});
	}, [loading]);
	return { state, message };
}

/** The account settings page at /settings. */
export function Settings() {
	const { user } = useAuth();
	const [version, setVersion] = useState(0);
	const confirmation = useEmailConfirmation(() => setVersion((v) => v + 1));
	const reauth = useReauthLink();

	return (
		<div className="min-h-dvh bg-background text-foreground">
			<div className="mx-auto flex max-w-4xl flex-col gap-6 px-4 py-6 sm:px-6 sm:py-8">
				<header className="flex flex-col gap-3">
					<div>
						<Link to="/" className={cn(buttonVariants({ variant: "ghost" }), "-ml-2")}>
							<ArrowLeftIcon />
							Back to ollo
						</Link>
					</div>
					<h1 className="font-display text-[2rem] leading-tight">Settings</h1>
				</header>

				{confirmation.state !== "idle" && (
					<div
						aria-live="polite"
						className={cn(
							"rounded-2xl border p-4 text-sm",
							confirmation.state === "failed"
								? "border-destructive/50 text-destructive"
								: "border-border bg-card",
						)}
					>
						{confirmation.state === "working" ? "Confirming your new email…" : confirmation.message}
						{confirmation.state === "done" && !user && " Sign in with it from now on."}
					</div>
				)}

				{reauth.state !== "idle" && (
					<div
						aria-live="polite"
						className={cn(
							"rounded-2xl border p-4 text-sm",
							reauth.state === "failed" ? "border-destructive/50 text-destructive" : "border-border bg-card",
						)}
					>
						{reauth.state === "working" ? "Confirming it's you…" : reauth.message}
					</div>
				)}

				{user ? (
					<AccountSettings key={version} />
				) : (
					<p className="text-sm text-muted-foreground">
						<Link to="/login" className="font-medium text-foreground underline underline-offset-4">
							Sign in
						</Link>{" "}
						to change your settings.
					</p>
				)}
			</div>
		</div>
	);
}

export default Settings;
