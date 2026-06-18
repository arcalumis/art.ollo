import { useState } from "react";
import type { TutorialStep as TutorialStepData } from "../data/tutorialData";
import { OlloAvatar } from "./OlloAvatar";

interface TutorialStepProps {
	step: TutorialStepData;
	stepNumber: number;
	totalSteps: number;
	onTryIt: () => void;
	onNext: () => void;
	onSkip: () => void;
	isLast: boolean;
}

export function TutorialStep({
	step,
	stepNumber,
	totalSteps,
	onTryIt,
	onNext,
	onSkip,
	isLast,
}: TutorialStepProps) {
	const [imageError, setImageError] = useState(false);

	return (
		<div className="flex flex-col h-full">
			{/* Step header */}
			<div className="flex items-center justify-between px-4 sm:px-6 py-3 border-b border-[var(--border)]">
				<div className="flex items-center gap-2">
					<span className="text-xs font-medium text-[var(--accent)]">
						Step {stepNumber} of {totalSteps}
					</span>
					<span className="text-[var(--text-secondary)]">—</span>
					<span className="text-sm font-semibold text-[var(--text-primary)]">
						{step.title}
					</span>
				</div>
				<button
					type="button"
					onClick={onSkip}
					className="text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
				>
					Skip Tutorial
				</button>
			</div>

			{/* Content */}
			<div className="flex-1 overflow-y-auto p-4 sm:p-6">
				<div className="flex flex-col lg:flex-row gap-6">
					{/* Left: Ollo narration + prompt */}
					<div className="flex-1 space-y-4">
						{/* Ollo message */}
						<div className="flex gap-3">
							<OlloAvatar size="sm" animated />
							<div className="ollo-message rounded-xl px-4 py-3 flex-1">
								<p className="text-[var(--text-primary)] text-sm leading-relaxed">
									{step.olloMessage}
								</p>
							</div>
						</div>

						{/* Multi-image note */}
						{step.isMultiImage && step.multiImageNote && (
							<div className="rounded-lg px-4 py-3 bg-[var(--accent)]/10 border border-[var(--accent)]/20">
								<div className="flex items-start gap-2">
									<svg className="w-4 h-4 text-[var(--accent)] mt-0.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
										<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
									</svg>
									<p className="text-xs text-[var(--accent)]">
										{step.multiImageNote}
									</p>
								</div>
							</div>
						)}

						{/* Prompt reference */}
						<div className="space-y-2">
							<p className="text-xs font-medium text-[var(--text-secondary)] uppercase tracking-wider">
								Prompt
							</p>
							<div className="rounded-lg px-4 py-3 bg-[var(--bg-secondary)] border border-[var(--border)] text-xs text-[var(--text-primary)] leading-relaxed font-mono">
								{step.prompt}
							</div>
						</div>

						{/* Model + Aspect Ratio info */}
						<div className="flex flex-wrap gap-3">
							<div className="flex items-center gap-1.5 text-xs text-[var(--text-secondary)]">
								<svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
									<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
								</svg>
								{step.model.split("/").pop()?.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())}
							</div>
							<div className="flex items-center gap-1.5 text-xs text-[var(--text-secondary)]">
								<svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
									<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 5a1 1 0 011-1h14a1 1 0 011 1v2a1 1 0 01-1 1H5a1 1 0 01-1-1V5z" />
								</svg>
								{step.aspectRatio}
							</div>
						</div>
					</div>

					{/* Right: Demo image */}
					<div className="lg:w-80 flex-shrink-0">
						<div className="rounded-lg overflow-hidden border border-[var(--border)] bg-[var(--bg-secondary)]">
							{!imageError ? (
								<img
									src={step.demoImagePath}
									alt={`Demo: ${step.title}`}
									className="w-full h-auto object-cover"
									onError={() => setImageError(true)}
								/>
							) : (
								<div className="aspect-[4/3] flex items-center justify-center text-[var(--text-secondary)]">
									<div className="text-center">
										<svg className="w-12 h-12 mx-auto mb-2 opacity-30" fill="none" stroke="currentColor" viewBox="0 0 24 24">
											<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
										</svg>
										<p className="text-xs">Demo image</p>
										<p className="text-xs opacity-60">Generate to see results</p>
									</div>
								</div>
							)}
						</div>
						<p className="mt-2 text-xs text-[var(--text-secondary)] text-center italic">
							{step.description}
						</p>
					</div>
				</div>
			</div>

			{/* Action buttons */}
			<div className="flex items-center justify-between px-4 sm:px-6 py-4 border-t border-[var(--border)]">
				<button
					type="button"
					onClick={onTryIt}
					className="divine-gradient rounded-lg py-2.5 px-5 text-sm font-semibold hover:scale-[1.01] transition-transform"
				>
					Try it yourself
				</button>
				<button
					type="button"
					onClick={onNext}
					className="px-5 py-2.5 text-sm font-medium text-[var(--text-primary)] hover:text-[var(--accent)] transition-colors"
				>
					{isLast ? "Finish Tutorial" : "Next Step →"}
				</button>
			</div>
		</div>
	);
}
