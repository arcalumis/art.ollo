import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import crypto from "node:crypto";
import "./inject-bun-fix";
import { redactUrl } from "../server/app";
import { getDb } from "../server/db";
import { signToken } from "../server/middleware/auth";
import { type OutgoingEmail, setEmailTransport } from "../server/services/email";
import { consumeToken, createEmailToken } from "../server/services/tokens";
import { authHeader, createUser, creditBalance, getApp } from "./helpers";

// ---- harness ----

const sent: OutgoingEmail[] = [];
let failSends = false;
let ipSeq = 0;

/** Every request gets its own client IP so per-IP route limits don't interfere between tests. */
function ip(): string {
	ipSeq++;
	return `198.51.${Math.floor(ipSeq / 250)}.${(ipSeq % 250) + 1}`;
}

function uniqueEmail(prefix = "person"): string {
	return `${prefix}.${crypto.randomBytes(4).toString("hex")}@example.com`;
}

function tokenFrom(mail: OutgoingEmail): string {
	const m = mail.devLink?.match(/token=([a-f0-9]+)/);
	if (!m) throw new Error("no token in email");
	return m[1];
}

async function requestLink(email: string, rememberMe = false) {
	const app = await getApp();
	return app.inject({
		method: "POST",
		url: "/api/auth/magic-link",
		headers: { "x-forwarded-for": ip() },
		payload: { email, rememberMe },
	});
}

async function verifyLink(token: string) {
	const app = await getApp();
	return app.inject({
		method: "GET",
		url: `/api/auth/magic-link/verify?token=${token}`,
		headers: { "x-forwarded-for": ip() },
	});
}

let fetchSpy: ReturnType<typeof spyOn>;

beforeAll(() => {
	setEmailTransport(async (mail) => {
		if (failSends) return { success: false, error: "resend down" };
		sent.push(mail);
		return { success: true };
	});
	// No test may reach the network.
	fetchSpy = spyOn(globalThis, "fetch").mockImplementation((() => {
		throw new Error("network access in tests");
	}) as unknown as typeof fetch);
});

afterAll(() => {
	setEmailTransport(null);
	fetchSpy.mockRestore();
});

beforeEach(() => {
	sent.length = 0;
	failSends = false;
});

function hashSha256(s: string): string {
	return crypto.createHash("sha256").update(s).digest("hex");
}

// ---- tests ----

describe("magic-link sign-up", () => {
	test("unknown email gets a sign-up link that creates exactly one user with initial credits + Free", async () => {
		const email = uniqueEmail("New.User");
		const res = await requestLink(`  ${email.toUpperCase()} `);
		expect(res.statusCode).toBe(200);
		expect(sent).toHaveLength(1);
		expect(sent[0].to).toBe(email.toLowerCase());
		expect(sent[0].subject).toContain("Create your");

		const verify = await verifyLink(tokenFrom(sent[0]));
		expect(verify.statusCode).toBe(200);
		const body = verify.json();
		expect(body.token).toBeString();
		expect(body.isNewUser).toBe(true);

		const db = getDb();
		const users = db.prepare("SELECT id, username, password_hash FROM users WHERE email = ?").all(email.toLowerCase()) as Array<{
			id: string;
			username: string;
			password_hash: string;
		}>;
		expect(users).toHaveLength(1);
		const user = users[0];
		expect(user.username).toMatch(/^newuser/);
		expect(user.password_hash.startsWith("!unusable:")).toBe(true);

		expect(creditBalance(user.id)).toBe(10);
		const initial = db
			.prepare("SELECT SUM(amount) AS n FROM user_credits WHERE user_id = ? AND credit_type = 'initial'")
			.get(user.id) as { n: number };
		expect(initial.n).toBe(10);

		const subs = db
			.prepare(`SELECT sp.name FROM user_subscriptions us JOIN subscription_products sp ON sp.id = us.product_id
				WHERE us.user_id = ? AND us.status = 'active'`)
			.all(user.id) as Array<{ name: string }>;
		expect(subs.map((s) => s.name)).toEqual(["Free"]);

		// The session works
		const app = await getApp();
		const me = await app.inject({ method: "GET", url: "/api/me", headers: { authorization: `Bearer ${body.token}` } });
		expect(me.statusCode).toBe(200);
	});

	test("a second sign-up link for the same email logs into the same account", async () => {
		const email = uniqueEmail();
		await requestLink(email);
		await requestLink(email);
		expect(sent).toHaveLength(2);
		const first = await verifyLink(tokenFrom(sent[0]));
		const second = await verifyLink(tokenFrom(sent[1]));
		expect(first.json().user.id).toBe(second.json().user.id);
		expect(second.json().isNewUser).toBe(false);
		const count = getDb().prepare("SELECT COUNT(*) AS n FROM users WHERE email = ?").get(email) as { n: number };
		expect(count.n).toBe(1);
	});

	test("responses for known and unknown emails are byte-identical", async () => {
		const known = createUser({ email: uniqueEmail("known") });
		const a = await requestLink(known.email);
		const b = await requestLink(uniqueEmail("unknown"));
		expect(a.statusCode).toBe(b.statusCode);
		expect(a.body).toBe(b.body);
		expect(a.headers["content-type"]).toBe(b.headers["content-type"]);
		expect(sent).toHaveLength(2);
		expect(sent[0].subject).toContain("sign-in");
	});

	test("when email delivery fails, known and unknown both get the same 503", async () => {
		failSends = true;
		const known = createUser({ email: uniqueEmail("known") });
		const a = await requestLink(known.email);
		const b = await requestLink(uniqueEmail("unknown"));
		expect(a.statusCode).toBe(503);
		expect(a.body).toBe(b.body);
		expect(a.json().error).toContain("couldn't send email");
	});

	test("check-email endpoint no longer exists", async () => {
		const app = await getApp();
		const res = await app.inject({
			method: "POST",
			url: "/api/auth/check-email",
			headers: { "x-forwarded-for": ip() },
			payload: { email: "x@example.com" },
		});
		expect(res.statusCode).toBe(404);
	});
});

describe("email flood protection", () => {
	test("per-recipient cap stops the 4th send in an hour, with an identical response", async () => {
		const email = uniqueEmail("flood");
		const responses = [];
		for (let i = 0; i < 4; i++) responses.push(await requestLink(email));
		expect(sent).toHaveLength(3);
		for (const r of responses) {
			expect(r.statusCode).toBe(200);
			expect(r.body).toBe(responses[0].body);
		}
	});

	test("cap is shared across magic-link and password-reset", async () => {
		const user = createUser({ email: uniqueEmail("shared") });
		const app = await getApp();
		await requestLink(user.email);
		await requestLink(user.email);
		await app.inject({
			method: "POST",
			url: "/api/auth/forgot-password",
			headers: { "x-forwarded-for": ip() },
			payload: { email: user.email },
		});
		const fourth = await app.inject({
			method: "POST",
			url: "/api/auth/forgot-password",
			headers: { "x-forwarded-for": ip() },
			payload: { email: user.email },
		});
		expect(fourth.statusCode).toBe(200);
		expect(sent).toHaveLength(3);
	});

	test("global daily cap blocks sends to anyone", async () => {
		const prev = process.env.EMAIL_DAILY_CAP;
		// Auth mail has its own global budget (receipts and other transactional mail don't count).
		const used = (
			getDb()
				.prepare(
					"SELECT COUNT(*) AS n FROM email_send_log WHERE kind NOT IN ('receipt', 'payment_failed', 'low_credits', 'email_changed')",
				)
				.get() as { n: number }
		).n;
		process.env.EMAIL_DAILY_CAP = String(used);
		try {
			const res = await requestLink(uniqueEmail("global"));
			expect(res.statusCode).toBe(200);
			expect(sent).toHaveLength(0);
		} finally {
			process.env.EMAIL_DAILY_CAP = prev;
		}
	});
});

describe("token consumption", () => {
	test("a replayed magic link fails", async () => {
		const user = createUser({ email: uniqueEmail("replay") });
		await requestLink(user.email);
		const token = tokenFrom(sent[0]);
		expect((await verifyLink(token)).statusCode).toBe(200);
		expect((await verifyLink(token)).statusCode).toBe(401);
	});

	test("tokens are stored hashed, never raw", async () => {
		const user = createUser({ email: uniqueEmail("hashed") });
		const raw = createEmailToken({ userId: user.id, type: "magic_link", expiresInMinutes: 15 });
		const row = getDb().prepare("SELECT token, token_hash FROM email_tokens WHERE user_id = ?").get(user.id) as {
			token: string;
			token_hash: string;
		};
		expect(row.token).not.toBe(raw);
		expect(row.token_hash).toBe(hashSha256(raw));
	});

	test("a concurrent double-consume yields exactly one success", async () => {
		const user = createUser({ email: uniqueEmail("race") });
		const raw = createEmailToken({ userId: user.id, type: "magic_link", expiresInMinutes: 15 });
		const results = await Promise.all([verifyLink(raw), verifyLink(raw), verifyLink(raw)]);
		expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
		expect(results.filter((r) => r.statusCode === 401)).toHaveLength(2);

		const raw2 = createEmailToken({ userId: user.id, type: "magic_link", expiresInMinutes: 15 });
		const direct = [consumeToken(raw2, "magic_link"), consumeToken(raw2, "magic_link")];
		expect(direct.filter((d) => d.valid)).toHaveLength(1);
	});

	test("expired and wrong-type tokens are rejected", async () => {
		const user = createUser({ email: uniqueEmail("expired") });
		const expired = createEmailToken({ userId: user.id, type: "magic_link", expiresInMinutes: -1 });
		expect((await verifyLink(expired)).statusCode).toBe(401);
		const reset = createEmailToken({ userId: user.id, type: "password_reset", expiresInMinutes: 15 });
		expect((await verifyLink(reset)).statusCode).toBe(401);
	});

	test("password reset bumps token_version, revoking sessions and other outstanding links", async () => {
		const app = await getApp();
		const user = createUser({ email: uniqueEmail("reset") });
		const otherLink = createEmailToken({ userId: user.id, type: "magic_link", expiresInMinutes: 15 });
		const reset = createEmailToken({ userId: user.id, type: "password_reset", expiresInMinutes: 60 });

		expect((await app.inject({ method: "GET", url: "/api/me", headers: authHeader(user) })).statusCode).toBe(200);

		const res = await app.inject({
			method: "POST",
			url: "/api/auth/reset-password",
			headers: { "x-forwarded-for": ip() },
			payload: { token: reset, newPassword: "NewPassw0rd" },
		});
		expect(res.statusCode).toBe(200);

		expect((await app.inject({ method: "GET", url: "/api/me", headers: authHeader(user) })).statusCode).toBe(401);
		expect((await verifyLink(otherLink)).statusCode).toBe(401);

		const login = await app.inject({
			method: "POST",
			url: "/api/auth/login-email",
			headers: { "x-forwarded-for": ip() },
			payload: { email: user.email, password: "NewPassw0rd" },
		});
		expect(login.statusCode).toBe(200);
		expect((await app.inject({ method: "GET", url: "/api/me", headers: { authorization: `Bearer ${login.json().token}` } })).statusCode).toBe(200);
	});
});

describe("sessions", () => {
	test("a deactivated user's existing token gets 401", async () => {
		const app = await getApp();
		const user = createUser();
		expect((await app.inject({ method: "GET", url: "/api/me", headers: authHeader(user) })).statusCode).toBe(200);
		getDb().prepare("UPDATE users SET is_active = 0 WHERE id = ?").run(user.id);
		expect((await app.inject({ method: "GET", url: "/api/me", headers: authHeader(user) })).statusCode).toBe(401);
	});

	test("admin deactivation revokes the token even after reactivation (token_version bump)", async () => {
		const app = await getApp();
		const admin = createUser({ isAdmin: true });
		const user = createUser();
		const patch = (isActive: boolean) =>
			app.inject({ method: "PATCH", url: `/api/admin/users/${user.id}`, headers: authHeader(admin), payload: { isActive, reason: "test toggle" } });
		expect((await patch(false)).statusCode).toBe(200);
		expect((await patch(true)).statusCode).toBe(200);
		expect((await app.inject({ method: "GET", url: "/api/me", headers: authHeader(user) })).statusCode).toBe(401);
	});

	test("a demoted admin loses admin immediately", async () => {
		const app = await getApp();
		const admin = createUser({ isAdmin: true });
		expect((await app.inject({ method: "GET", url: "/api/admin/stats", headers: authHeader(admin) })).statusCode).toBe(200);
		getDb().prepare("UPDATE users SET is_admin = 0 WHERE id = ?").run(admin.id);
		expect((await app.inject({ method: "GET", url: "/api/admin/stats", headers: authHeader(admin) })).statusCode).toBe(403);
		const me = await app.inject({ method: "GET", url: "/api/me", headers: authHeader(admin) });
		expect(me.json().user.isAdmin).toBe(false);
	});

	test("a non-admin token claiming isAdmin is not trusted", async () => {
		const app = await getApp();
		const user = createUser();
		const forged = signToken({ userId: user.id, username: user.username, isAdmin: true });
		const res = await app.inject({ method: "GET", url: "/api/admin/stats", headers: { authorization: `Bearer ${forged}` } });
		expect(res.statusCode).toBe(403);
	});

	test("inactive users cannot log in or use magic links", async () => {
		const app = await getApp();
		const email = uniqueEmail("inactive");
		const id = crypto.randomUUID();
		getDb()
			.prepare("INSERT INTO users (id, username, password_hash, email, is_active) VALUES (?, ?, ?, ?, 0)")
			.run(id, `inactive_${id.slice(0, 6)}`, hashSha256("Passw0rdX"), email);
		const login = await app.inject({
			method: "POST",
			url: "/api/auth/login-email",
			headers: { "x-forwarded-for": ip() },
			payload: { email, password: "Passw0rdX" },
		});
		expect(login.statusCode).toBe(401);

		const link = createEmailToken({ userId: id, type: "magic_link", expiresInMinutes: 15 });
		expect((await verifyLink(link)).statusCode).toBe(401);

		// Requesting a link looks normal but sends nothing
		const req = await requestLink(email);
		expect(req.statusCode).toBe(200);
		expect(sent).toHaveLength(0);
	});
});

describe("password hashing", () => {
	test("a legacy SHA-256 login succeeds and rehashes to bcrypt", async () => {
		const app = await getApp();
		const id = crypto.randomUUID();
		const username = `legacy_${id.slice(0, 6)}`;
		getDb()
			.prepare("INSERT INTO users (id, username, password_hash, is_active) VALUES (?, ?, ?, 1)")
			.run(id, username, hashSha256("OldPassw0rd"));

		const wrong = await app.inject({
			method: "POST",
			url: "/api/login",
			headers: { "x-forwarded-for": ip() },
			payload: { username, password: "nope" },
		});
		expect(wrong.statusCode).toBe(401);

		const ok = await app.inject({
			method: "POST",
			url: "/api/login",
			headers: { "x-forwarded-for": ip() },
			payload: { username, password: "OldPassw0rd" },
		});
		expect(ok.statusCode).toBe(200);

		const row = getDb().prepare("SELECT password_hash FROM users WHERE id = ?").get(id) as { password_hash: string };
		expect(row.password_hash.startsWith("$2")).toBe(true);

		const again = await app.inject({
			method: "POST",
			url: "/api/login",
			headers: { "x-forwarded-for": ip() },
			payload: { username, password: "OldPassw0rd" },
		});
		expect(again.statusCode).toBe(200);
	});

	test("admin-created users get bcrypt hashes", async () => {
		const app = await getApp();
		const admin = createUser({ isAdmin: true });
		const email = uniqueEmail("Created");
		const res = await app.inject({
			method: "POST",
			url: "/api/admin/users",
			headers: authHeader(admin),
			payload: { username: `made_${crypto.randomBytes(3).toString("hex")}`, email: email.toUpperCase() },
		});
		expect(res.statusCode).toBe(200);
		const row = getDb().prepare("SELECT password_hash, email FROM users WHERE id = ?").get(res.json().id) as {
			password_hash: string;
			email: string;
		};
		expect(row.password_hash.startsWith("$2")).toBe(true);
		expect(row.email).toBe(email.toLowerCase());
	});
});

describe("wallet challenge", () => {
	test("does not reveal registration status or username", async () => {
		const app = await getApp();
		const res = await app.inject({
			method: "POST",
			url: "/api/auth/wallet/challenge",
			headers: { "x-forwarded-for": ip() },
			payload: { walletAddress: "So11111111111111111111111111111111111111112" },
		});
		expect(res.statusCode).toBe(200);
		expect(Object.keys(res.json()).sort()).toEqual(["challenge", "message"]);
	});
});

describe("proxy + rate limiting", () => {
	test("trustProxy gives distinct x-forwarded-for clients separate limits", async () => {
		const app = await getApp();
		const attempt = (clientIp: string) =>
			app.inject({
				method: "POST",
				url: "/api/login",
				headers: { "x-forwarded-for": clientIp },
				payload: { username: "nobody-here", password: "wrong" },
			});
		const a = "203.0.113.10";
		const b = "203.0.113.11";
		const codes = [];
		for (let i = 0; i < 6; i++) codes.push((await attempt(a)).statusCode);
		expect(codes.slice(0, 5).every((c) => c === 401)).toBe(true);
		expect(codes[5]).toBe(429);
		expect((await attempt(b)).statusCode).toBe(401);
	});

	test("health check is exempt from the global limiter", async () => {
		const app = await getApp();
		for (let i = 0; i < 110; i++) {
			const res = await app.inject({ method: "GET", url: "/api/health", headers: { "x-forwarded-for": "203.0.113.50" } });
			expect(res.statusCode).toBe(200);
		}
	});

	test("static files use a separate bucket from the API budget", async () => {
		const app = await getApp();
		const client = "203.0.113.60";
		for (let i = 0; i < 105; i++) {
			const res = await app.inject({ method: "GET", url: "/images/missing.png", headers: { "x-forwarded-for": client } });
			expect(res.statusCode).not.toBe(429);
		}
		const api = await app.inject({ method: "GET", url: "/api/billing/status", headers: { "x-forwarded-for": client } });
		expect(api.statusCode).toBe(200);
	});
});

describe("log redaction", () => {
	test("token and signature query params are redacted", () => {
		expect(redactUrl("/api/auth/magic-link/verify?token=abc123")).toBe("/api/auth/magic-link/verify?token=%5BREDACTED%5D");
		expect(redactUrl("/x?a=1&signature=zzz&b=2")).toBe("/x?a=1&signature=%5BREDACTED%5D&b=2");
		expect(redactUrl("/api/health")).toBe("/api/health");
		expect(redactUrl("/x?q=token")).toBe("/x?q=token");
	});
});

describe("sign out", () => {
	test("POST /api/auth/logout ends this and every other session", async () => {
		const app = await getApp();
		const user = createUser();
		const otherDevice = signToken({ userId: user.id, username: user.username, isAdmin: false });
		const me = (token: string) =>
			app.inject({ method: "GET", url: "/api/me", headers: { authorization: `Bearer ${token}` }, remoteAddress: ip() });
		expect((await me(otherDevice)).statusCode).toBe(200);

		expect((await app.inject({ method: "POST", url: "/api/auth/logout", remoteAddress: ip() })).statusCode).toBe(401);
		const res = await app.inject({ method: "POST", url: "/api/auth/logout", headers: authHeader(user), remoteAddress: ip() });
		expect(res.statusCode).toBe(200);
		expect((await me(user.token)).statusCode).toBe(401);
		expect((await me(otherDevice)).statusCode).toBe(401);
		// A replayed logout with the revoked token does nothing
		expect(
			(await app.inject({ method: "POST", url: "/api/auth/logout", headers: authHeader(user), remoteAddress: ip() }))
				.statusCode,
		).toBe(401);
	});
});
