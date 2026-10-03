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
import { type Product, fmtInt, fmtUsd, useAdminCall, useAdminQuery } from "./api";
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

interface CatalogModel {
	id: string;
	name: string;
	kind: string;
	hidden: boolean;
}

interface FormState {
	name: string;
	description: string;
	price: string;
	priceSol: string;
	stripePriceId: string;
	availableForUsd: boolean;
	availableForSol: boolean;
	bonusCredits: string;
	creditRefillAmount: string;
	topoffIntervalHours: string;
	monthlyCostLimit: string;
	monthlyImageLimit: string;
	dailyImageLimit: string;
	allowedModels: string[] | null;
	isActive: boolean;
}

const EMPTY: FormState = {
	name: "",
	description: "",
	price: "0",
	priceSol: "",
	stripePriceId: "",
	availableForUsd: true,
	availableForSol: false,
	bonusCredits: "0",
	creditRefillAmount: "0",
	topoffIntervalHours: "24",
	monthlyCostLimit: "",
	monthlyImageLimit: "",
	dailyImageLimit: "",
	allowedModels: null,
	isActive: true,
};

function fromProduct(p: Product): FormState {
	const s = (v: number | null | undefined) => (v == null ? "" : String(v));
	return {
		name: p.name,
		description: p.description ?? "",
		price: String(p.price ?? 0),
		priceSol: s(p.priceSol),
		stripePriceId: p.stripePriceId ?? "",
		availableForUsd: p.availableForUsd,
		availableForSol: p.availableForSol,
		bonusCredits: String(p.bonusCredits ?? 0),
		creditRefillAmount: String(p.creditRefillAmount ?? 0),
		topoffIntervalHours: String(p.topoffIntervalHours ?? 24),
		monthlyCostLimit: s(p.monthlyCostLimit),
		monthlyImageLimit: s(p.monthlyImageLimit),
		dailyImageLimit: s(p.dailyImageLimit),
		allowedModels: p.allowedModels,
		isActive: p.isActive,
	};
}

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

function refillText(p: Product): string {
	if (!p.creditRefillAmount) return "None";
	const h = p.topoffIntervalHours;
	const every = h === 24 ? "day" : h === 168 ? "week" : h === 720 ? "30 days" : `${h} h`;
	return `Up to ${p.creditRefillAmount} every ${every}`;
}

function ProductDialog({
	open,
	onOpenChange,
	editing,
	models,
	onSaved,
}: {
	open: boolean;
	onOpenChange: (v: boolean) => void;
	editing: Product | null;
	models: CatalogModel[];
	onSaved: () => void;
}) {
	const call = useAdminCall();
	const id = useId();
	const [form, setForm] = useState<FormState>(editing ? fromProduct(editing) : EMPTY);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const set = <K extends keyof FormState>(k: K, v: FormState[K]) =>
		setForm((f) => ({ ...f, [k]: v }));

	const num = (v: string) => (v.trim() === "" ? null : Number(v));

	const submit = async (e: FormEvent) => {
		e.preventDefault();
		if (!form.name.trim()) {
			setError("Give the plan a name.");
			return;
		}
		const body = {
			name: form.name.trim(),
			description: form.description,
			price: num(form.price) ?? 0,
			priceSol: num(form.priceSol),
			stripePriceId: form.stripePriceId.trim() || null,
			availableForUsd: form.availableForUsd,
			availableForSol: form.availableForSol,
			bonusCredits: num(form.bonusCredits) ?? 0,
			creditRefillAmount: num(form.creditRefillAmount) ?? 0,
			topoffIntervalHours: num(form.topoffIntervalHours) ?? 24,
			monthlyCostLimit: num(form.monthlyCostLimit),
			monthlyImageLimit: num(form.monthlyImageLimit),
			dailyImageLimit: num(form.dailyImageLimit),
			allowedModels: form.allowedModels,
			...(editing ? { isActive: form.isActive } : {}),
		};
		setBusy(true);
		const res = editing
			? await call("PATCH", `/api/admin/products/${editing.id}`, body)
			: await call("POST", "/api/admin/products", body);
		setBusy(false);
		if (!res.ok) {
			setError(res.data.error ?? "Couldn't save the plan.");
			return;
		}
		toast.success(editing ? "Plan saved" : "Plan created");
		onOpenChange(false);
		onSaved();
	};

	const toggleModel = (modelId: string, on: boolean) => {
		const current = form.allowedModels ?? [];
		set("allowedModels", on ? [...current, modelId] : current.filter((m) => m !== modelId));
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
				<form onSubmit={submit} className="grid gap-4">
					<DialogHeader>
						<DialogTitle>{editing ? `Edit ${editing.name}` : "New plan"}</DialogTitle>
						<DialogDescription>
							Changes apply to everyone on this plan from their next generation.
						</DialogDescription>
					</DialogHeader>

					<div className="grid gap-4 sm:grid-cols-2">
						<Field label="Name" id={`${id}-name`}>
							<Input
								id={`${id}-name`}
								value={form.name}
								onChange={(e) => set("name", e.target.value)}
								maxLength={80}
								required
							/>
						</Field>
						<Field label="Description" id={`${id}-desc`}>
							<Input
								id={`${id}-desc`}
								value={form.description}
								onChange={(e) => set("description", e.target.value)}
							/>
						</Field>
						<Field label="Price (USD per month)" id={`${id}-price`}>
							<Input
								id={`${id}-price`}
								type="number"
								min={0}
								step="0.01"
								inputMode="decimal"
								value={form.price}
								onChange={(e) => set("price", e.target.value)}
							/>
						</Field>
						<Field
							label="Price (SOL)"
							hint="Leave empty if the plan isn't sold for SOL."
							id={`${id}-sol`}
						>
							<Input
								id={`${id}-sol`}
								type="number"
								min={0}
								step="0.001"
								inputMode="decimal"
								value={form.priceSol}
								onChange={(e) => set("priceSol", e.target.value)}
							/>
						</Field>
						<Field label="Stripe price id" id={`${id}-stripe`}>
							<Input
								id={`${id}-stripe`}
								value={form.stripePriceId}
								placeholder="price_…"
								onChange={(e) => set("stripePriceId", e.target.value)}
							/>
						</Field>
						<Field label="Welcome bonus (credits)" id={`${id}-bonus`}>
							<Input
								id={`${id}-bonus`}
								type="number"
								min={0}
								step={1}
								value={form.bonusCredits}
								onChange={(e) => set("bonusCredits", e.target.value)}
							/>
						</Field>
						<Field label="Refill up to (credits)" hint="0 turns refills off." id={`${id}-refill`}>
							<Input
								id={`${id}-refill`}
								type="number"
								min={0}
								step={1}
								value={form.creditRefillAmount}
								onChange={(e) => set("creditRefillAmount", e.target.value)}
							/>
						</Field>
						<Field
							label="Refill every (hours)"
							hint="24 = daily, 720 = every 30 days."
							id={`${id}-interval`}
						>
							<Input
								id={`${id}-interval`}
								type="number"
								min={1}
								step={1}
								value={form.topoffIntervalHours}
								onChange={(e) => set("topoffIntervalHours", e.target.value)}
							/>
						</Field>
						<Field
							label="Monthly cost limit (USD)"
							hint="Safety backstop. Empty = no limit."
							id={`${id}-cost`}
						>
							<Input
								id={`${id}-cost`}
								type="number"
								min={0}
								step="0.01"
								value={form.monthlyCostLimit}
								onChange={(e) => set("monthlyCostLimit", e.target.value)}
							/>
						</Field>
						<Field label="Monthly image limit" hint="Empty = no limit." id={`${id}-mimg`}>
							<Input
								id={`${id}-mimg`}
								type="number"
								min={0}
								step={1}
								value={form.monthlyImageLimit}
								onChange={(e) => set("monthlyImageLimit", e.target.value)}
							/>
						</Field>
						<Field label="Daily image limit" hint="Empty = no limit." id={`${id}-dimg`}>
							<Input
								id={`${id}-dimg`}
								type="number"
								min={0}
								step={1}
								value={form.dailyImageLimit}
								onChange={(e) => set("dailyImageLimit", e.target.value)}
							/>
						</Field>
					</div>

					<div className="flex flex-wrap gap-x-6">
						<Check checked={form.availableForUsd} onChange={(v) => set("availableForUsd", v)}>
							Sold for USD
						</Check>
						<Check checked={form.availableForSol} onChange={(v) => set("availableForSol", v)}>
							Sold for SOL
						</Check>
						{editing && (
							<Check checked={form.isActive} onChange={(v) => set("isActive", v)}>
								Active
							</Check>
						)}
					</div>

					<fieldset className="grid gap-2 rounded-xl border border-border p-3">
						<legend className="px-1 text-sm font-medium text-foreground">Models</legend>
						<Check
							checked={form.allowedModels === null}
							onChange={(v) => set("allowedModels", v ? null : models.map((m) => m.id))}
						>
							All models
						</Check>
						{form.allowedModels !== null && (
							<div className="grid gap-x-4 sm:grid-cols-2">
								{models.map((m) => (
									<Check
										key={m.id}
										checked={form.allowedModels?.includes(m.id) ?? false}
										onChange={(v) => toggleModel(m.id, v)}
									>
										<span className="truncate">{m.name}</span>
									</Check>
								))}
								{models.length === 0 && (
									<p className="text-xs text-muted-foreground">Loading models…</p>
								)}
							</div>
						)}
					</fieldset>

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
							{busy ? "Saving…" : editing ? "Save plan" : "Create plan"}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

export default function AdminProducts() {
	const call = useAdminCall();
	const { data, error, loading, reload } = useAdminQuery<{ products: Product[] }>(
		"/api/admin/products",
	);
	const catalog = useAdminQuery<{ models: CatalogModel[] }>("/api/admin/models/economics?days=0");
	const models = (catalog.data?.models ?? []).filter((m) => m.kind === "image" && !m.hidden);
	const nameOf = (id: string) => models.find((m) => m.id === id)?.name ?? id.split("/").pop() ?? id;

	const [dialog, setDialog] = useState<{ open: boolean; editing: Product | null; key: number }>({
		open: false,
		editing: null,
		key: 0,
	});
	const openDialog = (editing: Product | null) =>
		setDialog((d) => ({ open: true, editing, key: d.key + 1 }));

	const deactivate = async (p: Product) => {
		if (!window.confirm(`Deactivate ${p.name}? People on it keep it; nobody new can choose it.`))
			return;
		const res = await call("DELETE", `/api/admin/products/${p.id}`);
		if (res.ok) {
			toast.success(`${p.name} deactivated`);
			void reload();
		} else toast.error(res.data.error ?? "Couldn't deactivate the plan.");
	};

	const products = data?.products ?? [];

	return (
		<div>
			<PageHeader
				title="Plans"
				description="What each plan costs, what it refills and which models it can use."
				actions={
					<Button variant="outline" onClick={() => openDialog(null)}>
						<PlusIcon />
						New plan
					</Button>
				}
			/>
			{error && <ErrorState message={error} onRetry={reload} />}
			<Panel bodyClassName="pt-0 pb-0">
				{loading && !data ? (
					<div className="py-4">
						<LoadingBlock />
					</div>
				) : products.length === 0 ? (
					<EmptyState title="No plans yet">
						Plans you create appear here with their prices and limits.
					</EmptyState>
				) : (
					<DataTable className="min-w-[56rem]">
						<thead>
							<tr>
								<Th>Plan</Th>
								<Th right>Price</Th>
								<Th>Refill</Th>
								<Th>Limits</Th>
								<Th>Models</Th>
								<Th right>On plan</Th>
								<Th>Stripe price</Th>
								<Th>
									<span className="sr-only">Actions</span>
								</Th>
							</tr>
						</thead>
						<tbody>
							{products.map((p) => (
								<tr key={p.id} className={p.isActive ? undefined : "opacity-60"}>
									<Td>
										<div className="flex items-center gap-2">
											<span className="font-medium">{p.name}</span>
											{!p.isActive && <Badge variant="outline">Inactive</Badge>}
										</div>
										{p.description && (
											<p className="text-xs text-muted-foreground">{p.description}</p>
										)}
										<p className="text-xs text-muted-foreground">
											{[p.availableForUsd && "USD", p.availableForSol && "SOL"]
												.filter(Boolean)
												.join(" · ") || "Not for sale"}
										</p>
									</Td>
									<Td num>
										<div>{fmtUsd(p.price)}</div>
										{p.priceSol != null && (
											<div className="text-xs text-muted-foreground">{p.priceSol} SOL</div>
										)}
									</Td>
									<Td className="text-xs">
										{refillText(p)}
										{p.bonusCredits > 0 && (
											<div className="text-muted-foreground">Bonus {p.bonusCredits}</div>
										)}
									</Td>
									<Td className="text-xs tabular-nums">
										<div>
											Cost{" "}
											{p.monthlyCostLimit != null ? `${fmtUsd(p.monthlyCostLimit)}/mo` : "no limit"}
										</div>
										{p.monthlyImageLimit != null && (
											<div>{fmtInt(p.monthlyImageLimit)} images/mo</div>
										)}
										{p.dailyImageLimit != null && <div>{fmtInt(p.dailyImageLimit)} images/day</div>}
									</Td>
									<Td className="max-w-[14rem] text-xs">
										{p.allowedModels === null ? (
											"All models"
										) : (
											<span title={p.allowedModels.map(nameOf).join(", ")}>
												{p.allowedModels.length} models
												<span className="block truncate text-muted-foreground">
													{p.allowedModels.slice(0, 3).map(nameOf).join(", ")}
												</span>
											</span>
										)}
									</Td>
									<Td num>{fmtInt(p.activeUsers)}</Td>
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
				<ProductDialog
					key={dialog.key}
					open={dialog.open}
					onOpenChange={(open) => setDialog((d) => ({ ...d, open }))}
					editing={dialog.editing}
					models={models}
					onSaved={reload}
				/>
			)}
		</div>
	);
}
