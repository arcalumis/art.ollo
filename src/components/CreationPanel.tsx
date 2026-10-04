import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { useMediaQuery } from "@/lib/useMediaQuery";
import { cn } from "@/lib/utils";
import {
	CameraIcon,
	CheckIcon,
	ChevronDownIcon,
	ImagesIcon,
	LockIcon,
	MinusIcon,
	PlusIcon,
	RectangleHorizontalIcon,
	RectangleVerticalIcon,
	ScanIcon,
	SparklesIcon,
	SquareIcon,
	UploadIcon,
	XIcon,
} from "lucide-react";
import { type ReactElement, useCallback, useEffect, useId, useRef, useState } from "react";
import { API_BASE } from "../config";
import {
	CATALOG,
	type CatalogModel,
	MATCH_INPUT,
	TIERS,
	TIER_LABELS,
	TIER_RESOLUTION,
	type Tier,
	availableTiers,
	creditsPerOutput,
	groupModels,
	isTierAllowed,
	orientationOf,
	outputSizeLabel,
	ratioChoices,
	resolveTier,
	snapRatio,
	tierFromResolution,
	visibleModels,
} from "../config/models";
import type { Model } from "../types";
import {
	blobToFile,
	convertHeicToPng,
	isHeicFile,
	resizeImageIfNeeded,
} from "../utils/imageResize";
import { ImagePicker } from "./ImagePicker";

export interface CreationOptions {
	aspectRatio: string;
	/** Size tier as the server reads it: "1K" Draft, "2K" Standard, "4K" Max. */
	resolution: string;
	outputFormat: string;
	/** Images per Generate (only used when the panel's output stepper is enabled). */
	numOutputs?: number;
}

interface CreationPanelProps {
	/** Replaces the prompt text whenever `nonce` changes (starter prompts, example picks). */
	promptRequest?: { text: string; nonce: number } | null;
	// Model
	models: Model[];
	selectedModel: string;
	onSelectModel: (id: string) => void;
	supportsImageInput: boolean;

	// Images
	token: string;
	imageInputs: string[];
	onImagesChange: (urls: string[]) => void;
	maxImages: number;

	// Options
	options: CreationOptions;
	onOptionsChange: (opts: CreationOptions) => void;

	// Actions
	onGenerate: (prompt: string) => void;
	onEnhance: (prompt: string, hasImages?: boolean) => Promise<string>;

	// State
	loading: boolean;
	queueCount: number;

	// Subscription
	allowedModels?: string[] | null;

	// Credits
	/** Per-output credit cost of the selected model (fallback while the catalog loads). */
	creditCost?: number;
	/** Images one Generate produces when the output stepper is off. */
	numOutputs?: number;
	/**
	 * Show the "images per Generate" stepper. Only turn on once the caller sends
	 * `options.numOutputs` with the request, or the cost shown would be wrong.
	 */
	outputCountEnabled?: boolean;
	/** Current balance; null while loading. */
	balance?: number | null;
	/** Generations run on the user's own Replicate key and cost no credits. */
	usesOwnKey?: boolean;
	/** The balance can't cover this generation: open the upgrade sheet. */
	onNeedCredits?: (needed: number) => void;
	/** A model (or size) outside the user's plan was picked: open the upgrade sheet. */
	onLockedModel?: (modelId: string) => void;
}

const iconPill =
	"inline-flex h-10 shrink-0 items-center justify-center gap-1.5 rounded-full border border-border bg-muted px-3.5 text-[0.85rem] font-medium text-foreground outline-none hover:border-foreground/30 focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 aria-expanded:border-foreground/30";

/** A snapped ratio more than this far off is not offered. */
const MAX_SNAP_OFF = 0.1;

const catalogById = new Map(CATALOG.map((m) => [m.id, m]));

/** Catalog -> the shape /api/models returns, for use before it loads. */
function catalogAsModel(m: CatalogModel): Model {
	return {
		id: m.id,
		name: m.name,
		description: m.description,
		group: m.group,
		supportsImageInput: m.refs.max > 0,
		maxImages: m.refs.max,
		defaultTier: m.defaultTier,
	};
}

function creditsLabel(n: number): string {
	return `${n} ${n === 1 ? "credit" : "credits"}`;
}

/** "2 credits" or "2–11 credits" across a model's sizes (no reference images). */
function costRange(model: Model): string {
	const catalog = catalogById.get(model.id);
	const tiers = catalog ? availableTiers(catalog) : [];
	const costs = tiers.map((t) => creditsPerOutput(model.id, t, 0, model));
	if (costs.length === 0) return creditsLabel(model.creditCost ?? 2);
	const lo = Math.min(...costs);
	const hi = Math.max(...costs);
	return lo === hi ? creditsLabel(lo) : `${lo}–${hi} credits`;
}

/** Popover on desktop, bottom sheet on phones; same content. */
function SettingsMenu({
	isDesktop,
	open,
	onOpenChange,
	trigger,
	title,
	children,
	className,
}: {
	isDesktop: boolean;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	trigger: ReactElement;
	title: string;
	children: React.ReactNode;
	className?: string;
}) {
	if (isDesktop) {
		return (
			<Popover open={open} onOpenChange={onOpenChange}>
				<PopoverTrigger render={trigger} />
				<PopoverContent
					side="top"
					align="start"
					sideOffset={10}
					aria-label={title}
					className={cn(
						"max-h-[min(70dvh,36rem)] gap-0 overflow-y-auto rounded-2xl border border-border bg-card p-0 shadow-lg ring-0",
						className,
					)}
				>
					{children}
				</PopoverContent>
			</Popover>
		);
	}
	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			<SheetTrigger render={trigger} />
			<SheetContent
				side="bottom"
				className="max-h-[85dvh] gap-0 overflow-y-auto rounded-t-2xl border-border bg-card pb-[max(1rem,env(safe-area-inset-bottom))]"
			>
				<SheetHeader className="pr-12 pb-1">
					<SheetTitle className="font-sans text-lg font-semibold">{title}</SheetTitle>
				</SheetHeader>
				{children}
			</SheetContent>
		</Sheet>
	);
}

function ModelList({
	models,
	selectedModel,
	isLocked,
	onPick,
}: {
	models: Model[];
	selectedModel: string;
	isLocked: (id: string) => boolean;
	onPick: (id: string) => void;
}) {
	return (
		<div className="flex flex-col pb-2">
			{groupModels(models).map(({ group, models: items }) => (
				<section key={group} aria-label={group}>
					<p className="px-4 pt-3 pb-1 text-xs font-medium text-muted-foreground">{group}</p>
					<div className="flex flex-col px-1.5">
						{items.map((m) => {
							const selected = m.id === selectedModel;
							const locked = isLocked(m.id);
							const catalog = catalogById.get(m.id);
							return (
								<button
									key={m.id}
									type="button"
									onClick={() => onPick(m.id)}
									aria-pressed={selected}
									className={cn(
										"flex min-h-12 w-full items-start gap-3 rounded-lg px-2.5 py-2.5 text-left outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50",
										selected && "bg-muted",
									)}
								>
									<span className="min-w-0 flex-1">
										<span className="flex items-center gap-1.5 text-[0.92rem] font-medium text-foreground">
											{m.name}
											{selected && (
												<CheckIcon className="size-4 text-verdigris" aria-label="Selected" />
											)}
										</span>
										<span className="mt-0.5 block text-[0.8rem] leading-snug text-muted-foreground">
											{m.description}
											{catalog && catalog.refs.min > 0 && " Needs an image."}
										</span>
									</span>
									<span className="flex shrink-0 items-center gap-1 pt-0.5 text-[0.8rem] whitespace-nowrap text-muted-foreground tabular-nums">
										{locked ? (
											<>
												<LockIcon className="size-3.5" aria-hidden />
												Upgrade
											</>
										) : (
											costRange(m)
										)}
									</span>
								</button>
							);
						})}
					</div>
				</section>
			))}
		</div>
	);
}

function SectionLabel({ children, id }: { children: React.ReactNode; id?: string }) {
	return (
		<p id={id} className="text-xs font-medium text-muted-foreground">
			{children}
		</p>
	);
}

type Orientation = "square" | "portrait" | "landscape" | "match";

function ShapeAndSize({
	catalog,
	serverModel,
	options,
	onOptionsChange,
	canMatchInput,
	refsCount,
	allowedModels,
	onLockedModel,
	outputCountEnabled,
}: {
	catalog: CatalogModel;
	serverModel?: Model;
	options: CreationOptions;
	onOptionsChange: (opts: CreationOptions) => void;
	canMatchInput: boolean;
	refsCount: number;
	allowedModels: string[] | null;
	onLockedModel?: (modelId: string) => void;
	outputCountEnabled: boolean;
}) {
	const shapeId = useId();
	const sizeId = useId();
	const ratio = options.aspectRatio;
	const orientation: Orientation = ratio === MATCH_INPUT ? "match" : orientationOf(ratio);
	const choices = ratioChoices(catalog);
	const tier = resolveTier(catalog, tierFromResolution(options.resolution));
	const outputs = options.numOutputs ?? 1;
	const maxOutputs = Math.min(4, catalog.maxOutputs);

	const pickOrientation = (o: Orientation) => {
		if (o === "match") return onOptionsChange({ ...options, aspectRatio: MATCH_INPUT });
		if (o === "square") return onOptionsChange({ ...options, aspectRatio: "1:1" });
		const list = choices[o];
		const preferred = o === "portrait" ? "3:4" : "4:3";
		const native = list.filter((r) => !snapRatio(catalog, r).snapped);
		const next = native.includes(preferred) ? preferred : (native[0] ?? list[0]);
		onOptionsChange({ ...options, aspectRatio: next });
	};

	const segments: { value: Orientation; label: string; icon: ReactElement }[] = [
		{ value: "square", label: "Square", icon: <SquareIcon className="size-4" /> },
		{ value: "portrait", label: "Portrait", icon: <RectangleVerticalIcon className="size-4" /> },
		{
			value: "landscape",
			label: "Landscape",
			icon: <RectangleHorizontalIcon className="size-4" />,
		},
	];
	if (canMatchInput)
		segments.push({ value: "match", label: "Match input", icon: <ScanIcon className="size-4" /> });

	const snap = ratio === MATCH_INPUT ? null : snapRatio(catalog, ratio);

	return (
		<div className="flex flex-col gap-5 p-4">
			<section className="flex flex-col gap-2.5" aria-labelledby={shapeId}>
				<SectionLabel id={shapeId}>Shape</SectionLabel>
				<div
					aria-labelledby={shapeId}
					className="grid auto-cols-fr grid-flow-col gap-1 rounded-xl bg-muted p-1"
				>
					{segments.map((s) => {
						const checked = orientation === s.value;
						return (
							<button
								key={s.value}
								type="button"
								aria-pressed={checked}
								onClick={() => pickOrientation(s.value)}
								className={cn(
									"flex min-h-10 flex-col items-center justify-center gap-0.5 rounded-lg px-1 text-[0.78rem] font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 sm:flex-row sm:gap-1.5",
									checked && "bg-card text-foreground shadow-sm ring-1 ring-verdigris/70",
								)}
							>
								{s.icon}
								<span className="leading-tight">{s.label}</span>
							</button>
						);
					})}
				</div>

				{(orientation === "portrait" || orientation === "landscape") && (
					<div className="flex flex-wrap gap-1.5" aria-label={`${orientation} ratios`}>
						{choices[orientation].map((r) => {
							const s = snapRatio(catalog, r);
							const disabled = s.snapped && s.off > MAX_SNAP_OFF;
							const checked = ratio === r;
							return (
								<button
									key={r}
									type="button"
									aria-pressed={checked}
									disabled={disabled}
									onClick={() => onOptionsChange({ ...options, aspectRatio: r })}
									title={disabled ? "Not available for this model" : undefined}
									className={cn(
										"flex min-h-10 min-w-14 flex-col items-center justify-center rounded-full border border-border bg-muted px-3 text-[0.85rem] font-medium text-foreground tabular-nums outline-none hover:border-foreground/30 focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-40",
										checked && "border-verdigris bg-verdigris/10",
									)}
								>
									{r}
									{s.snapped && !disabled && (
										<span className="text-[0.68rem] leading-none font-normal text-muted-foreground">
											renders as {s.ratio}
										</span>
									)}
								</button>
							);
						})}
					</div>
				)}
				{orientation === "match" && (
					<p className="text-[0.8rem] text-muted-foreground">
						Keeps the shape of the first image you added.
					</p>
				)}
				{snap?.snapped && orientation === "square" && (
					<p className="text-[0.8rem] text-muted-foreground">
						Renders as {snap.ratio} with this model.
					</p>
				)}
			</section>

			<section className="flex flex-col gap-2.5" aria-labelledby={sizeId}>
				<SectionLabel id={sizeId}>Size</SectionLabel>
				<div aria-labelledby={sizeId} className="grid grid-cols-3 gap-1.5">
					{TIERS.map((t: Tier) => {
						const available = !!catalog.tiers[t];
						const allowed = available && isTierAllowed(allowedModels, catalog.id, t);
						const checked = available && tier === t;
						const credits = available
							? creditsPerOutput(catalog.id, t, refsCount, serverModel)
							: null;
						const size = available ? outputSizeLabel(catalog, t, ratio, serverModel) : null;
						return (
							<button
								key={t}
								type="button"
								aria-pressed={checked}
								disabled={!available}
								onClick={() => {
									if (!allowed) return onLockedModel?.(catalog.id);
									onOptionsChange({ ...options, resolution: TIER_RESOLUTION[t] });
								}}
								title={available ? undefined : "Not available for this model"}
								className={cn(
									"flex min-h-14 flex-col items-center justify-center gap-0.5 rounded-xl border border-border bg-muted px-2 py-1.5 outline-none hover:border-foreground/30 focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-40",
									checked && "border-verdigris bg-verdigris/10",
								)}
							>
								<span className="flex items-center gap-1 text-[0.85rem] font-medium text-foreground">
									{!allowed && available && (
										<LockIcon className="size-3.5" aria-label="Upgrade to use" />
									)}
									{TIER_LABELS[t]}
								</span>
								{size && (
									<span className="text-[0.75rem] whitespace-nowrap text-foreground/80 tabular-nums">
										{size}
									</span>
								)}
								<span className="text-[0.72rem] text-muted-foreground tabular-nums">
									{credits === null ? "Not offered" : allowed ? creditsLabel(credits) : "Upgrade"}
								</span>
							</button>
						);
					})}
				</div>
				{catalog.tiers[tier]?.hint && (
					<p className="text-[0.8rem] text-muted-foreground">{catalog.tiers[tier]?.hint}</p>
				)}
			</section>

			{outputCountEnabled && maxOutputs > 1 && (
				<section className="flex items-center justify-between gap-3">
					<SectionLabel>Images per Generate</SectionLabel>
					<div className="flex items-center gap-1 rounded-full border border-border bg-muted p-0.5">
						<Button
							type="button"
							variant="ghost"
							size="icon"
							className="rounded-full"
							aria-label="Fewer images"
							disabled={outputs <= 1}
							onClick={() => onOptionsChange({ ...options, numOutputs: Math.max(1, outputs - 1) })}
						>
							<MinusIcon />
						</Button>
						<span
							className="w-6 text-center text-[0.95rem] font-medium tabular-nums"
							aria-live="polite"
						>
							{outputs}
						</span>
						<Button
							type="button"
							variant="ghost"
							size="icon"
							className="rounded-full"
							aria-label="More images"
							disabled={outputs >= maxOutputs}
							onClick={() =>
								onOptionsChange({ ...options, numOutputs: Math.min(maxOutputs, outputs + 1) })
							}
						>
							<PlusIcon />
						</Button>
					</div>
				</section>
			)}
		</div>
	);
}

export function CreationPanel({
	promptRequest,
	models,
	selectedModel,
	onSelectModel,
	supportsImageInput,
	token,
	imageInputs,
	onImagesChange,
	maxImages,
	options,
	onOptionsChange,
	onGenerate,
	onEnhance,
	loading,
	queueCount,
	allowedModels,
	creditCost,
	numOutputs = 1,
	outputCountEnabled = false,
	balance = null,
	usesOwnKey = false,
	onNeedCredits,
	onLockedModel,
}: CreationPanelProps) {
	const isDesktop = useMediaQuery("(min-width: 640px)");
	const allowed = allowedModels ?? null;
	const catalog = catalogById.get(selectedModel);
	const serverModel = models.find((m) => m.id === selectedModel);
	const pickerModels = models.some((m) => m.group)
		? models.filter((m) => m.kind !== "tool" && !m.hidden)
		: visibleModels().map(catalogAsModel);
	const isLocked = (id: string) => {
		const m = catalogById.get(id);
		return !isTierAllowed(allowed, id, m?.defaultTier ?? "standard");
	};

	const [prompt, setPrompt] = useState("");
	useEffect(() => {
		if (promptRequest) setPrompt(promptRequest.text);
	}, [promptRequest]);
	const [enhancing, setEnhancing] = useState(false);
	const [uploading, setUploading] = useState(false);
	const [converting, setConverting] = useState(false);
	const [uploadError, setUploadError] = useState<string | null>(null);
	const [showPicker, setShowPicker] = useState(false);
	const [modelMenuOpen, setModelMenuOpen] = useState(false);
	const [shapeMenuOpen, setShapeMenuOpen] = useState(false);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const cameraInputRef = useRef<HTMLInputElement>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);
	const reasonId = useId();

	// Latest options for effects that react to model / image changes.
	const optionsRef = useRef(options);
	optionsRef.current = options;
	const onOptionsChangeRef = useRef(onOptionsChange);
	onOptionsChangeRef.current = onOptionsChange;

	// A new model starts at its own default size, with outputs inside its limit.
	const prevModelRef = useRef(selectedModel);
	useEffect(() => {
		if (prevModelRef.current === selectedModel) return;
		prevModelRef.current = selectedModel;
		const m = catalogById.get(selectedModel);
		if (!m) return;
		const current = optionsRef.current;
		const next: CreationOptions = { ...current, resolution: TIER_RESOLUTION[m.defaultTier] };
		if (current.numOutputs !== undefined)
			next.numOutputs = Math.min(current.numOutputs, Math.min(4, m.maxOutputs));
		if (current.aspectRatio === MATCH_INPUT && m.refs.max === 0) next.aspectRatio = "1:1";
		onOptionsChangeRef.current(next);
	}, [selectedModel]);

	// "Match input" follows the attached image: on when the first image arrives, off when none remain.
	const hadImagesRef = useRef(imageInputs.length > 0);
	useEffect(() => {
		const has = imageInputs.length > 0;
		if (has === hadImagesRef.current) return;
		hadImagesRef.current = has;
		const current = optionsRef.current;
		if (has && supportsImageInput && current.aspectRatio !== MATCH_INPUT) {
			onOptionsChangeRef.current({ ...current, aspectRatio: MATCH_INPUT });
		} else if (!has && current.aspectRatio === MATCH_INPUT) {
			onOptionsChangeRef.current({ ...current, aspectRatio: "1:1" });
		}
	}, [imageInputs.length, supportsImageInput]);

	const maxRefs = catalog ? catalog.refs.max : maxImages;
	const requiresImage = (catalog?.refs.min ?? 0) > 0;
	const needsImage = requiresImage && imageInputs.length === 0;
	const tooManyImages = supportsImageInput && imageInputs.length > maxRefs;
	const refsCount = supportsImageInput ? Math.min(imageInputs.length, maxRefs) : 0;
	// Same resolution the server applies: a missing size falls to the nearest one the model has.
	const tier: Tier = catalog
		? resolveTier(catalog, tierFromResolution(options.resolution))
		: "standard";
	const tierLocked = catalog ? !isTierAllowed(allowed, catalog.id, tier) : false;

	// Cost at the point of action.
	const perOutput = catalog
		? creditsPerOutput(selectedModel, tier, refsCount, serverModel)
		: (creditCost ?? 2);
	const outputs = outputCountEnabled ? Math.max(1, options.numOutputs ?? 1) : numOutputs;
	const totalCost = perOutput * outputs;
	const cantAfford = !usesOwnKey && balance !== null && balance < totalCost;
	const lowBalance = !usesOwnKey && !cantAfford && balance !== null && balance < totalCost * 2;
	const costLabel = usesOwnKey ? "your Replicate key" : creditsLabel(totalCost);

	// Pill labels.
	const ratioLabel = options.aspectRatio === MATCH_INPUT ? "Match input" : options.aspectRatio;
	const snapped =
		catalog && options.aspectRatio !== MATCH_INPUT ? snapRatio(catalog, options.aspectRatio) : null;
	const sizeText = catalog
		? outputSizeLabel(catalog, tier, options.aspectRatio, serverModel)
		: null;
	const shapeText = snapped?.snapped ? snapped.ratio : ratioLabel;
	const shapeIcon =
		options.aspectRatio === MATCH_INPUT ? (
			<ScanIcon className="size-4" />
		) : orientationOf(options.aspectRatio) === "portrait" ? (
			<RectangleVerticalIcon className="size-4" />
		) : orientationOf(options.aspectRatio) === "landscape" ? (
			<RectangleHorizontalIcon className="size-4" />
		) : (
			<SquareIcon className="size-4" />
		);

	// Auto-resize textarea
	useEffect(() => {
		if (textareaRef.current) {
			textareaRef.current.style.height = "auto";
			const scrollHeight = textareaRef.current.scrollHeight;
			textareaRef.current.style.height = `${Math.min(Math.max(scrollHeight, 72), 240)}px`;
		}
	}, [prompt]);

	const canSubmit = !!prompt.trim() && !loading && !enhancing && !needsImage && !tooManyImages;

	const handleSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		if (!canSubmit) return;
		if (tierLocked && catalog) {
			onLockedModel?.(catalog.id);
			return;
		}
		// Not enough credits: show the upgrade sheet over the work instead of a failed request.
		if (cantAfford) {
			onNeedCredits?.(totalCost);
			return;
		}
		onGenerate(prompt.trim());
		setPrompt("");
	};

	const handleEnhance = async () => {
		if (!prompt.trim() || enhancing) return;
		setEnhancing(true);
		try {
			const enhanced = await onEnhance(prompt.trim(), imageInputs.length > 0);
			if (enhanced?.trim()) {
				setPrompt(enhanced);
			}
		} catch (err) {
			console.error("Enhancement failed:", err);
		} finally {
			setEnhancing(false);
		}
	};

	const handleKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			handleSubmit(e);
		}
	};

	const handleModelChange = (id: string) => {
		setModelMenuOpen(false);
		if (isLocked(id)) {
			onLockedModel?.(id);
			return;
		}
		onSelectModel(id);
	};

	// File upload handler
	const uploadFile = useCallback(
		async (file: File) => {
			let fileToUpload = file;
			try {
				const result = await resizeImageIfNeeded(file);
				if (result.resized) {
					fileToUpload = blobToFile(result.blob, file);
				}
			} catch (err) {
				console.error("Resize failed:", err);
			}

			const formData = new FormData();
			formData.append("file", fileToUpload);

			const response = await fetch(`${API_BASE}/api/uploads`, {
				method: "POST",
				headers: { Authorization: `Bearer ${token}` },
				body: formData,
			});

			if (!response.ok) throw new Error("Upload failed");
			return (await response.json()) as { imageUrl: string };
		},
		[token],
	);

	const handleFileInput = async (e: React.ChangeEvent<HTMLInputElement>) => {
		const files = e.target.files;
		if (!files?.length) return;

		setUploading(true);
		setUploadError(null);
		try {
			const newUrls: string[] = [];
			const errors: string[] = [];

			for (let file of Array.from(files)) {
				// Check if file is an image (including HEIC)
				const isImage = file.type.startsWith("image/") || isHeicFile(file);
				if (!isImage) continue;
				if (imageInputs.length + newUrls.length >= maxRefs) break;

				// Convert HEIC to PNG if needed
				if (isHeicFile(file)) {
					setConverting(true);
					try {
						file = await convertHeicToPng(file);
					} catch (err) {
						console.error("HEIC conversion failed:", err);
						errors.push(`${file.name} couldn't be converted`);
						continue;
					} finally {
						setConverting(false);
					}
				}

				try {
					const upload = await uploadFile(file);
					newUrls.push(upload.imageUrl);
				} catch (err) {
					console.error("Upload failed:", err);
					errors.push(`${file.name} didn't upload`);
				}
			}

			onImagesChange([...imageInputs, ...newUrls]);
			if (errors.length > 0) {
				setUploadError(`${errors.join(", ")}. Try again.`);
				setTimeout(() => setUploadError(null), 5000);
			}
		} catch (err) {
			console.error("Upload failed:", err);
			setUploadError("The upload didn't finish. Try again.");
			setTimeout(() => setUploadError(null), 5000);
		} finally {
			setUploading(false);
			setConverting(false);
			e.target.value = "";
		}
	};

	const handleLibrarySelect = (urls: string[]) => {
		const newUrls = urls.filter((url) => !imageInputs.includes(url));
		onImagesChange([...imageInputs, ...newUrls]);
	};

	const removeImage = (url: string) => {
		onImagesChange(imageInputs.filter((u) => u !== url));
	};

	const atImageLimit = imageInputs.length >= maxRefs;
	const imageControlsDisabled = uploading || converting || atImageLimit;
	const selectedName = serverModel?.name ?? catalog?.name ?? "Model";

	return (
		<div className="border-t border-border bg-card px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
			<form onSubmit={handleSubmit} className="mx-auto flex max-w-3xl flex-col gap-2.5">
				{/* Selected reference images */}
				{imageInputs.length > 0 && (
					<div className="flex flex-wrap items-center gap-2">
						{imageInputs.map((url) => {
							const imgSrc = url.startsWith("http") ? url : `${API_BASE}${url}`;
							return (
								<button
									key={url}
									type="button"
									onClick={() => removeImage(url)}
									className="group relative size-11 overflow-hidden rounded-lg bg-muted outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
									aria-label="Remove reference image"
								>
									<img src={imgSrc} alt="" className="size-full object-cover" />
									<span className="absolute inset-0 hidden place-items-center bg-background/70 group-hover:grid group-focus-visible:grid">
										<XIcon className="size-4 text-foreground" />
									</span>
								</button>
							);
						})}
						{supportsImageInput ? (
							<span className="text-xs text-muted-foreground tabular-nums">
								{imageInputs.length}/{maxRefs}
							</span>
						) : (
							<span className="text-xs text-muted-foreground">
								{selectedName} doesn't use reference images.
							</span>
						)}
					</div>
				)}

				{needsImage && (
					<p className="text-sm text-muted-foreground">Add the image you want to edit.</p>
				)}
				{tooManyImages && (
					<p className="text-sm text-muted-foreground">
						{selectedName} uses up to {maxRefs} {maxRefs === 1 ? "image" : "images"}. Remove{" "}
						{imageInputs.length - maxRefs} to continue.
					</p>
				)}

				<label className="block">
					<span className="sr-only">Prompt</span>
					<textarea
						ref={textareaRef}
						value={prompt}
						onChange={(e) => setPrompt(e.target.value)}
						onKeyDown={handleKeyDown}
						placeholder={
							requiresImage ? "Describe the change you want" : "Describe the image you want"
						}
						disabled={enhancing}
						rows={2}
						className="block w-full resize-none rounded-xl border border-border bg-muted px-4 py-3 text-[0.95rem] text-foreground outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30 disabled:opacity-60"
					/>
				</label>

				{/* Settings as pills; scrolls inside itself on narrow screens, never the page. */}
				<div className="-mx-4 flex items-center gap-2 overflow-x-auto px-4 pb-0.5 [scrollbar-width:none]">
					<SettingsMenu
						isDesktop={isDesktop}
						open={modelMenuOpen}
						onOpenChange={setModelMenuOpen}
						title="Choose a model"
						className="w-[26rem]"
						trigger={
							<button
								type="button"
								className={cn(iconPill, "max-w-[12.5rem] pr-3")}
								aria-label={`Model: ${selectedName}`}
							>
								<span className="truncate">{selectedName}</span>
								<ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
							</button>
						}
					>
						<ModelList
							models={pickerModels}
							selectedModel={selectedModel}
							isLocked={isLocked}
							onPick={handleModelChange}
						/>
					</SettingsMenu>

					{catalog && (
						<SettingsMenu
							isDesktop={isDesktop}
							open={shapeMenuOpen}
							onOpenChange={setShapeMenuOpen}
							title="Shape and size"
							className="w-[24rem]"
							trigger={
								<button
									type="button"
									className={iconPill}
									aria-label={`Shape ${shapeText}, size ${TIER_LABELS[tier]}${sizeText ? `, ${sizeText}` : ""}`}
								>
									{shapeIcon}
									<span className="whitespace-nowrap tabular-nums">
										{/* Exact pixels say the shape; "≈ 2 MP" doesn't, so the ratio stays with it. */}
										{TIER_LABELS[tier]}
										{sizeText && !sizeText.startsWith("≈") ? "" : ` · ${shapeText}`}
										{sizeText ? ` · ${sizeText}` : ""}
										{outputCountEnabled && outputs > 1 ? ` · ×${outputs}` : ""}
									</span>
									<ChevronDownIcon className="size-3.5 text-muted-foreground" aria-hidden />
								</button>
							}
						>
							<ShapeAndSize
								catalog={catalog}
								serverModel={serverModel}
								options={options}
								onOptionsChange={onOptionsChange}
								canMatchInput={supportsImageInput && imageInputs.length > 0}
								refsCount={refsCount}
								allowedModels={allowed}
								onLockedModel={onLockedModel}
								outputCountEnabled={outputCountEnabled}
							/>
						</SettingsMenu>
					)}

					{supportsImageInput && (
						<>
							<button
								type="button"
								onClick={() => cameraInputRef.current?.click()}
								disabled={imageControlsDisabled}
								className={cn(iconPill, "w-10 px-0 md:hidden")}
								aria-label="Take a photo"
							>
								<CameraIcon className="size-4" />
							</button>
							<input
								ref={cameraInputRef}
								type="file"
								accept="image/*"
								capture="environment"
								onChange={handleFileInput}
								className="hidden"
							/>
							<button
								type="button"
								onClick={() => fileInputRef.current?.click()}
								disabled={imageControlsDisabled}
								className={cn(iconPill, needsImage && "border-verdigris")}
							>
								<UploadIcon className="size-3.5" />
								{converting ? "Converting…" : uploading ? "Uploading…" : "Upload"}
							</button>
							<input
								ref={fileInputRef}
								type="file"
								accept="image/*,.heic,.heif"
								multiple
								onChange={handleFileInput}
								className="hidden"
							/>
							<button
								type="button"
								onClick={() => setShowPicker(true)}
								disabled={atImageLimit}
								className={cn(iconPill, needsImage && "border-verdigris")}
							>
								<ImagesIcon className="size-3.5" />
								Library
							</button>
						</>
					)}
				</div>

				{uploadError && (
					<p className="text-sm text-destructive" role="alert">
						{uploadError}
					</p>
				)}

				<div className="flex items-center gap-2">
					<div
						className="min-w-0 flex-1 text-[0.82rem] text-muted-foreground"
						id={reasonId}
						aria-live="polite"
					>
						{tierLocked ? (
							<span>
								{TIER_LABELS[tier]} size needs a bigger plan.{" "}
								<button
									type="button"
									onClick={() => catalog && onLockedModel?.(catalog.id)}
									className="font-medium text-foreground underline underline-offset-4 hover:text-verdigris"
								>
									Upgrade
								</button>
							</span>
						) : cantAfford ? (
							<span>
								This needs {totalCost} credits and you have {balance}.{" "}
								<button
									type="button"
									onClick={() => onNeedCredits?.(totalCost)}
									className="font-medium text-foreground underline underline-offset-4 hover:text-verdigris"
								>
									Top up
								</button>
							</span>
						) : lowBalance ? (
							<span>
								{balance} {balance === 1 ? "credit" : "credits"} left ·{" "}
								<button
									type="button"
									onClick={() => onNeedCredits?.(totalCost)}
									className="font-medium text-foreground underline underline-offset-4 hover:text-verdigris"
								>
									Top up
								</button>
							</span>
						) : queueCount > 0 ? (
							<span>
								{queueCount === 1 ? "1 image in progress" : `${queueCount} images in progress`}
							</span>
						) : null}
					</div>

					<Button
						type="button"
						variant="ghost"
						size="icon"
						onClick={handleEnhance}
						disabled={!prompt.trim() || enhancing || loading}
						aria-label={enhancing ? "Improving prompt" : "Improve prompt"}
						title="Improve prompt"
					>
						<SparklesIcon className={cn(enhancing && "opacity-50")} />
					</Button>
					<Button
						type="submit"
						disabled={!canSubmit}
						aria-disabled={cantAfford || tierLocked || undefined}
						aria-describedby={cantAfford || tierLocked ? reasonId : undefined}
						className={cn("h-10 px-5", (cantAfford || tierLocked) && "opacity-60")}
					>
						Generate
						<span className="font-normal opacity-80">· {costLabel}</span>
					</Button>
				</div>
			</form>

			{/* Image Picker Modal */}
			<ImagePicker
				token={token}
				isOpen={showPicker}
				onClose={() => setShowPicker(false)}
				onSelect={handleLibrarySelect}
				selectedUrls={imageInputs}
				maxImages={maxRefs}
			/>
		</div>
	);
}
