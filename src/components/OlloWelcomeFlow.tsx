import { useCallback, useEffect, useRef, useState } from "react";
import type { OlloMessage as OlloMessageType, OlloOption, OlloPhase, ProjectMetadata } from "../types/ollo";
import { ASPECT_RATIO_OPTIONS, OLLO_MESSAGES, PURPOSE_OPTIONS } from "../types/ollo";
import { OlloAvatar } from "./OlloAvatar";
import { OlloMessage, OlloTypingIndicator } from "./OlloMessage";

interface OlloWelcomeFlowProps {
	isOpen: boolean;
	onClose: () => void;
	onComplete: (metadata: ProjectMetadata) => void;
	onSkip: () => void;
}

function getRandomMessage(messages: string[]): string {
	return messages[Math.floor(Math.random() * messages.length)];
}

function generateId(): string {
	return Math.random().toString(36).substring(2, 9);
}

const PHASE_STEPS: OlloPhase[] = ["welcome", "aspectRatio", "purpose", "summary"];

export function OlloWelcomeFlow({ isOpen, onClose, onComplete, onSkip }: OlloWelcomeFlowProps) {
	const [phase, setPhase] = useState<OlloPhase>("welcome");
	const [messages, setMessages] = useState<OlloMessageType[]>([]);
	const [metadata, setMetadata] = useState<ProjectMetadata>({});
	const [isTyping, setIsTyping] = useState(false);
	const messagesEndRef = useRef<HTMLDivElement>(null);

	const scrollToBottom = useCallback(() => {
		setTimeout(() => {
			messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
		}, 100);
	}, []);

	const addOlloMessage = useCallback((content: string, options?: OlloOption[]) => {
		setIsTyping(true);
		scrollToBottom();
		setTimeout(() => {
			setIsTyping(false);
			setMessages((prev) => [
				...prev,
				{
					id: generateId(),
					type: "ollo",
					content,
					timestamp: new Date().toISOString(),
					options,
				},
			]);
			scrollToBottom();
		}, 600);
	}, [scrollToBottom]);

	const addUserMessage = useCallback((content: string) => {
		setMessages((prev) => [
			...prev,
			{
				id: generateId(),
				type: "user",
				content,
				timestamp: new Date().toISOString(),
			},
		]);
		scrollToBottom();
	}, [scrollToBottom]);

	// Initialize conversation
	useEffect(() => {
		if (isOpen && messages.length === 0) {
			addOlloMessage(getRandomMessage(OLLO_MESSAGES.welcome), [
				{ id: "start", label: "Let's create together", value: "start" },
				{ id: "skip", label: "I'll dive right in", value: "skip" },
			]);
		}
	}, [isOpen, messages.length, addOlloMessage]);

	// Reset on close
	useEffect(() => {
		if (!isOpen) {
			setPhase("welcome");
			setMessages([]);
			setMetadata({});
			setIsTyping(false);
		}
	}, [isOpen]);

	const selectedAspectLabel = ASPECT_RATIO_OPTIONS.find((o) => o.value === metadata.aspectRatio)?.label;
	const selectedPurposeLabel = PURPOSE_OPTIONS.find((o) => o.value === metadata.purpose)?.label;

	const handleOptionSelect = (option: OlloOption) => {
		addUserMessage(option.label);

		switch (phase) {
			case "welcome":
				if (option.value === "skip") {
					setTimeout(() => onSkip(), 300);
					return;
				}
				setPhase("aspectRatio");
				setTimeout(() => {
					addOlloMessage(getRandomMessage(OLLO_MESSAGES.aspectRatio), ASPECT_RATIO_OPTIONS);
				}, 400);
				break;

			case "aspectRatio":
				setMetadata((prev) => ({ ...prev, aspectRatio: option.value }));
				setPhase("purpose");
				setTimeout(() => {
					addOlloMessage(
						`${getRandomMessage(OLLO_MESSAGES.encouragement)} ${getRandomMessage(OLLO_MESSAGES.purpose)}`,
						PURPOSE_OPTIONS
					);
				}, 400);
				break;

			case "purpose": {
				const updatedMetadata = { ...metadata, purpose: option.value };
				setMetadata(updatedMetadata);
				setPhase("summary");
				setTimeout(() => {
					addOlloMessage(getRandomMessage(OLLO_MESSAGES.summary));
				}, 400);
				break;
			}

			default:
				break;
		}
	};

	const handleStartThread = () => {
		onComplete({ ...metadata, olloEnabled: true });
	};

	const handleGoBack = () => {
		// Reset to aspectRatio phase
		setPhase("welcome");
		setMessages([]);
		setMetadata({});
		setIsTyping(false);
		// Re-initialize
		setTimeout(() => {
			addOlloMessage(getRandomMessage(OLLO_MESSAGES.welcome), [
				{ id: "start", label: "Let's create together", value: "start" },
				{ id: "skip", label: "I'll dive right in", value: "skip" },
			]);
		}, 100);
	};

	if (!isOpen) return null;

	const currentPhaseIndex = PHASE_STEPS.indexOf(phase);

	return (
		<div
			className="fixed inset-0 bg-black/90 z-50 flex items-center justify-center p-4"
			onClick={onClose}
			onKeyDown={(e) => e.key === "Escape" && onClose()}
		>
			<div
				className="cyber-card divine-border rounded-xl w-full max-w-2xl max-h-[85vh] flex flex-col overflow-hidden"
				onClick={(e) => e.stopPropagation()}
				onKeyDown={() => {}}
			>
				{/* Header */}
				<div className="flex items-center gap-3 p-4 border-b border-[var(--accent)]/20">
					<OlloAvatar size="md" />
					<div className="flex-1">
						<h2 className="text-lg font-semibold text-[var(--text-primary)]">Ollo</h2>
						<p className="text-xs text-[var(--text-secondary)]">Your creative guide</p>
					</div>
					<button
						type="button"
						onClick={onClose}
						className="p-1.5 hover:bg-[var(--bg-tertiary)] rounded-lg transition-colors"
					>
						<svg className="w-5 h-5 text-[var(--text-secondary)]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
							<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
						</svg>
					</button>
				</div>

				{/* Selection chips */}
				{(selectedAspectLabel || selectedPurposeLabel) && (
					<div className="px-4 pt-3 flex flex-wrap gap-2">
						{selectedAspectLabel && (
							<span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium bg-[var(--accent)]/15 text-[var(--accent)] border border-[var(--accent)]/30">
								<svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
									<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 5a1 1 0 011-1h14a1 1 0 011 1v2a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM4 13a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1H5a1 1 0 01-1-1v-6z" />
								</svg>
								{metadata.aspectRatio} {selectedAspectLabel}
							</span>
						)}
						{selectedPurposeLabel && (
							<span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium bg-[var(--accent)]/15 text-[var(--accent)] border border-[var(--accent)]/30">
								<svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
									<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
								</svg>
								{selectedPurposeLabel}
							</span>
						)}
					</div>
				)}

				{/* Messages */}
				<div className="flex-1 overflow-y-auto p-4 space-y-4">
					{messages.map((msg, index) => (
						<OlloMessage
							key={msg.id}
							message={msg}
							onOptionSelect={handleOptionSelect}
							isLatest={index === messages.length - 1 && msg.type === "ollo"}
							optionLayout={
								msg.type === "ollo" && msg.options?.some((o) => o.icon)
									? "grid"
									: "list"
							}
						/>
					))}
					{isTyping && <OlloTypingIndicator />}

					{/* Summary card */}
					{phase === "summary" && !isTyping && (
						<div className="mt-4 ollo-summary-card rounded-xl p-5 border border-[var(--accent)]/30 bg-[var(--bg-tertiary)]">
							<h3 className="text-base font-semibold text-[var(--text-primary)] mb-3">
								Your Creative Blueprint
							</h3>
							<div className="h-px bg-[var(--accent)]/20 mb-3" />
							<div className="space-y-2 mb-5">
								<div className="flex justify-between text-sm">
									<span className="text-[var(--text-secondary)]">Canvas</span>
									<span className="text-[var(--text-primary)] font-medium">
										{selectedAspectLabel} ({metadata.aspectRatio})
									</span>
								</div>
								<div className="flex justify-between text-sm">
									<span className="text-[var(--text-secondary)]">Purpose</span>
									<span className="text-[var(--text-primary)] font-medium">
										{selectedPurposeLabel}
									</span>
								</div>
							</div>
							<div className="flex flex-col sm:flex-row gap-2">
								<button
									type="button"
									onClick={handleStartThread}
									className="flex-1 divine-gradient rounded-lg py-2.5 px-4 text-sm font-semibold sacred-glow hover:scale-[1.01] transition-transform"
								>
									Start a new Thread
								</button>
								<button
									type="button"
									onClick={handleGoBack}
									className="px-4 py-2.5 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
								>
									Go back and change
								</button>
							</div>
						</div>
					)}

					<div ref={messagesEndRef} />
				</div>

				{/* Progress indicator */}
				<div className="px-4 pb-4">
					<div className="flex gap-2 justify-center">
						{PHASE_STEPS.map((p, i) => (
							<div
								key={p}
								className={`h-1.5 rounded-full transition-all ${
									i === currentPhaseIndex
										? "w-6 bg-[var(--accent)] sacred-glow"
										: i < currentPhaseIndex
										? "w-3 bg-[var(--accent)]/60"
										: "w-3 bg-[var(--border)]"
								}`}
							/>
						))}
					</div>
				</div>
			</div>
		</div>
	);
}
