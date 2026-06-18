import { useState } from "react";
import { TUTORIAL_STEPS } from "../data/tutorialData";
import { TutorialStep } from "./TutorialStep";

interface TutorialFlowProps {
	isOpen: boolean;
	onClose: () => void;
	onComplete: () => void;
	onTryGeneration: (prompt: string, model: string, aspectRatio: string) => void;
}

export function TutorialFlow({ isOpen, onClose, onComplete, onTryGeneration }: TutorialFlowProps) {
	const [currentStep, setCurrentStep] = useState(0);

	if (!isOpen) return null;

	const step = TUTORIAL_STEPS[currentStep];

	const handleNext = () => {
		if (currentStep >= TUTORIAL_STEPS.length - 1) {
			onComplete();
		} else {
			setCurrentStep((prev) => prev + 1);
		}
	};

	const handleSkip = () => {
		onComplete();
	};

	const handleTryIt = () => {
		onTryGeneration(step.prompt, step.model, step.aspectRatio);
	};

	return (
		<div
			className="fixed inset-0 bg-black/90 z-50 flex items-center justify-center p-4"
			onClick={onClose}
			onKeyDown={(e) => e.key === "Escape" && onClose()}
		>
			<div
				className="cyber-card divine-border rounded-xl w-full max-w-4xl max-h-[90vh] flex flex-col overflow-hidden"
				onClick={(e) => e.stopPropagation()}
				onKeyDown={() => {}}
			>
				{/* Progress bar */}
				<div className="h-1 bg-[var(--bg-tertiary)]">
					<div
						className="h-full bg-[var(--accent)] transition-all duration-300"
						style={{ width: `${((currentStep + 1) / TUTORIAL_STEPS.length) * 100}%` }}
					/>
				</div>

				<TutorialStep
					step={step}
					stepNumber={currentStep + 1}
					totalSteps={TUTORIAL_STEPS.length}
					onTryIt={handleTryIt}
					onNext={handleNext}
					onSkip={handleSkip}
					isLast={currentStep >= TUTORIAL_STEPS.length - 1}
				/>
			</div>
		</div>
	);
}
