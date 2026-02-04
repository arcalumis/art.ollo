import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { ChatFeed } from "./components/ChatFeed";
import { CreationPanel, type CreationOptions } from "./components/CreationPanel";
import { GenerationStatus } from "./components/GenerationStatus";
import { ImageGallery } from "./components/ImageGallery";
import { LoginForm } from "./components/LoginForm";
import { MagicLinkVerify } from "./components/MagicLinkVerify";
import { ResetPasswordPage } from "./components/ResetPasswordPage";
import { Sidebar } from "./components/Sidebar";
import { ThemeSwitcher } from "./components/ThemeSwitcher";
import { ThreadDeleteDialog } from "./components/ThreadDeleteDialog";
import { UserSettings } from "./components/UserSettings";
import { ModelsHelpButton, ModelsReferenceModal } from "./components/ModelsReferenceModal";
import { OlloWelcomeFlow } from "./components/OlloWelcomeFlow";
import { isVariationModel } from "./config/models";
import { WelcomeScreen } from "./components/WelcomeScreen";
import type { ProjectMetadata } from "./types/ollo";
import { AuthProvider, useAuth } from "./contexts/AuthContext";
import { useEnhancePrompt, useGenerate, useHistory, useModels, useThreads, useUploads } from "./hooks/useApi";
import { useUserSubscription, useUserUsage } from "./hooks/useUserSettings";
import { AdminLayout } from "./pages/AdminLayout";
import { Billing } from "./pages/Billing";

// Lazy load admin pages - these are only loaded when admin navigates to them
const AdminCosts = lazy(() => import("./pages/AdminCosts"));
const AdminCreditPackages = lazy(() => import("./pages/AdminCreditPackages"));
const AdminDashboard = lazy(() => import("./pages/AdminDashboard"));
const AdminFinancials = lazy(() => import("./pages/AdminFinancials"));
const AdminMetrics = lazy(() => import("./pages/AdminMetrics"));
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

function MainApp() {
	const { user, token, loading: authLoading, logout } = useAuth();
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

	const { generate, loading: generating, error: generateError } = useGenerate(token);
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

	// Ollo welcome flow state
	const [showOlloFlow, setShowOlloFlow] = useState(false);

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

	const selectedModelInfo = models.find((m) => m.id === selectedModel);
	const supportsImageInput = selectedModelInfo?.supportsImageInput || false;

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

			try {
				const result = await generate(request);

				if (result?.status === "succeeded") {
					setGenerationQueue((prev) => prev.filter((item) => item.id !== queueItem.id));
					// Refresh threads list and current thread
					fetchThreads();
					if (result.threadId) {
						fetchThread(result.threadId);
					}
					// Refresh gallery history and usage counter
					refreshHistory();
					fetchUserUsage();
				} else {
					setGenerationQueue((prev) =>
						prev.map((item) =>
							item.id === queueItem.id
								? { ...item, status: "failed", error: result?.error || "Generation failed" }
								: item,
						),
					);
				}
			} catch (err) {
				setGenerationQueue((prev) =>
					prev.map((item) =>
						item.id === queueItem.id ? { ...item, status: "failed", error: String(err) } : item,
					),
				);
			} finally {
				processingRef.current.delete(queueItem.id);
			}
		},
		[generate, fetchThreads, fetchThread, refreshHistory, models],
	);

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
		if (token) {
			fetchThreads();
			refreshHistory();
			fetchUploads(showArchived);
			fetchUserUsage();
			fetchUserSubscription();
		}
	}, [token, fetchThreads, refreshHistory, fetchUploads, showArchived, fetchUserUsage, fetchUserSubscription]);

	useEffect(() => {
		if (!supportsImageInput) {
			setImageInputs([]);
		}
	}, [supportsImageInput]);

	useEffect(() => {
		localStorage.setItem("viewMode", viewMode);
	}, [viewMode]);

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
		return <LoginForm />;
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

	const dismissQueueItem = (id: string) => {
		setGenerationQueue((prev) => prev.filter((item) => item.id !== id));
	};

	const handleVariations = (gen: Generation) => {
		if (!gen.imageUrl) return;

		const queueId = crypto.randomUUID();
		const randomSeed = Math.floor(Math.random() * 2147483647);

		// If this is already a variation (has imageInputs in parameters), use the original source
		// This ensures "Vary Again" always uses the original image, not the variation
		const originalImageInputs = gen.parameters?.imageInputs as string[] | undefined;
		const sourceImage = originalImageInputs?.[0] || gen.imageUrl;

		const request = {
			prompt: gen.prompt,
			model: "black-forest-labs/flux-redux-dev",
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

	const handleStartWithOllo = () => {
		setShowOlloFlow(true);
	};

	const handleOlloComplete = async (metadata: ProjectMetadata) => {
		setShowOlloFlow(false);
		// Update creation options with Ollo's selections
		if (metadata.aspectRatio) {
			setCreationOptions((prev) => ({ ...prev, aspectRatio: metadata.aspectRatio as string }));
		}
		// Clear active thread to show the new project is ready
		clearActiveThread();
		setViewMode("chat");
	};

	const handleOlloSkip = () => {
		setShowOlloFlow(false);
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

	const handleCategoryClick = (category: string) => {
		const categoryPrompts: Record<string, string> = {
			portrait: "A professional portrait photograph",
			landscape: "A breathtaking landscape photograph",
			abstract: "An abstract digital artwork",
			photo: "A high-quality photograph",
		};
		// Generate with the category as a starting prompt
		handleGenerate(categoryPrompts[category] || "");
	};

	const handlePromptClick = (prompt: string) => {
		handleGenerate(prompt);
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
				<div className="flex-shrink-0 flex items-center justify-between px-4 py-2 border-b border-[var(--border)]">
					<div className="flex items-center gap-2">
						{activeThread && (
							<h2 className="text-sm font-medium text-[var(--text-primary)] truncate max-w-xs">
								{activeThread.title}
							</h2>
						)}
					</div>
					<div className="flex items-center gap-3">
						<ModelsHelpButton onClick={() => setShowModelsRef(true)} />
						{userUsage?.limits?.dailyImageLimit != null && userUsage.limits.dailyImageLimit > 0 && (
							<div className="text-xs text-[var(--text-secondary)]">
								Today: <span className="text-[var(--accent)]">
									{userUsage.dailyUsage?.imageCount ?? 0} / {userUsage.limits.dailyImageLimit}
								</span>
							</div>
						)}
						<ThemeSwitcher compact />
					</div>
				</div>

				{/* Scrollable Content Area */}
				<div className="flex-1 overflow-y-auto" ref={chatContainerRef}>
					{viewMode === "billing" ? (
						/* Billing View */
						<Billing embedded onBack={() => setViewMode("chat")} />
					) : viewMode === "chat" ? (
						<div className="max-w-2xl mx-auto px-4 py-6">
							{showWelcome ? (
								<WelcomeScreen
									onPromptClick={handlePromptClick}
									onCategoryClick={handleCategoryClick}
									onStartWithOllo={handleStartWithOllo}
									onOpenModelGuide={() => setShowModelsRef(true)}
								/>
							) : !activeThread && threads.length > 0 && !generationQueue.some((q) => !q.threadId) ? (
								// No thread selected but threads exist and no pending new generations - show prompt to select or create
								<div className="flex flex-col items-center justify-center min-h-[60vh]">
									<h2 className="welcome-heading text-2xl text-[var(--text-primary)] mb-2">
										Ready to create?
									</h2>
									<p className="text-sm text-[var(--text-secondary)] mb-6">
										Start a new project or continue an existing thread
									</p>
									<div className="flex flex-col items-center gap-4">
										<button
											type="button"
											onClick={handleStartWithOllo}
											className="divine-gradient rounded-xl py-3 px-6 flex items-center gap-3 sacred-glow hover:scale-[1.02] transition-transform"
										>
											<span className="text-base font-semibold">Start building with Ollo</span>
										</button>
										<button
											type="button"
											onClick={handleNewThread}
											className="text-sm text-[var(--text-secondary)] hover:text-[var(--accent)] transition-colors"
										>
											or dive right in →
										</button>
									</div>
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
						<CreationPanel
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
						/>

						{/* Generation status */}
						<div className="px-4 pb-2">
							<GenerationStatus loading={generating} error={generateError} />
						</div>
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

			<OlloWelcomeFlow
				isOpen={showOlloFlow}
				onClose={() => setShowOlloFlow(false)}
				onComplete={handleOlloComplete}
				onSkip={handleOlloSkip}
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
					window.location.href = "/billing";
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
			<Route path="/auth/magic-link" element={<MagicLinkVerify />} />
			<Route path="/auth/reset-password" element={<ResetPasswordPage />} />
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
				<Route path="credit-packages" element={<Suspense fallback={<AdminLoading />}><AdminCreditPackages /></Suspense>} />
				<Route path="financials" element={<Suspense fallback={<AdminLoading />}><AdminFinancials /></Suspense>} />
				<Route path="financials/revenue" element={<Suspense fallback={<AdminLoading />}><AdminRevenue /></Suspense>} />
				<Route path="financials/costs" element={<Suspense fallback={<AdminLoading />}><AdminCosts /></Suspense>} />
				<Route path="financials/metrics" element={<Suspense fallback={<AdminLoading />}><AdminMetrics /></Suspense>} />
				<Route path="financials/pnl" element={<Suspense fallback={<AdminLoading />}><AdminPnL /></Suspense>} />
			</Route>
		</Routes>
	);
}

function App() {
	return (
		<BrowserRouter>
			<AuthProvider>
				<AppRoutes />
			</AuthProvider>
		</BrowserRouter>
	);
}

export default App;
