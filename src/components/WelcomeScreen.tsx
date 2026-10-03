import { Button } from "@/components/ui/button";

interface WelcomeScreenProps {
	/** Put an example into the prompt bar (doesn't start it: nothing is spent until Generate). */
	onPromptPick: (prompt: string) => void;
	onOpenModelGuide?: () => void;
}

/** Prompts that have made good first images on ollo (from the landing showcase). */
export const STARTER_PROMPTS = [
	"A young dragon sitting in a beautiful garden under an apple tree eating an apple while reading a book.",
	"Giant meditating monk stone statue in a giant fish tank with fish swimming around, surrounded by a tiny village.",
	"Roman soldier from biblical times in oil paint.",
];

/** Empty state for an account with no series yet. */
export function WelcomeScreen({ onPromptPick, onOpenModelGuide }: WelcomeScreenProps) {
	return (
		<div className="flex min-h-[55vh] flex-col justify-center py-8">
			<h1 className="font-display text-3xl leading-tight sm:text-4xl">Start your first series</h1>
			<p className="mt-3 max-w-prose text-muted-foreground">
				Describe an image in the bar below and press Generate. Then ask for changes, one at a time:
				each step builds on the last image.
			</p>

			<div className="mt-8">
				<p className="text-sm font-medium">Or start from an example</p>
				<ul className="mt-3 grid gap-2">
					{STARTER_PROMPTS.map((prompt) => (
						<li key={prompt}>
							<button
								type="button"
								onClick={() => onPromptPick(prompt)}
								className="w-full rounded-lg border border-border bg-card px-4 py-3 text-left text-sm text-foreground transition-colors hover:border-foreground/30 focus-visible:ring-3 focus-visible:ring-ring/50"
							>
								{prompt}
							</button>
						</li>
					))}
				</ul>
			</div>

			{onOpenModelGuide && (
				<Button
					type="button"
					variant="ghost"
					className="mt-6 self-start px-2"
					onClick={onOpenModelGuide}
				>
					Compare models and credit costs
				</Button>
			)}
		</div>
	);
}
