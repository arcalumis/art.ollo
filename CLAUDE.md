# ollo.art

AI image generation platform built with React 19 + Fastify 5 + Bun + SQLite.

## Tech Stack

- **Frontend:** React 19, TypeScript, Tailwind CSS 4, React Router 7, Vite 6
- **Backend:** Fastify 5, Bun runtime, SQLite (bun:sqlite, WAL mode)
- **Image Generation:** Replicate API (FLUX model family)
- **Payments:** Stripe (subscriptions), Solana (credits + subscriptions)
- **Auth:** JWT (bcrypt passwords, magic links via Resend, Solana wallet signatures via tweetnacl)
- **Email:** Resend API

## Directory Structure

```
server/
├── index.ts                  # Fastify setup, CORS, helmet, rate limiting, static files, SPA fallback
├── db/
│   ├── index.ts              # Database initialization
│   └── schema.ts             # All tables, migrations via ALTER TABLE try/catch
├── middleware/
│   └── auth.ts               # JWT sign/verify, authMiddleware, adminMiddleware, optionalAuthMiddleware
├── routes/
│   ├── auth.ts               # /api/login, /api/register, /api/me, magic links, wallet auth, password reset
│   ├── generate.ts           # /api/generate, /api/enhance-prompt
│   ├── history.ts            # /api/history (infinite scroll)
│   ├── threads.ts            # /api/threads CRUD
│   ├── models.ts             # /api/models
│   ├── uploads.ts            # /api/uploads (reference images)
│   ├── user.ts               # /api/user/* (subscription, usage, credits, api-key, tutorial)
│   ├── billing.ts            # /api/billing/* (Stripe checkout, portal, invoices, products)
│   ├── stripe-webhooks.ts    # /api/webhooks/stripe (invoice.paid, subscription.*, checkout.session.completed)
│   ├── solana-billing.ts     # /api/billing/solana/* (credit packages, subscription purchases)
│   ├── solana-rpc.ts         # /api/solana/rpc (proxy for frontend wallet)
│   ├── admin.ts              # /api/admin/* (users, products, credits, boosts, credit-packages, model-costs)
│   └── admin-financials.ts   # /api/admin/financials/* (revenue, costs, P&L, MRR, churn)
└── services/
    ├── usage.ts              # Credit system, subscriptions, generation gating, refills
    ├── stripe.ts             # Stripe customer/checkout/portal, payment recording, revenue events
    ├── solana.ts             # SOL price (CoinGecko), credit purchase, subscription purchase, tx verification
    ├── replicate.ts          # Model definitions, image generation, prompt enhancement, cost estimation
    ├── replicate-billing.ts  # Platform cost tracking, reconciliation (hourly), user charge calculation
    ├── subscription-boost.ts # Temporary premium access grants
    ├── financial-reports.ts  # Metrics, revenue breakdown, LTV, P&L, trends
    ├── encryption.ts         # AES-256-GCM for user API keys
    ├── email.ts              # Resend email service
    ├── tokens.ts             # Magic link / password reset token generation
    └── cleanup.ts            # Background job (every 5 min): purge trash, expire boosts, credit refills, SOL price snapshots

src/
├── App.tsx                   # Routing, main app state, generation queue, handlers
├── config.ts                 # API base URL
├── contexts/
│   └── AuthContext.tsx        # Global auth state (login/logout/register, token in localStorage)
├── types/
│   └── index.ts              # All TypeScript interfaces
├── hooks/
│   ├── useApi.ts             # useGenerate, useEnhancePrompt, useModels, useHistory, useUploads, useThreads
│   ├── useUserSettings.ts    # useUserSubscription, useUserUsage, useUserCredits, useTutorial, useUserApiKey
│   ├── useAdmin.ts           # useAdminStats, useAdminUsers, useAdminProducts, useAdminCreditPackages, useAdminBoosts
│   └── useSolanaBilling.ts   # SOL payment lifecycle (packages, initiate, verify, subscriptions)
├── components/
│   ├── ChatFeed.tsx          # Main chat view (thread messages)
│   ├── ChatMessage.tsx       # Individual generation display (single image, 4-up grid, vary/remix buttons)
│   ├── CreationPanel.tsx     # Prompt input, model selector, image upload, generation controls
│   ├── Sidebar.tsx           # Thread list, navigation, view mode switching
│   ├── ImageGallery.tsx      # Gallery view of all generations
│   ├── Lightbox.tsx          # Full-screen image viewer with actions
│   ├── UserSettings.tsx      # Settings modal (API key, account)
│   ├── SolanaCreditPurchase.tsx / SolanaSubscriptionPurchase.tsx  # SOL payment UIs
│   ├── OlloWelcomeFlow.tsx   # First-time onboarding
│   ├── TutorialFlow.tsx      # Feature walkthrough
│   └── ...                   # LoginForm, MagicLinkVerify, ResetPasswordPage, etc.
└── pages/
    ├── Billing.tsx            # User billing page (credits, plan, usage, Stripe products, SOL packages)
    ├── AdminLayout.tsx        # Admin shell with nav
    ├── AdminDashboard.tsx     # Stats overview
    ├── AdminUsers.tsx         # User management
    ├── AdminProducts.tsx      # Subscription product CRUD
    ├── AdminModels.tsx        # Model credit cost overrides
    ├── AdminCreditPackages.tsx # SOL credit package management
    ├── AdminFinancials.tsx    # Financial overview
    ├── AdminRevenue.tsx       # Revenue detail
    ├── AdminCosts.tsx         # Platform cost detail
    ├── AdminMetrics.tsx       # User metrics detail
    └── AdminPnL.tsx           # Profit & loss statement
```

## Database (SQLite)

Location: `/data/generations.db` (WAL mode). Schema is migration-based via `initializeSchema()` — CREATE TABLE IF NOT EXISTS + ALTER TABLE ADD COLUMN in try/catch blocks.

### Core Tables

| Table | Purpose |
|---|---|
| `users` | id, username, password_hash, email, wallet_address, is_admin, is_active, last_login, tutorial_completed_at |
| `generations` | id, prompt, model, image_path, width, height, parameters (JSON), user_id, cost, actual_cost, replicate_id, predict_time, thread_id, deleted_at, purged_at |
| `threads` | id, user_id, title, project_metadata (JSON), created_at, updated_at, deleted_at |
| `uploads` | id, user_id, filename, original_name, deleted_at |
| `email_tokens` | Magic link + password reset tokens (type, expires_at, used_at) |
| `wallet_challenges` | Solana wallet auth nonces |

### Credit & Subscription Tables

| Table | Purpose |
|---|---|
| `subscription_products` | Tier definitions (name, limits, pricing, refill config, allowed_models JSON) |
| `user_subscriptions` | User-to-product link (status, stripe_subscription_id, period dates, last_credit_topoff_at) |
| `user_credits` | **Ledger** — every credit change is a row (positive=add, negative=deduct). Balance = SUM(amount). Types: initial, bonus, purchase, admin, used, refill |
| `model_credit_costs` | Admin overrides for per-model credit costs |
| `credit_topoff_log` | Audit trail for automatic refills |
| `subscription_boosts` | Temporary premium access (boost_product_id, original_product_id, starts_at, ends_at, status) |

### Payment & Financial Tables

| Table | Purpose |
|---|---|
| `stripe_customers` | user_id <-> stripe_customer_id mapping |
| `payments` | All payment records (stripe_payment_intent_id, amount_cents, status, payment_type) |
| `revenue_events` | Revenue ledger (event_type: subscription/overage/credit_purchase/sol_credits/sol_subscription) |
| `platform_costs` | Our Replicate expenses per generation (estimated_cost, actual_cost, reconciled_at) |
| `user_metrics` | LTV tracking (first/last payment, total_paid_cents, churned_at) |
| `financial_periods` | Precomputed period snapshots for fast reporting |

### Solana Tables

| Table | Purpose |
|---|---|
| `solana_credit_packages` | Purchasable credit packs (name, credits, price_sol). Defaults: Starter 50/0.1, Creator 200/0.35, Pro 500/0.75 |
| `solana_transactions` | Credit purchase tx records (wallet, signature, amount, credits, status, verified_at) |
| `solana_subscription_transactions` | Subscription purchase tx records |
| `sol_price_snapshots` | CoinGecko price history |

---

## Payment System (Detailed)

### Credit System — The Primary Generation Gate

**Credits are the single currency for generating images.** Every generation costs credits. Users cannot generate without sufficient credits regardless of subscription status.

**Credit costs per model** (hardcoded in `server/services/usage.ts`, overridable via `model_credit_costs` table):

| Credits | Models |
|---|---|
| 1 | flux-schnell |
| 2 | flux-2-dev, flux-dev, flux-redux-schnell (default for unknown models) |
| 3 | flux-2-pro, flux-1.1-pro, flux-kontext-pro |
| 4 | flux-1.1-pro-ultra |
| 5 | flux-redux-dev |
| 10 | nano-banana-pro |

**Credit lifecycle:**
1. **Initial credits** — New users get `INITIAL_CREDITS` (env var, default 10) as type=`initial`
2. **Subscription bonus** — Products with `bonus_credits > 0` grant them on subscription assignment
3. **Refill (top-off)** — Background job every 5 min checks if `last_credit_topoff_at + topoff_interval_hours` has passed; if balance < `credit_refill_amount`, adds the *difference* (not the full amount)
4. **Purchase** — SOL credit packages add credits as type=`purchase`
5. **Admin grants** — Manual add/deduct via admin panel as type=`admin`
6. **Deduction** — Each generation inserts a negative amount as type=`used`

**Balance calculation:** `SELECT COALESCE(SUM(amount), 0) FROM user_credits WHERE user_id = ?`

### Generation Gating Flow (`canUserGenerate` in usage.ts)

```
1. Get credit balance (SUM of user_credits)
2. Get model credit cost (DB override → hardcoded map → default 2)
3. PRIMARY CHECK: balance >= creditCost? If not → blocked
4. SAFETY BACKSTOP: monthly_cost_limit exceeded? If so → blocked
5. Allowed
```

Also checked separately: `canUserUseModel()` — subscription's `allowed_models` JSON array restricts which models a tier can access (null = all allowed).

### Subscriptions

**`subscription_products` fields that matter:**
- `price` (USD), `price_sol` — display pricing
- `monthly_image_limit`, `monthly_cost_limit`, `daily_image_limit` — safety limits
- `bonus_credits` — one-time grant on subscription assignment
- `credit_refill_amount` — top-off target for automatic refills
- `topoff_interval_hours` — how often to refill (Free tier: 720 = 30 days)
- `allowed_models` — JSON array of model IDs (null = all)
- `stripe_price_id` — links to Stripe Price for checkout
- `overage_price_cents` — used by replicate-billing's charge calculator
- `available_for_usd`, `available_for_sol` — which payment methods can buy this product

**Default "Free" product:** 5 images/month limit, $1.50 cost limit, credit_refill_amount=5, topoff_interval_hours=720 (monthly refill).

**Subscription boosts** (server/services/subscription-boost.ts): Admin can grant temporary premium access. `getUserSubscription()` checks for active boosts first — if one exists, it returns the boost product instead of the user's actual subscription. Boosts auto-expire; cleanup job marks them expired.

### Stripe Integration (Current State)

**What exists:**
- `server/services/stripe.ts` — Full Stripe SDK integration (v20.1.2, API version 2024-12-18.acacia)
- Customer creation/lookup via `stripe_customers` table
- Checkout Session creation for subscription mode
- Customer Portal for self-service management
- Invoice listing
- Subscription cancellation
- Payment + revenue event recording + user metrics tracking

**Webhook handling** (`server/routes/stripe-webhooks.ts`):
- Uses `fastify-raw-body` for signature verification
- `invoice.paid` → records payment, revenue event, updates user_metrics
- `invoice.payment_failed` → records failed payment, sets subscription to `past_due`
- `customer.subscription.created/updated` → syncs status/period to local DB via `updateUserSubscription()`
- `customer.subscription.deleted` → marks canceled, records churn date
- `checkout.session.completed` → logging only (subscription creation handled by subscription.created webhook)

**Billing routes** (`server/routes/billing.ts`):
- `GET /api/billing/status` — is Stripe configured?
- `GET /api/billing` — full billing dashboard data (credits, subscription, usage, payments)
- `GET /api/billing/products` — available subscription products
- `POST /api/billing/checkout` — create Stripe Checkout Session (requires priceId, successUrl, cancelUrl)
- `POST /api/billing/portal` — create Stripe Customer Portal session
- `GET /api/billing/invoices` — Stripe invoice history
- `GET /api/billing/subscription` — active Stripe subscription details

**What's NOT wired up yet:**
- No Stripe integration for one-time credit purchases (only SOL can buy credits currently)
- `checkout.session.completed` webhook doesn't assign the local subscription or bonus credits — it only logs. The actual subscription sync relies on `customer.subscription.created/updated` webhooks which call `updateUserSubscription()` (updates the DB row) but do NOT call `assignSubscription()` (which would grant bonus credits and handle the old subscription properly)
- Products need `stripe_price_id` set in the admin panel to be purchasable via Stripe

### Solana Integration

**Credit purchases:**
1. Frontend calls `POST /api/billing/solana/initiate` with packageId
2. Backend creates pending `solana_transactions` row, returns treasury wallet + amount
3. User sends SOL from their connected wallet
4. Frontend calls `POST /api/billing/solana/verify` with txSignature
5. Backend polls Solana RPC for finalized tx, verifies treasury balance increased (1% tolerance)
6. Credits added, revenue event recorded

**Subscription purchases:** Same flow via `/api/billing/solana/subscribe/initiate` and `/verify`. Creates 30-day subscription + bonus credits.

**SOL pricing:** CoinGecko API, cached 5 min, fallback $250.

### Platform Cost Tracking

Two layers of cost tracking:

1. **Estimated cost at generation time** — `replicate.ts` has `MODEL_PRICING` with per-image or per-megapixel rates. Recorded in `platform_costs` and `generations.cost`.

2. **Actual cost reconciliation** — `replicate-billing.ts` runs hourly, fetches actual `predict_time` from Replicate API, calculates `predict_time * hardware_rate`, updates `platform_costs.actual_cost` and `generations.actual_cost`.

### Financial Reporting

`server/services/financial-reports.ts` provides comprehensive metrics:
- Revenue by type (subscription, overage, credit purchase, SOL)
- Platform costs (estimated vs actual)
- MRR, ARR, ARPU, LTV
- Revenue by tier, top customers, costs by model
- Period comparisons, trends, P&L statements

Admin endpoints at `/api/admin/financials/*`.

---

## Image Generation Pipeline

1. `POST /api/generate` receives prompt, model, dimensions, imageInputs, threadId
2. Checks: model access (subscription tier) → credit balance → deduct credits
3. Gets user's BYO Replicate API key if stored
4. Creates/validates thread
5. Calls `generateImage()` → Replicate API → polls for completion → downloads output → Sharp resize if >2048px → saves to `/generated-images/`
6. Records usage (monthly + daily counters), platform cost
7. Stores generation in DB with parameters JSON (includes imageInputs, multi-output image array for grids)

**10 models available** across categories: fast (schnell), quality (dev, pro), ultra, variation (redux), edit (kontext), external (nano-banana).

**Prompt enhancement:** `/api/enhance-prompt` uses Meta Llama 3 70B Instruct via Replicate.

## Authentication

Three methods, all produce JWT tokens:
1. **Username/password** — bcrypt (with legacy SHA-256 auto-migration)
2. **Magic link email** — Resend sends link, token verified on click, creates user if needed
3. **Solana wallet** — Challenge/response with tweetnacl signature verification

Initial admin created on first startup from `ADMIN_PASSWORD` env var (username: "ollo").

JWT: 1-day default, 7-day with rememberMe. Stored in localStorage.

## Deployment

- **Dockerfile:** Two-stage (bun:1 builder → bun:1-slim production)
- **docker-compose.prod.yml:** Single `app` service, port 3001, volumes for data/images/uploads, `web` Docker network
- **Caddy reverse proxy** at `/home/baud/caddy/` handles TLS and routing

## Environment Variables

**Required:** `REPLICATE_API_TOKEN`, `JWT_SECRET`, `ADMIN_PASSWORD`, `ENCRYPTION_KEY`

**Stripe:** `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PUBLISHABLE_KEY`

**Solana:** `SOLANA_NETWORK`, `SOLANA_RPC_URL`, `SOLANA_TREASURY_WALLET`, `VITE_SOLANA_NETWORK`

**Email:** `RESEND_API_KEY`, `FROM_EMAIL`, `APP_URL`

**Optional:** `INITIAL_CREDITS` (default 10), `PORT` (default 3001), `NODE_ENV`, `CORS_ORIGIN`, S3 settings (unused)
