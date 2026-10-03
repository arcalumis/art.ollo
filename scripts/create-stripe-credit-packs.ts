// Create the one-time Stripe credit packs and the DB rows /api/billing/credit-packages reads.
//
//   bun scripts/create-stripe-credit-packs.ts [--db <path>]            # dry run: prints the plan
//   bun scripts/create-stripe-credit-packs.ts [--db <path>] --confirm  # creates in Stripe + DB
//
// The amounts below are PLACEHOLDERS until the owner approves them. Stripe is in live mode:
// --confirm creates real Products and Prices. The dry run makes no network calls.
//
// Idempotent: a Stripe Product is reused when one carries metadata ollo_pack_key=<key> and an
// active one-time USD Price with the same amount; DB rows are upserted by the stable id
// `stripe-<key>`. Changing an amount creates a new Price (Stripe Prices are immutable) and
// points the row at it.
import path from "node:path";
import Stripe from "stripe";

const PACKS = [
	{ key: "pack-100", name: "100 credits", credits: 100, priceCents: 800 },
	{ key: "pack-300", name: "300 credits", credits: 300, priceCents: 2000 },
	{ key: "pack-1000", name: "1000 credits", credits: 1000, priceCents: 5500 },
] as const;

const args = process.argv.slice(2);
const confirm = args.includes("--confirm");
const dbFlag = args.indexOf("--db");
if (dbFlag !== -1) {
	const dbPath = args[dbFlag + 1];
	if (!dbPath) throw new Error("--db needs a path");
	process.env.DB_PATH = path.resolve(dbPath);
}
const dbPath = process.env.DB_PATH || path.join(process.cwd(), "data", "generations.db");

const secret = process.env.STRIPE_SECRET_KEY || "";
const mode = secret.startsWith("sk_live_") || secret.startsWith("rk_live_") ? "LIVE" : secret ? "test" : "missing";

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const rowId = (key: string) => `stripe-${key}`;

// Imported after DB_PATH is settled: the db module reads it at load time.
const { getDb } = await import("../server/db");
const db = getDb();

interface Row {
	id: string;
	name: string;
	credits: number;
	price_cents: number | null;
	stripe_price_id: string | null;
}
const existing = (key: string) =>
	db
		.prepare("SELECT id, name, credits, price_cents, stripe_price_id FROM solana_credit_packages WHERE id = ?")
		.get(rowId(key)) as Row | undefined;

console.log(confirm ? "Creating credit packs" : "Dry run (nothing will change). Add --confirm to apply.");
console.log(`  Database:   ${dbPath}`);
console.log(`  Stripe key: ${mode}${mode === "LIVE" ? " (real products and prices will be created)" : ""}`);
console.log("");
for (const pack of PACKS) {
	const row = existing(pack.key);
	console.log(`  ${pack.name}: ${pack.credits} credits for ${money(pack.priceCents)}`);
	console.log(
		`    Stripe: find or create Product (metadata ollo_pack_key=${pack.key}) + one-time USD Price ${money(pack.priceCents)}`,
	);
	console.log(
		row
			? `    DB: update solana_credit_packages ${row.id} (now ${row.credits} credits, ${row.price_cents == null ? "no USD price" : money(row.price_cents)}, price ${row.stripe_price_id ?? "none"})`
			: `    DB: insert solana_credit_packages ${rowId(pack.key)} (available_for_usd=1, available_for_sol=0, is_active=1)`,
	);
}
console.log("");

if (!confirm) process.exit(0);

if (mode === "missing") throw new Error("STRIPE_SECRET_KEY is not set");
const stripe = new Stripe(secret, { apiVersion: "2024-12-18.acacia" as Stripe.StripeConfig["apiVersion"] });

async function findOrCreatePrice(pack: (typeof PACKS)[number]): Promise<string> {
	const found = await stripe.products.search({ query: `metadata['ollo_pack_key']:'${pack.key}'` });
	let product = found.data.find((p) => p.active) ?? found.data[0];
	if (!product) {
		product = await stripe.products.create({
			name: `ollo.art ${pack.name}`,
			description: `${pack.credits} image credits. One-time purchase; credits never expire.`,
			metadata: { ollo_pack_key: pack.key, credits: String(pack.credits) },
		});
		console.log(`  Created product ${product.id} for ${pack.name}`);
	} else if (!product.active) {
		product = await stripe.products.update(product.id, { active: true });
	}

	const prices = await stripe.prices.list({ product: product.id, active: true, limit: 100 });
	const match = prices.data.find(
		(p) => p.type === "one_time" && p.currency === "usd" && p.unit_amount === pack.priceCents,
	);
	if (match) {
		console.log(`  Reusing price ${match.id} for ${pack.name}`);
		return match.id;
	}
	const price = await stripe.prices.create({
		product: product.id,
		currency: "usd",
		unit_amount: pack.priceCents,
		metadata: { ollo_pack_key: pack.key, credits: String(pack.credits) },
	});
	console.log(`  Created price ${price.id} for ${pack.name}`);
	return price.id;
}

for (const pack of PACKS) {
	const priceId = await findOrCreatePrice(pack);
	db.prepare(
		`INSERT INTO solana_credit_packages
			(id, name, credits, price_sol, is_active, price_cents, stripe_price_id, available_for_usd, available_for_sol)
		VALUES (?, ?, ?, 0, 1, ?, ?, 1, 0)
		ON CONFLICT(id) DO UPDATE SET
			name = excluded.name,
			credits = excluded.credits,
			price_cents = excluded.price_cents,
			stripe_price_id = excluded.stripe_price_id,
			available_for_usd = 1,
			is_active = 1`,
	).run(rowId(pack.key), pack.name, pack.credits, pack.priceCents, priceId);
	console.log(`  Saved ${rowId(pack.key)} -> ${priceId}`);
}
console.log("\nDone. The packs now show on /billing and in the upgrade sheet.");
process.exit(0);
