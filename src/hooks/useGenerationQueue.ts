import { useCallback, useMemo, useRef, useState } from "react";
import { opensPaywall } from "../components/billing/generationErrors";
import { usePaywall } from "../contexts/PaywallContext";
import type { GenerateRequest, GenerateResponse, ModelsResponse, QueuedGeneration } from "../types";
import { useGenerate } from "./useApi";

/** Image tools that run on one existing image. */
export type ImageTool = "upscale" | "remove-background";

/**
 * What goes to POST /api/generate. The body shape is owned by the generate
 * endpoint; the queue only carries it, so it stays open-ended here.
 */
export type QueueRequest = GenerateRequest & {
	threadId?: string;
	variation?: boolean;
	parameters?: Record<string, unknown>;
};

/** One queue row: what the user sees plus the request needed to retry it. */
export interface QueueEntry extends QueuedGeneration {
	request: QueueRequest;
}

export interface QueueFailure {
	error?: string;
	errorCode?: QueuedGeneration["errorCode"];
	creditsNeeded?: number;
	balanceAtFailure?: number;
}

export type QueueAction =
	| { type: "add"; entry: QueueEntry }
	| { type: "start"; id: string; startedAt: string; estimatedDuration: number }
	| { type: "fail"; id: string; failure: QueueFailure }
	| { type: "retry"; id: string; createdAt: string }
	| { type: "remove"; id: string };

/** Pure queue transitions; newest first. Unknown ids leave the queue unchanged. */
export function queueReducer(state: QueueEntry[], action: QueueAction): QueueEntry[] {
	switch (action.type) {
		case "add":
			return [action.entry, ...state];
		case "start":
			return state.map((e) =>
				e.id === action.id
					? {
							...e,
							status: "generating",
							startedAt: action.startedAt,
							estimatedDuration: action.estimatedDuration,
						}
					: e,
			);
		case "fail":
			return state.map((e) =>
				e.id === action.id ? { ...e, status: "failed", ...action.failure } : e,
			);
		case "retry":
			return state.map((e) =>
				e.id === action.id
					? {
							...e,
							status: "queued",
							createdAt: action.createdAt,
							error: undefined,
							errorCode: undefined,
							creditsNeeded: undefined,
							balanceAtFailure: undefined,
						}
					: e,
			);
		case "remove":
			return state.filter((e) => e.id !== action.id);
	}
}

/** The image a tool runs on. */
export interface ToolSource {
	id: string;
	imageUrl?: string;
	prompt: string;
}

export interface ToolContext {
	threadId?: string;
	aspectRatio?: string;
	outputFormat?: string;
}

/**
 * The request for an image tool. Today Upscale re-renders the image at 4K with
 * FLUX 2 Dev (the behaviour before tools existed). When the tool endpoint
 * lands (`parameters.tool`), this is the one place to switch.
 */
export function buildToolRequest(
	source: ToolSource,
	tool: ImageTool,
	ctx: ToolContext,
): QueueRequest | null {
	if (!source.imageUrl) return null;
	if (tool !== "upscale") return null;
	return {
		prompt: source.prompt,
		model: "black-forest-labs/flux-2-dev",
		imageInputs: [source.imageUrl],
		aspectRatio: ctx.aspectRatio,
		resolution: "4K",
		outputFormat: ctx.outputFormat,
		threadId: ctx.threadId,
	};
}

export interface EnqueueSpec {
	/** Shown on the queue row while it runs (the prompt, or "Variations of: …"). */
	label: string;
	model: string;
	threadId?: string;
	request: QueueRequest;
}

interface UseGenerationQueueOptions {
	token: string | null;
	models: ModelsResponse["models"];
	/** After a success: refresh the series and the library. */
	onSucceeded?: (result: GenerateResponse, entry: QueueEntry) => void;
	/** After every attempt, success or not: the balance may have changed. */
	onSettled?: () => void;
	/** For failures that are fixed in settings (an unreadable own API key). */
	onOpenSettings?: () => void;
	/** Finds an image by id for runTool, plus the context its request needs. */
	resolveToolSource?: (imageId: string) => { source: ToolSource; ctx: ToolContext } | null;
}

/**
 * One queue for every way of making an image: generate, vary, tools. Each row
 * carries its own status and error, with Retry and Dismiss on the row. Error
 * codes that need a purchase or an upgrade open the paywall over the work.
 */
export function useGenerationQueue({
	token,
	models,
	onSucceeded,
	onSettled,
	onOpenSettings,
	resolveToolSource,
}: UseGenerationQueueOptions) {
	const { generate } = useGenerate(token);
	const paywall = usePaywall();
	const [entries, setEntries] = useState<QueueEntry[]>([]);
	const entriesRef = useRef(entries);
	const inFlight = useRef(new Set<string>());

	// Callers pass fresh closures every render; read them through a ref so the
	// queue functions stay stable and an in-flight request sees the latest ones.
	const latest = useRef({
		models,
		onSucceeded,
		onSettled,
		onOpenSettings,
		resolveToolSource,
		generate,
		paywall,
	});
	latest.current = {
		models,
		onSucceeded,
		onSettled,
		onOpenSettings,
		resolveToolSource,
		generate,
		paywall,
	};

	const dispatch = useCallback((action: QueueAction) => {
		entriesRef.current = queueReducer(entriesRef.current, action);
		setEntries(entriesRef.current);
	}, []);

	const run = useCallback(
		async (entry: QueueEntry) => {
			if (inFlight.current.has(entry.id)) return;
			inFlight.current.add(entry.id);
			const ctx = latest.current;

			const modelInfo = ctx.models.find((m) => m.id === entry.model);
			// A few seconds over the average so the bar stays ahead of the real finish.
			const estimatedDuration = (modelInfo?.avgGenerationTime || 30) + 3;
			dispatch({
				type: "start",
				id: entry.id,
				startedAt: new Date().toISOString(),
				estimatedDuration,
			});

			// useGenerate never throws: failures come back with a code.
			const result = await ctx.generate(entry.request);
			inFlight.current.delete(entry.id);
			const after = latest.current;
			// Success charges credits; failures may have refunded them. Either way the pill updates.
			after.onSettled?.();

			if (result.status === "succeeded") {
				dispatch({ type: "remove", id: entry.id });
				after.onSucceeded?.(result, entry);
				return;
			}

			dispatch({
				type: "fail",
				id: entry.id,
				failure: {
					error: result.error,
					errorCode: result.code,
					creditsNeeded: result.creditCost,
					balanceAtFailure: result.availableCredits,
				},
			});

			// Out of credits or outside the plan: offer the way forward over the work.
			if (opensPaywall(result.code)) {
				after.paywall.open(
					result.code === "MODEL_NOT_ALLOWED"
						? { reason: "model_not_allowed", modelId: entry.request.model ?? entry.model }
						: {
								reason: "insufficient_credits",
								needed: result.creditCost,
								balance: result.availableCredits,
							},
				);
			}
		},
		[dispatch],
	);

	const enqueue = useCallback(
		(spec: EnqueueSpec): string => {
			const entry: QueueEntry = {
				id: crypto.randomUUID(),
				prompt: spec.label,
				model: spec.model,
				status: "queued",
				createdAt: new Date().toISOString(),
				threadId: spec.threadId,
				request: spec.request,
			};
			dispatch({ type: "add", entry });
			void run(entry);
			return entry.id;
		},
		[dispatch, run],
	);

	const retry = useCallback(
		(id: string) => {
			const entry = entriesRef.current.find((e) => e.id === id);
			if (!entry || entry.status !== "failed") return;
			dispatch({ type: "retry", id, createdAt: new Date().toISOString() });
			void run({ ...entry, status: "queued" });
		},
		[dispatch, run],
	);

	const dismiss = useCallback((id: string) => dispatch({ type: "remove", id }), [dispatch]);

	/** Run an image tool on one image. Returns false when the image can't be found. */
	const runTool = useCallback(
		(imageId: string, tool: ImageTool): boolean => {
			const found = latest.current.resolveToolSource?.(imageId);
			if (!found) return false;
			const request = buildToolRequest(found.source, tool, found.ctx);
			if (!request) return false;
			enqueue({
				label: found.source.prompt,
				model: request.model ?? "black-forest-labs/flux-2-dev",
				threadId: found.ctx.threadId,
				request,
			});
			return true;
		},
		[enqueue],
	);

	// Rows for the feed and gallery, with their actions attached (the existing
	// QueuedGeneration contract those components render).
	const items = useMemo<QueuedGeneration[]>(
		() =>
			entries.map(({ request: _request, ...item }) =>
				item.status === "failed"
					? {
							...item,
							onRetry: () => retry(item.id),
							onDismiss: () => dismiss(item.id),
							onOpenSettings: () => latest.current.onOpenSettings?.(),
						}
					: item,
			),
		[entries, retry, dismiss],
	);

	const busy = entries.some((e) => e.status === "generating" || e.status === "queued");

	return { items, enqueue, retry, dismiss, runTool, busy };
}
