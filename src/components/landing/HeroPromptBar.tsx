import { ChevronDownIcon } from "lucide-react";
import { useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { getModelConfig } from "../../config/models";
import type { PendingPrompt } from "../../lib/pendingPrompt";

/** Text-to-image models offered before sign-up: all affordable with the free credits. */
const LANDING_MODELS = [
	{ id: "black-forest-labs/flux-2-klein-4b", label: "Fast draft" },
	{ id: "black-forest-labs/flux-2-dev", label: "FLUX 2 Dev" },
	{ id: "black-forest-labs/flux-2-pro", label: "FLUX 2 Pro" },
].map((m) => ({ ...m, credits: getModelConfig(m.id)?.pricing.creditCost ?? 2 }));

const ASPECT_RATIOS = [
	{ value: "1:1", label: "Square 1:1" },
	{ value: "4:3", label: "Landscape 4:3" },
	{ value: "16:9", label: "Wide 16:9" },
	{ value: "3:4", label: "Portrait 3:4" },
	{ value: "9:16", label: "Tall 9:16" },
];

const pill =
	"inline-flex h-10 items-center gap-1.5 rounded-full border border-border bg-muted px-3.5 text-sm font-medium text-foreground transition-colors hover:border-foreground/30 aria-expanded:border-foreground/30 focus-visible:ring-3 focus-visible:ring-ring/50 outline-none";

/**
 * The real prompt bar, before sign-up. Generate saves the prompt and hands
 * over to sign-up; the app starts it once the visitor is in.
 */
export function HeroPromptBar({ onGenerate }: { onGenerate: (pending: PendingPrompt) => void }) {
	const [prompt, setPrompt] = useState("");
	const [model, setModel] = useState(LANDING_MODELS[1].id);
	const [aspectRatio, setAspectRatio] = useState("4:3");
	const [hint, setHint] = useState("");
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const id = useId();

	const selected = LANDING_MODELS.find((m) => m.id === model) ?? LANDING_MODELS[1];

	const submit = () => {
		if (!prompt.trim()) {
			setHint("Describe the image you want first.");
			textareaRef.current?.focus();
			return;
		}
		setHint("");
		onGenerate({ prompt: prompt.trim(), aspectRatio, model });
	};

	return (
		<form
			className="rounded-2xl border border-border bg-card p-2"
			onSubmit={(e) => {
				e.preventDefault();
				submit();
			}}
		>
			<label htmlFor={`${id}-prompt`} className="sr-only">
				Describe an image
			</label>
			<textarea
				ref={textareaRef}
				id={`${id}-prompt`}
				value={prompt}
				onChange={(e) => {
					setPrompt(e.target.value);
					if (hint) setHint("");
				}}
				onKeyDown={(e) => {
					if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
						e.preventDefault();
						submit();
					}
				}}
				rows={3}
				maxLength={2000}
				placeholder="A bronze crow wearing a laurel crown, on a stone pedestal at the bottom of the sea"
				aria-describedby={hint ? `${id}-hint` : undefined}
				className="block min-h-24 w-full resize-none rounded-lg bg-transparent px-3 py-2.5 text-base text-foreground outline-none placeholder:text-muted-foreground/80 focus-visible:ring-0"
			/>
			{hint && (
				<p id={`${id}-hint`} role="alert" className="px-3 pb-1 text-sm text-destructive">
					{hint}
				</p>
			)}
			<div className="flex flex-col gap-2 p-1 sm:flex-row sm:items-center sm:justify-between">
				<div className="flex flex-wrap gap-2">
					<DropdownMenu>
						<DropdownMenuTrigger className={pill} aria-label={`Aspect ratio: ${aspectRatio}`}>
							{aspectRatio}
							<ChevronDownIcon className="size-4 text-muted-foreground" aria-hidden />
						</DropdownMenuTrigger>
						<DropdownMenuContent className="w-auto min-w-44">
							<DropdownMenuRadioGroup
								value={aspectRatio}
								onValueChange={(v) => setAspectRatio(String(v))}
							>
								{ASPECT_RATIOS.map((r) => (
									<DropdownMenuRadioItem
										closeOnClick
										key={r.value}
										value={r.value}
										className="min-h-10"
									>
										{r.label}
									</DropdownMenuRadioItem>
								))}
							</DropdownMenuRadioGroup>
						</DropdownMenuContent>
					</DropdownMenu>
					<DropdownMenu>
						<DropdownMenuTrigger className={pill} aria-label={`Model: ${selected.label}`}>
							{selected.label}
							<ChevronDownIcon className="size-4 text-muted-foreground" aria-hidden />
						</DropdownMenuTrigger>
						<DropdownMenuContent className="w-auto min-w-56">
							<DropdownMenuRadioGroup value={model} onValueChange={(v) => setModel(String(v))}>
								{LANDING_MODELS.map((m) => (
									<DropdownMenuRadioItem
										closeOnClick
										key={m.id}
										value={m.id}
										className="min-h-10 justify-between gap-6"
									>
										{m.label}
										<span className="text-muted-foreground tabular-nums">
											{m.credits} {m.credits === 1 ? "credit" : "credits"}
										</span>
									</DropdownMenuRadioItem>
								))}
							</DropdownMenuRadioGroup>
						</DropdownMenuContent>
					</DropdownMenu>
				</div>
				<Button type="submit" size="lg" className="w-full rounded-xl sm:w-auto">
					Generate · {selected.credits} {selected.credits === 1 ? "credit" : "credits"}
				</Button>
			</div>
		</form>
	);
}

export { LANDING_MODELS };
