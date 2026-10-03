import { useCallback, useEffect, useState } from "react";
import { API_BASE } from "../config";
import type {
	GenerateErrorCode,
	GenerateRequest,
	GenerateResponse,
	GenerationPhase,
	HistoryResponse,
	ModelsResponse,
	Thread,
	ThreadsResponse,
} from "../types";

function getAuthHeaders(token: string | null, includeContentType = true): HeadersInit {
	const headers: HeadersInit = {};
	if (includeContentType) {
		headers["Content-Type"] = "application/json";
	}
	if (token) {
		headers.Authorization = `Bearer ${token}`;
	}
	return headers;
}

/** Map a non-JSON or code-less failure onto a code the UI knows how to explain. */
function fallbackErrorCode(status: number): GenerateErrorCode {
	if (status === 401) return "UNAUTHORIZED";
	if (status === 402) return "INSUFFICIENT_CREDITS";
	if (status === 429) return "RATE_LIMITED";
	if (status === 503) return "GPU_BUSY";
	if (status === 504) return "GENERATION_TIMEOUT";
	return "GENERATION_FAILED";
}

/** The server's live status of one in-flight request (see server/services/generation-status.ts). */
export interface GenerationStatusResponse {
	phase: GenerationPhase;
	waitingForMs?: number;
	renderingForMs?: number;
}

/** GET /api/generate/status/:id. Null when unknown yet, expired, or the call failed. */
export async function fetchGenerationStatus(
	token: string | null,
	clientRequestId: string,
): Promise<GenerationStatusResponse | null> {
	try {
		const res = await fetch(`${API_BASE}/api/generate/status/${clientRequestId}`, {
			headers: getAuthHeaders(token, false),
		});
		if (!res.ok) return null;
		return (await res.json()) as GenerationStatusResponse;
	} catch {
		return null;
	}
}

/**
 * POST /api/generate. Never throws: a failure comes back as a `status: "failed"`
 * response carrying a `code`, so callers branch on the code (paywall, retry,
 * settings) instead of showing server text.
 *
 * Stateless on purpose: several generations run at once, so loading and errors
 * live on each queue item (see useGenerationQueue), not in this hook.
 */
export function useGenerate(token: string | null) {
	const generate = useCallback(
		async (
			request: GenerateRequest & {
				tool?: string;
				image?: string;
				threadId?: string;
				clientRequestId?: string;
			},
		): Promise<GenerateResponse> => {
			const failed = (
				code: GenerateErrorCode,
				extra: Partial<GenerateResponse> = {},
			): GenerateResponse => ({
				id: "",
				status: "failed",
				code,
				...extra,
			});

			try {
				// Tools (upscale, remove background) run on one image through their own endpoint.
				const response = request.tool
					? await fetch(`${API_BASE}/api/tools/${request.tool}`, {
							method: "POST",
							headers: getAuthHeaders(token),
							body: JSON.stringify({
								image: request.image,
								threadId: request.threadId,
								clientRequestId: request.clientRequestId,
							}),
						})
					: await fetch(`${API_BASE}/api/generate`, {
							method: "POST",
							headers: getAuthHeaders(token),
							body: JSON.stringify(request),
						});

				const data = (await response.json().catch(() => null)) as Partial<GenerateResponse> | null;

				if (!response.ok || !data || data.status === "failed") {
					return failed(data?.code ?? fallbackErrorCode(response.status), {
						error: data?.error,
						creditCost: data?.creditCost,
						availableCredits: data?.availableCredits,
					});
				}

				return data as GenerateResponse;
			} catch (err) {
				return failed("NETWORK_ERROR", { error: err instanceof Error ? err.message : String(err) });
			}
		},
		[token],
	);

	return { generate };
}

export function useEnhancePrompt(token: string | null) {
	const enhance = useCallback(
		async (prompt: string, hasImages?: boolean): Promise<string> => {
			const response = await fetch(`${API_BASE}/api/enhance-prompt`, {
				method: "POST",
				headers: getAuthHeaders(token),
				body: JSON.stringify({ prompt, hasImages }),
			});

			const data = await response.json();

			if (!response.ok) {
				throw new Error(data.error || "Enhancement failed");
			}

			return data.enhanced;
		},
		[token],
	);

	return { enhance };
}

/**
 * GET /api/models: the picker catalog (every visible model, locked ones flagged
 * `allowed: false`), per-tier credit tables and the tools. Pass the token to get
 * the plan flags for the signed-in user.
 */
export function useModels(token?: string | null) {
	const [models, setModels] = useState<ModelsResponse["models"]>([]);
	const [tools, setTools] = useState<NonNullable<ModelsResponse["tools"]>>([]);
	const [loading, setLoading] = useState(false);

	const fetchModels = useCallback(async () => {
		setLoading(true);
		try {
			const response = await fetch(`${API_BASE}/api/models`, { headers: getAuthHeaders(token ?? null, false) });
			// A 429/500 body has no `models`; keep the last good list instead of crashing on undefined.
			if (!response.ok) return;
			const data = (await response.json()) as ModelsResponse;
			if (Array.isArray(data.models)) setModels(data.models);
			if (Array.isArray(data.tools)) setTools(data.tools);
		} catch (err) {
			console.error("Failed to fetch models:", err);
		} finally {
			setLoading(false);
		}
	}, [token]);

	return { models, tools, fetchModels, loading };
}

export function useHistory(token: string | null) {
	const [history, setHistory] = useState<HistoryResponse | null>(null);
	const [loading, setLoading] = useState(false);
	const [currentPage, setCurrentPage] = useState(1);

	// Fetch history (replaces existing data - use for initial load or filter changes)
	const fetchHistory = useCallback(
		async (page = 1, limit = 20, trash = false, archived = false) => {
			if (!token) return;

			setLoading(true);
			setCurrentPage(page);
			try {
				const response = await fetch(
					`${API_BASE}/api/history?page=${page}&limit=${limit}&trash=${trash}&archived=${archived}`,
					{ headers: getAuthHeaders(token) },
				);
				if (!response.ok) return;
				const data = (await response.json()) as HistoryResponse;
				setHistory(data);
			} catch (err) {
				console.error("Failed to fetch history:", err);
			} finally {
				setLoading(false);
			}
		},
		[token],
	);

	// Fetch more history (appends to existing data - use for infinite scroll)
	const fetchMoreHistory = useCallback(
		async (limit = 20, trash = false, archived = false) => {
			if (!token || loading || !history) return;

			// Check if there are more items to load
			const loadedCount = history.generations.length;
			if (loadedCount >= history.total) return;

			const nextPage = currentPage + 1;
			setLoading(true);
			try {
				const response = await fetch(
					`${API_BASE}/api/history?page=${nextPage}&limit=${limit}&trash=${trash}&archived=${archived}`,
					{ headers: getAuthHeaders(token) },
				);
				if (!response.ok) return;
				const data = (await response.json()) as HistoryResponse;

				// Append new generations to existing ones
				setHistory((prev) => {
					if (!prev) return data;
					return {
						...data,
						generations: [...prev.generations, ...data.generations],
					};
				});
				setCurrentPage(nextPage);
			} catch (err) {
				console.error("Failed to fetch more history:", err);
			} finally {
				setLoading(false);
			}
		},
		[token, loading, history, currentPage],
	);

	// Reset history (for when filters change)
	const resetHistory = useCallback(() => {
		setHistory(null);
		setCurrentPage(1);
	}, []);

	const trashGeneration = useCallback(
		async (id: string) => {
			if (!token) return false;
			try {
				const response = await fetch(`${API_BASE}/api/history/${id}`, {
					method: "PATCH",
					headers: getAuthHeaders(token),
					body: JSON.stringify({ deleted: true }),
				});
				return response.ok;
			} catch (err) {
				console.error("Failed to trash generation:", err);
				return false;
			}
		},
		[token],
	);

	const restoreGeneration = useCallback(
		async (id: string) => {
			if (!token) return false;
			try {
				const response = await fetch(`${API_BASE}/api/history/${id}`, {
					method: "PATCH",
					headers: getAuthHeaders(token),
					body: JSON.stringify({ deleted: false }),
				});
				return response.ok;
			} catch (err) {
				console.error("Failed to restore generation:", err);
				return false;
			}
		},
		[token],
	);

	const archiveGeneration = useCallback(
		async (id: string) => {
			if (!token) return false;
			try {
				const response = await fetch(`${API_BASE}/api/history/${id}/archive`, {
					method: "PATCH",
					headers: getAuthHeaders(token),
					body: JSON.stringify({ archived: true }),
				});
				return response.ok;
			} catch (err) {
				console.error("Failed to archive generation:", err);
				return false;
			}
		},
		[token],
	);

	const unarchiveGeneration = useCallback(
		async (id: string) => {
			if (!token) return false;
			try {
				const response = await fetch(`${API_BASE}/api/history/${id}/archive`, {
					method: "PATCH",
					headers: getAuthHeaders(token),
					body: JSON.stringify({ archived: false }),
				});
				return response.ok;
			} catch (err) {
				console.error("Failed to unarchive generation:", err);
				return false;
			}
		},
		[token],
	);

	const deleteGeneration = useCallback(
		async (id: string) => {
			if (!token) return false;
			try {
				const response = await fetch(`${API_BASE}/api/history/${id}`, {
					method: "DELETE",
					headers: getAuthHeaders(token, false),
				});
				return response.ok;
			} catch (err) {
				console.error("Failed to delete generation:", err);
				return false;
			}
		},
		[token],
	);

	return {
		history,
		fetchHistory,
		fetchMoreHistory,
		resetHistory,
		trashGeneration,
		restoreGeneration,
		archiveGeneration,
		unarchiveGeneration,
		deleteGeneration,
		loading,
	};
}

export function useUploads(token: string | null) {
	const [uploads, setUploads] = useState<import("../types").Upload[]>([]);
	const [loading, setLoading] = useState(false);

	const fetchUploads = useCallback(
		async (archived = false) => {
			if (!token) return;

			setLoading(true);
			try {
				const response = await fetch(`${API_BASE}/api/uploads?archived=${archived}`, {
					headers: getAuthHeaders(token),
				});
				if (!response.ok) return;
				const data = await response.json();
				setUploads(data.uploads);
			} catch (err) {
				console.error("Failed to fetch uploads:", err);
			} finally {
				setLoading(false);
			}
		},
		[token],
	);

	const archiveUpload = useCallback(
		async (id: string) => {
			if (!token) return false;
			try {
				const response = await fetch(`${API_BASE}/api/uploads/${id}/archive`, {
					method: "PATCH",
					headers: getAuthHeaders(token),
					body: JSON.stringify({ archived: true }),
				});
				return response.ok;
			} catch (err) {
				console.error("Failed to archive upload:", err);
				return false;
			}
		},
		[token],
	);

	const unarchiveUpload = useCallback(
		async (id: string) => {
			if (!token) return false;
			try {
				const response = await fetch(`${API_BASE}/api/uploads/${id}/archive`, {
					method: "PATCH",
					headers: getAuthHeaders(token),
					body: JSON.stringify({ archived: false }),
				});
				return response.ok;
			} catch (err) {
				console.error("Failed to unarchive upload:", err);
				return false;
			}
		},
		[token],
	);

	const deleteUpload = useCallback(
		async (id: string) => {
			if (!token) return false;
			try {
				const response = await fetch(`${API_BASE}/api/uploads/${id}`, {
					method: "DELETE",
					headers: getAuthHeaders(token, false),
				});
				return response.ok;
			} catch (err) {
				console.error("Failed to delete upload:", err);
				return false;
			}
		},
		[token],
	);

	return { uploads, fetchUploads, archiveUpload, unarchiveUpload, deleteUpload, loading };
}

export function useThreads(token: string | null) {
	const [threads, setThreads] = useState<Thread[]>([]);
	const [activeThread, setActiveThread] = useState<Thread | null>(null);
	const [loading, setLoading] = useState(false);

	// Clear threads when token changes (user logged out or switched accounts)
	useEffect(() => {
		setThreads([]);
		setActiveThread(null);
	}, [token]);

	const fetchThreads = useCallback(async () => {
		if (!token) return;

		setLoading(true);
		try {
			const response = await fetch(`${API_BASE}/api/threads`, {
				headers: getAuthHeaders(token),
			});
			if (!response.ok) return;
			const data = (await response.json()) as ThreadsResponse;
			setThreads(data.threads);
		} catch (err) {
			console.error("Failed to fetch threads:", err);
		} finally {
			setLoading(false);
		}
	}, [token]);

	const fetchThread = useCallback(
		async (threadId: string) => {
			if (!token) return null;

			setLoading(true);
			try {
				const response = await fetch(`${API_BASE}/api/threads/${threadId}`, {
					headers: getAuthHeaders(token),
				});
				if (!response.ok) return null;
				const data = (await response.json()) as Thread;
				setActiveThread(data);
				return data;
			} catch (err) {
				console.error("Failed to fetch thread:", err);
				return null;
			} finally {
				setLoading(false);
			}
		},
		[token],
	);

	const createThread = useCallback(
		async (title?: string, projectMetadata?: Record<string, unknown>) => {
			if (!token) return null;

			try {
				const response = await fetch(`${API_BASE}/api/threads`, {
					method: "POST",
					headers: getAuthHeaders(token),
					body: JSON.stringify({ title, projectMetadata }),
				});
				if (!response.ok) return null;
				const data = (await response.json()) as Thread;
				setThreads((prev) => [data, ...prev]);
				return data;
			} catch (err) {
				console.error("Failed to create thread:", err);
				return null;
			}
		},
		[token],
	);

	const renameThread = useCallback(
		async (threadId: string, title: string) => {
			if (!token) return false;

			try {
				const response = await fetch(`${API_BASE}/api/threads/${threadId}`, {
					method: "PATCH",
					headers: getAuthHeaders(token),
					body: JSON.stringify({ title }),
				});
				if (response.ok) {
					setThreads((prev) => prev.map((t) => (t.id === threadId ? { ...t, title } : t)));
					if (activeThread?.id === threadId) {
						setActiveThread((prev) => (prev ? { ...prev, title } : null));
					}
				}
				return response.ok;
			} catch (err) {
				console.error("Failed to rename thread:", err);
				return false;
			}
		},
		[token, activeThread],
	);

	const deleteThread = useCallback(
		async (threadId: string) => {
			if (!token) return false;

			try {
				const response = await fetch(`${API_BASE}/api/threads/${threadId}`, {
					method: "DELETE",
					headers: getAuthHeaders(token, false),
				});
				if (response.ok) {
					setThreads((prev) => prev.filter((t) => t.id !== threadId));
					if (activeThread?.id === threadId) {
						setActiveThread(null);
					}
				}
				return response.ok;
			} catch (err) {
				console.error("Failed to delete thread:", err);
				return false;
			}
		},
		[token, activeThread],
	);

	const deleteThreadWithOptions = useCallback(
		async (threadId: string, deletePhotos: boolean) => {
			if (!token) return false;

			try {
				const response = await fetch(
					`${API_BASE}/api/threads/${threadId}?deletePhotos=${deletePhotos}`,
					{
						method: "DELETE",
						headers: getAuthHeaders(token, false),
					},
				);
				if (response.ok) {
					if (deletePhotos) {
						// Thread was deleted - remove from list
						setThreads((prev) => prev.filter((t) => t.id !== threadId));
					} else {
						// Thread was archived - update in list
						setThreads((prev) =>
							prev.map((t) =>
								t.id === threadId ? { ...t, archivedAt: new Date().toISOString() } : t,
							),
						);
					}
					if (activeThread?.id === threadId) {
						setActiveThread(null);
					}
				}
				return response.ok;
			} catch (err) {
				console.error("Failed to delete thread:", err);
				return false;
			}
		},
		[token, activeThread],
	);

	const archiveThread = useCallback(
		async (threadId: string) => {
			if (!token) return false;

			try {
				const response = await fetch(`${API_BASE}/api/threads/${threadId}/archive`, {
					method: "POST",
					headers: getAuthHeaders(token, false),
				});
				if (response.ok) {
					setThreads((prev) =>
						prev.map((t) =>
							t.id === threadId ? { ...t, archivedAt: new Date().toISOString() } : t,
						),
					);
				}
				return response.ok;
			} catch (err) {
				console.error("Failed to archive thread:", err);
				return false;
			}
		},
		[token],
	);

	const unarchiveThread = useCallback(
		async (threadId: string) => {
			if (!token) return false;

			try {
				const response = await fetch(`${API_BASE}/api/threads/${threadId}/unarchive`, {
					method: "POST",
					headers: getAuthHeaders(token, false),
				});
				if (response.ok) {
					setThreads((prev) =>
						prev.map((t) => (t.id === threadId ? { ...t, archivedAt: undefined } : t)),
					);
				}
				return response.ok;
			} catch (err) {
				console.error("Failed to restore thread:", err);
				return false;
			}
		},
		[token],
	);

	const clearActiveThread = useCallback(() => {
		setActiveThread(null);
	}, []);

	return {
		threads,
		activeThread,
		setActiveThread,
		fetchThreads,
		fetchThread,
		createThread,
		renameThread,
		deleteThread,
		deleteThreadWithOptions,
		archiveThread,
		unarchiveThread,
		clearActiveThread,
		loading,
	};
}
