import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { ChatFeed } from "./components/ChatFeed";
import { CreationPanel, type CreationOptions } from "./components/CreationPanel";
import { GenerationStatus } from "./components/GenerationStatus";
import { ImageGallery } from "./components/ImageGallery";
import { MagicLinkVerify } from "./components/MagicLinkVerify";
import { ResetPasswordPage } from "./components/ResetPasswordPage";
import { Sidebar } from "./components/Sidebar";
import { ThemeSwitcher } from "./components/ThemeSwitcher";
import { ThreadDeleteDialog } from "./components/ThreadDeleteDialog";
import { UserSettings } from "./components/UserSettings";
import { ModelsHelpButton, ModelsReferenceModal } from "./components/ModelsReferenceModal";
import { LoginPage } from "./components/auth/LoginPage";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { fallbackCreditCost, isVariationModel } from "./config/models";
import { STARTER_PROMPTS, WelcomeScreen } from "./components/WelcomeScreen";
import { type PendingPrompt, takePendingPrompt } from "./lib/pendingPrompt";
import { CreditPill } from "./components/brand/CreditPill";
import { opensPaywall } from "./components/billing/generationErrors";
import { useCheckoutReturn } from "./components/billing/hooks";
import { PaywallSheet } from "./components/billing/PaywallSheet";
import { usePaywall } from "./contexts/PaywallContext";
import { AuthProvider, useAuth } from "./contexts/AuthContext";
import { useEnhancePrompt, useGenerate, useHistory, useModels, useThreads, useUploads } from "./hooks/useApi";
import { useTutorial, useUserApiKey, useUserSubscription, useUserUsage } from "./hooks/useUserSettings";
import { AdminLayout } from "./pages/AdminLayout";
import { Billing } from "./pages/Billing";
import { Landing } from "./pages/Landing";
import { Pricing } from "./pages/Pricing";
import { NotFound } from "./pages/NotFound";
import { Privacy } from "./pages/Privacy";
import { Terms } from "./pages/Terms";

// Lazy load admin pages - these are only loaded when admin navigates to them
const AdminCosts = lazy(() => import("./pages/AdminCosts"));
const AdminCreditPackages = lazy(() => import("./pages/AdminCreditPackages"));
const AdminDashboard = lazy(() => import("./pages/AdminDashboard"));
const AdminFinancials = lazy(() => import("./pages/AdminFinancials"));
const AdminMetrics = lazy(() => import("./pages/AdminMetrics"));
const AdminModels = lazy(() => import("./pages/AdminModels"));
const AdminPnL = lazy(() => import("./pages/AdminPnL"));
const AdminProducts = lazy(() => import("./pages/AdminProducts"));
const AdminRevenue = lazy(() => import("./pages/AdminRevenue"));
const AdminUsers = lazy(() => import("./pages/AdminUsers"));

// Loading fallback for lazy-loaded admin pages
function AdminLoading() {
	return (
		<div className="flex items-center justify-center p-8">
			<div className="text-[var(--text-secondary)] mono">Loading<span className="cursor-blink">_</span></div>
		</div>
	);
}

import type { Generation, QueuedGeneration, Thread } from "./types";
import "./App.css";

// Design-system reference, compiled out of production builds.
const Styleguide = import.meta.env.DEV
	? lazy(() => import("./pages/Styleguide").then((m) => ({ default: m.Styleguide })))
	: null;

function MainApp() {
	const { user, token, loading: authLoading, updateUser, logout } = useAuth();
	const { completeTutorial } = useTutorial(token);
	const location = useLocation();
	const [selectedModel, setSelectedModel] = useState("black-forest-labs/flux-2-dev");
	const [imageInputs, setImageInputs] = useState<string[]>([]);
	const [showTrash] = useState(false);
	const [showArchived] = useState(false);
	const [showSettings, setShowSettings] = useState(false);
	const [creationOptions, setCreationOptions] = useState<CreationOptions>({
		aspectRatio: "4:3",
		resolution: "2K",
		outputFormat: "png",
	});
	const [viewMode, setViewMode] = useState<"gallery" | "chat" | "billing">(
		() => (localStorage.getItem("viewMode") as "gallery" | "chat" | "billing") || "chat",
	);
	const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
	const chatContainerRef = useRef<HTMLDivElement>(null);

	// Generation queue
	const [generationQueue, setGenerationQueue] = useState<QueuedGeneration[]>([]);
	const processingRef = useRef<Set<string>>(new Set());

	const { generate, loading: generating } = useGenerate(token);
	const paywall = usePaywall();
	const { enhance: enhancePrompt } = useEnhancePrompt(token);
	const { models, fetchModels } = useModels();
	const {
		threads,
		activeThread,
		fetchThreads,
		fetchThread,
		renameThread,
		deleteThreadWithOptions,
		clearActiveThread,
		loading: threadsLoading,
	} = useThreads(token);

	// Thread delete dialog state
	const [threadToDelete, setThreadToDelete] = useState<Thread | null>(null);
	const [showDeleteDialog, setShowDeleteDialog] = useState(false);

	// Models reference modal state
	const [showModelsRef, setShowModelsRef] = useState(false);
	const {
		history,
		fetchHistory,
		fetchMoreHistory,
		trashGeneration,
		restoreGeneration,
		archiveGeneration,
		unarchiveGeneration,
		deleteGeneration,
		loading: historyLoading,
	} = useHistory(token);
	const { uploads, fetchUploads, archiveUpload, unarchiveUpload, deleteUpload } = useUploads(token);
	const { usage: userUsage, fetchUsage: fetchUserUsage } = useUserUsage(token);
	const { subscription: userSubscription, fetchSubscription: fetchUserSubscription } = useUserSubscription(token);
	const { apiKeyInfo, fetchApiKey } = useUserApiKey(token);
	const balance = userUsage?.availableCredits ?? null;

	// Purchases (SOL in the sheet, or a return from Stripe) change the balance and maybe the plan.
	const refreshCredits = useCallback(() => {
		fetchUserUsage();
		fetchUserSubscription();
	}, [fetchUserUsage, fetchUserSubscription]);
	useCheckoutReturn(refreshCredits);
	// Own-key generations cost no credits, so the prompt bar shows no credit cost for them.
	useEffect(() => {
		if (token) fetchApiKey();
	}, [token, fetchApiKey]);
	useEffect(() => {
		if (paywall.creditsVersion > 0) refreshCredits();
	}, [paywall.creditsVersion, refreshCredits]);

	const selectedModelInfo = models.find((m) => m.id === selectedModel);
	const supportsImageInput = selectedModelInfo?.supportsImageInput || false;
	// Cost of one Generate press at the current model: server price, config fallback while loading.
	const perImageCost = selectedModelInfo?.creditCost ?? fallbackCreditCost(selectedModel);
	const outputsPerGenerate = isVariationModel(selectedModel) ? 4 : 1;
	const currentTotalCost = apiKeyInfo?.hasKey ? 0 : perImageCost * outputsPerGenerate;

	// Get generations to display - either from active thread or empty for welcome screen
	const displayGenerations = activeThread?.generations || [];
	const showWelcome = !threadsLoading && !activeThread && threads.length === 0 && generationQueue.length === 0;

	// Helper to refresh history with current filters
	const refreshHistory = useCallback(() => {
		fetchHistory(1, 20, showTrash, showArchived);
	}, [fetchHistory, showTrash, showArchived]);

	// Process a single queued generation
	const processGeneration = useCallback(
		async (queueItem: QueuedGeneration, request: Parameters<typeof generate>[0]) => {
			if (processingRef.current.has(queueItem.id)) return;
			processingRef.current.add(queueItem.id);

			const modelInfo = models.find((m) => m.id === queueItem.model);
			// Add 3 seconds buffer to always stay ahead of actual generation time
			const estimatedDuration = (modelInfo?.avgGenerationTime || 30) + 3;

			setGenerationQueue((prev) =>
				prev.map((item) =>
					item.id === queueItem.id
						? {
								...item,
								status: "generating",
								startedAt: new Date().toISOString(),
								estimatedDuration,
							}
						: item,
				),
			);

			// useGenerate never throws: failures come back with a code.
			const result = await generate(request);
			processingRef.current.delete(queueItem.id);
			// Success charges credits; failures may have refunded them. Either way the pill updates.
			fetchUserUsage();

			if (result.status === "succeeded") {
				setGenerationQueue((prev) => prev.filter((item) => item.id !== queueItem.id));
				// Refresh threads list and current thread
				fetchThreads();
				if (result.threadId) {
					fetchThread(result.threadId);
				}
				refreshHistory();
				return;
			}

			const dismiss = () => setGenerationQueue((prev) => prev.filter((item) => item.id !== queueItem.id));
			const retry = () => {
				const fresh: QueuedGeneration = { ...queueItem, status: "queued", createdAt: new Date().toISOString() };
				setGenerationQueue((prev) => prev.map((item) => (item.id === queueItem.id ? fresh : item)));
				processGenerationRef.current?.(fresh, request);
			};
			setGenerationQueue((prev) =>
				prev.map((item) =>
					item.id === queueItem.id
						? {
								...item,
								status: "failed",
								error: result.error,
								errorCode: result.code,
								creditsNeeded: result.creditCost,
								balanceAtFailure: result.availableCredits,
								onRetry: retry,
								onDismiss: dismiss,
								onOpenSettings: () => setShowSettings(true),
							}
						: item,
				),
			);

			// Out of credits or outside the plan: offer the way forward over the work.
			if (opensPaywall(result.code)) {
				paywall.open(
					result.code === "MODEL_NOT_ALLOWED"
						? { reason: "model_not_allowed", modelId: request.model }
						: {
								reason: "insufficient_credits",
								needed: result.creditCost,
								balance: result.availableCredits,
							},
				);
			}
		},
		[generate, fetchThreads, fetchThread, refreshHistory, models, fetchUserUsage, paywall.open],
	);
	const processGenerationRef = useRef<typeof processGeneration | null>(null);
	processGenerationRef.current = processGeneration;

	const handleAddToInputs = useCallback(
		(imageUrl: string) => {
			if (imageInputs.includes(imageUrl)) {
				setImageInputs((prev) => prev.filter((url) => url !== imageUrl));
			} else if (imageInputs.length < (selectedModelInfo?.maxImages || 14)) {
				setImageInputs((prev) => [...prev, imageUrl]);
			}
		},
		[imageInputs, selectedModelInfo?.maxImages],
	);

	useEffect(() => {
		fetchModels();
	}, [fetchModels]);

	useEffect(() => {
		if (token && user) {
			fetchThreads();
			refreshHistory();
			fetchUploads(showArchived);
			fetchUserUsage();
			fetchUserSubscription();
		}
	}, [token, user, fetchThreads, refreshHistory, fetchUploads, showArchived, fetchUserUsage, fetchUserSubscription]);

	useEffect(() => {
		if (!supportsImageInput) {
			setImageInputs([]);
		}
	}, [supportsImageInput]);

	useEffect(() => {
		localStorage.setItem("viewMode", viewMode);
	}, [viewMode]);

	// --- First run: the prompt typed on the landing page, or a starter prompt ---
	// handleGenerate is defined below the early returns; effects reach it through this ref.
	const handleGenerateRef = useRef<((prompt: string) => void) | null>(null);
	// undefined = not read yet; null = read, nothing pending (or already used).
	const pendingRef = useRef<PendingPrompt | null | undefined>(undefined);
	// Text to put in the prompt bar (starter prompt, pending prompt, example picks).
	const [promptRequest, setPromptRequest] = useState<{ text: string; nonce: number } | null>(null);
	const [pendingReady, setPendingReady] = useState(false);
	const [pendingWaitedOut, setPendingWaitedOut] = useState(false);

	// Once signed in, take the pending prompt (clearing it) and apply its settings.
	useEffect(() => {
		if (!user || pendingRef.current !== undefined) return;
		const pending = takePendingPrompt();
		pendingRef.current = pending;
		if (pending) {
			setSelectedModel(pending.model);
			setCreationOptions((prev) => ({ ...prev, aspectRatio: pending.aspectRatio }));
			setViewMode("chat");
			setPendingReady(true);
			return;
		}
		// New accounts land with a sensible prompt in the bar instead of an empty one.
		const isNewUser = (location.state as { isNewUser?: boolean } | null)?.isNewUser;
		if (isNewUser || user.tutorialCompleted === false) {
			setPromptRequest({ text: STARTER_PROMPTS[0], nonce: Date.now() });
		}
	}, [user, location.state]);

	// Don't wait forever on balance and plan: after a few seconds, fall back to prefilling.
	useEffect(() => {
		if (!pendingReady) return;
		const t = setTimeout(() => setPendingWaitedOut(true), 6000);
		return () => clearTimeout(t);
	}, [pendingReady]);

	// Start the pending prompt once, but only if the balance covers it and the
	// plan allows the model; otherwise just put it in the prompt bar.
	useEffect(() => {
		const pending = pendingRef.current;
		if (!pendingReady || !pending || selectedModel !== pending.model) return;
		if (!(userUsage && userSubscription) && !pendingWaitedOut) return;
		pendingRef.current = null;
		setPendingReady(false);
		const cost = models.find((m) => m.id === pending.model)?.creditCost ?? fallbackCreditCost(pending.model);
		const allowed = userSubscription?.subscription?.allowedModels;
		const canUseModel = allowed == null || allowed.includes(pending.model);
		const balance = userUsage?.availableCredits;
		if (canUseModel && balance != null && balance >= cost && handleGenerateRef.current) {
			handleGenerateRef.current(pending.prompt);
		} else {
			setPromptRequest({ text: pending.prompt, nonce: Date.now() });
		}
	}, [pendingReady, pendingWaitedOut, selectedModel, userUsage, userSubscription, models]);

	// The tutorial is gone; the first generation marks it complete so the flag stays meaningful.
	useEffect(() => {
		if (user?.tutorialCompleted === false && generationQueue.length > 0) {
			completeTutorial();
			updateUser({ tutorialCompleted: true });
		}
	}, [user?.tutorialCompleted, generationQueue.length, completeTutorial, updateUser]);

	// Infinite scroll handler - must be before conditional returns
	const handleLoadMore = useCallback(() => {
		fetchMoreHistory(20, showTrash, showArchived);
	}, [fetchMoreHistory, showTrash, showArchived]);


	if (authLoading) {
		return (
			<div className="min-h-screen flex items-center justify-center bg-[var(--bg-primary)]">
				<div className="text-[var(--text-secondary)] mono">Loading<span className="cursor-blink">_</span></div>
			</div>
		);
	}

	if (!user || !token) {
		return <Landing />;
	}

	const handleGenerate = async (prompt: string) => {
		const queueId = crypto.randomUUID();
		const isVariation = isVariationModel(selectedModel);
		const request = {
			prompt,
			model: selectedModel,
			imageInputs: supportsImageInput ? imageInputs : undefined,
			aspectRatio: creationOptions.aspectRatio,
			resolution: creationOptions.resolution,
			outputFormat: creationOptions.outputFormat,
			threadId: activeThread?.id,
			// Variation models always generate 4 outputs
			numOutputs: isVariation ? 4 : undefined,
		};

		const queueItem: QueuedGeneration = {
			id: queueId,
			prompt: isVariation ? "Generating 4 variations" : prompt,
			model: selectedModel,
			status: "queued",
			createdAt: new Date().toISOString(),
			threadId: activeThread?.id,
		};

		setGenerationQueue((prev) => [queueItem, ...prev]);

		if (supportsImageInput) {
			setImageInputs([]);
		}

		processGeneration(queueItem, request);
	};
	handleGenerateRef.current = handleGenerate;

	const dismissQueueItem = (id: string) => {
		setGenerationQueue((prev) => prev.filter((item) => item.id !== id));
	};

	const handleVariations = (gen: Generation) => {
		if (!gen.imageUrl) return;

		const queueId = crypto.randomUUID();
		const randomSeed = Math.floor(Math.random() * 2147483647);

		const sourceImage = gen.imageUrl;

		const request = {
			prompt: gen.prompt,
			model: "black-forest-labs/flux-redux-dev",
			// Server substitutes the best variation model the user's tier allows
			variation: true,
			imageInputs: [sourceImage],
			numOutputs: 4,
			seed: randomSeed,
			threadId: activeThread?.id,
		};

		const queueItem: QueuedGeneration = {
			id: queueId,
			prompt: `Variations of: ${gen.prompt}`,
			model: "black-forest-labs/flux-redux-dev",
			status: "queued",
			createdAt: new Date().toISOString(),
			threadId: activeThread?.id,
		};

		setGenerationQueue((prev) => [queueItem, ...prev]);
		processGeneration(queueItem, request);
	};

	// Vary a specific image from a grid (individual image selection)
	const handleVaryImage = (imageUrl: string, prompt: string) => {
		const queueId = crypto.randomUUID();
		const randomSeed = Math.floor(Math.random() * 2147483647);

		const request = {
			prompt,
			model: "black-forest-labs/flux-redux-dev",
			// Server substitutes the best variation model the user's tier allows
			variation: true,
			imageInputs: [imageUrl],
			numOutputs: 4,
			seed: randomSeed,
			threadId: activeThread?.id,
		};

		const queueItem: QueuedGeneration = {
			id: queueId,
			prompt: `Variations of: ${prompt}`,
			model: "black-forest-labs/flux-redux-dev",
			status: "queued",
			createdAt: new Date().toISOString(),
			threadId: activeThread?.id,
		};

		setGenerationQueue((prev) => [queueItem, ...prev]);
		processGeneration(queueItem, request);
	};

	const handleUpscale = (gen: Generation) => {
		if (gen.imageUrl) {
			const queueId = crypto.randomUUID();
			const request = {
				prompt: gen.prompt,
				model: "black-forest-labs/flux-2-dev",
				imageInputs: [gen.imageUrl],
				aspectRatio: creationOptions.aspectRatio,
				resolution: "4K" as const,
				outputFormat: creationOptions.outputFormat,
				threadId: activeThread?.id,
			};

			const queueItem: QueuedGeneration = {
				id: queueId,
				prompt: gen.prompt,
				model: "black-forest-labs/flux-2-dev",
				status: "queued",
				createdAt: new Date().toISOString(),
				threadId: activeThread?.id,
			};

			setGenerationQueue((prev) => [queueItem, ...prev]);
			processGeneration(queueItem, request);
		} else {
			handleGenerate(gen.prompt);
		}
	};

	const handleRemix = (gen: Generation) => {
		if (gen.imageUrl) {
			setImageInputs([gen.imageUrl]);
			setSelectedModel("black-forest-labs/flux-2-dev");
		}
	};

	const handleImageClick = (gen: Generation) => {
		if (gen.imageUrl) {
			// Add image to inputs (append if not already present)
			setImageInputs((prev) => {
				if (prev.includes(gen.imageUrl!)) return prev;
				const maxImages = selectedModelInfo?.maxImages || 14;
				if (prev.length >= maxImages) return prev;
				return [...prev, gen.imageUrl!];
			});
			// If model doesn't support image input, switch to one that does
			if (!supportsImageInput) {
				setSelectedModel("black-forest-labs/flux-2-dev");
			}
		}
	};

	const handleTrash = async (id: string) => {
		const success = await trashGeneration(id);
		if (success) {
			refreshHistory();
			if (activeThread) {
				fetchThread(activeThread.id);
			}
		}
	};

	const handleRestore = async (id: string) => {
		const success = await restoreGeneration(id);
		if (success) {
			refreshHistory();
		}
	};

	const handleDelete = async (id: string) => {
		const success = await deleteGeneration(id);
		if (success) {
			refreshHistory();
		}
	};

	const handleArchive = async (id: string) => {
		const success = await archiveGeneration(id);
		if (success) {
			refreshHistory();
		}
	};

	const handleUnarchive = async (id: string) => {
		const success = await unarchiveGeneration(id);
		if (success) {
			refreshHistory();
		}
	};

	const handleArchiveUpload = async (id: string) => {
		const success = await archiveUpload(id);
		if (success) {
			fetchUploads(showArchived);
		}
	};

	const handleUnarchiveUpload = async (id: string) => {
		const success = await unarchiveUpload(id);
		if (success) {
			fetchUploads(showArchived);
		}
	};

	const handleDeleteUpload = async (id: string) => {
		const success = await deleteUpload(id);
		if (success) {
			fetchUploads(showArchived);
		}
	};

	const hasMore = history ? history.total > history.generations.length : false;

	const handleNewThread = () => {
		clearActiveThread();
		setViewMode("chat");
	};

	const handleSelectThread = async (thread: Thread) => {
		await fetchThread(thread.id);
		setViewMode("chat");
	};

	const handleRenameThread = async (threadId: string, newTitle: string) => {
		await renameThread(threadId, newTitle);
	};

	const handleDeleteThread = (thread: Thread) => {
		setThreadToDelete(thread);
		setShowDeleteDialog(true);
	};

	const handleConfirmDeleteThread = async (deletePhotos: boolean) => {
		if (!threadToDelete) return;

		const success = await deleteThreadWithOptions(threadToDelete.id, deletePhotos);
		if (success && activeThread?.id === threadToDelete.id) {
			clearActiveThread();
		}
		setShowDeleteDialog(false);
		setThreadToDelete(null);
	};

	// Examples on the empty state fill the prompt bar; nothing is spent until Generate.
	const handlePromptPick = (prompt: string) => {
		setPromptRequest({ text: prompt, nonce: Date.now() });
	};

	return (
		<div className="h-screen flex bg-[var(--bg-primary)]">
			{/* Sidebar */}
			<Sidebar
				threads={threads}
				selectedThreadId={activeThread?.id}
				onSelectThread={handleSelectThread}
				onNewThread={handleNewThread}
				onRenameThread={handleRenameThread}
				onDeleteThread={handleDeleteThread}
				onViewGallery={() => setViewMode("gallery")}
				viewMode={viewMode}
				onViewModeChange={setViewMode}
				onOpenSettings={() => setShowSettings(true)}
				onLogout={logout}
				username={user.username}
				isAdmin={user.isAdmin}
				collapsed={sidebarCollapsed}
				onToggleCollapse={() => setSidebarCollapsed(!sidebarCollapsed)}
			/>

			{/* Main Content */}
			<main className="flex-1 flex flex-col min-w-0 overflow-hidden">
				{/* Top Bar - Thread title, Settings gear and theme switcher */}
				<div className="flex flex-shrink-0 items-center justify-between gap-3 border-b border-border px-4 py-2">
					<div className="flex min-w-0 items-center gap-2">
						{activeThread && (
							<h2 className="max-w-xs truncate text-sm font-medium text-foreground">{activeThread.title}</h2>
						)}
					</div>
					<div className="flex shrink-0 items-center gap-2 sm:gap-3">
						<ModelsHelpButton onClick={() => setShowModelsRef(true)} />
						<CreditPill
							credits={balance}
							lowAt={currentTotalCost * 2}
							onClick={() => setViewMode("billing")}
						/>
						<ThemeSwitcher compact />
					</div>
				</div>
				<PaywallSheet />

				{/* Scrollable Content Area */}
				<div className="flex-1 overflow-y-auto" ref={chatContainerRef}>
					{viewMode === "billing" ? (
						/* Billing View */
						<Billing embedded onBack={() => setViewMode("chat")} />
					) : viewMode === "chat" ? (
						<div className="max-w-2xl mx-auto px-4 py-6">
							{showWelcome ? (
								<WelcomeScreen
									onPromptPick={handlePromptPick}
									onOpenModelGuide={() => setShowModelsRef(true)}
								/>
							) : !activeThread && threads.length > 0 && !generationQueue.some((q) => !q.threadId) ? (
								// No thread selected but threads exist and no pending new generations - show prompt to select or create
								<div className="flex flex-col items-center justify-center min-h-[60vh]">
									<h2 className="text-xl font-semibold text-foreground">Pick up a series or start a new one</h2>
									<p className="mt-2 max-w-sm text-center text-sm text-muted-foreground">
										Choose a series from the sidebar, or describe a new image below to start one.
									</p>
								</div>
							) : (
								<>
									{/* Chat Feed */}
									<ChatFeed
										generations={displayGenerations}
										queuedItems={generationQueue.filter(
											(q) => !activeThread || q.threadId === activeThread.id,
										)}
										onVariations={handleVariations}
										onVaryImage={handleVaryImage}
										onUpscale={handleUpscale}
										onRemix={handleRemix}
										onTrash={handleTrash}
										onImageClick={handleImageClick}
										onLoadMore={() => {}}
										hasMore={false}
										loading={threadsLoading}
									/>
								</>
							)}
						</div>
					) : (
						/* Gallery View */
						<div className="p-4">
							<ImageGallery
								generations={history?.generations || []}
								uploads={!showTrash ? uploads : []}
								queuedItems={generationQueue}
								onTrash={handleTrash}
								onRestore={handleRestore}
								onDelete={handleDelete}
								onArchive={handleArchive}
								onUnarchive={handleUnarchive}
								onArchiveUpload={handleArchiveUpload}
								onUnarchiveUpload={handleUnarchiveUpload}
								onDeleteUpload={handleDeleteUpload}
								onDismissQueueItem={dismissQueueItem}
								onAddToInputs={supportsImageInput ? handleAddToInputs : undefined}
								selectedInputUrls={imageInputs}
								onLoadMore={handleLoadMore}
								hasMore={hasMore}
								loading={historyLoading}
								showTrash={showTrash}
								showArchived={showArchived}
							/>
						</div>
					)}
				</div>

				{/* Creation Panel - hide when viewing billing */}
				{viewMode !== "billing" && (
					<>
						{/* Failures the current view doesn't already show, each with its own Retry/Dismiss */}
						<div className="px-4 pb-2 empty:hidden">
							<GenerationStatus
								failures={generationQueue.filter(
									(q) =>
										q.status === "failed" &&
										(viewMode !== "chat" || (!!activeThread && q.threadId !== activeThread.id)),
								)}
							/>
						</div>
						<CreationPanel
							promptRequest={promptRequest}
							models={models}
							selectedModel={selectedModel}
							onSelectModel={setSelectedModel}
							supportsImageInput={supportsImageInput}
							token={token}
							imageInputs={imageInputs}
							onImagesChange={setImageInputs}
							maxImages={selectedModelInfo?.maxImages || 14}
							options={creationOptions}
							onOptionsChange={setCreationOptions}
							onGenerate={handleGenerate}
							onEnhance={enhancePrompt}
							loading={generating}
							queueCount={generationQueue.filter(q => q.status !== 'failed').length}
							allowedModels={userSubscription?.subscription?.allowedModels}
							creditCost={perImageCost}
							numOutputs={outputsPerGenerate}
							balance={balance}
							usesOwnKey={!!apiKeyInfo?.hasKey}
							onNeedCredits={(needed) =>
								// The low-balance hint opens it before the balance is actually short.
								paywall.open(
									balance !== null && balance >= needed
										? { reason: "low_balance", balance }
										: { reason: "insufficient_credits", needed, balance },
								)
							}
							onLockedModel={(modelId) => paywall.open({ reason: "model_not_allowed", modelId })}
						/>
					</>
				)}
			</main>

			{/* User Settings Modal */}
			<UserSettings
				isOpen={showSettings}
				onClose={() => setShowSettings(false)}
				onOpenBilling={() => setViewMode("billing")}
			/>

			{/* Thread Delete Dialog */}
			<ThreadDeleteDialog
				isOpen={showDeleteDialog}
				onClose={() => {
					setShowDeleteDialog(false);
					setThreadToDelete(null);
				}}
				thread={threadToDelete}
				onConfirm={handleConfirmDeleteThread}
			/>

			<ModelsReferenceModal
				isOpen={showModelsRef}
				onClose={() => setShowModelsRef(false)}
				onSelectModel={(modelId) => {
					setSelectedModel(modelId);
					setShowModelsRef(false);
				}}
				currentModel={selectedModel}
				allowedModels={userSubscription?.subscription?.allowedModels}
				onUpgrade={() => {
					setShowModelsRef(false);
					paywall.open({ reason: "upgrade", balance });
				}}
			/>
		</div>
	);
}

function AdminRoute({ children }: { children: React.ReactNode }) {
	const { user, loading } = useAuth();

	if (loading) {
		return (
			<div className="min-h-screen flex items-center justify-center bg-[var(--bg-primary)]">
				<div className="text-[var(--text-secondary)] mono">Loading<span className="cursor-blink">_</span></div>
			</div>
		);
	}

	if (!user) {
		return <Navigate to="/" replace />;
	}

	if (!user.isAdmin) {
		return <Navigate to="/" replace />;
	}

	return <>{children}</>;
}

function ProtectedRoute({ children }: { children: React.ReactNode }) {
	const { user, loading } = useAuth();

	if (loading) {
		return (
			<div className="min-h-screen flex items-center justify-center bg-[var(--bg-primary)]">
				<div className="text-[var(--text-secondary)] mono">Loading<span className="cursor-blink">_</span></div>
			</div>
		);
	}

	if (!user) {
		return <Navigate to="/" replace />;
	}

	return <>{children}</>;
}

function AppRoutes() {
	return (
		<Routes>
			<Route path="/" element={<MainApp />} />
			<Route path="/login" element={<LoginPage />} />
			<Route path="/terms" element={<Terms />} />
			<Route path="/privacy" element={<Privacy />} />
			<Route path="/auth/magic-link" element={<MagicLinkVerify />} />
			{Styleguide && (
				<Route
					path="/styleguide"
					element={
						<Suspense fallback={null}>
							<Styleguide />
						</Suspense>
					}
				/>
			)}
			<Route path="/auth/reset-password" element={<ResetPasswordPage />} />
			<Route path="/pricing" element={<Pricing />} />
			<Route
				path="/billing"
				element={
					<ProtectedRoute>
						<Billing />
					</ProtectedRoute>
				}
			/>
			<Route
				path="/admin"
				element={
					<AdminRoute>
						<AdminLayout />
					</AdminRoute>
				}
			>
				<Route index element={<Suspense fallback={<AdminLoading />}><AdminDashboard /></Suspense>} />
				<Route path="users" element={<Suspense fallback={<AdminLoading />}><AdminUsers /></Suspense>} />
				<Route path="users/:id" element={<Suspense fallback={<AdminLoading />}><AdminUsers /></Suspense>} />
				<Route path="products" element={<Suspense fallback={<AdminLoading />}><AdminProducts /></Suspense>} />
				<Route path="models" element={<Suspense fallback={<AdminLoading />}><AdminModels /></Suspense>} />
				<Route path="credit-packages" element={<Suspense fallback={<AdminLoading />}><AdminCreditPackages /></Suspense>} />
				<Route path="financials" element={<Suspense fallback={<AdminLoading />}><AdminFinancials /></Suspense>} />
				<Route path="financials/revenue" element={<Suspense fallback={<AdminLoading />}><AdminRevenue /></Suspense>} />
				<Route path="financials/costs" element={<Suspense fallback={<AdminLoading />}><AdminCosts /></Suspense>} />
				<Route path="financials/metrics" element={<Suspense fallback={<AdminLoading />}><AdminMetrics /></Suspense>} />
				<Route path="financials/pnl" element={<Suspense fallback={<AdminLoading />}><AdminPnL /></Suspense>} />
			</Route>
			<Route path="*" element={<NotFound />} />
		</Routes>
	);
}

function App() {
	return (
		<ErrorBoundary>
			<BrowserRouter>
				<AuthProvider>
					<AppRoutes />
				</AuthProvider>
			</BrowserRouter>
		</ErrorBoundary>
	);
}

export default App;
