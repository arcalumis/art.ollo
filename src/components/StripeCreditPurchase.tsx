import { useAuth } from "../contexts/AuthContext";
import { CreditPackList } from "./billing/CreditPackList";
import { useBillingCatalog } from "./billing/hooks";

interface StripeCreditPurchaseProps {
	/** Where Stripe returns the user after checkout. */
	returnPath?: string;
}

/** Card credit packs, priced from the server. Renders nothing when there are no packs. */
export function StripeCreditPurchase({ returnPath = "/billing" }: StripeCreditPurchaseProps) {
	const { token } = useAuth();
	const catalog = useBillingCatalog();
	if (!catalog) return null;
	const perImage = catalog.costs ? (catalog.costs.costs[catalog.costs.defaultModel] ?? 2) : 2;
	return <CreditPackList packs={catalog.packs} token={token} perImage={perImage} returnPath={returnPath} />;
}
