import { useState } from "react";
import { getModelConfig, getModelCategory } from "../config/models";

interface ModelInfoTooltipProps {
	modelId: string;
	className?: string;
}

export function ModelInfoTooltip({ modelId, className = "" }: ModelInfoTooltipProps) {
	const [isOpen, setIsOpen] = useState(false);
	const config = getModelConfig(modelId);
	const categoryInfo = getModelCategory(modelId);

	if (!config) return null;

	return (
		<div className={`relative inline-flex ${className}`}>
			<button
				type="button"
				onClick={() => setIsOpen(!isOpen)}
				onMouseEnter={() => setIsOpen(true)}
				onMouseLeave={() => setIsOpen(false)}
				className="w-5 h-5 rounded-full border border-[var(--border)] text-[var(--text-secondary)] hover:border-[var(--accent)] hover:text-[var(--accent)] transition-colors flex items-center justify-center text-xs font-medium"
				aria-label="Model information"
			>
				?
			</button>

			{isOpen && (
				<div className="absolute left-full ml-2 top-1/2 -translate-y-1/2 z-50 w-72 p-3 rounded-lg bg-[var(--bg-secondary)] border border-[var(--border)] shadow-lg">
					{/* Arrow */}
					<div className="absolute right-full top-1/2 -translate-y-1/2 w-0 h-0 border-t-[6px] border-t-transparent border-b-[6px] border-b-transparent border-r-[6px] border-r-[var(--border)]" />

					{/* Header */}
					<div className="flex items-center gap-2 mb-2">
						<span className="text-sm font-semibold text-[var(--text-primary)]">
							{config.name}
						</span>
						{categoryInfo && (
							<span
								className="text-[10px] px-1.5 py-0.5 rounded-full font-medium"
								style={{
									backgroundColor: `${categoryInfo.color}20`,
									color: categoryInfo.color,
								}}
							>
								{categoryInfo.label}
							</span>
						)}
					</div>

					{/* Description */}
					<p className="text-xs text-[var(--text-secondary)] mb-3 leading-relaxed">
						{config.detailedDescription}
					</p>

					{/* Best for */}
					<div className="mb-2">
						<span className="text-[10px] uppercase tracking-wider text-[var(--text-secondary)]">
							Best for:
						</span>
						<div className="flex flex-wrap gap-1 mt-1">
							{config.bestFor.map((use) => (
								<span
									key={use}
									className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--bg-tertiary)] text-[var(--text-secondary)]"
								>
									{use}
								</span>
							))}
						</div>
					</div>

					{/* Differentiator */}
					{config.differentiators && (
						<p className="text-[10px] text-[var(--accent)] italic">
							{config.differentiators}
						</p>
					)}

					{/* Pricing */}
					<div className="mt-2 pt-2 border-t border-[var(--border)] flex items-center justify-between">
						<span className="text-[10px] text-[var(--text-secondary)]">Cost:</span>
						<div className="flex items-center gap-2">
							<span className="text-xs font-mono text-[var(--text-secondary)]">
								{config.pricing.displayCost}
							</span>
							<span className="text-xs font-mono text-[var(--accent)]">
								{config.pricing.creditCost} {config.pricing.creditCost === 1 ? "credit" : "credits"}
							</span>
						</div>
					</div>

					{/* Image input indicator */}
					{config.capabilities.requiresImageInput && (
						<div className="mt-2 p-2 rounded bg-[var(--accent)]/10 border border-[var(--accent)]/30">
							<span className="text-[10px] text-[var(--accent)] font-medium">
								Requires an image to be uploaded
							</span>
						</div>
					)}
				</div>
			)}
		</div>
	);
}

interface ImageRequiredTooltipProps {
	modelId: string;
	show: boolean;
}

export function ImageRequiredTooltip({ modelId, show }: ImageRequiredTooltipProps) {
	const config = getModelConfig(modelId);

	if (!show || !config?.capabilities.requiresImageInput) return null;

	const isVariation = config.category === "variation";
	const isEdit = config.category === "edit";

	let message = "This model works with reference images.";
	if (isVariation) {
		message = "Upload an image to create variations of it. The model will generate similar images with different compositions.";
	} else if (isEdit) {
		message = "Upload an image to edit it. Describe the changes you want in your prompt.";
	}

	return (
		<div className="p-3 rounded-lg bg-[var(--accent)]/10 border border-[var(--accent)]/30 mb-3 animate-pulse">
			<div className="flex items-start gap-2">
				<span className="text-[var(--accent)] text-lg">↓</span>
				<div>
					<p className="text-sm text-[var(--accent)] font-medium mb-1">
						{isVariation ? "Upload a reference image" : isEdit ? "Upload an image to edit" : "Add an image"}
					</p>
					<p className="text-xs text-[var(--text-secondary)]">{message}</p>
				</div>
			</div>
		</div>
	);
}
