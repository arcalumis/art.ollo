// Runs before any test file is loaded.
//
// Bun auto-loads .env, which in this repo is a symlink to .env.production with
// LIVE Replicate, Stripe, Resend and Solana credentials. Every secret is
// overwritten here so no test can ever reach a real paid API or real inbox.
const overrides: Record<string, string> = {
	NODE_ENV: "test",
	DB_PATH: ":memory:",
	JWT_SECRET: "test-jwt-secret",
	ENCRYPTION_KEY: "test-encryption-key-0123456789abcdef",
	ADMIN_PASSWORD: "test-admin-password",
	REPLICATE_API_TOKEN: "r8_test_invalid",
	STRIPE_SECRET_KEY: "sk_test_invalid",
	STRIPE_WEBHOOK_SECRET: "whsec_test",
	STRIPE_PUBLISHABLE_KEY: "pk_test_invalid",
	RESEND_API_KEY: "re_test_invalid",
	FROM_EMAIL: "test@example.com",
	APP_URL: "http://localhost:5173",
	SOLANA_NETWORK: "devnet",
	SOLANA_RPC_URL: "http://127.0.0.1:1",
	SOLANA_TREASURY_WALLET: "11111111111111111111111111111111",
	INITIAL_CREDITS: "10",
};
for (const [k, v] of Object.entries(overrides)) process.env[k] = v;

// Fail loudly rather than silently hitting production if a live key slips through.
for (const [k, v] of Object.entries(process.env)) {
	if (v && /^(sk_live_|rk_live_)/.test(v)) throw new Error(`Live secret in test env: ${k}`);
}
