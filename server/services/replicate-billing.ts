import crypto from "node:crypto";
import Replicate from "replicate";
import { getDb } from "../db";
import { isPerOutputPriced } from "./replicate";

// Replicate cost rates (per second of compute time)
// These are approximate - actual costs vary by model and hardware
const REPLICATE_COST_PER_SECOND: Record<string, number> = {
	// GPU A40 Large (48GB) - most common for image models
	"gpu-a40-large": 0.000725,
	// GPU A100 (40GB)
	"gpu-a100-40gb": 0.00115,
	// Default fallback rate
	default: 0.000725,
};

// Model to hardware mapping (approximate)
const MODEL_HARDWARE: Record<string, string> = {
	flux: "gpu-a40-large",
	"flux-pro": "gpu-a40-large",
	"flux-1.1-pro": "gpu-a40-large",
	"flux-dev": "gpu-a40-large",
	"flux-schnell": "gpu-a40-large",
	"stable-diffusion": "gpu-a40-large",
	sdxl: "gpu-a40-large",
	default: "gpu-a40-large",
};

interface ReplicatePrediction {
	id: string;
	model: string;
	version: string;
	status: string;
	metrics?: {
		predict_time?: number;
	};
	created_at: string;
	completed_at?: string;
}

// Initialize Replicate client
const replicateToken = process.env.REPLICATE_API_TOKEN;
const replicate = replicateToken ? new Replicate({ auth: replicateToken }) : null;

// Calculate estimated cost for a generation
export function estimateCost(model: string, predictTimeSeconds: number): number {
	const hardware = MODEL_HARDWARE[model] || MODEL_HARDWARE.default;
	const ratePerSecond = REPLICATE_COST_PER_SECOND[hardware] || REPLICATE_COST_PER_SECOND.default;
	return predictTimeSeconds * ratePerSecond;
}

// Get prediction details from Replicate API
export async function getPredictionDetails(
	predictionId: string,
): Promise<ReplicatePrediction | null> {
	if (!replicate) {
		console.warn("Replicate client not initialized");
		return null;
	}

	try {
		const prediction = await replicate.predictions.get(predictionId);
		return prediction as unknown as ReplicatePrediction;
	} catch (error) {
		console.error(`Failed to fetch prediction ${predictionId}:`, error);
		return null;
	}
}

// Record platform cost for a generation
export function recordPlatformCost(
	generationId: string,
	replicatePredictionId: string,
	model: string,
	estimatedCost: number,
	actualCost?: number,
	computeTimeSeconds?: number,
): string {
	const db = getDb();
	const id = crypto.randomUUID();

	db.prepare(`
		INSERT INTO platform_costs (
			id, generation_id, replicate_prediction_id, estimated_cost, actual_cost,
			cost_reconciled_at, model, compute_time_seconds
		)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
	`).run(
		id,
		generationId,
		replicatePredictionId,
		estimatedCost,
		actualCost || null,
		actualCost ? new Date().toISOString() : null,
		model,
		computeTimeSeconds || null,
	);

	return id;
}

// Update platform cost with actual cost from Replicate
export function updatePlatformCostActual(
	generationId: string,
	actualCost: number,
	computeTimeSeconds: number,
): void {
	const db = getDb();

	db.prepare(`
		UPDATE platform_costs
		SET actual_cost = ?, compute_time_seconds = ?, cost_reconciled_at = datetime('now')
		WHERE generation_id = ?
	`).run(actualCost, computeTimeSeconds, generationId);

	// Also update the generation record
	db.prepare(`
		UPDATE generations
		SET actual_cost = ?
		WHERE id = ?
	`).run(actualCost, generationId);
}

// Reconcile costs for a single generation
export async function reconcileGenerationCost(generationId: string): Promise<boolean> {
	const db = getDb();

	// Get generation with replicate ID
	const generation = db
		.prepare(
			`SELECT g.id, g.replicate_id, g.model, COALESCE(pc.estimated_cost, g.cost) as cost
			FROM generations g LEFT JOIN platform_costs pc ON pc.generation_id = g.id
			WHERE g.id = ?`,
		)
		.get(generationId) as
		| {
				id: string;
				replicate_id: string | null;
				model: string;
				cost: number | null;
		  }
		| undefined;

	if (!generation || !generation.replicate_id) {
		return false;
	}

	// Fetch prediction details from Replicate
	const prediction = await getPredictionDetails(generation.replicate_id);

	if (!prediction || !prediction.metrics?.predict_time) {
		return false;
	}

	// Official models are billed per output/megapixel, not per second: their
	// estimate is the billed price, and a predict_time-based figure would
	// understate it by an order of magnitude.
	const actualCost =
		isPerOutputPriced(generation.model) && generation.cost !== null
			? generation.cost
			: estimateCost(generation.model, prediction.metrics.predict_time);

	// Update the cost
	updatePlatformCostActual(generationId, actualCost, prediction.metrics.predict_time);

	return true;
}

// Reconcile all unreconciled costs
export async function reconcileAllCosts(limit = 100): Promise<{
	processed: number;
	reconciled: number;
	errors: number;
}> {
	const db = getDb();

	// Only platform-key generations have a platform_costs row; own-key
	// predictions belong to another Replicate account and can't be fetched.
	// The 7-day window stops permanently-unfetchable rows from being retried forever.
	const unreconciled = db
		.prepare(`
			SELECT g.id, g.replicate_id, g.model
			FROM generations g
			JOIN platform_costs pc ON g.id = pc.generation_id
			WHERE g.replicate_id IS NOT NULL
			AND pc.actual_cost IS NULL
			AND pc.created_at >= datetime('now', '-7 days')
			ORDER BY g.created_at DESC
			LIMIT ?
		`)
		.all(limit) as Array<{
		id: string;
		replicate_id: string;
		model: string;
	}>;

	let processed = 0;
	let reconciled = 0;
	let errors = 0;

	for (const gen of unreconciled) {
		processed++;
		try {
			const success = await reconcileGenerationCost(gen.id);
			if (success) {
				reconciled++;
			}
		} catch (error) {
			console.error(`Error reconciling generation ${gen.id}:`, error);
			errors++;
		}

		// Small delay to avoid rate limiting
		await new Promise((resolve) => setTimeout(resolve, 100));
	}

	console.log(`Cost reconciliation: ${reconciled}/${processed} reconciled, ${errors} errors`);

	return { processed, reconciled, errors };
}

// Get cost summary for a time period
export function getCostSummary(
	startDate: Date,
	endDate: Date,
	userId?: string,
): {
	totalEstimated: number;
	totalActual: number;
	totalGenerations: number;
	avgCostPerGeneration: number;
	costByModel: Record<string, { estimated: number; actual: number; count: number }>;
} {
	const db = getDb();

	let query = `
		SELECT
			pc.model,
			COUNT(*) as count,
			SUM(pc.estimated_cost) as estimated,
			SUM(pc.actual_cost) as actual
		FROM platform_costs pc
		JOIN generations g ON pc.generation_id = g.id
		WHERE pc.created_at >= ? AND pc.created_at < ?
	`;

	const params: string[] = [startDate.toISOString(), endDate.toISOString()];

	if (userId) {
		query += " AND g.user_id = ?";
		params.push(userId);
	}

	query += " GROUP BY pc.model";

	const results = db.prepare(query).all(...params) as Array<{
		model: string;
		count: number;
		estimated: number | null;
		actual: number | null;
	}>;

	const costByModel: Record<string, { estimated: number; actual: number; count: number }> = {};
	let totalEstimated = 0;
	let totalActual = 0;
	let totalGenerations = 0;

	for (const row of results) {
		costByModel[row.model] = {
			estimated: row.estimated || 0,
			actual: row.actual || 0,
			count: row.count,
		};
		totalEstimated += row.estimated || 0;
		totalActual += row.actual || row.estimated || 0;
		totalGenerations += row.count;
	}

	return {
		totalEstimated,
		totalActual,
		totalGenerations,
		avgCostPerGeneration: totalGenerations > 0 ? totalActual / totalGenerations : 0,
		costByModel,
	};
}

// Calculate what to charge a user for a generation
export function calculateUserCharge(
	userId: string,
	platformCost: number,
	model: string,
): {
	chargeAmount: number;
	isOverage: boolean;
	overageAmount: number;
} {
	const db = getDb();

	// Get user's subscription
	const subscription = db
		.prepare(`
			SELECT
				sp.monthly_cost_limit,
				sp.overage_price_cents
			FROM user_subscriptions us
			JOIN subscription_products sp ON us.product_id = sp.id
			WHERE us.user_id = ? AND us.status = 'active'
			ORDER BY us.created_at DESC
			LIMIT 1
		`)
		.get(userId) as
		| {
				monthly_cost_limit: number | null;
				overage_price_cents: number;
		  }
		| undefined;

	// If no subscription, charge full price with markup
	if (!subscription) {
		const markup = 1.5; // 50% markup for non-subscribers
		return {
			chargeAmount: Math.ceil(platformCost * markup * 100), // Convert to cents
			isOverage: true,
			overageAmount: Math.ceil(platformCost * markup * 100),
		};
	}

	// Get current month usage
	const now = new Date();
	const yearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
	const usage = db
		.prepare(`
			SELECT total_cost
			FROM usage_monthly
			WHERE user_id = ? AND year_month = ?
		`)
		.get(userId, yearMonth) as { total_cost: number } | undefined;

	const currentUsage = usage?.total_cost || 0;
	const limit = subscription.monthly_cost_limit || 0;

	// Check if this would exceed the limit
	if (limit > 0 && currentUsage + platformCost > limit) {
		// Calculate overage
		const withinLimit = Math.max(0, limit - currentUsage);
		const overage = platformCost - withinLimit;
		const overageCharge = overage * (subscription.overage_price_cents / 100);

		return {
			chargeAmount: Math.ceil(overageCharge * 100),
			isOverage: true,
			overageAmount: Math.ceil(overageCharge * 100),
		};
	}

	// Within limits - no additional charge
	return {
		chargeAmount: 0,
		isOverage: false,
		overageAmount: 0,
	};
}

// Start a periodic reconciliation job
let reconciliationInterval: ReturnType<typeof setInterval> | null = null;

export function startReconciliationJob(
	intervalMs = 60 * 60 * 1000,
): ReturnType<typeof setInterval> {
	if (reconciliationInterval) {
		clearInterval(reconciliationInterval);
	}

	// Run immediately, then periodically
	reconcileAllCosts().catch(console.error);

	reconciliationInterval = setInterval(() => {
		reconcileAllCosts().catch(console.error);
	}, intervalMs);

	console.log(`Cost reconciliation job started (interval: ${intervalMs / 1000}s)`);

	return reconciliationInterval;
}

export function stopReconciliationJob(): void {
	if (reconciliationInterval) {
		clearInterval(reconciliationInterval);
		reconciliationInterval = null;
		console.log("Cost reconciliation job stopped");
	}
}
