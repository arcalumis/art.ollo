/**
 * Input rules for admin mutations. Pure functions: each returns an error message (and code)
 * or the cleaned value, so routes answer 400 instead of writing bad data or throwing a 500.
 */
import { CATALOG, TIERS, type Tier } from "./model-catalog";

export type Check<T> = { ok: true; value: T } | { ok: false; code: string; error: string };

const fail = (code: string, error: string) => ({ ok: false as const, code, error });

export const MAX_CREDIT_ADJUSTMENT = 10_000;
export const MIN_BOOST_DAYS = 1;
export const MAX_BOOST_DAYS = 365;

/** A reason is required for every user-facing admin action: 3 to 500 characters. */
export function checkReason(value: unknown): Check<string> {
	const reason = typeof value === "string" ? value.trim() : "";
	if (reason.length < 3) return fail("REASON_REQUIRED", "Add a reason (at least 3 characters).");
	if (reason.length > 500) return fail("REASON_TOO_LONG", "Keep the reason under 500 characters.");
	return { ok: true, value: reason };
}

/** Credit grants/deductions: a non-zero integer within ±10,000. */
export function checkCreditAmount(value: unknown): Check<number> {
	if (typeof value !== "number" || !Number.isInteger(value) || value === 0) {
		return fail("INVALID_AMOUNT", "Enter a whole number of credits other than 0.");
	}
	if (Math.abs(value) > MAX_CREDIT_ADJUSTMENT) {
		return fail("AMOUNT_TOO_LARGE", `Adjust at most ${MAX_CREDIT_ADJUSTMENT.toLocaleString("en-US")} credits at a time.`);
	}
	return { ok: true, value };
}

export function checkBoostDays(value: unknown): Check<number> {
	const days = value === undefined ? 30 : value;
	if (typeof days !== "number" || !Number.isInteger(days) || days < MIN_BOOST_DAYS || days > MAX_BOOST_DAYS) {
		return fail("INVALID_DURATION", `Boosts last ${MIN_BOOST_DAYS} to ${MAX_BOOST_DAYS} days.`);
	}
	return { ok: true, value: days };
}

/** Credit-cost override: a positive integer (0 would make every reservation throw). */
export function checkCreditCost(value: unknown): Check<number> {
	if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 10_000) {
		return fail("INVALID_CREDIT_COST", "Credit cost must be a whole number from 1 to 10,000.");
	}
	return { ok: true, value };
}

/** Override keys are a catalog model id, or `<model>:<tier>` for a tier that model has. */
export function checkOverrideKey(key: string): Check<{ modelId: string; tier: Tier | null }> {
	const idx = key.lastIndexOf(":");
	const maybeTier = idx > 0 ? key.slice(idx + 1) : "";
	const isTier = (TIERS as string[]).includes(maybeTier);
	const modelId = isTier ? key.slice(0, idx) : key;
	const model = CATALOG.find((m) => m.id === modelId);
	if (!model) return fail("UNKNOWN_MODEL", "That model isn't in the catalog.");
	if (isTier && !model.tiers[maybeTier as Tier]) {
		return fail("UNKNOWN_TIER", `${model.name} has no ${maybeTier} tier.`);
	}
	return { ok: true, value: { modelId, tier: isTier ? (maybeTier as Tier) : null } };
}

export interface CreditPackageInput {
	name: string;
	credits: number;
	priceSol: number | null;
	priceCents: number | null;
	stripePriceId: string | null;
	availableForUsd: boolean;
	availableForSol: boolean;
	isActive: boolean;
}

/**
 * A credit pack's final state: credits a positive integer; a USD pack needs a positive integer
 * price in cents; a SOL pack needs a positive SOL price (a 0 price would sell credits for a dust
 * transfer). A pack sold only for USD does not need a SOL price; its SOL price is stored as 0.
 */
export function checkCreditPackage(input: CreditPackageInput): Check<CreditPackageInput> {
	const name = typeof input.name === "string" ? input.name.trim() : "";
	if (!name || name.length > 80) return fail("INVALID_NAME", "Give the pack a name (up to 80 characters).");
	if (!Number.isInteger(input.credits) || input.credits < 1 || input.credits > 1_000_000) {
		return fail("INVALID_CREDITS", "Credits must be a whole number from 1 to 1,000,000.");
	}
	if (!input.availableForUsd && !input.availableForSol) {
		return fail("NO_PAYMENT_METHOD", "Sell the pack for USD, SOL, or both.");
	}
	if (input.availableForUsd) {
		if (typeof input.priceCents !== "number" || !Number.isInteger(input.priceCents) || input.priceCents < 1) {
			return fail("INVALID_PRICE_CENTS", "A USD pack needs a price in whole cents above 0.");
		}
	}
	if (input.availableForSol) {
		if (typeof input.priceSol !== "number" || !Number.isFinite(input.priceSol) || input.priceSol <= 0) {
			return fail("INVALID_PRICE_SOL", "A SOL pack needs a SOL price above 0.");
		}
	}
	if (input.stripePriceId !== null && (typeof input.stripePriceId !== "string" || input.stripePriceId.length > 200)) {
		return fail("INVALID_STRIPE_PRICE", "Stripe price id is not valid.");
	}
	return {
		ok: true,
		value: {
			...input,
			name,
			priceSol: input.availableForSol ? input.priceSol : 0,
			priceCents: input.priceCents ?? null,
			stripePriceId: input.stripePriceId?.trim() || null,
		},
	};
}

const optionalNonNegative = (v: unknown) => v === undefined || v === null || (typeof v === "number" && Number.isFinite(v) && v >= 0);
const optionalNonNegativeInt = (v: unknown) => v === undefined || v === null || (typeof v === "number" && Number.isInteger(v) && v >= 0);

/** Light sanity checks on a plan edit (only the fields present). */
export function checkProductFields(body: Record<string, unknown>, creating: boolean): Check<null> {
	if (creating || body.name !== undefined) {
		if (typeof body.name !== "string" || !body.name.trim() || body.name.length > 80) {
			return fail("INVALID_NAME", "Give the plan a name (up to 80 characters).");
		}
	}
	for (const f of ["price", "priceSol", "monthlyCostLimit"]) {
		if (!optionalNonNegative(body[f])) return fail("INVALID_FIELD", `${f} must be a number 0 or above.`);
	}
	for (const f of ["monthlyImageLimit", "dailyImageLimit", "bonusCredits", "creditRefillAmount"]) {
		if (!optionalNonNegativeInt(body[f])) return fail("INVALID_FIELD", `${f} must be a whole number 0 or above.`);
	}
	if (body.topoffIntervalHours !== undefined) {
		const h = body.topoffIntervalHours;
		if (typeof h !== "number" || !Number.isInteger(h) || h < 1 || h > 24 * 366) {
			return fail("INVALID_FIELD", "Refill interval must be 1 hour to a year.");
		}
	}
	if (body.allowedModels !== undefined && body.allowedModels !== null) {
		if (!Array.isArray(body.allowedModels) || !body.allowedModels.every((m) => typeof m === "string")) {
			return fail("INVALID_FIELD", "allowedModels must be a list of model ids or null.");
		}
	}
	return { ok: true, value: null };
}
