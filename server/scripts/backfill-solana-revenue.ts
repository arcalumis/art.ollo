/**
 * Backfill revenue events for existing completed Solana transactions
 *
 * Run with: bun run server/scripts/backfill-solana-revenue.ts
 */

import crypto from "node:crypto";
import { getDb } from "../db";

async function getSolUsdPrice(): Promise<number> {
	try {
		const res = await fetch(
			"https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd",
		);
		const data = await res.json();
		return data.solana?.usd || 250;
	} catch {
		return 250;
	}
}

async function backfillSolanaRevenue() {
	const db = getDb();

	// Get all completed Solana transactions
	const transactions = db
		.prepare(`
			SELECT id, user_id, amount_sol, verified_at
			FROM solana_transactions
			WHERE status = 'completed'
		`)
		.all() as Array<{
		id: string;
		user_id: string;
		amount_sol: number;
		verified_at: string;
	}>;

	console.log(`Found ${transactions.length} completed Solana transactions`);

	// Check which ones already have revenue events
	const existingDescriptions = new Set(
		(
			db
				.prepare(`
					SELECT description FROM revenue_events
					WHERE event_type = 'credit_purchase' AND description LIKE 'SOL payment:%'
				`)
				.all() as Array<{ description: string }>
		).map((r) => r.description),
	);

	// Fetch current SOL price for backfill
	const solPrice = await getSolUsdPrice();
	console.log(`Using SOL price: $${solPrice}`);

	let backfilledCount = 0;
	for (const tx of transactions) {
		const description = `SOL payment: ${tx.amount_sol} SOL`;

		if (existingDescriptions.has(description)) {
			console.log(`Skipping ${tx.id} - already has revenue event`);
			continue;
		}

		const usdCents = Math.round(tx.amount_sol * solPrice * 100);

		db.prepare(`
			INSERT INTO revenue_events (id, user_id, event_type, amount_cents, description, created_at)
			VALUES (?, ?, 'credit_purchase', ?, ?, ?)
		`).run(crypto.randomUUID(), tx.user_id, usdCents, description, tx.verified_at);

		console.log(
			`Backfilled ${tx.id}: ${tx.amount_sol} SOL = $${(usdCents / 100).toFixed(2)}`,
		);
		backfilledCount++;
	}

	console.log(`\nBackfilled ${backfilledCount} revenue events`);
}

backfillSolanaRevenue().catch(console.error);
