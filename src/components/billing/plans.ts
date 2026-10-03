import { getModelConfig } from "@/config/models";
import type { Plan } from "./api";

/** The plan we point people at when there's no better signal. */
export const RECOMMENDED_PLAN_NAME = "Creator";

/** "every month" / "every week" / "every day" from a refill interval in hours. */
export function refillCadence(hours: number | null | undefined): string {
	if (!hours || hours <= 0) return "every month";
	if (hours >= 24 * 28) return "every month";
	if (hours >= 24 * 7) return "every week";
	if (hours === 24) return "every day";
	if (hours > 24) return `every ${Math.round(hours / 24)} days`;
	return `every ${hours} hours`;
}

/** The next tier up from the current plan, or the recommended plan for free users. */
export function nextPlanUp(plans: Plan[], currentId: string | null | undefined, currentPrice = 0): Plan | null {
	if (plans.length === 0) return null;
	const current = plans.find((p) => p.id === currentId);
	const floor = current ? current.price : currentPrice;
	if (floor <= 0 && !current) {
		return plans.find((p) => p.name === RECOMMENDED_PLAN_NAME) ?? plans[Math.min(1, plans.length - 1)];
	}
	return plans.find((p) => p.price > floor) ?? null;
}

/** The cheapest plan that includes `modelId` (null allowedModels = every model). */
export function cheapestPlanWithModel(plans: Plan[], modelId: string): Plan | null {
	return plans.find((p) => p.allowedModels === null || p.allowedModels.includes(modelId)) ?? null;
}

/** About how many images `credits` buys at `costPerImage`. */
export function approxImages(credits: number, costPerImage: number): number {
	if (costPerImage <= 0) return credits;
	return Math.floor(credits / costPerImage);
}

export function modelName(modelId: string): string {
	return getModelConfig(modelId)?.name ?? modelId.split("/").pop() ?? modelId;
}

export function formatUsd(amount: number): string {
	return new Intl.NumberFormat("en-US", {
		style: "currency",
		currency: "USD",
		minimumFractionDigits: Number.isInteger(amount) ? 0 : 2,
	}).format(amount);
}

export function plural(n: number, word: string): string {
	return `${n} ${word}${n === 1 ? "" : "s"}`;
}
