import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useState } from "react";
import { toast } from "sonner";
import { fmtCost, fmtInt, fmtPct, fmtUsd, useAdminCall, useAdminQuery } from "./api";
import {
	DataTable,
	EmptyState,
	ErrorState,
	FilterSelect,
	LoadingBlock,
	PageHeader,
	Panel,
	Td,
	Th,
} from "./parts";

interface TierRow {
	tier: string;
	officialCostUsd: number;
	formulaCredits: number;
	override: number | null;
}

interface ModelRow {
	id: string;
	name: string;
	kind: string;
	hidden: boolean;
	runs: number;
	failures: number;
	failureRate: number | null;
	p50Seconds: number | null;
	p95Seconds: number | null;
	queueWaitP50Seconds: number | null;
	queueWaitP95Seconds: number | null;
	costUsd: number;
	estimatedCostUsd: number;
	creditsCharged: number;
	creditValueUsd: number;
	marginUsd: number;
	plainOverride: number | null;
	tiers: TierRow[];
}

interface Economics {
	days: number;
	valuePerCredit: { cents: number; source: string };
	models: ModelRow[];
}

const RANGES = [
	{ value: "7", label: "Last 7 days" },
	{ value: "30", label: "Last 30 days" },
	{ value: "90", label: "Last 90 days" },
	{ value: "0", label: "All time" },
];

const TIER_LABEL: Record<string, string> = { draft: "Draft", standard: "Standard", max: "Max" };
const secs = (v: number | null) => (v == null ? "—" : `${v < 10 ? v.toFixed(1) : Math.round(v)} s`);

function OverrideRow({
	label,
	cell,
	keyId,
	official,
	formula,
	override,
	onChanged,
}: {
	label: string;
	cell: string;
	keyId: string;
	official: number | null;
	formula: number | null;
	override: number | null;
	onChanged: () => void;
}) {
	const call = useAdminCall();
	const [value, setValue] = useState(override != null ? String(override) : "");
	const [busy, setBusy] = useState(false);
	const parsed = Number(value);
	const valid = value.trim() !== "" && Number.isInteger(parsed) && parsed >= 1 && parsed <= 10_000;
	const dirty = valid && parsed !== override;

	const save = async () => {
		if (!valid) {
			toast.error("Credit cost must be a whole number from 1 to 10,000.");
			return;
		}
		setBusy(true);
		const res = await call("PATCH", `/api/admin/model-costs/${encodeURIComponent(keyId)}`, {
			creditCost: parsed,
		});
		setBusy(false);
		if (res.ok) {
			toast.success(`${label}: ${parsed} credits`);
			onChanged();
		} else toast.error(res.data.error ?? "Couldn't save the override.");
	};
	const reset = async () => {
		setBusy(true);
		const res = await call("DELETE", `/api/admin/model-costs/${encodeURIComponent(keyId)}`);
		setBusy(false);
		if (res.ok) {
			toast.success(`${label}: back to the formula`);
			setValue("");
			onChanged();
		} else toast.error(res.data.error ?? "Couldn't reset the override.");
	};

	return (
		<tr>
			<Td>{cell}</Td>
			<Td num>{official == null ? "—" : fmtCost(official)}</Td>
			<Td num>{formula == null ? "—" : fmtInt(formula)}</Td>
			<Td num>
				{override == null ? (
					<span className="text-muted-foreground">Formula</span>
				) : (
					fmtInt(override)
				)}
			</Td>
			<Td right>
				<div className="flex items-center justify-end gap-1.5">
					<Input
						type="number"
						min={1}
						step={1}
						inputMode="numeric"
						aria-label={`Credit cost for ${label}`}
						placeholder={formula != null ? String(formula) : ""}
						value={value}
						onChange={(e) => setValue(e.target.value)}
						className="h-8 w-20 text-right text-sm tabular-nums"
					/>
					<Button size="sm" variant="outline" disabled={!dirty || busy} onClick={save}>
						Save
					</Button>
					<Button size="sm" variant="ghost" disabled={override == null || busy} onClick={reset}>
						Reset
					</Button>
				</div>
			</Td>
		</tr>
	);
}

export default function AdminModels() {
	const [days, setDays] = useState("30");
	const { data, error, loading, reload } = useAdminQuery<Economics>(
		`/api/admin/models/economics?days=${days}`,
	);
	const models = data?.models ?? [];
	const used = models.filter((m) => m.runs > 0 || m.failures > 0);
	const editable = models.filter((m) => !m.hidden && m.tiers.length > 0);
	const totals = used.reduce(
		(t, m) => ({
			cost: t.cost + m.costUsd,
			value: t.value + m.creditValueUsd,
			runs: t.runs + m.runs,
		}),
		{ cost: 0, value: 0, runs: 0 },
	);

	return (
		<div className="flex flex-col gap-6">
			<PageHeader
				title="Models"
				description="What each model costs us on Replicate against the credits it brings in."
				actions={
					<FilterSelect
						label="Range"
						value={days}
						options={RANGES}
						onChange={(v) => setDays(v || "0")}
					/>
				}
			/>
			{error && <ErrorState message={error} onRetry={reload} />}

			<Panel
				title="Economics"
				description={
					data
						? `Credit value uses ${(data.valuePerCredit.cents).toFixed(1)}¢ per credit (${data.valuePerCredit.source}). Credits from older generations without a model in the ledger aren't counted.`
						: undefined
				}
				bodyClassName="pt-0 pb-0"
			>
				{loading && !data ? (
					<div className="py-4">
						<LoadingBlock />
					</div>
				) : used.length === 0 ? (
					<EmptyState title="No runs in this range">
						Each model's runs, failures, latency and margin appear here once people generate.
					</EmptyState>
				) : (
					<DataTable className="min-w-[66rem]">
						<thead>
							<tr>
								<Th>Model</Th>
								<Th right>Runs</Th>
								<Th right>Failure rate</Th>
								<Th right>p50</Th>
								<Th right>p95</Th>
								<Th right>Queue wait p50/p95</Th>
								<Th right>Replicate cost</Th>
								<Th right>Credits</Th>
								<Th right>Credit value</Th>
								<Th right>Margin</Th>
							</tr>
						</thead>
						<tbody>
							{used.map((m) => (
								<tr key={m.id}>
									<Td>
										<div className="flex items-center gap-2">
											<span className="font-medium">{m.name}</span>
											{m.hidden && <Badge variant="outline">Retired</Badge>}
											{m.kind === "tool" && <Badge variant="outline">Tool</Badge>}
										</div>
										<p className="text-xs text-muted-foreground">{m.id}</p>
									</Td>
									<Td num>{fmtInt(m.runs)}</Td>
									<Td
										num
										className={cn(
											m.failureRate != null && m.failureRate >= 10 && "text-destructive",
										)}
									>
										{fmtPct(m.failureRate, 1)}
										{m.failures > 0 && (
											<div className="text-xs text-muted-foreground">
												{fmtInt(m.failures)} failed
											</div>
										)}
									</Td>
									<Td num>{secs(m.p50Seconds)}</Td>
									<Td num>{secs(m.p95Seconds)}</Td>
									<Td num>
										{m.queueWaitP50Seconds == null
											? "—"
											: `${secs(m.queueWaitP50Seconds)} / ${secs(m.queueWaitP95Seconds)}`}
									</Td>
									<Td num>
										{fmtCost(m.costUsd)}
										{m.estimatedCostUsd > 0 && (
											<div className="text-xs text-muted-foreground">
												includes {fmtCost(m.estimatedCostUsd)} estimated
											</div>
										)}
									</Td>
									<Td num>{fmtInt(m.creditsCharged)}</Td>
									<Td num>{fmtUsd(m.creditValueUsd)}</Td>
									<Td num className={cn(m.marginUsd < 0 && "text-destructive")}>
										{fmtUsd(m.marginUsd)}
									</Td>
								</tr>
							))}
						</tbody>
						<tfoot>
							<tr>
								<Td className="font-medium">Total</Td>
								<Td num>{fmtInt(totals.runs)}</Td>
								<Td />
								<Td />
								<Td />
								<Td />
								<Td num>{fmtCost(totals.cost)}</Td>
								<Td />
								<Td num>{fmtUsd(totals.value)}</Td>
								<Td num className={cn(totals.value - totals.cost < 0 && "text-destructive")}>
									{fmtUsd(totals.value - totals.cost)}
								</Td>
							</tr>
						</tfoot>
					</DataTable>
				)}
			</Panel>

			<Panel
				title="Credit costs"
				description="Credits per image at each tier. Empty uses the formula (official cost × 42, rounded up). An override wins over the formula."
				bodyClassName="pt-0 pb-0"
			>
				{loading && !data ? (
					<div className="py-4">
						<LoadingBlock />
					</div>
				) : editable.length === 0 ? (
					<EmptyState title="No models to price">
						Models in the catalog appear here with their tiers.
					</EmptyState>
				) : (
					<DataTable className="min-w-[44rem]">
						<thead>
							<tr>
								<Th>Model and tier</Th>
								<Th right>Official cost</Th>
								<Th right>Formula</Th>
								<Th right>Current</Th>
								<Th right>Override</Th>
							</tr>
						</thead>
						{editable.map((m) => (
							<tbody key={`${m.id}-${days}`}>
								<tr>
									<th
										scope="rowgroup"
										colSpan={5}
										className="border-b border-border bg-muted/50 px-4 py-2 text-left text-xs font-semibold text-foreground"
									>
										{m.name}
										{m.kind === "tool" && (
											<span className="ml-2 font-normal text-muted-foreground">Tool</span>
										)}
									</th>
								</tr>
								{m.plainOverride != null && (
									<OverrideRow
										key={`${m.id}-plain-${m.plainOverride}`}
										label={`${m.name}, every tier`}
										cell="Every tier"
										keyId={m.id}
										official={null}
										formula={null}
										override={m.plainOverride}
										onChanged={reload}
									/>
								)}
								{m.tiers.map((t) => (
									<OverrideRow
										key={`${m.id}:${t.tier}-${t.override ?? "f"}`}
										label={`${m.name} ${TIER_LABEL[t.tier] ?? t.tier}`}
										cell={TIER_LABEL[t.tier] ?? t.tier}
										keyId={`${m.id}:${t.tier}`}
										official={t.officialCostUsd}
										formula={t.formulaCredits}
										override={t.override}
										onChanged={reload}
									/>
								))}
							</tbody>
						))}
					</DataTable>
				)}
			</Panel>
		</div>
	);
}
