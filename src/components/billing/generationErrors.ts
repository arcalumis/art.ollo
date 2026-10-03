import type { GenerateErrorCode } from "@/types";

export type ErrorAction = "retry" | "topUp" | "upgrade" | "settings";

export interface GenerationErrorCopy {
	title: string;
	detail: string;
	/** Actions offered besides Dismiss, most useful first. */
	actions: ErrorAction[];
}

interface ErrorContext {
	creditsNeeded?: number;
	balance?: number;
	modelName?: string;
}

const REFUNDED = "Your credits were refunded.";

/**
 * What to tell the user for each /api/generate error code. Branches on the code
 * only; the server's message text is never shown.
 */
export function describeGenerationError(code: GenerateErrorCode | undefined, ctx: ErrorContext = {}): GenerationErrorCopy {
	switch (code) {
		case "INSUFFICIENT_CREDITS": {
			const detail =
				ctx.creditsNeeded !== undefined && ctx.balance !== undefined
					? `This needs ${ctx.creditsNeeded} credits and you have ${ctx.balance}.`
					: "You don't have enough credits for this one.";
			return { title: "Not enough credits", detail, actions: ["topUp", "retry"] };
		}
		case "MODEL_NOT_ALLOWED":
			return {
				title: `${ctx.modelName ?? "This model"} isn't on your plan`,
				detail: "Upgrade to use it, or pick another model and try again.",
				actions: ["upgrade"],
			};
		case "MONTHLY_COST_LIMIT":
			return {
				title: "Generating is paused on this account",
				detail: "This account reached its monthly usage cap. It resets next month; contact support if you need it sooner.",
				actions: [],
			};
		case "INVALID_REQUEST":
			return {
				title: "Those settings weren't accepted",
				detail: "Check the prompt, size and format, then try again.",
				actions: ["retry"],
			};
		case "INVALID_IMAGE_INPUT":
			return {
				title: "A reference image couldn't be used",
				detail: "Remove it or upload it again, then retry.",
				actions: ["retry"],
			};
		case "GENERATION_TIMEOUT":
			return {
				title: "The model took too long",
				detail: `${REFUNDED} Try again, or switch to a faster model.`,
				actions: ["retry"],
			};
		case "GENERATION_CANCELED":
			return { title: "The generation was stopped", detail: `${REFUNDED} Try again.`, actions: ["retry"] };
		case "GENERATION_NO_OUTPUT":
			return {
				title: "The model returned no image",
				detail: `${REFUNDED} Rewording the prompt usually helps.`,
				actions: ["retry"],
			};
		case "API_KEY_UNREADABLE":
			return {
				title: "Your Replicate key can't be read",
				detail: "Remove it and add it again in Settings, then retry.",
				actions: ["settings", "retry"],
			};
		case "THREAD_NOT_FOUND":
			return {
				title: "This series no longer exists",
				detail: "It may have been deleted. Start a new series and try again.",
				actions: [],
			};
		case "RATE_LIMITED":
			return { title: "Too many requests at once", detail: "Wait a few seconds, then try again.", actions: ["retry"] };
		case "NETWORK_ERROR":
			return { title: "Couldn't reach ollo", detail: "Check your connection, then try again.", actions: ["retry"] };
		case "UNAUTHORIZED":
			return { title: "You've been signed out", detail: "Sign in again, then retry.", actions: [] };
		default:
			return {
				title: "The image didn't finish",
				detail: `${REFUNDED} Try again in a moment, or try another model.`,
				actions: ["retry"],
			};
	}
}

/** Codes that open the upgrade sheet on their own instead of only showing a message. */
export function opensPaywall(code: GenerateErrorCode | undefined): boolean {
	return code === "INSUFFICIENT_CREDITS" || code === "MODEL_NOT_ALLOWED";
}
