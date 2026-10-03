import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { type CreditPack, startPackCheckout } from "./api";
import { approxImages, formatUsd } from "./plans";

interface CreditPackListProps {
	packs: CreditPack[];
	token: string | null;
	perImage: number;
	/** Where Stripe sends the user back. */
	returnPath?: string;
}

/** One-time credit packs by card. Renders nothing when there are none. */
export function CreditPackList({ packs, token, perImage, returnPath = "/billing" }: CreditPackListProps) {
	const [busy, setBusy] = useState<string | null>(null);
	if (packs.length === 0) return null;

	const buy = async (pack: CreditPack) => {
		if (!token || busy) return;
		setBusy(pack.id);
		const result = await startPackCheckout(token, pack.id, returnPath);
		if (!result.ok) {
			toast.error(result.reason);
			setBusy(null);
		}
	};

	return (
		<ul className="grid gap-2 sm:grid-cols-3 sm:gap-3">
			{packs.map((pack) => (
				<li key={pack.id} className="flex items-center justify-between gap-3 rounded-xl bg-muted p-4 sm:flex-col sm:items-start">
					<div className="min-w-0">
						<p className="font-medium text-foreground">{pack.credits} credits</p>
						<p className="text-sm text-muted-foreground">About {approxImages(pack.credits, perImage)} images</p>
					</div>
					<Button
						variant="outline"
						className="shrink-0 sm:w-full"
						onClick={() => buy(pack)}
						disabled={!!busy}
						aria-label={`Buy ${pack.credits} credits for ${formatUsd(pack.priceCents / 100)}`}
					>
						{busy === pack.id ? "Opening checkout…" : `Buy for ${formatUsd(pack.priceCents / 100)}`}
					</Button>
				</li>
			))}
		</ul>
	);
}
