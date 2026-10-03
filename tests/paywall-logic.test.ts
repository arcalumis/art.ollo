import { describe, expect, test } from "bun:test";
import { describeGenerationError, opensPaywall } from "../src/components/billing/generationErrors";
import {
	approxImages,
	cheapestPlanWithModel,
	nextPlanUp,
	type Plan,
	purchasablePlans,
	refillCadence,
} from "../src/components/billing/plans";
import type { GenerateErrorCode } from "../src/types";

function plan(name: string, price: number, extra: Partial<Plan> = {}): Plan {
	return {
		id: `id-${name}`,
		name,
		description: null,
		creditRefillAmount: 0,
		topoffIntervalHours: 720,
		bonusCredits: 0,
		price,
		priceSol: null,
		availableForUsd: true,
		availableForSol: false,
		stripePriceId: `price_${name}`,
		allowedModels: null,
		...extra,
	};
}

const starter = plan("Starter", 9, { allowedModels: ["a", "b"] });
const creator = plan("Creator", 19, { allowedModels: ["a", "b", "c"] });
const pro = plan("Pro", 39);

describe("plan selection", () => {
	test("purchasablePlans drops $0 and non-card products and sorts by price", () => {
		const junk = plan("Test", 0);
		const solOnly = plan("Sol", 5, { availableForUsd: false });
		const noPrice = plan("NoPrice", 7, { stripePriceId: null });
		expect(purchasablePlans([pro, junk, starter, solOnly, creator, noPrice]).map((p) => p.name)).toEqual([
			"Starter",
			"Creator",
			"Pro",
		]);
	});

	test("free users are pointed at Creator; paid users at the next tier up", () => {
		const plans = [starter, creator, pro];
		expect(nextPlanUp(plans, null, 0)?.name).toBe("Creator");
		expect(nextPlanUp(plans, "free-product-id", 0)?.name).toBe("Creator");
		expect(nextPlanUp(plans, starter.id)?.name).toBe("Creator");
		expect(nextPlanUp(plans, creator.id)?.name).toBe("Pro");
		expect(nextPlanUp(plans, pro.id)).toBeNull();
	});

	test("the cheapest plan that unlocks a model", () => {
		const plans = [starter, creator, pro];
		expect(cheapestPlanWithModel(plans, "c")?.name).toBe("Creator");
		expect(cheapestPlanWithModel(plans, "z")?.name).toBe("Pro");
	});

	test("refill cadence and image counts", () => {
		expect(refillCadence(720)).toBe("every month");
		expect(refillCadence(168)).toBe("every week");
		expect(refillCadence(24)).toBe("every day");
		expect(approxImages(200, 2)).toBe(100);
		expect(approxImages(75, 2)).toBe(37);
	});
});

describe("generation error copy", () => {
	const codes: GenerateErrorCode[] = [
		"INSUFFICIENT_CREDITS",
		"MODEL_NOT_ALLOWED",
		"MONTHLY_COST_LIMIT",
		"INVALID_REQUEST",
		"INVALID_IMAGE_INPUT",
		"GENERATION_TIMEOUT",
		"GENERATION_CANCELED",
		"GENERATION_NO_OUTPUT",
		"GENERATION_FAILED",
		"GPU_BUSY",
		"API_KEY_UNREADABLE",
		"NETWORK_ERROR",
	];

	test("every code has its own specific message", () => {
		const titles = codes.map((c) => describeGenerationError(c).title);
		expect(new Set(titles).size).toBe(codes.length);
	});

	test("the shortfall is stated in plain words", () => {
		const copy = describeGenerationError("INSUFFICIENT_CREDITS", { creditsNeeded: 4, balance: 1 });
		expect(copy.detail).toBe("This needs 4 credits and you have 1.");
		expect(copy.actions).toContain("topUp");
	});

	test("internal numbers never appear in the cost-limit message", () => {
		expect(describeGenerationError("MONTHLY_COST_LIMIT").detail).not.toMatch(/\$|\d/);
	});

	test("only credit and plan problems open the paywall", () => {
		expect(opensPaywall("INSUFFICIENT_CREDITS")).toBe(true);
		expect(opensPaywall("MODEL_NOT_ALLOWED")).toBe(true);
		expect(opensPaywall("GENERATION_TIMEOUT")).toBe(false);
		expect(opensPaywall(undefined)).toBe(false);
	});
});
