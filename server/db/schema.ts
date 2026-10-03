import type { Database } from "bun:sqlite";
import crypto from "node:crypto";

export function initializeSchema(db: Database): void {
	// Users table
	db.exec(`
		CREATE TABLE IF NOT EXISTS users (
			id TEXT PRIMARY KEY,
			username TEXT UNIQUE NOT NULL,
			password_hash TEXT NOT NULL,
			is_admin INTEGER DEFAULT 0,
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP
		);
	`);

	// Add email column to users
	try {
		db.exec("ALTER TABLE users ADD COLUMN email TEXT");
	} catch {
		// Column already exists
	}

	// Add is_active column to users
	try {
		db.exec("ALTER TABLE users ADD COLUMN is_active INTEGER DEFAULT 1");
	} catch {
		// Column already exists
	}

	// Add last_login column to users
	try {
		db.exec("ALTER TABLE users ADD COLUMN last_login DATETIME");
	} catch {
		// Column already exists
	}

	// Add wallet_address column to users
	try {
		db.exec("ALTER TABLE users ADD COLUMN wallet_address TEXT UNIQUE");
	} catch {
		// Column already exists
	}

	// Add tutorial_completed_at column to users
	try {
		db.exec("ALTER TABLE users ADD COLUMN tutorial_completed_at DATETIME DEFAULT NULL");
	} catch {
		// Column already exists
	}

	// Mark existing users as tutorial-completed so they don't get the tutorial unexpectedly.
	// New users created after this migration will have NULL (tutorial not completed).
	db.exec("UPDATE users SET tutorial_completed_at = datetime('now') WHERE tutorial_completed_at IS NULL AND last_login IS NOT NULL");

	// Subscription products table
	db.exec(`
		CREATE TABLE IF NOT EXISTS subscription_products (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			description TEXT,
			monthly_image_limit INTEGER,
			monthly_cost_limit REAL,
			bonus_credits INTEGER DEFAULT 0,
			price REAL DEFAULT 0,
			is_active INTEGER DEFAULT 1,
			allowed_models TEXT,
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP
		);
	`);

	// Migration: Add allowed_models column if it doesn't exist
	const columns = db.prepare("PRAGMA table_info(subscription_products)").all() as Array<{ name: string }>;
	if (!columns.some((c) => c.name === "allowed_models")) {
		db.exec("ALTER TABLE subscription_products ADD COLUMN allowed_models TEXT");
	}

	// User subscriptions table
	db.exec(`
		CREATE TABLE IF NOT EXISTS user_subscriptions (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL REFERENCES users(id),
			product_id TEXT NOT NULL REFERENCES subscription_products(id),
			starts_at DATETIME DEFAULT CURRENT_TIMESTAMP,
			ends_at DATETIME,
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP
		);

		CREATE INDEX IF NOT EXISTS idx_user_subscriptions_user_id ON user_subscriptions(user_id);
	`);

	// User API keys table (for BYO Replicate keys)
	db.exec(`
		CREATE TABLE IF NOT EXISTS user_api_keys (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL REFERENCES users(id),
			provider TEXT NOT NULL DEFAULT 'replicate',
			api_key_encrypted TEXT NOT NULL,
			is_active INTEGER DEFAULT 1,
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
			UNIQUE(user_id, provider)
		);

		CREATE INDEX IF NOT EXISTS idx_user_api_keys_user_id ON user_api_keys(user_id);
	`);

	// User credits table
	db.exec(`
		CREATE TABLE IF NOT EXISTS user_credits (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL REFERENCES users(id),
			credit_type TEXT NOT NULL,
			amount INTEGER NOT NULL,
			reason TEXT,
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP
		);

		CREATE INDEX IF NOT EXISTS idx_user_credits_user_id ON user_credits(user_id);
	`);

	// Monthly usage tracking table
	db.exec(`
		CREATE TABLE IF NOT EXISTS usage_monthly (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL REFERENCES users(id),
			year_month TEXT NOT NULL,
			image_count INTEGER DEFAULT 0,
			total_cost REAL DEFAULT 0,
			used_own_key INTEGER DEFAULT 0,
			UNIQUE(user_id, year_month)
		);

		CREATE INDEX IF NOT EXISTS idx_usage_monthly_user_id ON usage_monthly(user_id);
	`);

	// Daily usage tracking table (resets at UTC midnight)
	db.exec(`
		CREATE TABLE IF NOT EXISTS usage_daily (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL REFERENCES users(id),
			date TEXT NOT NULL,
			image_count INTEGER DEFAULT 0,
			UNIQUE(user_id, date)
		);

		CREATE INDEX IF NOT EXISTS idx_usage_daily_user_id ON usage_daily(user_id);
	`);

	// Create default Free subscription product if none exists
	const existingProduct = db.prepare("SELECT id FROM subscription_products LIMIT 1").get();
	if (!existingProduct) {
		const freeProductId = crypto.randomUUID();
		db.prepare(`
			INSERT INTO subscription_products (id, name, description, monthly_image_limit, monthly_cost_limit, bonus_credits, price)
			VALUES (?, ?, ?, ?, ?, ?, ?)
		`).run(freeProductId, "Free", "Try ollo.art with 5 free generations per month", 5, 1.50, 0, 0);
	}

	// Generations table (base schema without new columns)
	db.exec(`
		CREATE TABLE IF NOT EXISTS generations (
			id TEXT PRIMARY KEY,
			prompt TEXT NOT NULL,
			model TEXT NOT NULL,
			model_version TEXT,
			image_path TEXT NOT NULL,
			width INTEGER,
			height INTEGER,
			parameters TEXT,
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
			replicate_id TEXT
		);

		CREATE INDEX IF NOT EXISTS idx_generations_created_at ON generations(created_at DESC);
	`);

	// Add user_id column if it doesn't exist
	try {
		db.exec("ALTER TABLE generations ADD COLUMN user_id TEXT REFERENCES users(id)");
	} catch {
		// Column already exists
	}

	// Add cost column if it doesn't exist
	try {
		db.exec("ALTER TABLE generations ADD COLUMN cost REAL DEFAULT 0");
	} catch {
		// Column already exists
	}

	// Create index for user_id (only after column exists)
	try {
		db.exec("CREATE INDEX IF NOT EXISTS idx_generations_user_id ON generations(user_id)");
	} catch {
		// Index already exists or column doesn't exist
	}

	// Add deleted_at column for soft delete
	try {
		db.exec("ALTER TABLE generations ADD COLUMN deleted_at DATETIME DEFAULT NULL");
	} catch {
		// Column already exists
	}

	// Add predict_time column for generation duration tracking
	try {
		db.exec("ALTER TABLE generations ADD COLUMN predict_time REAL DEFAULT NULL");
	} catch {
		// Column already exists
	}

	// Add archived_at column for archiving generations
	try {
		db.exec("ALTER TABLE generations ADD COLUMN archived_at DATETIME DEFAULT NULL");
	} catch {
		// Column already exists
	}

	// Add purged_at column for permanent deletion (keeps record for cost tracking)
	try {
		db.exec("ALTER TABLE generations ADD COLUMN purged_at DATETIME DEFAULT NULL");
	} catch {
		// Column already exists
	}

	// Uploads table for reference images
	db.exec(`
		CREATE TABLE IF NOT EXISTS uploads (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL REFERENCES users(id),
			filename TEXT NOT NULL,
			original_name TEXT NOT NULL,
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP
		);

		CREATE INDEX IF NOT EXISTS idx_uploads_user_id ON uploads(user_id);
	`);

	// Add deleted_at column for soft delete on uploads
	try {
		db.exec("ALTER TABLE uploads ADD COLUMN deleted_at DATETIME DEFAULT NULL");
	} catch {
		// Column already exists
	}

	// Add archived_at column for archiving uploads
	try {
		db.exec("ALTER TABLE uploads ADD COLUMN archived_at DATETIME DEFAULT NULL");
	} catch {
		// Column already exists
	}

	// Email tokens table for magic links and password resets
	db.exec(`
		CREATE TABLE IF NOT EXISTS email_tokens (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL REFERENCES users(id),
			token TEXT UNIQUE NOT NULL,
			type TEXT NOT NULL CHECK (type IN ('magic_link', 'password_reset')),
			remember_me INTEGER DEFAULT 0,
			expires_at DATETIME NOT NULL,
			used_at DATETIME DEFAULT NULL,
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP
		);

		CREATE INDEX IF NOT EXISTS idx_email_tokens_token ON email_tokens(token);
		CREATE INDEX IF NOT EXISTS idx_email_tokens_user_id ON email_tokens(user_id);
		CREATE INDEX IF NOT EXISTS idx_email_tokens_expires ON email_tokens(expires_at);
	`);

	// Wallet challenges table for Solana wallet authentication
	db.exec(`
		CREATE TABLE IF NOT EXISTS wallet_challenges (
			id TEXT PRIMARY KEY,
			wallet_address TEXT NOT NULL,
			challenge TEXT UNIQUE NOT NULL,
			expires_at DATETIME NOT NULL,
			used_at DATETIME DEFAULT NULL,
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP
		);

		CREATE INDEX IF NOT EXISTS idx_wallet_challenges_challenge ON wallet_challenges(challenge);
		CREATE INDEX IF NOT EXISTS idx_wallet_challenges_wallet ON wallet_challenges(wallet_address);
		CREATE INDEX IF NOT EXISTS idx_wallet_challenges_expires ON wallet_challenges(expires_at);
	`);

	// ============================================
	// FINANCIAL & BILLING TABLES
	// ============================================

	// Stripe customer mapping
	db.exec(`
		CREATE TABLE IF NOT EXISTS stripe_customers (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL REFERENCES users(id),
			stripe_customer_id TEXT UNIQUE NOT NULL,
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP
		);

		CREATE INDEX IF NOT EXISTS idx_stripe_customers_user_id ON stripe_customers(user_id);
		CREATE INDEX IF NOT EXISTS idx_stripe_customers_stripe_id ON stripe_customers(stripe_customer_id);
	`);

	// Payment transactions (from Stripe)
	db.exec(`
		CREATE TABLE IF NOT EXISTS payments (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL REFERENCES users(id),
			stripe_payment_intent_id TEXT UNIQUE,
			stripe_invoice_id TEXT,
			amount_cents INTEGER NOT NULL,
			currency TEXT DEFAULT 'usd',
			status TEXT NOT NULL,
			payment_type TEXT NOT NULL,
			description TEXT,
			metadata TEXT,
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP
		);

		CREATE INDEX IF NOT EXISTS idx_payments_user_id ON payments(user_id);
		CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);
		CREATE INDEX IF NOT EXISTS idx_payments_created_at ON payments(created_at);
	`);

	// Platform costs (our expenses - what we pay Replicate)
	db.exec(`
		CREATE TABLE IF NOT EXISTS platform_costs (
			id TEXT PRIMARY KEY,
			generation_id TEXT REFERENCES generations(id),
			replicate_prediction_id TEXT,
			estimated_cost REAL,
			actual_cost REAL,
			cost_reconciled_at DATETIME,
			model TEXT,
			compute_time_seconds REAL,
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP
		);

		CREATE INDEX IF NOT EXISTS idx_platform_costs_generation_id ON platform_costs(generation_id);
		CREATE INDEX IF NOT EXISTS idx_platform_costs_replicate_id ON platform_costs(replicate_prediction_id);
		CREATE INDEX IF NOT EXISTS idx_platform_costs_created_at ON platform_costs(created_at);
	`);

	// Revenue events (what users are charged)
	db.exec(`
		CREATE TABLE IF NOT EXISTS revenue_events (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL REFERENCES users(id),
			payment_id TEXT REFERENCES payments(id),
			generation_id TEXT REFERENCES generations(id),
			event_type TEXT NOT NULL,
			amount_cents INTEGER NOT NULL,
			description TEXT,
			period_start DATE,
			period_end DATE,
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP
		);

		CREATE INDEX IF NOT EXISTS idx_revenue_events_user_id ON revenue_events(user_id);
		CREATE INDEX IF NOT EXISTS idx_revenue_events_payment_id ON revenue_events(payment_id);
		CREATE INDEX IF NOT EXISTS idx_revenue_events_event_type ON revenue_events(event_type);
		CREATE INDEX IF NOT EXISTS idx_revenue_events_created_at ON revenue_events(created_at);
	`);

	// Financial period snapshots (for fast reporting)
	db.exec(`
		CREATE TABLE IF NOT EXISTS financial_periods (
			id TEXT PRIMARY KEY,
			period_type TEXT NOT NULL,
			period_start DATE NOT NULL,
			period_end DATE NOT NULL,
			total_revenue_cents INTEGER DEFAULT 0,
			total_platform_cost_cents INTEGER DEFAULT 0,
			total_generations INTEGER DEFAULT 0,
			active_subscribers INTEGER DEFAULT 0,
			new_subscribers INTEGER DEFAULT 0,
			churned_subscribers INTEGER DEFAULT 0,
			mrr_cents INTEGER DEFAULT 0,
			computed_at DATETIME,
			UNIQUE(period_type, period_start)
		);

		CREATE INDEX IF NOT EXISTS idx_financial_periods_type ON financial_periods(period_type);
		CREATE INDEX IF NOT EXISTS idx_financial_periods_start ON financial_periods(period_start);
	`);

	// User lifetime metrics (for LTV calculation)
	db.exec(`
		CREATE TABLE IF NOT EXISTS user_metrics (
			user_id TEXT PRIMARY KEY REFERENCES users(id),
			first_payment_at DATETIME,
			last_payment_at DATETIME,
			total_paid_cents INTEGER DEFAULT 0,
			total_generations INTEGER DEFAULT 0,
			subscription_months INTEGER DEFAULT 0,
			churned_at DATETIME,
			ltv_cents INTEGER DEFAULT 0
		);
	`);

	// ============================================
	// ALTERATIONS TO EXISTING TABLES FOR BILLING
	// ============================================

	// Add stripe_price_id to subscription_products
	try {
		db.exec("ALTER TABLE subscription_products ADD COLUMN stripe_price_id TEXT");
	} catch {
		// Column already exists
	}

	// Add overage_price_cents to subscription_products
	try {
		db.exec("ALTER TABLE subscription_products ADD COLUMN overage_price_cents INTEGER DEFAULT 0");
	} catch {
		// Column already exists
	}

	// Add daily_image_limit to subscription_products
	try {
		db.exec("ALTER TABLE subscription_products ADD COLUMN daily_image_limit INTEGER DEFAULT NULL");
	} catch {
		// Column already exists
	}

	// Add stripe_subscription_id to user_subscriptions
	try {
		db.exec("ALTER TABLE user_subscriptions ADD COLUMN stripe_subscription_id TEXT");
	} catch {
		// Column already exists
	}

	// Add status to user_subscriptions
	try {
		db.exec("ALTER TABLE user_subscriptions ADD COLUMN status TEXT DEFAULT 'active'");
	} catch {
		// Column already exists
	}

	// Add current_period_start to user_subscriptions
	try {
		db.exec("ALTER TABLE user_subscriptions ADD COLUMN current_period_start DATE");
	} catch {
		// Column already exists
	}

	// Add current_period_end to user_subscriptions
	try {
		db.exec("ALTER TABLE user_subscriptions ADD COLUMN current_period_end DATE");
	} catch {
		// Column already exists
	}

	// Add actual_cost to generations (reconciled cost from Replicate)
	try {
		db.exec("ALTER TABLE generations ADD COLUMN actual_cost REAL");
	} catch {
		// Column already exists
	}

	// Add user_charged_cents to generations (what we charged the user)
	try {
		db.exec("ALTER TABLE generations ADD COLUMN user_charged_cents INTEGER");
	} catch {
		// Column already exists
	}

	// Add is_overage to generations (whether this was an overage charge)
	try {
		db.exec("ALTER TABLE generations ADD COLUMN is_overage INTEGER DEFAULT 0");
	} catch {
		// Column already exists
	}

	// ============================================
	// CHAT THREADS
	// ============================================

	// Threads table for organizing generations into conversations
	db.exec(`
		CREATE TABLE IF NOT EXISTS threads (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL REFERENCES users(id),
			title TEXT NOT NULL,
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
			updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
			archived_at DATETIME DEFAULT NULL,
			deleted_at DATETIME DEFAULT NULL
		);

		CREATE INDEX IF NOT EXISTS idx_threads_user_id ON threads(user_id);
		CREATE INDEX IF NOT EXISTS idx_threads_updated_at ON threads(updated_at DESC);
	`);

	// Add thread_id column to generations
	try {
		db.exec("ALTER TABLE generations ADD COLUMN thread_id TEXT REFERENCES threads(id)");
	} catch {
		// Column already exists
	}

	// Create index for thread_id
	try {
		db.exec("CREATE INDEX IF NOT EXISTS idx_generations_thread_id ON generations(thread_id)");
	} catch {
		// Index already exists
	}

	// Add project_metadata column to threads for Ollo-guided project settings
	try {
		db.exec("ALTER TABLE threads ADD COLUMN project_metadata TEXT DEFAULT NULL");
	} catch {
		// Column already exists
	}

	// Migrate existing generations to a "History" thread if they don't have a thread_id
	// This runs on every startup but only affects generations without a thread_id
	const usersWithOrphanedGenerations = db
		.prepare(`
			SELECT DISTINCT user_id FROM generations
			WHERE thread_id IS NULL AND user_id IS NOT NULL
		`)
		.all() as { user_id: string }[];

	for (const { user_id } of usersWithOrphanedGenerations) {
		// Check if this user already has a "History" thread
		let historyThread = db
			.prepare("SELECT id FROM threads WHERE user_id = ? AND title = 'History'")
			.get(user_id) as { id: string } | undefined;

		if (!historyThread) {
			// Create a "History" thread for this user
			const threadId = crypto.randomUUID();
			db.prepare(`
				INSERT INTO threads (id, user_id, title, created_at, updated_at)
				VALUES (?, ?, 'History', datetime('now'), datetime('now'))
			`).run(threadId, user_id);
			historyThread = { id: threadId };
		}

		// Assign all orphaned generations to the History thread
		db.prepare(`
			UPDATE generations SET thread_id = ?
			WHERE user_id = ? AND thread_id IS NULL
		`).run(historyThread.id, user_id);
	}

	// ============================================
	// SOLANA PAYMENTS
	// ============================================

	// Track Solana payments
	db.exec(`
		CREATE TABLE IF NOT EXISTS solana_transactions (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL REFERENCES users(id),
			wallet_address TEXT NOT NULL,
			transaction_signature TEXT UNIQUE NOT NULL,
			amount_lamports INTEGER NOT NULL,
			amount_sol REAL NOT NULL,
			credits_purchased INTEGER NOT NULL,
			status TEXT NOT NULL DEFAULT 'pending',
			network TEXT NOT NULL DEFAULT 'mainnet-beta',
			verified_at DATETIME,
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP
		);

		CREATE INDEX IF NOT EXISTS idx_solana_transactions_user_id ON solana_transactions(user_id);
		CREATE INDEX IF NOT EXISTS idx_solana_transactions_signature ON solana_transactions(transaction_signature);
		CREATE INDEX IF NOT EXISTS idx_solana_transactions_status ON solana_transactions(status);
	`);

	// Credit packages for SOL purchases
	db.exec(`
		CREATE TABLE IF NOT EXISTS solana_credit_packages (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			credits INTEGER NOT NULL,
			price_sol REAL NOT NULL,
			is_active INTEGER DEFAULT 1,
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP
		);
	`);

	// Add USD pricing columns to solana_credit_packages
	try {
		db.exec("ALTER TABLE solana_credit_packages ADD COLUMN price_cents INTEGER DEFAULT NULL");
	} catch {
		// Column already exists
	}

	try {
		db.exec("ALTER TABLE solana_credit_packages ADD COLUMN stripe_price_id TEXT DEFAULT NULL");
	} catch {
		// Column already exists
	}

	try {
		db.exec("ALTER TABLE solana_credit_packages ADD COLUMN available_for_usd INTEGER DEFAULT 0");
	} catch {
		// Column already exists
	}

	try {
		db.exec("ALTER TABLE solana_credit_packages ADD COLUMN available_for_sol INTEGER DEFAULT 1");
	} catch {
		// Column already exists
	}

	// Create default SOL credit packages if none exist
	const existingSolPackage = db.prepare("SELECT id FROM solana_credit_packages LIMIT 1").get();
	if (!existingSolPackage) {
		const packages = [
			{ name: "Starter", credits: 50, price_sol: 0.1 },
			{ name: "Creator", credits: 200, price_sol: 0.35 },
			{ name: "Pro", credits: 500, price_sol: 0.75 },
		];
		for (const pkg of packages) {
			const pkgId = crypto.randomUUID();
			db.prepare(`
				INSERT INTO solana_credit_packages (id, name, credits, price_sol)
				VALUES (?, ?, ?, ?)
			`).run(pkgId, pkg.name, pkg.credits, pkg.price_sol);
		}
	}

	// ============================================
	// SUBSCRIPTION PRODUCTS - SOL PRICING
	// ============================================

	// Add price_sol column to subscription_products
	try {
		db.exec("ALTER TABLE subscription_products ADD COLUMN price_sol REAL DEFAULT NULL");
	} catch {
		// Column already exists
	}

	// Add available_for_usd column to subscription_products
	try {
		db.exec("ALTER TABLE subscription_products ADD COLUMN available_for_usd INTEGER DEFAULT 1");
	} catch {
		// Column already exists
	}

	// Add available_for_sol column to subscription_products
	try {
		db.exec("ALTER TABLE subscription_products ADD COLUMN available_for_sol INTEGER DEFAULT 0");
	} catch {
		// Column already exists
	}

	// ============================================
	// CREDIT REFILL SYSTEM
	// ============================================

	// Add credit_refill_amount to subscription_products (daily refill target)
	try {
		db.exec("ALTER TABLE subscription_products ADD COLUMN credit_refill_amount INTEGER DEFAULT 0");
	} catch {
		// Column already exists
	}

	// Add topoff_interval_hours to subscription_products (refill frequency)
	try {
		db.exec("ALTER TABLE subscription_products ADD COLUMN topoff_interval_hours INTEGER DEFAULT 24");
	} catch {
		// Column already exists
	}

	// Add last_credit_topoff_at to user_subscriptions
	try {
		db.exec("ALTER TABLE user_subscriptions ADD COLUMN last_credit_topoff_at DATETIME DEFAULT NULL");
	} catch {
		// Column already exists
	}

	// SOL price snapshots for tracking exchange rates
	db.exec(`
		CREATE TABLE IF NOT EXISTS sol_price_snapshots (
			id TEXT PRIMARY KEY,
			price_usd REAL NOT NULL,
			source TEXT DEFAULT 'coingecko',
			captured_at DATETIME DEFAULT CURRENT_TIMESTAMP
		);
		CREATE INDEX IF NOT EXISTS idx_sol_price_captured ON sol_price_snapshots(captured_at DESC);
	`);

	// Credit topoff log for audit trail and breakage analysis
	db.exec(`
		CREATE TABLE IF NOT EXISTS credit_topoff_log (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL,
			subscription_id TEXT NOT NULL,
			credits_added INTEGER NOT NULL,
			balance_before INTEGER NOT NULL,
			balance_after INTEGER NOT NULL,
			refill_target INTEGER NOT NULL,
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP
		);
		CREATE INDEX IF NOT EXISTS idx_credit_topoff_user ON credit_topoff_log(user_id);
		CREATE INDEX IF NOT EXISTS idx_credit_topoff_created ON credit_topoff_log(created_at);
	`);

	// Processed webhook events for idempotency (Stripe can deliver the same event multiple times)
	db.exec(`
		CREATE TABLE IF NOT EXISTS processed_webhook_events (
			stripe_event_id TEXT PRIMARY KEY,
			event_type TEXT NOT NULL,
			processed_at DATETIME DEFAULT CURRENT_TIMESTAMP
		);
		CREATE INDEX IF NOT EXISTS idx_processed_webhooks_processed_at ON processed_webhook_events(processed_at);
	`);

	// ============================================
	// SUBSCRIPTION BOOSTS
	// ============================================

	// Track temporary premium access grants
	db.exec(`
		CREATE TABLE IF NOT EXISTS subscription_boosts (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL REFERENCES users(id),
			boost_product_id TEXT NOT NULL REFERENCES subscription_products(id),
			original_product_id TEXT REFERENCES subscription_products(id),
			granted_by_user_id TEXT REFERENCES users(id),
			reason TEXT,
			starts_at DATETIME DEFAULT CURRENT_TIMESTAMP,
			ends_at DATETIME NOT NULL,
			status TEXT DEFAULT 'active',
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP
		);

		CREATE INDEX IF NOT EXISTS idx_subscription_boosts_user_id ON subscription_boosts(user_id);
		CREATE INDEX IF NOT EXISTS idx_subscription_boosts_status ON subscription_boosts(status);
		CREATE INDEX IF NOT EXISTS idx_subscription_boosts_ends_at ON subscription_boosts(ends_at);
	`);

	// ============================================
	// SOLANA SUBSCRIPTION TRANSACTIONS
	// ============================================

	// Model credit cost overrides (admin-configurable)
	db.exec(`
		CREATE TABLE IF NOT EXISTS model_credit_costs (
			model_id TEXT PRIMARY KEY,
			credit_cost INTEGER NOT NULL,
			updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
		);
	`);

	// Track SOL-based subscription purchases
	db.exec(`
		CREATE TABLE IF NOT EXISTS solana_subscription_transactions (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL REFERENCES users(id),
			product_id TEXT NOT NULL REFERENCES subscription_products(id),
			wallet_address TEXT NOT NULL,
			transaction_signature TEXT UNIQUE NOT NULL,
			amount_lamports INTEGER NOT NULL,
			amount_sol REAL NOT NULL,
			status TEXT DEFAULT 'pending',
			network TEXT DEFAULT 'mainnet-beta',
			subscription_id TEXT REFERENCES user_subscriptions(id),
			verified_at DATETIME,
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP
		);

		CREATE INDEX IF NOT EXISTS idx_solana_sub_tx_user_id ON solana_subscription_transactions(user_id);
		CREATE INDEX IF NOT EXISTS idx_solana_sub_tx_signature ON solana_subscription_transactions(transaction_signature);
		CREATE INDEX IF NOT EXISTS idx_solana_sub_tx_status ON solana_subscription_transactions(status);
	`);

	// ---- Phase 1A migrations ----
	// One-shot data migrations are recorded in schema_migrations so they run
	// exactly once per database (an admin's later edits are never clobbered at boot).
	db.exec(`
		CREATE TABLE IF NOT EXISTS schema_migrations (
			name TEXT PRIMARY KEY,
			applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
		);
	`);
	const runOnce = (name: string, fn: () => void) => {
		const done = db.prepare("SELECT 1 FROM schema_migrations WHERE name = ?").get(name);
		if (done) return;
		db.transaction(() => {
			fn();
			db.prepare("INSERT INTO schema_migrations (name) VALUES (?)").run(name);
		})();
	};

	// Free tier: monthly top-off to 5 credits. Existing Free subscribers who were
	// never topped off start their 30-day clock at their subscription start, so the
	// first refill lands one interval after signup rather than all at once.
	runOnce("1a_free_tier_monthly_refill", () => {
		db.prepare(
			"UPDATE subscription_products SET credit_refill_amount = 5, topoff_interval_hours = 720 WHERE name = 'Free'",
		).run();
		db.prepare(`
			UPDATE user_subscriptions SET last_credit_topoff_at = starts_at
			WHERE last_credit_topoff_at IS NULL
			AND product_id IN (SELECT id FROM subscription_products WHERE name = 'Free')
		`).run();
	});

	// Indexes for the generation path: input-ownership lookups and reconciliation.
	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_uploads_user_filename ON uploads(user_id, filename);
		CREATE INDEX IF NOT EXISTS idx_generations_user_image_path ON generations(user_id, image_path);
		CREATE INDEX IF NOT EXISTS idx_user_credits_user_type ON user_credits(user_id, credit_type);
	`);

	// ---- Phase 1B migrations ----
	// All idempotent: they run at every boot against the live DB.
	runPhase1BMigrations(db);

	// ---- Phase 3.5 migrations ----
	// New model lineup: move every restricted product's allowed_models onto it (once).
	runOnce("3.5_allowed_models_lineup", () => migrateAllowedModelsToLineup(db));
}

// ---- Phase 3.5 migrations (definitions) ----

/** Dropped model id -> the model that replaces it. */
export const PHASE35_MODEL_REPLACEMENTS: Record<string, string> = {
	"google/nano-banana-pro": "google/nano-banana-2",
	"black-forest-labs/flux-schnell": "black-forest-labs/flux-2-klein-4b",
	"black-forest-labs/flux-dev": "black-forest-labs/flux-2-dev",
	"black-forest-labs/flux-1.1-pro": "black-forest-labs/flux-2-pro",
	"black-forest-labs/flux-1.1-pro-ultra": "black-forest-labs/flux-2-pro",
	"black-forest-labs/flux-kontext-pro": "prunaai/p-image-edit",
	"black-forest-labs/flux-redux-schnell": "black-forest-labs/flux-2-dev",
	"black-forest-labs/flux-redux-dev": "black-forest-labs/flux-2-dev",
};

/** Every model the old picker offered (a list with all of them meant "everything"). */
const PHASE35_OLD_LINEUP = [...Object.keys(PHASE35_MODEL_REPLACEMENTS), "black-forest-labs/flux-2-dev", "black-forest-labs/flux-2-pro"];

/** The new picker lineup. Tools (upscale, remove background) are on every plan and never listed. */
export const PHASE35_LINEUP = [
	"black-forest-labs/flux-2-klein-4b",
	"black-forest-labs/flux-2-dev",
	"google/nano-banana-2-lite",
	"xai/grok-imagine-image-2",
	"openai/gpt-image-2.5-flare",
	"bytedance/seedream-5-pro",
	"google/nano-banana-2",
	"black-forest-labs/flux-2-pro",
	"ideogram-ai/ideogram-4-5",
	"recraft-ai/recraft-v4.1",
	"recraft-ai/recraft-v4.1-svg",
	"openai/gpt-image-2.5-sunburst",
	"prunaai/p-image-edit",
];
const PHASE35_FAST_DRAFTS = ["black-forest-labs/flux-2-klein-4b", "black-forest-labs/flux-2-dev", "google/nano-banana-2-lite"];

/**
 * New allowed_models for one product (null = all models). Pure, for tests.
 * - Dropped ids map to their replacements.
 * - Free: + the fast-draft models.
 * - Starter: every model, but no premium Max tiers (GPT Image xhigh, Nano Banana 2 4K,
 *   Recraft Pro), which need an explicit "<model>:max" entry.
 * - Creator / Pro, or any list that held every old model: all models (null).
 * - Anything else: just the id mapping.
 */
export function phase35AllowedModels(name: string, allowed: string[]): string[] | null {
	const mapped = allowed.map((id) => PHASE35_MODEL_REPLACEMENTS[id] ?? id);
	const unique = (ids: string[]) => Array.from(new Set(ids));
	if (name === "Creator" || name === "Pro") return null;
	if (name === "Free") return unique([...mapped, ...PHASE35_FAST_DRAFTS]);
	if (name === "Starter") return unique([...mapped, ...PHASE35_LINEUP]);
	if (PHASE35_OLD_LINEUP.every((id) => allowed.includes(id))) return null;
	return unique(mapped);
}

/** Rewrite every product whose allowed_models is a list. NULL (all models) is never touched. */
export function migrateAllowedModelsToLineup(db: Database): number {
	const rows = db
		.prepare("SELECT id, name, allowed_models FROM subscription_products WHERE allowed_models IS NOT NULL")
		.all() as { id: string; name: string; allowed_models: string }[];
	let changed = 0;
	for (const row of rows) {
		let list: unknown;
		try {
			list = JSON.parse(row.allowed_models);
		} catch {
			continue;
		}
		if (!Array.isArray(list) || !list.every((x) => typeof x === "string")) continue;
		const next = phase35AllowedModels(row.name, list as string[]);
		const json = next === null ? null : JSON.stringify(next);
		if (json === row.allowed_models) continue;
		db.prepare("UPDATE subscription_products SET allowed_models = ? WHERE id = ?").run(json, row.id);
		console.log(`[migration] ${row.name}: allowed_models -> ${json ?? "NULL (all models)"}`);
		changed++;
	}
	return changed;
}

// ---- Phase 1B migrations (definitions) ----

function hasColumn(db: Database, table: string, column: string): boolean {
	const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
	return cols.some((c) => c.name === column);
}

/** Parse SQLite CURRENT_TIMESTAMP ("YYYY-MM-DD HH:MM:SS", UTC) or ISO strings to epoch ms. */
export function parseDbTime(value: string | null | undefined): number | null {
	if (!value) return null;
	const iso = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
	const t = Date.parse(iso);
	return Number.isNaN(t) ? null : t;
}

/**
 * Keep exactly one status='active' user_subscriptions row per user. Preference order:
 * currently in effect (ends_at NULL or future) > has stripe_subscription_id > non-Free
 * product > most recent. Losers are marked 'superseded' (never deleted).
 * Returns the number of rows superseded.
 */
export function dedupeActiveSubscriptions(db: Database): number {
	const dupUsers = db
		.prepare(
			"SELECT user_id FROM user_subscriptions WHERE status = 'active' GROUP BY user_id HAVING COUNT(*) > 1",
		)
		.all() as Array<{ user_id: string }>;
	if (dupUsers.length === 0) return 0;

	const now = Date.now();
	let superseded = 0;
	const supersede = db.prepare(
		"UPDATE user_subscriptions SET status = 'superseded', ends_at = COALESCE(ends_at, datetime('now')) WHERE id = ?",
	);
	db.transaction(() => {
		for (const { user_id } of dupUsers) {
			const rows = db
				.prepare(`
					SELECT us.id, us.stripe_subscription_id, us.ends_at, us.created_at, sp.name AS product_name
					FROM user_subscriptions us
					LEFT JOIN subscription_products sp ON sp.id = us.product_id
					WHERE us.user_id = ? AND us.status = 'active'
				`)
				.all(user_id) as Array<{
				id: string;
				stripe_subscription_id: string | null;
				ends_at: string | null;
				created_at: string | null;
				product_name: string | null;
			}>;
			const score = (r: (typeof rows)[number]) => {
				const ends = parseDbTime(r.ends_at);
				return [
					ends === null || ends > now ? 1 : 0,
					r.stripe_subscription_id ? 1 : 0,
					r.product_name && r.product_name !== "Free" ? 1 : 0,
					parseDbTime(r.created_at) ?? 0,
				];
			};
			rows.sort((a, b) => {
				const sa = score(a);
				const sb = score(b);
				for (let i = 0; i < sa.length; i++) {
					if (sa[i] !== sb[i]) return sb[i] - sa[i];
				}
				return 0;
			});
			for (const loser of rows.slice(1)) {
				supersede.run(loser.id);
				superseded++;
			}
		}
	})();
	console.log(`[migration] Superseded ${superseded} duplicate active subscription rows for ${dupUsers.length} users`);
	return superseded;
}

function runPhase1BMigrations(db: Database): void {
	// The original `ALTER TABLE users ADD COLUMN wallet_address TEXT UNIQUE` always fails (SQLite
	// can't add UNIQUE columns) and the error is swallowed, so fresh databases had no wallet
	// column at all. The live DB has it plus a hand-made idx_users_wallet; mirror that here.
	if (!hasColumn(db, "users", "wallet_address")) {
		db.exec("ALTER TABLE users ADD COLUMN wallet_address TEXT");
	}
	db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_wallet ON users(wallet_address)");

	// Session revocation: JWTs carry a `tv` claim that must match users.token_version.
	if (!hasColumn(db, "users", "token_version")) {
		db.exec("ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0");
	}

	// Normalize emails to trim+lowercase, but only if that cannot create duplicates.
	const emailCollisions = db
		.prepare(
			"SELECT lower(trim(email)) AS e, COUNT(*) AS n FROM users WHERE email IS NOT NULL AND trim(email) <> '' GROUP BY e HAVING n > 1",
		)
		.all() as Array<{ e: string; n: number }>;
	if (emailCollisions.length > 0) {
		console.warn(
			`[migration] Skipping email lowercase + unique index: ${emailCollisions.length} case-insensitive email collisions need manual review`,
		);
	} else {
		db.exec("UPDATE users SET email = NULL WHERE email IS NOT NULL AND trim(email) = ''");
		db.exec("UPDATE users SET email = lower(trim(email)) WHERE email IS NOT NULL AND email <> lower(trim(email))");
		db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_unique ON users(email) WHERE email IS NOT NULL");
	}

	// Email tokens are stored as SHA-256 hashes. Legacy plaintext rows (token_hash NULL) are invalidated.
	if (!hasColumn(db, "email_tokens", "token_hash")) {
		db.exec("ALTER TABLE email_tokens ADD COLUMN token_hash TEXT");
	}
	db.exec("CREATE INDEX IF NOT EXISTS idx_email_tokens_token_hash ON email_tokens(token_hash)");
	db.exec("UPDATE email_tokens SET used_at = datetime('now') WHERE token_hash IS NULL AND used_at IS NULL");

	// Sign-up links for emails that don't have an account yet (no user_id to reference).
	db.exec(`
		CREATE TABLE IF NOT EXISTS signup_tokens (
			id TEXT PRIMARY KEY,
			email TEXT NOT NULL,
			token_hash TEXT UNIQUE NOT NULL,
			remember_me INTEGER DEFAULT 0,
			expires_at DATETIME NOT NULL,
			used_at DATETIME DEFAULT NULL,
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP
		);
		CREATE INDEX IF NOT EXISTS idx_signup_tokens_expires ON signup_tokens(expires_at);
	`);

	// Outbound auth email log for flood protection (per-recipient + global caps).
	db.exec(`
		CREATE TABLE IF NOT EXISTS email_send_log (
			id TEXT PRIMARY KEY,
			recipient TEXT NOT NULL,
			kind TEXT NOT NULL,
			ip TEXT,
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP
		);
		CREATE INDEX IF NOT EXISTS idx_email_send_log_recipient ON email_send_log(recipient, created_at);
		CREATE INDEX IF NOT EXISTS idx_email_send_log_created ON email_send_log(created_at);
	`);

	// Track whether a subscription row's welcome bonus was granted, so a Stripe subscription that
	// starts 'incomplete' gets its bonus exactly once when it becomes active. Existing rows were
	// already paid out under the old logic, so they are backfilled as granted.
	if (!hasColumn(db, "user_subscriptions", "bonus_granted")) {
		db.exec("ALTER TABLE user_subscriptions ADD COLUMN bonus_granted INTEGER NOT NULL DEFAULT 0");
		db.exec("UPDATE user_subscriptions SET bonus_granted = 1");
	}

	// One active subscription per user.
	db.exec("UPDATE user_subscriptions SET status = 'active' WHERE status IS NULL");
	dedupeActiveSubscriptions(db);
	db.exec(
		"CREATE UNIQUE INDEX IF NOT EXISTS idx_user_subscriptions_one_active ON user_subscriptions(user_id) WHERE status = 'active'",
	);
	db.exec(
		"CREATE INDEX IF NOT EXISTS idx_user_subscriptions_stripe_id ON user_subscriptions(stripe_subscription_id)",
	);

	// A Solana signature can be claimed once across credit purchases AND subscriptions.
	db.exec(`
		CREATE TABLE IF NOT EXISTS solana_claimed_signatures (
			signature TEXT PRIMARY KEY,
			kind TEXT NOT NULL,
			payment_id TEXT NOT NULL,
			user_id TEXT NOT NULL,
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP
		);
		INSERT OR IGNORE INTO solana_claimed_signatures (signature, kind, payment_id, user_id)
			SELECT transaction_signature, 'credits', id, user_id FROM solana_transactions
			WHERE status = 'completed' AND transaction_signature NOT LIKE 'pending_%';
		INSERT OR IGNORE INTO solana_claimed_signatures (signature, kind, payment_id, user_id)
			SELECT transaction_signature, 'subscription', id, user_id FROM solana_subscription_transactions
			WHERE status = 'completed' AND transaction_signature NOT LIKE 'pending_%';
	`);

	// ---- Phase 3D migrations ----
	// Low-credit email throttle (at most one per user per 7 days).
	if (!hasColumn(db, "users", "low_credit_email_at")) {
		db.exec("ALTER TABLE users ADD COLUMN low_credit_email_at DATETIME");
	}
	// One row per transactional email that must go out at most once (receipt per invoice, etc.).
	db.exec(`
		CREATE TABLE IF NOT EXISTS transactional_email_log (
			dedupe_key TEXT PRIMARY KEY,
			user_id TEXT,
			kind TEXT NOT NULL,
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP
		);
	`);

	// ---- Phase 4F migrations ----
	// Public share links: one live (unrevoked) slug per generation; revoked rows are kept so an
	// old slug can never be reissued to a different image.
	db.exec(`
		CREATE TABLE IF NOT EXISTS share_links (
			slug TEXT PRIMARY KEY,
			generation_id TEXT NOT NULL REFERENCES generations(id),
			user_id TEXT NOT NULL REFERENCES users(id),
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
			revoked_at DATETIME DEFAULT NULL
		);
		CREATE UNIQUE INDEX IF NOT EXISTS idx_share_links_live
			ON share_links(generation_id) WHERE revoked_at IS NULL;
		CREATE INDEX IF NOT EXISTS idx_share_links_user ON share_links(user_id);
	`);
	// Email change: the link goes to the NEW address; the row carries the address to switch to.
	// (email_tokens has a CHECK on its type, so these live in their own table.)
	db.exec(`
		CREATE TABLE IF NOT EXISTS email_change_tokens (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL REFERENCES users(id),
			new_email TEXT NOT NULL,
			token_hash TEXT UNIQUE NOT NULL,
			expires_at DATETIME NOT NULL,
			used_at DATETIME DEFAULT NULL,
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP
		);
		CREATE INDEX IF NOT EXISTS idx_email_change_tokens_user ON email_change_tokens(user_id);
	`);
	// Account deletion is a soft delete: the row stays for financial records.
	if (!hasColumn(db, "users", "deleted_at")) {
		db.exec("ALTER TABLE users ADD COLUMN deleted_at DATETIME DEFAULT NULL");
	}
}
