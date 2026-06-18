/**
 * Seed subscription tiers with credit refill system
 *
 * Run with: bun run server/scripts/seed-subscription-tiers.ts
 */

import crypto from "node:crypto";
import { getDb } from "../db";

// Model IDs by tier
const FREE_MODELS = [
	"black-forest-labs/flux-schnell",
	"black-forest-labs/flux-dev",
	"black-forest-labs/flux-2-dev",
	"black-forest-labs/flux-redux-schnell",
	"black-forest-labs/flux-kontext-pro",
];

const PRO_MODELS = [
	...FREE_MODELS,
	"black-forest-labs/flux-1.1-pro",
	"black-forest-labs/flux-1.1-pro-ultra",
	"black-forest-labs/flux-2-pro",
	"black-forest-labs/flux-redux-dev",
];

// Premium has access to ALL models (null = no restriction)
const PREMIUM_MODELS = null;

// Tier definitions with credit refill system
const TIERS = [
	{
		name: "Free",
		description: "Try ollo.art with free credits",
		credit_refill_amount: 0,
		bonus_credits: 0,
		monthly_cost_limit: 1.5,
		price: 0,
		allowed_models: JSON.stringify(FREE_MODELS),
	},
	{
		name: "Pro",
		description: "Professional tier with daily credit refills",
		credit_refill_amount: 10,
		bonus_credits: 10,
		monthly_cost_limit: 25.0,
		price: 5.0,
		allowed_models: JSON.stringify(PRO_MODELS),
	},
	{
		name: "Premium",
		description: "Unlimited access to all models with generous daily refills",
		credit_refill_amount: 30,
		bonus_credits: 50,
		monthly_cost_limit: 100.0,
		price: 13.0,
		allowed_models: null,
	},
];

function seedTiers() {
	const db = getDb();

	for (const tier of TIERS) {
		const existing = db
			.prepare("SELECT id FROM subscription_products WHERE name = ?")
			.get(tier.name) as { id: string } | undefined;

		if (existing) {
			db.prepare(`
				UPDATE subscription_products SET
					description = ?,
					monthly_image_limit = NULL,
					daily_image_limit = NULL,
					monthly_cost_limit = ?,
					bonus_credits = ?,
					price = ?,
					allowed_models = ?,
					credit_refill_amount = ?,
					topoff_interval_hours = 24
				WHERE name = ?
			`).run(
				tier.description,
				tier.monthly_cost_limit,
				tier.bonus_credits,
				tier.price,
				tier.allowed_models,
				tier.credit_refill_amount,
				tier.name,
			);
			console.log(`Updated ${tier.name} tier: refill=${tier.credit_refill_amount}, $${tier.price}/mo`);
		} else {
			db.prepare(`
				INSERT INTO subscription_products (id, name, description, monthly_image_limit, daily_image_limit, monthly_cost_limit, bonus_credits, price, allowed_models, credit_refill_amount, topoff_interval_hours)
				VALUES (?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, 24)
			`).run(
				crypto.randomUUID(),
				tier.name,
				tier.description,
				tier.monthly_cost_limit,
				tier.bonus_credits,
				tier.price,
				tier.allowed_models,
				tier.credit_refill_amount,
			);
			console.log(`Created ${tier.name} tier: refill=${tier.credit_refill_amount}, $${tier.price}/mo`);
		}
	}

	// Display current tiers
	console.log("\nCurrent subscription tiers:");
	const tiers = db
		.prepare("SELECT name, credit_refill_amount, monthly_cost_limit, price, allowed_models FROM subscription_products ORDER BY price")
		.all() as Array<{
		name: string;
		credit_refill_amount: number;
		monthly_cost_limit: number | null;
		price: number;
		allowed_models: string | null;
	}>;

	for (const tier of tiers) {
		const modelCount = tier.allowed_models ? JSON.parse(tier.allowed_models).length : "ALL";
		console.log(
			`  ${tier.name}: refill=${tier.credit_refill_amount}/day, cost_limit=$${tier.monthly_cost_limit}, $${tier.price}/mo, ${modelCount} models`,
		);
	}
}

seedTiers();
