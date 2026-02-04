/**
 * Seed subscription tiers with model access restrictions
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

function seedTiers() {
	const db = getDb();

	// Update existing Free tier with allowed models
	const freeResult = db
		.prepare("UPDATE subscription_products SET allowed_models = ? WHERE name = 'Free'")
		.run(JSON.stringify(FREE_MODELS));

	if (freeResult.changes > 0) {
		console.log(`Updated Free tier with ${FREE_MODELS.length} allowed models`);
	} else {
		console.log("Free tier not found - creating it");
		db.prepare(`
			INSERT INTO subscription_products (id, name, description, monthly_image_limit, monthly_cost_limit, bonus_credits, price, allowed_models)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		`).run(
			crypto.randomUUID(),
			"Free",
			"Try ollo.art with 5 free generations per month",
			5,
			1.5,
			0,
			0,
			JSON.stringify(FREE_MODELS),
		);
	}

	// Check if Pro tier exists
	const proExists = db.prepare("SELECT id FROM subscription_products WHERE name = 'Pro'").get();
	if (proExists) {
		db.prepare("UPDATE subscription_products SET allowed_models = ?, price = ? WHERE name = 'Pro'").run(
			JSON.stringify(PRO_MODELS),
			5.0,
		);
		console.log(`Updated Pro tier with ${PRO_MODELS.length} allowed models, $5/mo`);
	} else {
		db.prepare(`
			INSERT INTO subscription_products (id, name, description, monthly_image_limit, monthly_cost_limit, bonus_credits, price, allowed_models)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		`).run(
			crypto.randomUUID(),
			"Pro",
			"Professional tier with access to most models",
			100,
			25.0,
			10,
			5.0,
			JSON.stringify(PRO_MODELS),
		);
		console.log(`Created Pro tier with ${PRO_MODELS.length} allowed models, $5/mo`);
	}

	// Check if Premium tier exists
	const premiumExists = db.prepare("SELECT id FROM subscription_products WHERE name = 'Premium'").get();
	if (premiumExists) {
		db.prepare("UPDATE subscription_products SET allowed_models = ?, price = ? WHERE name = 'Premium'").run(
			null,
			13.0,
		);
		console.log("Updated Premium tier with access to ALL models, $13/mo");
	} else {
		db.prepare(`
			INSERT INTO subscription_products (id, name, description, monthly_image_limit, monthly_cost_limit, bonus_credits, price, allowed_models)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		`).run(
			crypto.randomUUID(),
			"Premium",
			"Unlimited access to all models including experimental ones",
			500,
			100.0,
			50,
			13.0,
			null, // null = all models allowed
		);
		console.log("Created Premium tier with access to ALL models, $13/mo");
	}

	// Display current tiers
	console.log("\nCurrent subscription tiers:");
	const tiers = db
		.prepare("SELECT name, monthly_image_limit, price, allowed_models FROM subscription_products ORDER BY price")
		.all() as Array<{
		name: string;
		monthly_image_limit: number;
		price: number;
		allowed_models: string | null;
	}>;

	for (const tier of tiers) {
		const modelCount = tier.allowed_models ? JSON.parse(tier.allowed_models).length : "ALL";
		console.log(`  ${tier.name}: ${tier.monthly_image_limit} images/mo, $${tier.price}/mo, ${modelCount} models`);
	}
}

seedTiers();
