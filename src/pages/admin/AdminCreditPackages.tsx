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
import { PlusIcon } from "lucide-react";
import { type FormEvent, type ReactNode, useId, useState } from "react";
import { toast } from "sonner";
import { fmtCents, fmtInt, useAdminCall, useAdminQuery } from "./api";
import {
	DataTable,
	EmptyState,
	ErrorState,
	LoadingBlock,
	PageHeader,
	Panel,
	Td,
	Th,
} from "./parts";

interface CreditPackage {
	id: string;
	name: string;
	credits: number;
	priceSol: number | null;
	priceCents: number | null;
	stripePriceId: string | null;
	availableForUsd: boolean;
	availableForSol: boolean;
	isActive: boolean;
	createdAt?: string;
}

interface FormState {
	name: string;
	credits: string;
	priceUsd: string;
	priceSol: string;
	stripePriceId: string;
	availableForUsd: boolean;
	availableForSol: boolean;
	isActive: boolean;
}

const EMPTY: FormState = {
	name: "",
	credits: "",
	priceUsd: "",
	priceSol: "",
	stripePriceId: "",
	availableForUsd: true,
	availableForSol: false,
	isActive: true,
};

function Field({
	label,
	hint,
	children,
	id,
}: { label: string; hint?: string; children: ReactNode; id: string }) {
	return (
		<div className="grid gap-1.5">
			<label htmlFor={id} className="text-sm font-medium text-foreground">
				{label}
			</label>
			{children}
			{hint && <p className="text-xs text-muted-foreground">{hint}</p>}
		</div>
	);
}

function Check({
	checked,
	onChange,
	children,
}: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode }) {
	return (
		<label className="flex min-h-10 cursor-pointer items-center gap-2 text-sm text-foreground">
			<input
				type="checkbox"
				className="size-4 accent-verdigris"
				checked={checked}
				onChange={(e) => onChange(e.target.checked)}
			/>
			{children}
		</label>
	);
}

/** Client-side mirror of the server's rules; returns an error message or null. */
function validate(f: FormState): string | null {
	if (!f.name.trim()) return "Give the pack a name.";
	const credits = Number(f.credits);
	if (!Number.isInteger(credits) || credits < 1) return "Credits must be a whole number above 0.";
	if (!f.availableForUsd && !f.availableForSol) return "Sell the pack for USD, SOL, or both.";
	if (f.availableForUsd) {
		const cents = Math.round(Number(f.priceUsd) * 100);
		if (!f.priceUsd.trim() || !Number.isFinite(cents) || cents < 1)
			return "A USD pack needs a price above $0.";
	}
	if (f.availableForSol) {
		const sol = Number(f.priceSol);
		if (!f.priceSol.trim() || !Number.isFinite(sol) || sol <= 0)
			return "A SOL pack needs a SOL price above 0.";
	}
	return null;
}

function PackageDialog({
	open,
	onOpenChange,
	editing,
	onSaved,
}: {
	open: boolean;
	onOpenChange: (v: boolean) => void;
	editing: CreditPackage | null;
	onSaved: () => void;
}) {
	const call = useAdminCall();
	const id = useId();
	const [form, setForm] = useState<FormState>(
		editing
			? {
					name: editing.name,
					credits: String(editing.credits),
					priceUsd: editing.priceCents != null ? (editing.priceCents / 100).toFixed(2) : "",
					priceSol: editing.priceSol ? String(editing.priceSol) : "",
					stripePriceId: editing.stripePriceId ?? "",
					availableForUsd: editing.availableForUsd,
					availableForSol: editing.availableForSol,
					isActive: editing.isActive,
				}
			: EMPTY,
	);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const set = <K extends keyof FormState>(k: K, v: FormState[K]) =>
		setForm((f) => ({ ...f, [k]: v }));

	const submit = async (e: FormEvent) => {
		e.preventDefault();
		const invalid = validate(form);
		if (invalid) {
			setError(invalid);
			return;
		}
		const body = {
			name: form.name.trim(),
			credits: Number(form.credits),
			availableForUsd: form.availableForUsd,
			availableForSol: form.availableForSol,
			priceCents: form.availableForUsd
				? Math.round(Number(form.priceUsd) * 100)
				: form.priceUsd.trim()
					? Math.round(Number(form.priceUsd) * 100)
					: null,
			...(form.availableForSol ? { priceSol: Number(form.priceSol) } : {}),
			stripePriceId: form.stripePriceId.trim() || null,
			isActive: form.isActive,
		};
		setBusy(true);
		const res = editing
			? await call("PATCH", `/api/admin/credit-packages/${editing.id}`, body)
			: await call("POST", "/api/admin/credit-packages", body);
		setBusy(false);
		if (!res.ok) {
			setError(res.data.error ?? "Couldn't save the pack.");
			return;
		}
		toast.success(editing ? "Credit pack saved" : "Credit pack created");
		onOpenChange(false);
		onSaved();
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
				<form onSubmit={submit} className="grid gap-4">
					<DialogHeader>
						<DialogTitle>{editing ? `Edit ${editing.name}` : "New credit pack"}</DialogTitle>
						<DialogDescription>
							Packs are one-time purchases that add credits to a balance.
						</DialogDescription>
					</DialogHeader>
					<div className="grid gap-4 sm:grid-cols-2">
						<Field label="Name" id={`${id}-name`}>
							<Input
								id={`${id}-name`}
								value={form.name}
								maxLength={80}
								onChange={(e) => set("name", e.target.value)}
								required
							/>
						</Field>
						<Field label="Credits" id={`${id}-credits`}>
							<Input
								id={`${id}-credits`}
								type="number"
								min={1}
								step={1}
								inputMode="numeric"
								value={form.credits}
								onChange={(e) => set("credits", e.target.value)}
								required
							/>
						</Field>
					</div>
					<div className="flex flex-wrap gap-x-6">
						<Check checked={form.availableForUsd} onChange={(v) => set("availableForUsd", v)}>
							Sell for USD
						</Check>
						<Check checked={form.availableForSol} onChange={(v) => set("availableForSol", v)}>
							Sell for SOL
						</Check>
						<Check checked={form.isActive} onChange={(v) => set("isActive", v)}>
							Active
						</Check>
					</div>
					<div className="grid gap-4 sm:grid-cols-2">
						{form.availableForUsd && (
							<>
								<Field label="Price (USD)" id={`${id}-usd`}>
									<Input
										id={`${id}-usd`}
										type="number"
										min={0.01}
										step="0.01"
										inputMode="decimal"
										value={form.priceUsd}
										onChange={(e) => set("priceUsd", e.target.value)}
										required
									/>
								</Field>
								<Field
									label="Stripe price id"
									hint="Optional; checkout uses the price above."
									id={`${id}-stripe`}
								>
									<Input
										id={`${id}-stripe`}
										value={form.stripePriceId}
										placeholder="price_…"
										onChange={(e) => set("stripePriceId", e.target.value)}
									/>
								</Field>
							</>
						)}
						{form.availableForSol && (
							<Field label="Price (SOL)" id={`${id}-sol`}>
								<Input
									id={`${id}-sol`}
									type="number"
									min={0}
									step="0.001"
									inputMode="decimal"
									value={form.priceSol}
									onChange={(e) => set("priceSol", e.target.value)}
									required
								/>
							</Field>
						)}
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
						<Button type="submit" variant="outline" disabled={busy}>
							{busy ? "Saving…" : editing ? "Save pack" : "Create pack"}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

export default function AdminCreditPackages() {
	const call = useAdminCall();
	const { data, error, loading, reload } = useAdminQuery<{ packages: CreditPackage[] }>(
		"/api/admin/credit-packages",
	);
	const [dialog, setDialog] = useState<{
		open: boolean;
		editing: CreditPackage | null;
		key: number;
	}>({
		open: false,
		editing: null,
		key: 0,
	});
	const openDialog = (editing: CreditPackage | null) =>
		setDialog((d) => ({ open: true, editing, key: d.key + 1 }));

	const deactivate = async (p: CreditPackage) => {
		if (!window.confirm(`Deactivate ${p.name}? It stops being offered; past purchases are kept.`))
			return;
		const res = await call("DELETE", `/api/admin/credit-packages/${p.id}`);
		if (res.ok) {
			toast.success(`${p.name} deactivated`);
			void reload();
		} else toast.error(res.data.error ?? "Couldn't deactivate the pack.");
	};

	const packages = data?.packages ?? [];

	return (
		<div>
			<PageHeader
				title="Credit packs"
				description="One-time credit purchases, sold for USD through Stripe or for SOL."
				actions={
					<Button variant="outline" onClick={() => openDialog(null)}>
						<PlusIcon />
						New pack
					</Button>
				}
			/>
			{error && <ErrorState message={error} onRetry={reload} />}
			<Panel bodyClassName="pt-0 pb-0">
				{loading && !data ? (
					<div className="py-4">
						<LoadingBlock />
					</div>
				) : packages.length === 0 ? (
					<EmptyState title="No credit packs yet">
						Packs you create appear here with their prices per credit.
					</EmptyState>
				) : (
					<DataTable>
						<thead>
							<tr>
								<Th>Pack</Th>
								<Th right>Credits</Th>
								<Th right>USD</Th>
								<Th right>Per credit</Th>
								<Th right>SOL</Th>
								<Th>Stripe price</Th>
								<Th>
									<span className="sr-only">Actions</span>
								</Th>
							</tr>
						</thead>
						<tbody>
							{packages.map((p) => (
								<tr key={p.id} className={p.isActive ? undefined : "opacity-60"}>
									<Td>
										<div className="flex items-center gap-2">
											<span className="font-medium">{p.name}</span>
											{!p.isActive && <Badge variant="outline">Inactive</Badge>}
										</div>
										<p className="text-xs text-muted-foreground">
											{[p.availableForUsd && "USD", p.availableForSol && "SOL"]
												.filter(Boolean)
												.join(" · ") || "Not for sale"}
										</p>
									</Td>
									<Td num>{fmtInt(p.credits)}</Td>
									<Td num>{p.availableForUsd ? fmtCents(p.priceCents) : "—"}</Td>
									<Td num>
										{p.availableForUsd && p.priceCents && p.credits
											? `${(p.priceCents / p.credits).toFixed(1)}¢`
											: "—"}
									</Td>
									<Td num>{p.availableForSol && p.priceSol ? `${p.priceSol} SOL` : "—"}</Td>
									<Td className="max-w-[10rem] truncate font-mono text-xs">
										{p.stripePriceId ?? "—"}
									</Td>
									<Td right>
										<div className="flex justify-end gap-1">
											<Button variant="ghost" size="sm" onClick={() => openDialog(p)}>
												Edit
											</Button>
											{p.isActive && (
												<Button variant="ghost" size="sm" onClick={() => deactivate(p)}>
													Deactivate
												</Button>
											)}
										</div>
									</Td>
								</tr>
							))}
						</tbody>
					</DataTable>
				)}
			</Panel>
			{dialog.open && (
				<PackageDialog
					key={dialog.key}
					open={dialog.open}
					onOpenChange={(open) => setDialog((d) => ({ ...d, open }))}
					editing={dialog.editing}
					onSaved={reload}
				/>
			)}
		</div>
	);
}
