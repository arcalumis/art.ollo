import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { CheckIcon, CircleHelpIcon, LockIcon } from "lucide-react";
import {
	type CatalogModel,
	MODEL_CATEGORIES,
	TIER_LABELS,
	availableTiers,
	catalogCredits,
	groupModels,
	isTierAllowed,
	supportedRatios,
	visibleModels,
} from "../config/models";

interface ModelsReferenceModalProps {
	isOpen: boolean;
	onClose: () => void;
	onSelectModel?: (modelId: string) => void;
	currentModel?: string;
	allowedModels?: string[] | null;
	onUpgrade?: () => void;
}

function sizesLine(m: CatalogModel): string {
	return availableTiers(m)
		.map((t) => {
			const credits = catalogCredits(m, t, 0);
			return `${TIER_LABELS[t]} ${credits} ${credits === 1 ? "credit" : "credits"}`;
		})
		.join(" · ");
}

function referencesLine(m: CatalogModel): string {
	if (m.refs.max === 0) return "Text only";
	if (m.refs.min > 0)
		return m.refs.max === 1 ? "Needs 1 image" : `Needs an image, up to ${m.refs.max}`;
	return m.refs.max === 1 ? "Up to 1 reference image" : `Up to ${m.refs.max} reference images`;
}

/** The model guide: every model in the picker, in plain words, with its cost in credits. */
export function ModelsReferenceModal({
	isOpen,
	onClose,
	onSelectModel,
	currentModel,
	allowedModels,
	onUpgrade,
}: ModelsReferenceModalProps) {
	const allowed = allowedModels ?? null;

	return (
		<Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
			<DialogContent className="max-h-[88dvh] gap-0 overflow-y-auto rounded-2xl bg-card p-0 sm:max-w-2xl">
				<DialogHeader className="sticky top-0 z-10 gap-1 border-b border-border bg-card px-5 pt-5 pb-4">
					<DialogTitle className="font-sans text-lg font-semibold">Model guide</DialogTitle>
					<DialogDescription>
						Costs are per image. Bigger sizes and reference images can cost more; the Generate
						button always shows the total.
					</DialogDescription>
				</DialogHeader>

				<div className="flex flex-col gap-6 px-5 py-5">
					{groupModels(visibleModels()).map(({ group, models }) => (
						<section key={group} className="flex flex-col gap-2">
							<div>
								<h3 className="text-[0.95rem] font-semibold text-foreground">{group}</h3>
								<p className="text-[0.82rem] text-muted-foreground">
									{MODEL_CATEGORIES[group].description}
								</p>
							</div>
							<ul className="flex flex-col divide-y divide-border rounded-xl border border-border">
								{models.map((m) => {
									const locked = !isTierAllowed(allowed, m.id, m.defaultTier);
									const current = m.id === currentModel;
									const ratios = supportedRatios(m);
									return (
										<li
											key={m.id}
											className="flex flex-col gap-2 p-3.5 sm:flex-row sm:items-start sm:gap-4"
										>
											<div className="min-w-0 flex-1">
												<p className="flex items-center gap-1.5 font-medium text-foreground">
													{m.name}
													{current && (
														<CheckIcon className="size-4 text-verdigris" aria-label="Selected" />
													)}
												</p>
												<p className="mt-0.5 text-[0.85rem] text-muted-foreground">
													{m.description}
												</p>
												<p className="mt-1.5 text-[0.78rem] text-muted-foreground">
													{sizesLine(m)}
													<br />
													{referencesLine(m)} · {ratios.length} shapes
													{m.maxOutputs > 1 ? " · up to 4 per Generate" : ""}
												</p>
											</div>
											{locked ? (
												<Button
													variant="outline"
													size="sm"
													className="shrink-0 self-start"
													onClick={() => onUpgrade?.()}
												>
													<LockIcon />
													Upgrade
												</Button>
											) : (
												onSelectModel && (
													<Button
														variant={current ? "ghost" : "outline"}
														size="sm"
														className={cn("shrink-0 self-start", current && "pointer-events-none")}
														onClick={() => onSelectModel(m.id)}
														aria-pressed={current}
													>
														{current ? "In use" : "Use this model"}
													</Button>
												)
											)}
										</li>
									);
								})}
							</ul>
						</section>
					))}
					<p className="text-[0.82rem] text-muted-foreground">
						Upscale and Remove background are in the image viewer, 1 credit each.
					</p>
				</div>
			</DialogContent>
		</Dialog>
	);
}

/**
 * Button to open the models reference modal
 */
interface ModelsHelpButtonProps {
	onClick: () => void;
	className?: string;
}

export function ModelsHelpButton({ onClick, className = "" }: ModelsHelpButtonProps) {
	return (
		<button
			type="button"
			onClick={onClick}
			className={cn(
				"inline-flex items-center gap-1 rounded-lg text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50",
				className,
			)}
			title="Open the model guide"
		>
			<CircleHelpIcon className="size-4" aria-hidden />
			<span>Model guide</span>
		</button>
	);
}
