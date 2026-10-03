# ollo.art

AI image generation subscription product: React 19 + Fastify 5 + Bun + SQLite, images via Replicate, payments via Stripe (primary) and Solana (secondary). Operated by Matahari Development, LLC (Florida). Live at https://ollo.art; production runs on this VPS from this directory.

## Ground rules

- **`.env` is a symlink to `.env.production` with LIVE Stripe/Replicate/Resend/Alchemy keys**, and Bun auto-loads it. `tests/setup.ts` overwrites every secret before tests load; never bypass it, and never run ad-hoc scripts that call external APIs from the repo assuming test keys.
- Never touch the live container `artollo-app-1` or its volumes for experiments. Use a staging container over a copy of the DB (see Deployment).
- **UI work:** load `.claude/skills/ollo-design/SKILL.md` (tokens, primitives, copy voice, screenshot loop) and `.claude/skills/frontend-design/SKILL.md` first.
- Stripe is in live mode: creating products or prices needs the owner's OK on amounts.

## Commands

```bash
bun install
bun run dev              # server (bun --watch) + vite on :5173
bun run check:types      # tsconfig.app.json (src) + tsconfig.server.json (server, tests, scripts)
bun run check:lint       # biome
bun test                 # in-process app via buildApp() on an :memory: DB
bun run build
bun run ci               # all of the above, what GitHub Actions runs
bun scripts/shoot.ts <baseUrl> <outDir> [routes…]   # Playwright screenshots at 390px + 1440px
```

## Layout

```
server/
  index.ts            entry: buildApp() + cleanup job + listen
  app.ts              Fastify setup (trustProxy for Caddy, CORS, helmet, rate limits, static, SPA fallback, OG for /s/:slug)
  db/schema.ts        all tables; migrations appended per phase (run-once via schema_migrations or column checks)
  middleware/auth.ts  JWT; authMiddleware re-reads the user (is_active, is_admin, token_version) every request
  routes/             auth, generate (+ /api/tools/:tool), models, history, threads, uploads, user, account,
                      share, billing, stripe-webhooks, solana-billing, solana-rpc, admin*, admin-console
  services/
    model-catalog.ts  SINGLE SOURCE OF TRUTH for models: ratios, size tiers → per-model params, official
                      price formulas, credits = max(1, ceil(cost × 42)) per output, plan locks, hidden legacy ids
    replicate.ts      builds inputs from the catalog, saves files, records real dims. Waiting for a GPU: identical
                      same-model hedges at 5/10/15s, first to start wins, others canceled; nothing started by
                      45s → GPU_BUSY (refund). Render deadline 120s from start. Phases → generation-status.ts
    generation-status.ts  in-memory live phase per clientRequestId (owner-only, 10 min TTL) for
                      GET /api/generate/status/:id, polled by useGenerationQueue
    usage.ts          credit ledger, reserveCredits (atomic, before Replicate) + refunds, subscriptions, refills
    stripe.ts         customers, checkout, portal, recordPayment (upsert per payment intent / invoice)
    solana.ts         SOL packs/subscriptions; payments bound by a Solana Pay reference key
    email.ts          Resend (lazy); per-recipient, per-IP and global caps; separate transactional budget
    admin-*.ts        admin console metrics, subscriptions, health, audit log, validation, backfills
    cleanup.ts        5-min job: trash purge (30 days), refills, SOL subscription expiry, snapshots, reconciliation
src/
  App.tsx             routes; signed-in app shell (/create[/:threadId], /gallery[/archive|/trash], /billing, /settings)
  pages/              Landing, Pricing, Terms, Privacy, Settings, SharedImage, NotFound, admin/*
  components/ui       shadcn/ui on Base UI, restyled to ollo tokens
  components/brand    Laurel (mark + progress), Wordmark, CreditPill
  components/{shell,series,viewer,billing,auth,landing}
  hooks/useGenerationQueue.ts  one queue for generate / vary / tools, per-item errors, paywall on credit codes
  index.css           design tokens: Night (default) and Plaster finishes, legacy var mapping
```

## Money

- **Credits are the only generation currency.** Each generation reserves `credits per output × outputs` in one SQLite transaction before Replicate is called; failures, timeouts and missing outputs write `refund` rows. Ledger: `user_credits` (`credit_type`: initial, bonus, purchase/purchased, admin, used, refund, refill). Balance = SUM(amount).
- **Plans** (Stripe live prices): Free (10 on sign-up, refills to 5 every 30 days), Starter $9 (75/month refill), Creator $19 (200), Pro $39 (500). Refills top up to the amount; they don't stack. `subscription_products.allowed_models` gates models (NULL = all; `<model>:max` entries gate the Max tier).
- **Credit packs** (Stripe one-time): 100/$9, 300/$24, 1000/$69, stored in `solana_credit_packages` with `available_for_sol = 0`; SOL purchases require `available_for_sol = 1` and a positive SOL price.
- **Pricing rule:** credits = ceil(official Replicate cost × 42) → worst-case gross margin ≥ 68% on Pro. Admin overrides in `model_credit_costs` (`<model>` or `<model>:<tier>`, positive integers only).
- **Stripe webhooks** (`/api/webhooks/stripe`): raw-body async signature check, 500 on handler failure so Stripe retries, idempotent by event id, stale subscription events ignored; grants only on paid/active; receipts once per invoice.

## Auth

Email magic link is the primary path and also creates accounts (INITIAL_CREDITS + Free plan). Password and Solana wallet sign-in are secondary. Tokens: JWT (1 day, or 30 days with "remember me") carrying `tv` = `users.token_version`; bumping it revokes every session (password/email change, deactivation, "Sign out everywhere"). Email/password changes require recent re-authentication. The admin account is `admin` (no email); `ADMIN_PASSWORD` only seeds it when missing.

## Deployment

CI (`.github/workflows/ci.yml`) only verifies: types, lint, tests, build. **It does not deploy.** Releases are done on this host:

1. Merge to `main`; `bun run ci` green.
2. `scripts/backup.sh hourly` (also runs from cron; snapshots + B2 off-host; `verify-restore.sh` weekly).
3. Staging: build an image (`docker build -t ollo-art:staging .`), copy the live DB with `VACUUM INTO` from inside the container, run it on `127.0.0.1:3101` with `--env-file .env.production` but invalid Stripe/Resend keys, and check the migrations and flows.
4. `docker tag artollo-app:latest artollo-app:pre-<release>` (rollback), then `docker compose up --build -d` (never `down -v`).

Caddy (`/home/baud/caddy/Caddyfile`) proxies `ollo.art` → `artollo-app-1:3001` with `lb_try_duration 30s`, so restarts don't return 503s. The app port is bound to 127.0.0.1 only. Volumes: `ollo_art_data` (DB at /app/data/generations.db), `ollo_art_images`, `ollo_art_uploads`. The host `data/*.db` files are stale January snapshots.

## Environment

Required: `REPLICATE_API_TOKEN`, `JWT_SECRET`, `ENCRYPTION_KEY`, `ADMIN_PASSWORD`, `APP_URL`, `RESEND_API_KEY`, `FROM_EMAIL`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `SOLANA_NETWORK`, `SOLANA_RPC_URL` (Alchemy; the server adds the Origin header it requires), `SOLANA_TREASURY_WALLET`. Optional: `INITIAL_CREDITS` (10), `EMAIL_DAILY_CAP` (500), `MAGIC_LINK_EXPIRY_MINUTES`, `PASSWORD_RESET_EXPIRY_MINUTES`, `PORT`. Build arg: `VITE_SOLANA_NETWORK` (docker-compose passes it; `.env*` files are excluded from the build context).
