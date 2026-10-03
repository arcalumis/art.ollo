/**
 * One-shot backfill of platform_costs for generations that predate cost tracking.
 *
 * The cost is the catalog's official price formula (server/services/model-catalog.ts) for the
 * generation's model, tier (from its legacy `resolution`), output size, reference images and
 * number of outputs. Backfilled rows carry source = 'backfill_estimate' and no actual_cost, so
 * reports can label them as estimates. Takes the Database explicitly (it runs inside
 * initializeSchema, before getDb() is usable) and imports nothing that touches the DB.
 */
import type { Database } from "bun:sqlite";
import crypto from "node:crypto";
import { getCatalogModel, priceOfOutput, resolveTier, tierFromResolution } from "./model-catalog";

export const BACKFILL_SOURCE = "backfill_estimate";

export interface BackfillGeneration {
	model: string;
	width: number | null;
	height: number | null;
	parameters: string | null;
	cost: number | null;
}

/** Official-formula cost of one historical generation (all of its outputs), in USD. */
export function estimateHistoricalCost(gen: BackfillGeneration): number {
	let params: { resolution?: unknown; tier?: unknown; imageInputs?: unknown; images?: unknown } = {};
	try {
		params = gen.parameters ? JSON.parse(gen.parameters) : {};
	} catch {
		params = {};
	}
	const outputs = Array.isArray(params.images) && params.images.length > 0 ? params.images.length : 1;
	const refs = Array.isArray(params.imageInputs) ? params.imageInputs.length : 0;
	const model = getCatalogModel(gen.model);
	if (!model) {
		// Unknown model: fall back to the cost booked at the time.
		return gen.cost ?? 0;
	}
	const requested =
		typeof params.tier === "string" && ["draft", "standard", "max"].includes(params.tier)
			? (params.tier as "draft" | "standard" | "max")
			: tierFromResolution(typeof params.resolution === "string" ? params.resolution : undefined);
	const tier = resolveTier(model, requested);
	const outputMp = gen.width && gen.height ? (gen.width * gen.height) / 1_000_000 : undefined;
	return priceOfOutput(model, tier, { outputMp, refs }) * outputs;
}

/**
 * Insert an estimated platform_costs row for every generation that has a Replicate id and no
 * cost row yet. Idempotent (re-running inserts nothing). Returns rows inserted.
 */
export function backfillPlatformCosts(db: Database): number {
	const rows = db
		.prepare(`
			SELECT g.id, g.model, g.width, g.height, g.parameters, g.cost, g.replicate_id, g.predict_time, g.created_at
			FROM generations g
			WHERE g.replicate_id IS NOT NULL
			AND NOT EXISTS (SELECT 1 FROM platform_costs pc WHERE pc.generation_id = g.id)
		`)
		.all() as Array<
		BackfillGeneration & { id: string; replicate_id: string; predict_time: number | null; created_at: string }
	>;
	const insert = db.prepare(`
		INSERT INTO platform_costs
			(id, generation_id, replicate_prediction_id, estimated_cost, actual_cost, model, compute_time_seconds, created_at, source)
		VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?)
	`);
	for (const row of rows) {
		const cost = Math.round(estimateHistoricalCost(row) * 1e6) / 1e6;
		insert.run(
			crypto.randomUUID(),
			row.id,
			row.replicate_id,
			cost,
			row.model,
			row.predict_time,
			row.created_at,
			BACKFILL_SOURCE,
		);
	}
	if (rows.length > 0) console.log(`[migration] Backfilled ${rows.length} estimated platform_costs rows`);
	return rows.length;
}
