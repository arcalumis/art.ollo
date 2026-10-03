import { type ReactNode, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { SignInDialog } from "@/components/auth/SignInDialog";
import { HeroPromptBar, LANDING_MODELS } from "@/components/landing/HeroPromptBar";
import { ShowcaseTile, useShowcase } from "@/components/landing/Showcase";
import { SiteFooter, SiteHeader } from "@/components/site/SiteChrome";
import { Button } from "@/components/ui/button";
import { type PendingPrompt, savePendingPrompt } from "@/lib/pendingPrompt";

/** The owl series in "How it works" uses these two; the grid shows the rest. */
const SERIES_SLUGS = ["owl-glasses", "owl-stethoscope"];
const SERIES_STEPS = [
	{ slug: "owl-glasses", instruction: "Have the owl wearing black round glasses." },
	{
		slug: "owl-stethoscope",
		instruction: "Have a stethoscope hanging from his pouch and black round glasses.",
	},
];

/** ollo.art for signed-out visitors. */
export function Landing() {
	const [signUpOpen, setSignUpOpen] = useState(false);
	const showcase = useShowcase().filter((item) => !SERIES_SLUGS.includes(item.slug));

	useEffect(() => {
		document.title = "ollo: describe an image, then refine it";
	}, []);

	const handleGenerate = (pending: PendingPrompt) => {
		savePendingPrompt(pending);
		setSignUpOpen(true);
	};

	return (
		<div className="min-h-dvh overflow-x-clip bg-background">
			<Hero onGenerate={handleGenerate} />

			<main>
				{showcase.length > 0 && (
					<section
						aria-labelledby="showcase-title"
						className="mx-auto max-w-6xl px-4 pt-16 sm:px-6 sm:pt-20"
					>
						<div className="max-w-2xl">
							<h2 id="showcase-title" className="text-2xl font-semibold sm:text-3xl">
								Made on ollo
							</h2>
							<p className="mt-2 text-muted-foreground">
								Real results with the prompts that made them. Hover or tap an image to read its
								prompt.
							</p>
						</div>
						<div className="mt-8 grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-4">
							{showcase.map((item) => (
								<ShowcaseTile key={item.slug} item={item} />
							))}
						</div>
					</section>
				)}

				<HowItWorks />
				<PricingTeaser />
			</main>

			<SiteFooter className="mt-24" />

			<SignInDialog
				open={signUpOpen}
				onOpenChange={setSignUpOpen}
				title="Create your account to generate"
				description="We'll email you a link. Your prompt is saved and starts as soon as you're in. No password, no card."
			/>
		</div>
	);
}

/**
 * The crow, full-bleed and mirrored so it stands on the right, looking toward
 * the copy. On phones the photo keeps its own aspect ratio (the whole crow)
 * and the copy starts over its empty lower edge.
 */
function Hero({ onGenerate }: { onGenerate: (pending: PendingPrompt) => void }) {
	return (
		<section className="finish-night relative isolate bg-background lg:flex lg:min-h-[min(100dvh,1000px)] lg:flex-col">
			<div className="lg:absolute lg:inset-0 lg:-z-10">
				<img
					src="/showcase/crow-hero.webp"
					alt="A bronze crow wearing a laurel crown, standing on a stone pedestal under shafts of light"
					width={1232}
					height={1248}
					fetchPriority="high"
					className="block aspect-[1232/1248] w-full -scale-x-100 object-cover [mask-image:linear-gradient(to_bottom,black_70%,transparent)] lg:aspect-auto lg:h-full lg:object-[50%_0%]"
				/>
			</div>
			<SiteHeader className="absolute inset-x-0 top-0 z-10" />

			<div className="relative mx-auto w-full max-w-6xl px-4 pb-12 sm:px-6 lg:flex lg:flex-1 lg:items-center lg:pt-24 lg:pb-20">
				<div className="-mt-28 max-w-xl sm:-mt-48 lg:mt-0 lg:max-w-[34rem]">
					<h1 className="font-display text-[2.6rem] leading-[1.08] sm:text-6xl">
						Describe an image. Watch it take shape.
					</h1>
					<p className="mt-4 max-w-md text-lg text-muted-foreground">
						Start with 10 free credits. Sign up with your email: no password, no card.
					</p>
					<div className="mt-8">
						<HeroPromptBar onGenerate={onGenerate} />
					</div>
				</div>
			</div>
		</section>
	);
}

function HowItWorks() {
	return (
		<section aria-labelledby="how-title" className="mx-auto max-w-6xl px-4 pt-24 sm:px-6 sm:pt-32">
			<div className="grid gap-10 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-16">
				<div className="max-w-md">
					<h2 id="how-title" className="text-2xl font-semibold sm:text-3xl">
						Keep the image, change the details
					</h2>
					<p className="mt-3 text-muted-foreground">
						Most generators start from scratch every time. On ollo each image starts a series:
						describe it once, then ask for changes in plain words. The owl stays the same owl while
						you add the glasses, then the stethoscope.
					</p>
					<ol className="mt-6 space-y-4">
						<Step n={1} title="Describe it">
							Write a sentence and pick a model. Fast drafts cost 1 credit.
						</Step>
						<Step n={2} title="Ask for a change">
							"Add glasses." "Make it night." Each step builds on the last image.
						</Step>
						<Step n={3} title="Keep the series">
							Every step stays in order with the words that made it, so you can go back to any
							version.
						</Step>
					</ol>
				</div>

				<ol aria-label="Example series" className="grid gap-4 sm:grid-cols-2 sm:gap-3">
					{SERIES_STEPS.map((step, i) => (
						<li key={step.slug} className="flex flex-col gap-3">
							<p className="flex gap-2 text-sm">
								<span className="shrink-0 text-muted-foreground tabular-nums">Step {i + 2}</span>
								<span className="text-foreground">{step.instruction}</span>
							</p>
							<img
								src={`/showcase/${step.slug}.webp`}
								alt={`The owl after: ${step.instruction}`}
								loading="lazy"
								decoding="async"
								width={1024}
								height={768}
								className="aspect-[4/3] w-full rounded-xl bg-muted object-cover"
							/>
						</li>
					))}
				</ol>
			</div>
		</section>
	);
}

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
	return (
		<li className="flex gap-4">
			<span
				className="flex size-8 shrink-0 items-center justify-center rounded-full border border-border text-sm text-verdigris tabular-nums"
				aria-hidden
			>
				{n}
			</span>
			<div>
				<p className="font-medium">{title}</p>
				<p className="text-sm text-muted-foreground">{children}</p>
			</div>
		</li>
	);
}

function PricingTeaser() {
	return (
		<section
			aria-labelledby="pricing-title"
			className="mx-auto max-w-6xl px-4 pt-24 sm:px-6 sm:pt-32"
		>
			<div className="grid gap-8 rounded-2xl border border-border bg-card p-6 sm:p-10 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center lg:gap-16">
				<div className="max-w-xl">
					<h2 id="pricing-title" className="text-2xl font-semibold sm:text-3xl">
						Pay for what you make
					</h2>
					<p className="mt-3 text-muted-foreground">
						Every account starts with 10 free credits. When you need more, choose a monthly plan or
						top up once, by card or with SOL. You see the cost on the Generate button before you
						spend anything.
					</p>
					<Button
						render={<Link to="/pricing" />}
						nativeButton={false}
						variant="outline"
						className="mt-6"
					>
						See plans and prices
					</Button>
				</div>
				<dl className="grid grid-cols-3 gap-3 sm:gap-6 lg:grid-cols-1 lg:gap-4">
					{LANDING_MODELS.map((m) => (
						<div
							key={m.id}
							className="flex flex-col gap-0.5 lg:flex-row lg:items-baseline lg:justify-between lg:gap-10"
						>
							<dt className="text-sm text-muted-foreground">{m.label}</dt>
							<dd className="font-semibold tabular-nums">
								{m.credits} {m.credits === 1 ? "credit" : "credits"}
							</dd>
						</div>
					))}
				</dl>
			</div>
		</section>
	);
}
