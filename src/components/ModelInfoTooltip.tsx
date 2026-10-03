import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { CircleHelpIcon } from "lucide-react";
import {
	TIER_LABELS,
	availableTiers,
	catalogCredits,
	getModelConfig,
	visibleModels,
} from "../config/models";

interface ModelInfoTooltipProps {
	modelId: string;
	className?: string;
}

/** A small "?" that explains a model in plain words, with its cost in credits per size. */
export function ModelInfoTooltip({ modelId, className }: ModelInfoTooltipProps) {
	const config = getModelConfig(modelId);
	const catalog = visibleModels().find((m) => m.id === modelId);
	if (!config || !catalog) return null;

	return (
		<Popover>
			<PopoverTrigger
				render={
					<button
						type="button"
						className={cn(
							"inline-flex size-6 items-center justify-center rounded-full text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50",
							className,
						)}
						aria-label={`About ${config.name}`}
					/>
				}
			>
				<CircleHelpIcon className="size-4" />
			</PopoverTrigger>
			<PopoverContent
				side="top"
				className="w-72 rounded-xl border border-border bg-card p-3 ring-0"
			>
				<p className="font-medium text-foreground">{config.name}</p>
				<p className="text-[0.82rem] text-muted-foreground">{config.description}</p>
				{config.bestFor.length > 0 && (
					<p className="text-[0.78rem] text-muted-foreground">
						Good for: {config.bestFor.join(", ").toLowerCase()}
					</p>
				)}
				<p className="text-[0.78rem] text-foreground tabular-nums">
					{availableTiers(catalog)
						.map((t) => `${TIER_LABELS[t]} ${catalogCredits(catalog, t, 0)}`)
						.join(" · ")}{" "}
					credits per image
				</p>
				{config.capabilities.requiresImageInput && (
					<p className="text-[0.78rem] text-muted-foreground">Needs an image to work from.</p>
				)}
			</PopoverContent>
		</Popover>
	);
}

/** A plain prompt shown when the selected model needs an image and none is attached. */
export function ImageRequiredTooltip({ modelId, show }: { modelId: string; show: boolean }) {
	const config = getModelConfig(modelId);
	if (!show || !config?.capabilities.requiresImageInput) return null;
	return (
		<p className="rounded-lg border border-border bg-muted px-3 py-2 text-sm text-muted-foreground">
			Add the image you want to edit, then describe the change.
		</p>
	);
}
