import { OlloAvatar } from "./OlloAvatar";
import type { OlloMessage as OlloMessageType, OlloOption } from "../types/ollo";

function AspectRatioIcon({ icon, className = "" }: { icon: string; className?: string }) {
	const dimensions: Record<string, { w: number; h: number }> = {
		horizontal: { w: 40, h: 30 },
		vertical: { w: 30, h: 40 },
		cinematic: { w: 48, h: 27 },
		mobile: { w: 27, h: 48 },
	};

	const dim = dimensions[icon] || { w: 32, h: 32 };

	return (
		<svg viewBox="0 0 56 56" className={`w-10 h-10 ${className}`} fill="none">
			<rect
				x={(56 - dim.w) / 2}
				y={(56 - dim.h) / 2}
				width={dim.w}
				height={dim.h}
				rx={3}
				stroke="currentColor"
				strokeWidth={2}
				fill="color-mix(in srgb, currentColor 10%, transparent)"
			/>
		</svg>
	);
}

interface OlloMessageProps {
	message: OlloMessageType;
	onOptionSelect?: (option: OlloOption) => void;
	isLatest?: boolean;
	optionLayout?: "grid" | "list";
}

export function OlloMessage({ message, onOptionSelect, isLatest = false, optionLayout = "list" }: OlloMessageProps) {
	const isOllo = message.type === "ollo";

	return (
		<div className={`flex gap-3 ${isOllo ? "" : "flex-row-reverse"}`}>
			{isOllo && <OlloAvatar size="sm" animated={isLatest} />}

			<div className={`flex-1 max-w-[85%] ${isOllo ? "" : "flex justify-end"}`}>
				<div
					className={`rounded-xl px-4 py-3 ${
						isOllo
							? "ollo-message"
							: "bg-[var(--bg-tertiary)] border border-[var(--border)]"
					}`}
				>
					<p className="text-[var(--text-primary)] text-sm leading-relaxed">
						{message.content}
					</p>
				</div>

				{isOllo && message.options && message.options.length > 0 && (
					<div className={`mt-3 ${
						optionLayout === "grid"
							? "grid grid-cols-1 md:grid-cols-2 gap-3"
							: "flex flex-wrap gap-2"
					}`}>
						{message.options.map((option) => (
							<button
								key={option.id}
								type="button"
								onClick={() => onOptionSelect?.(option)}
								className={`ollo-option rounded-lg text-sm text-[var(--text-primary)] text-left ${
									optionLayout === "grid"
										? "p-4 flex items-center gap-3"
										: "px-4 py-2 flex flex-col items-start"
								}`}
							>
								{optionLayout === "grid" && option.icon && (
									<AspectRatioIcon icon={option.icon} className="text-[var(--accent)] flex-shrink-0" />
								)}
								<div className="flex flex-col">
									<span className="font-medium">{option.label}</span>
									{option.description && (
										<span className="text-xs text-[var(--text-secondary)] mt-0.5">
											{option.description}
										</span>
									)}
								</div>
							</button>
						))}
					</div>
				)}
			</div>
		</div>
	);
}

interface OlloTypingIndicatorProps {
	className?: string;
}

export function OlloTypingIndicator({ className = "" }: OlloTypingIndicatorProps) {
	return (
		<div className={`flex gap-3 ${className}`}>
			<OlloAvatar size="sm" animated />
			<div className="ollo-message rounded-xl px-4 py-3 flex items-center gap-1.5">
				<span className="w-2 h-2 rounded-full bg-[var(--accent)] animate-pulse" />
				<span
					className="w-2 h-2 rounded-full bg-[var(--accent)] animate-pulse"
					style={{ animationDelay: "0.2s" }}
				/>
				<span
					className="w-2 h-2 rounded-full bg-[var(--accent)] animate-pulse"
					style={{ animationDelay: "0.4s" }}
				/>
			</div>
		</div>
	);
}
