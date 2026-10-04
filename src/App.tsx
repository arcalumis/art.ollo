import { Suspense, lazy, useCallback, useEffect, useRef, useState } from "react";
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { ChatFeed } from "./components/ChatFeed";
import { type CreationOptions, CreationPanel } from "./components/CreationPanel";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { PendingSignIn } from "./components/auth/PendingSignIn";
import { GenerationStatus } from "./components/GenerationStatus";
import { ImageGallery } from "./components/ImageGallery";
import { MagicLinkVerify } from "./components/MagicLinkVerify";
import { ModelsReferenceModal } from "./components/ModelsReferenceModal";
import { ResetPasswordPage } from "./components/ResetPasswordPage";
import { Sidebar } from "./components/Sidebar";
import { ThreadDeleteDialog } from "./components/ThreadDeleteDialog";
import { STARTER_PROMPTS, WelcomeScreen } from "./components/WelcomeScreen";
import { useCheckoutReturn } from "./components/billing/hooks";
import { Laurel } from "./components/brand/Laurel";
import { AppShell } from "./components/shell/AppShell";
import { RenameSeriesDialog } from "./components/shell/RenameSeriesDialog";
import { ArchivedSeries, NewSeriesIntro, SeriesHeader } from "./components/shell/SeriesParts";
import type { ImageActionCosts, ImageTool, ViewerImage } from "./components/viewer/media";
import { Settings } from "./pages/Settings";
import { SharedImage } from "./pages/SharedImage";
import {
	type AppView,
	CREATE_PATH,
	GALLERY_PATH,
	LIBRARY_TITLES,
	SETTINGS_PATH,
	clearReturnPath,
	peekReturnPath,
	rememberReturnPath,
	seriesPath,
	viewFromPath,
} from "./components/shell/routes";
import { SolanaBoundary } from "./components/solana/SolanaBoundary";
import { Skeleton } from "./components/ui/skeleton";
import { fallbackCreditCost, isVariationModel } from "./config/models";
import { AuthProvider, useAuth } from "./contexts/AuthContext";
import { usePaywall } from "./contexts/PaywallContext";
import { useEnhancePrompt, useHistory, useModels, useThreads, useUploads } from "./hooks/useApi";
import { type QueueRequest, toImagePath, useGenerationQueue } from "./hooks/useGenerationQueue";
import {
	useTutorial,
	useUserApiKey,
	useUserSubscription,
	useUserUsage,
} from "./hooks/useUserSettings";
import { type PendingPrompt, takePendingPrompt } from "./lib/pendingPrompt";
import { Landing } from "./pages/Landing";
import { NotFound } from "./pages/NotFound";
import { Pricing } from "./pages/Pricing";
import { Privacy } from "./pages/Privacy";
import { Terms } from "./pages/Terms";
import type { Generation, Thread } from "./types";
import "./App.css";

// The admin console (its own layout and routes) loads only when an admin opens it.
const AdminApp = lazy(() => import("./pages/admin/AdminApp"));

// These carry the Solana wallet features (SOL purchase, wallet sign-in), so
// they load on demand inside a <SolanaBoundary> instead of with every page.
const Billing = lazy(() => import("./pages/Billing").then((m) => ({ default: m.Billing })));
const PaywallSheet = lazy(() =>
	import("./components/billing/PaywallSheet").then((m) => ({ default: m.PaywallSheet })),
);
const LoginPage = lazy(() =>
	import("./components/auth/LoginPage").then((m) => ({ default: m.LoginPage })),
);

// Design-system reference, compiled out of production builds.
const Styleguide = import.meta.env.DEV
	? lazy(() => import("./pages/Styleguide").then((m) => ({ default: m.Styleguide })))
	: null;

const DEFAULT_MODEL = "black-forest-labs/flux-2-dev";
// Vary sends `variation: true`; the server picks the tier-allowed model (FLUX 2 Dev, then Klein).
const VARIATION_MODEL = "black-forest-labs/flux-2-dev";

function FullPageLoading() {
	return (
		<div className="grid min-h-dvh place-items-center bg-background text-bronze">
			<Laurel className="size-12 opacity-60" label="Loading" />
		</div>
	);
}

function AdminLoading() {
	return (
		<div className="flex items-center justify-center p-8 text-bronze">
			<Laurel className="size-10 opacity-60" label="Loading" />
		</div>
	);
}

function BillingLoading() {
	return (
		<div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-8" aria-busy="true">
			<Skeleton className="h-9 w-48" />
			<Skeleton className="h-40 w-full rounded-2xl" />
			<Skeleton className="h-40 w-full rounded-2xl" />
		</div>
	);
}

/** Watches for a return from Stripe Checkout (toast + credit refresh). */
function CheckoutReturnWatcher({ onReturn }: { onReturn: () => void }) {
	useCheckoutReturn(onReturn);
	return null;
}

/**
 * The signed-in app. Mounted once for every app route (/create, /gallery,
 * /billing, /settings), so the queue and the prompt bar survive navigation;
 * which screen shows comes from the URL.
 */
function MainApp() {
	const { user, token, updateUser, logout } = useAuth();
	const { completeTutorial } = useTutorial(token);
	const location = useLocation();
	const navigate = useNavigate();
	// navigate changes identity on every navigation; effects use this stable handle.
	const navigateRef = useRef(navigate);
	navigateRef.current = navigate;
	const view = viewFromPath(location.pathname);
	const routeThreadId = view?.kind === "create" ? view.threadId : undefined;
	const library = view?.kind === "gallery" ? view.library : "all";
	const showTrash = library === "trash";
	const showArchived = library === "archive";

	const [selectedModel, setSelectedModel] = useState(DEFAULT_MODEL);
	const [imageInputs, setImageInputs] = useState<string[]>([]);
	const [creationOptions, setCreationOptions] = useState<CreationOptions>({
		aspectRatio: "4:3",
		resolution: "2K",
		outputFormat: "png",
	});

	const paywall = usePaywall();
	const { enhance: enhancePrompt } = useEnhancePrompt(token);
	const { models, tools, fetchModels } = useModels(token);
	const {
		threads,
		activeThread,
		fetchThreads,
		fetchThread,
		renameThread,
		deleteThreadWithOptions,
		unarchiveThread,
		clearActiveThread,
		loading: threadsLoading,
	} = useThreads(token);
	const [threadsLoaded, setThreadsLoaded] = useState(false);

	const [threadToDelete, setThreadToDelete] = useState<Thread | null>(null);
	const [threadToRename, setThreadToRename] = useState<Thread | null>(null);
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
	const { subscription: userSubscription, fetchSubscription: fetchUserSubscription } =
		useUserSubscription(token);
	const { apiKeyInfo, fetchApiKey } = useUserApiKey(token);
	const balance = userUsage?.availableCredits ?? null;

	// Purchases (SOL in the sheet, or a return from Stripe) change the balance and maybe the plan.
	const refreshCredits = useCallback(() => {
		fetchUserUsage();
		fetchUserSubscription();
	}, [fetchUserUsage, fetchUserSubscription]);
	// Own-key generations cost no credits, so the prompt bar shows no credit cost for them.
	useEffect(() => {
		if (token) fetchApiKey();
	}, [token, fetchApiKey]);
	useEffect(() => {
		if (paywall.creditsVersion > 0) refreshCredits();
	}, [paywall.creditsVersion, refreshCredits]);

	// Signed in: a remembered deep link has done its job.
	useEffect(() => clearReturnPath(), []);

	const selectedModelInfo = models.find((m) => m.id === selectedModel);
	const supportsImageInput = selectedModelInfo?.supportsImageInput || false;
	// Cost of one Generate press at the current model: server price, config fallback while loading.
	const perImageCost = selectedModelInfo?.creditCost ?? fallbackCreditCost(selectedModel);
	const outputsPerGenerate = isVariationModel(selectedModel) ? 4 : 1;
	const currentTotalCost = apiKeyInfo?.hasKey ? 0 : perImageCost * outputsPerGenerate;

	// The open series, once its data matches the URL.
	const openThread = routeThreadId && activeThread?.id === routeThreadId ? activeThread : null;

	const refreshHistory = useCallback(() => {
		fetchHistory(1, 20, showTrash, showArchived);
	}, [fetchHistory, showTrash, showArchived]);

	// Latest route and data for callbacks that finish later (queue results).
	const live = useRef({
		view,
		routeThreadId,
		openThread,
		history,
		creationOptions,
		refreshHistory,
	});
	live.current = { view, routeThreadId, openThread, history, creationOptions, refreshHistory };

	const queue = useGenerationQueue({
		token,
		models,
		onSettled: fetchUserUsage,
		onOpenSettings: () => navigateRef.current(SETTINGS_PATH),
		onSucceeded: (result, entry) => {
			const now = live.current;
			fetchThreads();
			now.refreshHistory();
			if (!result.threadId) return;
			if (result.threadId === now.routeThreadId) {
				fetchThread(result.threadId);
			} else if (!entry.threadId && now.view?.kind === "create" && !now.routeThreadId) {
				// The first image of a new series: open the series it created.
				navigateRef.current(seriesPath(result.threadId), { replace: true });
			}
		},
		resolveToolSource: (imageId) => {
			const now = live.current;
			const gen =
				now.openThread?.generations?.find((g) => g.id === imageId) ??
				now.history?.generations.find((g) => g.id === imageId);
			if (!gen) return null;
			return {
				source: { id: gen.id, imageUrl: gen.imageUrl, prompt: gen.prompt },
				ctx: {
					threadId: now.routeThreadId,
					aspectRatio: now.creationOptions.aspectRatio,
					outputFormat: now.creationOptions.outputFormat,
				},
			};
		},
	});

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
			fetchThreads().finally(() => setThreadsLoaded(true));
			fetchUserUsage();
			fetchUserSubscription();
		}
	}, [token, user, fetchThreads, fetchUserUsage, fetchUserSubscription]);

	// The library follows the URL: All images, Archive or Trash.
	useEffect(() => {
		if (token && user) refreshHistory();
	}, [token, user, refreshHistory]);
	useEffect(() => {
		if (token && user) fetchUploads(showArchived);
	}, [token, user, fetchUploads, showArchived]);

	// The open series follows the URL. A series that doesn't exist (deleted, or
	// another account's link) falls back to a new series.
	useEffect(() => {
		if (!routeThreadId) {
			clearActiveThread();
			return;
		}
		let cancelled = false;
		fetchThread(routeThreadId).then((thread) => {
			if (cancelled || thread) return;
			toast("That series isn't available.");
			navigateRef.current(CREATE_PATH, { replace: true });
		});
		return () => {
			cancelled = true;
		};
	}, [routeThreadId, fetchThread, clearActiveThread]);

	useEffect(() => {
		if (!supportsImageInput) {
			setImageInputs([]);
		}
	}, [supportsImageInput]);

	// --- First run: the prompt typed on the landing page, or a starter prompt ---
	// handleGenerate is defined below; effects reach it through this ref.
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
			// It starts a new series.
			if (live.current.view?.kind !== "create" || live.current.routeThreadId)
				navigateRef.current(CREATE_PATH);
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
		const cost =
			models.find((m) => m.id === pending.model)?.creditCost ?? fallbackCreditCost(pending.model);
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
		if (user?.tutorialCompleted === false && queue.items.length > 0) {
			completeTutorial();
			updateUser({ tutorialCompleted: true });
		}
	}, [user?.tutorialCompleted, queue.items.length, completeTutorial, updateUser]);

	// The paywall sheet (and the wallet code inside it) loads the first time it opens.
	const [paywallMounted, setPaywallMounted] = useState(false);
	useEffect(() => {
		if (paywall.isOpen) setPaywallMounted(true);
	}, [paywall.isOpen]);

	const handleLoadMore = useCallback(() => {
		fetchMoreHistory(20, showTrash, showArchived);
	}, [fetchMoreHistory, showTrash, showArchived]);

	if (!user || !token) return null;
	// Unknown sub-paths of an app route (e.g. /gallery/foo).
	if (!view) return <Navigate to={GALLERY_PATH} replace />;

	// --- Making images: everything goes through the one queue ---

	const handleGenerate = (prompt: string) => {
		const isVariation = isVariationModel(selectedModel);
		const request: QueueRequest = {
			prompt,
			model: selectedModel,
			imageInputs: supportsImageInput ? imageInputs : undefined,
			aspectRatio: creationOptions.aspectRatio,
			resolution: creationOptions.resolution,
			outputFormat: creationOptions.outputFormat,
			threadId: routeThreadId,
			// Variation models always generate 4 outputs
			numOutputs: isVariation ? 4 : creationOptions.numOutputs,
		};
		queue.enqueue({
			label: isVariation ? "Generating 4 variations" : prompt,
			model: selectedModel,
			threadId: routeThreadId,
			request,
		});
		if (supportsImageInput) setImageInputs([]);
	};
	handleGenerateRef.current = handleGenerate;

	const varyImage = (imageUrl: string, prompt: string) => {
		queue.enqueue({
			label: `Variations of: ${prompt}`,
			model: VARIATION_MODEL,
			threadId: routeThreadId,
			request: {
				prompt,
				model: VARIATION_MODEL,
				// Server substitutes the best variation model the user's tier allows
				variation: true,
				imageInputs: [imageUrl],
				numOutputs: 4,
				seed: Math.floor(Math.random() * 2147483647),
				threadId: routeThreadId,
			},
		});
	};

	const handleVariations = (gen: Generation) => {
		if (gen.imageUrl) varyImage(gen.imageUrl, gen.prompt);
	};

	const handleUpscale = (gen: Generation) => {
		if (!queue.runTool(gen.id, "upscale")) toast.error("This image can't be upscaled.");
	};

	// Viewer and gallery tools work on any image (grid images and uploads included).
	const handleTool = (image: ViewerImage, tool: ImageTool) => {
		queue.enqueue({
			label: tool === "upscale" ? "Upscaling" : "Removing the background",
			model: `tool:${tool}`,
			threadId: routeThreadId,
			request: {
				prompt: image.generation?.prompt ?? "",
				tool,
				image: toImagePath(image.url),
				threadId: routeThreadId,
			},
		});
	};

	const handleReusePrompt = (prompt: string) => setPromptRequest({ text: prompt, nonce: Date.now() });

	const toolCost = (needle: string) => tools.find((t) => t.id.includes(needle))?.creditCost;
	const varyCost = models.find((m) => m.id === VARIATION_MODEL)?.creditCost;
	const actionCosts: ImageActionCosts = {
		vary: varyCost != null ? varyCost * 4 : undefined,
		upscale: toolCost("upscale"),
		"remove-background": toolCost("remove-background"),
	};

	const handleRemix = (gen: Generation) => {
		if (gen.imageUrl) {
			setImageInputs([gen.imageUrl]);
			setSelectedModel(DEFAULT_MODEL);
		}
	};

	const handleImageClick = (gen: Generation) => {
		const url = gen.imageUrl;
		if (!url) return;
		// Add image to inputs (append if not already present)
		setImageInputs((prev) => {
			if (prev.includes(url)) return prev;
			if (prev.length >= (selectedModelInfo?.maxImages || 14)) return prev;
			return [...prev, url];
		});
		// If model doesn't support image input, switch to one that does
		if (!supportsImageInput) setSelectedModel(DEFAULT_MODEL);
	};

	// --- Library actions ---

	const afterHistoryChange = (ok: boolean) => {
		if (!ok) return;
		refreshHistory();
		if (routeThreadId) fetchThread(routeThreadId);
	};
	const handleTrash = async (id: string) => afterHistoryChange(await trashGeneration(id));
	const handleRestore = async (id: string) => afterHistoryChange(await restoreGeneration(id));
	const handleDelete = async (id: string) => afterHistoryChange(await deleteGeneration(id));
	const handleArchive = async (id: string) => afterHistoryChange(await archiveGeneration(id));
	const handleUnarchive = async (id: string) => afterHistoryChange(await unarchiveGeneration(id));
	const afterUploadChange = (ok: boolean) => ok && fetchUploads(showArchived);
	const handleArchiveUpload = async (id: string) => afterUploadChange(await archiveUpload(id));
	const handleUnarchiveUpload = async (id: string) => afterUploadChange(await unarchiveUpload(id));
	const handleDeleteUpload = async (id: string) => afterUploadChange(await deleteUpload(id));

	const hasMore = history ? history.total > history.generations.length : false;

	// --- Series ---

	const listedSeries = threads.filter((t) => !t.archivedAt);
	const archivedSeries = threads.filter((t) => t.archivedAt);

	const handleRenameThread = async (thread: Thread, title: string) => {
		const ok = await renameThread(thread.id, title);
		if (!ok) toast.error("The name didn't save. Try again.");
		return ok;
	};

	const handleConfirmDeleteThread = async (deletePhotos: boolean) => {
		const thread = threadToDelete;
		if (!thread) return;
		const ok = await deleteThreadWithOptions(thread.id, deletePhotos);
		if (!ok) {
			toast.error("The series wasn't removed. Try again.");
			return;
		}
		setThreadToDelete(null);
		toast(deletePhotos ? "Series deleted" : "Series archived");
		refreshHistory();
		if (routeThreadId === thread.id) navigate(CREATE_PATH);
	};

	const handleRestoreThread = async (thread: Thread) => {
		const ok = await unarchiveThread(thread.id);
		if (ok) toast("Series restored");
		else toast.error("The series wasn't restored. Try again.");
	};

	const handleSignOut = () => {
		// Leave the app first, so the sign-out doesn't remember this page as a deep link.
		navigate("/", { replace: true });
		logout();
	};

	// Examples on the empty state fill the prompt bar; nothing is spent until Generate.
	const handlePromptPick = (prompt: string) => {
		setPromptRequest({ text: prompt, nonce: Date.now() });
	};

	// --- What the work area shows ---

	const newSeriesItems = queue.items.filter((q) => !q.threadId);
	const showWelcome = threadsLoaded && threads.length === 0 && queue.items.length === 0;
	// Failures the current view doesn't already show, each with its own Retry/Dismiss.
	const unseenFailures = queue.items.filter((q) => {
		if (q.status !== "failed") return false;
		if (view.kind !== "create") return true;
		return routeThreadId ? q.threadId !== routeThreadId : !!q.threadId;
	});
	const showPromptBar = view.kind === "create" || view.kind === "gallery";

	const feedProps = {
		onVariations: handleVariations,
		onVaryImage: varyImage,
		onUpscale: handleUpscale,
		onRemix: handleRemix,
		onTrash: handleTrash,
		// "Use as reference" on the selected step; clicking an image opens the viewer.
		onImageClick: handleImageClick,
		onLoadMore: () => {},
		hasMore: false,
		onRestore: handleRestore,
		onTool: handleTool,
		onReusePrompt: handleReusePrompt,
		onRetry: (item: { id: string }) => queue.retry(item.id),
		onDismiss: queue.dismiss,
		selectedInputUrls: imageInputs,
		actionCosts,
		pendingAspectRatio: creationOptions.aspectRatio,
	};

	let content: React.ReactNode;
	if (view.kind === "create" && routeThreadId) {
		content = (
			<div className="mx-auto w-full max-w-3xl px-4 py-6">
				<SeriesHeader
					thread={openThread}
					onRename={setThreadToRename}
					// The list entry carries the image count the dialog shows.
					onDelete={(t) => setThreadToDelete(threads.find((x) => x.id === t.id) ?? t)}
				/>
				<div className="mt-6">
					{openThread ? (
						<ChatFeed
							{...feedProps}
							generations={openThread.generations ?? []}
							queuedItems={queue.items.filter((q) => q.threadId === routeThreadId)}
							loading={threadsLoading}
						/>
					) : (
						<Skeleton className="aspect-[4/3] w-full rounded-xl" />
					)}
				</div>
			</div>
		);
	} else if (view.kind === "create") {
		content = (
			<div className="mx-auto w-full max-w-3xl px-4 py-6">
				{newSeriesItems.length > 0 ? (
					<ChatFeed {...feedProps} generations={[]} queuedItems={newSeriesItems} loading={false} />
				) : showWelcome ? (
					<WelcomeScreen
						onPromptPick={handlePromptPick}
						onOpenModelGuide={() => setShowModelsRef(true)}
					/>
				) : threadsLoaded ? (
					<NewSeriesIntro recent={listedSeries} />
				) : null}
			</div>
		);
	} else if (view.kind === "gallery") {
		content = (
			<div className="px-4 py-6">
				<LibraryHeader view={view} />
				{showArchived && (
					<ArchivedSeries threads={archivedSeries} onRestore={handleRestoreThread} />
				)}
				<ImageGallery
					key={view.library}
					generations={history?.generations || []}
					uploads={!showTrash ? uploads : []}
					queuedItems={queue.items}
					onTrash={handleTrash}
					onRestore={handleRestore}
					onDelete={handleDelete}
					onArchive={handleArchive}
					onUnarchive={handleUnarchive}
					onArchiveUpload={handleArchiveUpload}
					onUnarchiveUpload={handleUnarchiveUpload}
					onDeleteUpload={handleDeleteUpload}
					onDismissQueueItem={queue.dismiss}
					onAddToInputs={supportsImageInput ? handleAddToInputs : undefined}
					selectedInputUrls={imageInputs}
					onLoadMore={handleLoadMore}
					hasMore={hasMore}
					loading={historyLoading}
					showTrash={showTrash}
					showArchived={showArchived}
					onVariations={handleVariations}
					onVaryImage={varyImage}
					onUpscale={handleUpscale}
					onTool={handleTool}
					onUseAsReference={(image) => handleAddToInputs(image.url)}
					onReusePrompt={handleReusePrompt}
					actionCosts={actionCosts}
				/>
			</div>
		);
	} else if (view.kind === "billing") {
		content = (
			<SolanaBoundary fallback={<BillingLoading />}>
				<Billing embedded onBack={() => navigate(CREATE_PATH)} />
			</SolanaBoundary>
		);
	} else {
		content = <Settings />;
	}

	return (
		<AppShell
			username={user.username}
			isAdmin={user.isAdmin}
			credits={balance}
			lowAt={currentTotalCost * 2}
			onSignOut={handleSignOut}
			renderNav={(onNavigate) => (
				<Sidebar
					threads={listedSeries}
					selectedThreadId={routeThreadId}
					loading={!threadsLoaded}
					onNewSeries={() => navigate(CREATE_PATH)}
					onRenameSeries={setThreadToRename}
					onDeleteSeries={setThreadToDelete}
					onOpenModelGuide={() => setShowModelsRef(true)}
					onNavigate={onNavigate}
				/>
			)}
		>
			{/* Billing handles its own return from Stripe (it refreshes its page, then the balance). */}
			{view.kind !== "billing" && <CheckoutReturnWatcher onReturn={refreshCredits} />}
			{(paywallMounted || paywall.isOpen) && (
				<SolanaBoundary>
					<PaywallSheet />
				</SolanaBoundary>
			)}

			<div className="min-h-0 flex-1 overflow-y-auto">{content}</div>

			{showPromptBar && (
				<>
					<div className="px-4 pb-2 empty:hidden">
						<GenerationStatus failures={unseenFailures} />
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
						outputCountEnabled
						onGenerate={handleGenerate}
						onEnhance={enhancePrompt}
						loading={queue.busy}
						queueCount={queue.items.filter((q) => q.status !== "failed").length}
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

			<ThreadDeleteDialog
				isOpen={!!threadToDelete}
				onClose={() => setThreadToDelete(null)}
				thread={threadToDelete}
				onConfirm={handleConfirmDeleteThread}
			/>
			<RenameSeriesDialog
				thread={threadToRename}
				onClose={() => setThreadToRename(null)}
				onRename={handleRenameThread}
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
		</AppShell>
	);
}

const LIBRARY_NOTES: Record<"all" | "archive" | "trash", string> = {
	all: "Every image you've made, newest first.",
	archive: "Images and series you've put away. They stay here until you restore or delete them.",
	trash: "Images in Trash are deleted for good an hour after you move them here.",
};

function LibraryHeader({ view }: { view: Extract<AppView, { kind: "gallery" }> }) {
	return (
		<div className="mb-6">
			<h1 className="font-display text-3xl">{LIBRARY_TITLES[view.library]}</h1>
			<p className="mt-2 max-w-prose text-sm text-muted-foreground">
				{LIBRARY_NOTES[view.library]}
			</p>
		</div>
	);
}

/** `/`: the landing page when signed out; the app (or a remembered deep link) when signed in. */
function RootRoute() {
	const { user, token, loading } = useAuth();
	const location = useLocation();
	if (loading) return <FullPageLoading />;
	// Keep the router state (e.g. isNewUser from a magic link) for the app's first run.
	if (user && token) return <Navigate to={peekReturnPath()} replace state={location.state} />;
	return <Landing />;
}

/** App routes require an account; signed-out visitors go to the landing page and come back after signing in. */
function SignedInApp() {
	const { user, token, loading } = useAuth();
	const location = useLocation();
	if (loading) return <FullPageLoading />;
	if (!user || !token) {
		// The "confirm your new email" link works without a session.
		if (location.pathname === "/settings" && new URLSearchParams(location.search).has("confirmEmail")) {
			return <Settings />;
		}
		rememberReturnPath(location.pathname + location.search);
		return <Navigate to="/" replace />;
	}
	return <MainApp />;
}

function AdminRoute({ children }: { children: React.ReactNode }) {
	const { user, loading } = useAuth();
	if (loading) return <FullPageLoading />;
	if (!user?.isAdmin) return <Navigate to="/" replace />;
	return <>{children}</>;
}

function AppRoutes() {
	return (
		<Routes>
			<Route path="/" element={<RootRoute />} />
			{/* One mounted app for all of these; the screen comes from the path. */}
			<Route element={<SignedInApp />}>
				<Route path="/create" element={null} />
				<Route path="/create/:threadId" element={null} />
				<Route path="/gallery" element={null} />
				<Route path="/gallery/:library" element={null} />
				<Route path="/billing" element={null} />
				<Route path="/settings" element={null} />
			</Route>
			<Route
				path="/login"
				element={
					<SolanaBoundary fallback={<FullPageLoading />}>
						<LoginPage />
					</SolanaBoundary>
				}
			/>
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
			<Route path="/s/:slug" element={<SharedImage />} />
			<Route
				path="/admin/*"
				element={
					<AdminRoute>
						<Suspense fallback={<AdminLoading />}>
							<AdminApp />
						</Suspense>
					</AdminRoute>
				}
			/>
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
					<PendingSignIn />
				</AuthProvider>
			</BrowserRouter>
		</ErrorBoundary>
	);
}

export default App;
