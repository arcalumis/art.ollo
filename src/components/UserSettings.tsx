import { useEffect } from "react";
import { useAuth } from "../contexts/AuthContext";
import {
	useUserCredits,
	useUserSubscription,
	useUserUsage,
} from "../hooks/useUserSettings";

interface UserSettingsProps {
	isOpen: boolean;
	onClose: () => void;
	onOpenBilling?: () => void;
	onRelaunchTutorial?: () => void;
}

export function UserSettings({ isOpen, onClose, onOpenBilling, onRelaunchTutorial }: UserSettingsProps) {
	const { token } = useAuth();
	const { subscription, fetchSubscription } = useUserSubscription(token);
	const { usage, fetchUsage } = useUserUsage(token);
	const { credits, fetchCredits } = useUserCredits(token);

	useEffect(() => {
		if (isOpen) {
			fetchSubscription();
			fetchUsage();
			fetchCredits();
		}
	}, [isOpen, fetchSubscription, fetchUsage, fetchCredits]);

	if (!isOpen) return null;

	return (
		<div
			className="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-4"
			onClick={onClose}
			onKeyDown={(e) => e.key === "Escape" && onClose()}
		>
			<div
				className="cyber-card rounded-lg w-full max-w-lg max-h-[80vh] overflow-auto"
				onClick={(e) => e.stopPropagation()}
				onKeyDown={() => {}}
			>
				<div className="flex items-center justify-between p-4 border-b border-[var(--border)] sticky top-0 bg-[var(--bg-secondary)]">
					<h2 className="text-xl font-semibold text-[var(--text-primary)]">Account Settings</h2>
					<button type="button" onClick={onClose} className="p-1 hover:bg-[var(--bg-tertiary)] rounded">
						<svg
							className="w-6 h-6 text-[var(--text-secondary)]"
							fill="none"
							stroke="currentColor"
							viewBox="0 0 24 24"
							role="img"
							aria-label="Close"
						>
							<path
								strokeLinecap="round"
								strokeLinejoin="round"
								strokeWidth={2}
								d="M6 18L18 6M6 6l12 12"
							/>
						</svg>
					</button>
				</div>

				<div className="p-4 space-y-6">
					{/* Subscription */}
					<section>
						<h3 className="text-sm font-medium text-[var(--text-secondary)] mb-3">Subscription</h3>
						<div className="bg-[var(--bg-tertiary)] rounded-lg p-4">
							{subscription?.subscription ? (
								<>
									<div className="flex items-center justify-between mb-2">
										<span className="text-lg font-semibold text-[var(--text-primary)]">{subscription.subscription.name}</span>
										{subscription.subscription.price > 0 ? (
											<span className="text-[var(--accent)]">${subscription.subscription.price}/mo</span>
										) : (
											<span className="text-green-400">Free</span>
										)}
									</div>
									{subscription.subscription.description && (
										<p className="text-sm text-[var(--text-secondary)]">{subscription.subscription.description}</p>
									)}
								</>
							) : (
								<p className="text-[var(--text-secondary)]">No active subscription</p>
							)}
						</div>
					</section>

					{/* Usage */}
					<section>
						<h3 className="text-sm font-medium text-[var(--text-secondary)] mb-3">This Month&apos;s Usage</h3>
						<div className="bg-[var(--bg-tertiary)] rounded-lg p-4">
							<div className="flex justify-between text-sm mb-2">
								<span className="text-[var(--text-primary)]">Credits</span>
								<span className="text-[var(--accent)] font-bold">
									{usage?.availableCredits ?? 0}
								</span>
							</div>

							{usage?.creditRefillAmount && usage.creditRefillAmount > 0 && (
								<p className="text-xs text-[var(--text-secondary)] mb-2">
									Refills to {usage.creditRefillAmount} daily
								</p>
							)}

							<div className="flex justify-between text-sm mb-2">
								<span className="text-[var(--text-primary)]">Images This Month</span>
								<span className="text-[var(--text-primary)]">
									{usage?.usage.imageCount || 0}
								</span>
							</div>

							{usage && !usage.canGenerate && (
								<div className="mt-3 p-2 bg-red-900/30 border border-red-800 rounded text-sm text-red-300">
									{usage.limitReason}
								</div>
							)}
						</div>
					</section>

					{/* Credits */}
					<section>
						<h3 className="text-sm font-medium text-[var(--text-secondary)] mb-3">Credits</h3>
						<div className="bg-[var(--bg-tertiary)] rounded-lg p-4">
							<div className="flex items-center justify-between">
								<span className="text-2xl font-bold text-[var(--text-primary)]">{credits?.credits || 0}</span>
								<span className="text-sm text-[var(--text-secondary)]">credits available</span>
							</div>
							{credits?.history && credits.history.length > 0 && (
								<div className="mt-3 pt-3 border-t border-[var(--border)]">
									<p className="text-xs text-[var(--text-secondary)] mb-2">Recent history</p>
									<div className="space-y-1">
										{credits.history.slice(0, 3).map((h) => (
											<div key={h.id} className="flex justify-between text-xs">
												<span className="text-[var(--text-secondary)]">{h.reason || h.type}</span>
												<span className={h.amount > 0 ? "text-green-400" : "text-red-400"}>
													{h.amount > 0 ? "+" : ""}
													{h.amount}
												</span>
											</div>
										))}
									</div>
								</div>
							)}
							<button
								type="button"
								onClick={() => {
									onClose();
									onOpenBilling?.();
								}}
								className="w-full mt-4 cyber-button py-2 flex items-center justify-center gap-2"
							>
								<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
									<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" />
								</svg>
								Buy More Credits
							</button>
						</div>
					</section>

					{/* Tutorial */}
					{onRelaunchTutorial && (
						<section>
							<h3 className="text-sm font-medium text-[var(--text-secondary)] mb-3">Tutorial</h3>
							<div className="bg-[var(--bg-tertiary)] rounded-lg p-4">
								<p className="text-sm text-[var(--text-secondary)] mb-3">
									Learn the full workflow — character creation, scene composition, and multi-image input.
								</p>
								<button
									type="button"
									onClick={onRelaunchTutorial}
									className="w-full cyber-button py-2 flex items-center justify-center gap-2 rounded-lg"
								>
									<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
										<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
										<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
									</svg>
									Relaunch Tutorial
								</button>
							</div>
						</section>
					)}
				</div>
			</div>
		</div>
	);
}
