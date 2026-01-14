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
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP
		);
	`);

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
}
