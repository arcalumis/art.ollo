import { useEffect, useState } from "react";
import { toast } from "sonner";
import { CreditPill } from "@/components/brand/CreditPill";
import { Laurel, Wordmark } from "@/components/brand/Laurel";
import { ThemeSwitcher } from "@/components/ThemeSwitcher";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * Dev-only reference for the design system (route /styleguide, not built into
 * production). Every primitive in both finishes, used for screenshot review.
 */
export function Styleguide() {
	const [progress, setProgress] = useState(0);
	useEffect(() => {
		const id = setInterval(() => setProgress((p) => (p >= 1 ? 0 : p + 0.125)), 450);
		return () => clearInterval(id);
	}, []);

	return (
		<div className="mx-auto grid max-w-5xl gap-14 px-5 py-12">
			<header className="flex items-center justify-between gap-4">
				<Wordmark className="text-3xl" />
				<div className="flex items-center gap-2">
					<CreditPill credits={148} onClick={() => toast("Opens billing")} />
					<ThemeSwitcher />
				</div>
			</header>

			<Section title="Type">
				<h1 className="font-display text-5xl leading-tight">Your series</h1>
				<p className="font-display text-3xl">$19 a month</p>
				<p className="text-2xl font-semibold">Out of credits</p>
				<p className="text-lg font-medium">Top up 200 credits for $12, or upgrade to Creator.</p>
				<p>Have the owl wearing black round glasses.</p>
				<p className="text-sm text-muted-foreground">Flux 2 Dev · 1024 × 1024 · 2 credits</p>
			</Section>

			<Section title="Buttons">
				<div className="flex flex-wrap items-center gap-3">
					<Button>
						Generate <span className="font-medium opacity-75">· 2 credits</span>
					</Button>
					<Button variant="outline">Vary</Button>
					<Button variant="ghost">Cancel</Button>
					<Button variant="destructive">Delete forever</Button>
					<Button disabled>Generate</Button>
					<Button size="lg">Continue to payment</Button>
				</div>
			</Section>

			<Section title="Fields">
				<div className="grid max-w-md gap-3">
					<label className="grid gap-1.5 text-sm" htmlFor="sg-email">
						Email
						<Input id="sg-email" type="email" placeholder="you@example.com" />
					</label>
					<Textarea placeholder="Describe an image" rows={3} />
				</div>
			</Section>

			<Section title="Chrome">
				<div className="flex flex-wrap items-center gap-3">
					<CreditPill credits={148} />
					<CreditPill credits={3} />
					<CreditPill credits={148} compact />
					<Badge variant="secondary">Creator</Badge>
					<Badge variant="outline">Portrait 3:4</Badge>
				</div>
			</Section>

			<Section title="Laurel">
				<div className="flex flex-wrap items-center gap-8">
					<Laurel className="size-24" label="ollo" />
					<div className="grid place-items-center rounded-2xl bg-stone-2 p-6">
						<Laurel className="size-20" progress={progress} />
					</div>
					<Skeleton className="size-24 rounded-xl" />
				</div>
			</Section>

			<Section title="Overlays">
				<div className="flex flex-wrap items-center gap-3">
					<Dialog>
						<DialogTrigger render={<Button variant="outline">Open dialog</Button>} />
						<DialogContent>
							<DialogHeader>
								<DialogTitle>Delete this series?</DialogTitle>
								<DialogDescription>Its 3 images move to Trash. You can restore them for 30 days.</DialogDescription>
							</DialogHeader>
							<DialogFooter>
								<Button variant="destructive">Move to Trash</Button>
							</DialogFooter>
						</DialogContent>
					</Dialog>
					<Sheet>
						<SheetTrigger render={<Button variant="outline">Open sheet</Button>} />
						<SheetContent side="bottom">
							<SheetHeader>
								<SheetTitle>You need 1 more credit</SheetTitle>
								<SheetDescription>This image costs 2 credits and you have 1.</SheetDescription>
							</SheetHeader>
						</SheetContent>
					</Sheet>
					<DropdownMenu>
						<DropdownMenuTrigger render={<Button variant="outline">Menu</Button>} />
						<DropdownMenuContent>
							<DropdownMenuItem>Rename</DropdownMenuItem>
							<DropdownMenuItem>Download all</DropdownMenuItem>
							<DropdownMenuItem variant="destructive">Move to Trash</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>
					<Tooltip>
						<TooltipTrigger render={<Button variant="ghost">Hover me</Button>} />
						<TooltipContent>Flux 2 Dev costs 2 credits per image</TooltipContent>
					</Tooltip>
					<Button variant="outline" onClick={() => toast.success("Saved to Downloads")}>
						Toast
					</Button>
				</div>
			</Section>

			<Section title="Tabs">
				<Tabs defaultValue="card" className="max-w-md">
					<TabsList>
						<TabsTrigger value="card">Card</TabsTrigger>
						<TabsTrigger value="sol">SOL</TabsTrigger>
					</TabsList>
					<TabsContent value="card" className="pt-3 text-sm text-muted-foreground">
						Pay with any card through Stripe.
					</TabsContent>
					<TabsContent value="sol" className="pt-3 text-sm text-muted-foreground">
						Pay from a connected Solana wallet.
					</TabsContent>
				</Tabs>
			</Section>
		</div>
	);
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
	return (
		<section className="grid gap-5">
			<h2 className="border-b border-border pb-2 text-sm font-medium text-muted-foreground">{title}</h2>
			{children}
		</section>
	);
}
