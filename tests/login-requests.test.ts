import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import crypto from "node:crypto";
import "./inject-bun-fix";
import jwt from "jsonwebtoken";
import { getDb } from "../server/db";
import { type OutgoingEmail, setEmailTransport } from "../server/services/email";
import { summarizeUserAgent } from "../server/services/login-requests";
import { peekToken } from "../server/services/tokens";
import { createUser, creditBalance, getApp } from "./helpers";

// ---- harness ----

const sent: OutgoingEmail[] = [];
let ipSeq = 0;

/** Every request gets its own client IP so per-IP route limits don't interfere between tests. */
function ip(): string {
	ipSeq++;
	return `192.0.${Math.floor(ipSeq / 250) % 250}.${(ipSeq % 250) + 1}`;
}

function uniqueEmail(prefix = "xdev"): string {
	return `${prefix}.${crypto.randomBytes(4).toString("hex")}@example.com`;
}

const IPHONE_SAFARI =
	"Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

interface LinkResponse {
	success: boolean;
	message: string;
	requestId: string;
	pollSecret: string;
	code: string;
}

async function requestLink(
	email: string,
	opts: { rememberMe?: boolean; replaces?: { requestId: string; pollSecret: string } } = {},
): Promise<LinkResponse> {
	const app = await getApp();
	const res = await app.inject({
		method: "POST",
		url: "/api/auth/magic-link",
		headers: { "x-forwarded-for": ip(), "user-agent": IPHONE_SAFARI },
		payload: { email, rememberMe: opts.rememberMe ?? false, replaces: opts.replaces },
	});
	expect(res.statusCode).toBe(200);
	return res.json();
}

/** The token and rid in the most recent email. */
function lastLink(): { token: string; rid: string | null; url: string } {
	const mail = sent.at(-1);
	if (!mail?.devLink) throw new Error("no email sent");
	const url = new URL(mail.devLink);
	return {
		token: url.searchParams.get("token") ?? "",
		rid: url.searchParams.get("rid"),
		url: mail.devLink,
	};
}

async function post(url: string, payload: unknown, clientIp = ip()) {
	const app = await getApp();
	return app.inject({
		method: "POST",
		url,
		headers: { "x-forwarded-for": clientIp },
		payload: payload as object,
	});
}

const approve = (requestId: string, token: string) =>
	post("/api/auth/login-request/approve", { requestId, token });
const here = (requestId: string, token: string) =>
	post("/api/auth/login-request/here", { requestId, token });
const deny = (requestId: string, token: string) =>
	post("/api/auth/login-request/deny", { requestId, token });
const poll = (requestId: string, pollSecret: string, clientIp?: string) =>
	post("/api/auth/login-request/status", { requestId, pollSecret }, clientIp);

async function info(rid: string, token: string) {
	const app = await getApp();
	return app.inject({
		method: "GET",
		url: `/api/auth/login-request/info?rid=${rid}&token=${token}`,
		headers: { "x-forwarded-for": ip() },
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

function requestRow(id: string) {
	return getDb().prepare("SELECT * FROM login_requests WHERE id = ?").get(id) as Record<
		string,
		unknown
	>;
}

let fetchSpy: ReturnType<typeof spyOn>;

beforeAll(() => {
	setEmailTransport(async (mail) => {
		sent.push(mail);
		return { success: true };
	});
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
});

// ---- tests ----

describe("magic-link request", () => {
	test("returns a login request: id, 32-byte poll secret, 4-digit code; only the secret's hash is stored", async () => {
		const user = createUser({ email: uniqueEmail() });
		const res = await requestLink(user.email);
		expect(res.success).toBe(true);
		expect(res.requestId).toMatch(/^[0-9a-f-]{36}$/);
		expect(Buffer.from(res.pollSecret, "base64url")).toHaveLength(32);
		expect(res.code).toMatch(/^\d{4}$/);

		const row = requestRow(res.requestId);
		expect(row.status).toBe("pending");
		expect(row.code).toBe(res.code);
		expect(row.poll_secret_hash).toBe(
			crypto.createHash("sha256").update(res.pollSecret).digest("hex"),
		);
		expect(JSON.stringify(row)).not.toContain(res.pollSecret);
		expect(row.user_agent_summary).toBe("Safari on iPhone");
	});

	test("the email carries the rid and the device summary, never the raw user agent", async () => {
		const user = createUser({ email: uniqueEmail() });
		const res = await requestLink(user.email);
		const link = lastLink();
		expect(link.rid).toBe(res.requestId);
		const html = sent[0].html;
		expect(html).toContain("Safari on iPhone");
		expect(html).not.toContain("AppleWebKit");
		expect(html).toContain("If you didn't just try to sign in to ollo, ignore this email.");
		expect(html).toContain("sign in the device where you asked");
	});

	test("known, unknown, deactivated and over-cap emails get the same response shape", async () => {
		const shape = (r: LinkResponse) =>
			Object.keys(r).sort().join(",") + typeof r.requestId + r.code.length;
		const known = createUser({ email: uniqueEmail("known") });
		const inactive = createUser({ email: uniqueEmail("inactive") });
		getDb().prepare("UPDATE users SET is_active = 0 WHERE id = ?").run(inactive.id);
		const capped = uniqueEmail("capped");
		for (let i = 0; i < 3; i++) await requestLink(capped);

		const responses = [
			await requestLink(known.email),
			await requestLink(uniqueEmail("unknown")),
			await requestLink(inactive.email),
			await requestLink(capped),
		];
		for (const r of responses) {
			expect(shape(r)).toBe(shape(responses[0]));
			expect(r.message).toBe(responses[0].message);
		}
		// The deactivated and over-cap requests exist but are backed by no link.
		expect(requestRow(responses[2].requestId).token_hash).toBeNull();
		expect(requestRow(responses[3].requestId).token_hash).toBeNull();
	});
});

describe("same device", () => {
	test("opening the link where it was requested signs in as before and consumes the request", async () => {
		const user = createUser({ email: uniqueEmail() });
		const res = await requestLink(user.email);
		const { token } = lastLink();

		const verify = await verifyLink(token);
		expect(verify.statusCode).toBe(200);
		expect(verify.json().token).toBeString();
		expect(verify.json().user.id).toBe(user.id);
		expect(verify.json().isNewUser).toBeUndefined();

		expect(requestRow(res.requestId).status).toBe("consumed");
		const p = await poll(res.requestId, res.pollSecret);
		expect(p.json() as object).toEqual({ status: "consumed" });
	});
});

describe("cross-device approval", () => {
	test("approve on B: A receives a session once; a second poll gets nothing", async () => {
		const user = createUser({ email: uniqueEmail() });
		const res = await requestLink(user.email);
		const { token, rid } = lastLink();
		expect(rid).toBe(res.requestId);

		const pending = await poll(res.requestId, res.pollSecret);
		expect(pending.json() as object).toEqual({ status: "pending" });

		const page = await info(res.requestId, token);
		expect(page.statusCode).toBe(200);
		expect(page.json()).toMatchObject({
			status: "pending",
			device: "Safari on iPhone",
			code: res.code,
		});

		const ok = await approve(res.requestId, token);
		expect(ok.statusCode).toBe(200);
		expect(ok.json() as object).toEqual({ success: true });
		// B gets no session from approving.
		expect(ok.json().token).toBeUndefined();

		const first = await poll(res.requestId, res.pollSecret);
		expect(first.statusCode).toBe(200);
		const body = first.json();
		expect(body.status).toBe("approved");
		expect(body.token).toBeString();
		expect(body.user.id).toBe(user.id);
		expect(body.isNewUser).toBe(false);

		const app = await getApp();
		const me = await app.inject({
			method: "GET",
			url: "/api/me",
			headers: { authorization: `Bearer ${body.token}` },
		});
		expect(me.statusCode).toBe(200);

		const second = await poll(res.requestId, res.pollSecret);
		expect(second.json() as object).toEqual({ status: "consumed" });

		// The email token is spent: the link no longer signs in anywhere.
		expect((await verifyLink(token)).statusCode).toBe(401);
	});

	test("the session issued to A respects Remember me chosen on A", async () => {
		const user = createUser({ email: uniqueEmail() });
		const res = await requestLink(user.email, { rememberMe: true });
		await approve(res.requestId, lastLink().token);
		const body = (await poll(res.requestId, res.pollSecret)).json();
		const claims = jwt.decode(body.token) as { exp: number; iat: number };
		expect(claims.exp - claims.iat).toBe(30 * 24 * 3600);

		const short = await requestLink(user.email);
		await approve(short.requestId, lastLink().token);
		const shortBody = (await poll(short.requestId, short.pollSecret)).json();
		const shortClaims = jwt.decode(shortBody.token) as { exp: number; iat: number };
		expect(shortClaims.exp - shortClaims.iat).toBe(24 * 3600);
	});

	test("a wrong poll secret never receives the token", async () => {
		const user = createUser({ email: uniqueEmail() });
		const res = await requestLink(user.email);
		await approve(res.requestId, lastLink().token);

		const forged = crypto.randomBytes(32).toString("base64url");
		for (const secret of [forged, "", res.pollSecret.slice(0, -1), `${res.pollSecret}x`]) {
			const r = await poll(res.requestId, secret);
			expect(r.statusCode).toBe(404);
			expect(r.json().token).toBeUndefined();
		}
		// Unknown request id: the same answer.
		const unknown = await poll(crypto.randomUUID(), res.pollSecret);
		expect(unknown.statusCode).toBe(404);
		// The real device still collects it.
		const real = await poll(res.requestId, res.pollSecret);
		expect(real.json().token).toBeString();
	});

	test("deny: A sees denied, and the link stops working", async () => {
		const user = createUser({ email: uniqueEmail() });
		const res = await requestLink(user.email);
		const { token } = lastLink();
		const d = await deny(res.requestId, token);
		expect(d.statusCode).toBe(200);
		expect((await poll(res.requestId, res.pollSecret)).json() as object).toEqual({
			status: "denied",
			reason: "denied",
		});
		expect((await verifyLink(token)).statusCode).toBe(401);
		expect((await approve(res.requestId, token)).statusCode).toBe(401);
	});

	test("sign in here instead: B gets the session, A stops waiting", async () => {
		const user = createUser({ email: uniqueEmail() });
		const res = await requestLink(user.email);
		const { token } = lastLink();
		const h = await here(res.requestId, token);
		expect(h.statusCode).toBe(200);
		expect(h.json().token).toBeString();
		expect(h.json().user.id).toBe(user.id);
		expect((await poll(res.requestId, res.pollSecret)).json() as object).toEqual({
			status: "denied",
			reason: "elsewhere",
		});
		expect((await approve(res.requestId, token)).statusCode).toBe(401);
	});

	test("viewing the approval page has no side effects", async () => {
		const user = createUser({ email: uniqueEmail() });
		const res = await requestLink(user.email);
		const { token } = lastLink();
		const before = requestRow(res.requestId);
		for (let i = 0; i < 3; i++) expect((await info(res.requestId, token)).statusCode).toBe(200);
		expect(requestRow(res.requestId)).toEqual(before);
		expect(peekToken(token, "magic_link").valid).toBe(true);
		expect((await poll(res.requestId, res.pollSecret)).json() as object).toEqual({
			status: "pending",
		});

		// The page itself is a plain GET too (SPA fallback); nothing changes.
		const app = await getApp();
		await app.inject({
			method: "GET",
			url: lastLink().url.replace("http://localhost:5173", ""),
			headers: { "x-forwarded-for": ip() },
		});
		expect(requestRow(res.requestId)).toEqual(before);
		expect(peekToken(token, "magic_link").valid).toBe(true);
	});

	test("the approval page needs the link token", async () => {
		const user = createUser({ email: uniqueEmail() });
		const res = await requestLink(user.email);
		expect((await info(res.requestId, crypto.randomBytes(32).toString("hex"))).statusCode).toBe(
			404,
		);
		expect((await approve(res.requestId, crypto.randomBytes(32).toString("hex"))).statusCode).toBe(
			401,
		);
		expect(requestRow(res.requestId).status).toBe("pending");
	});

	test("replaying the approval fails, including concurrently", async () => {
		const user = createUser({ email: uniqueEmail() });
		const res = await requestLink(user.email);
		const { token } = lastLink();
		const results = await Promise.all([
			approve(res.requestId, token),
			approve(res.requestId, token),
		]);
		expect(results.map((r) => r.statusCode).sort()).toEqual([200, 401]);
		expect((await approve(res.requestId, token)).statusCode).toBe(401);
		expect((await here(res.requestId, token)).statusCode).toBe(401);
		// One delivery only.
		expect((await poll(res.requestId, res.pollSecret)).json().token).toBeString();
		expect((await poll(res.requestId, res.pollSecret)).json().token).toBeUndefined();
	});

	test("an expired request can't be approved", async () => {
		const user = createUser({ email: uniqueEmail() });
		const res = await requestLink(user.email);
		const { token } = lastLink();
		getDb()
			.prepare("UPDATE login_requests SET expires_at = ? WHERE id = ?")
			.run(new Date(Date.now() - 1000).toISOString(), res.requestId);
		expect((await info(res.requestId, token)).statusCode).toBe(404);
		expect((await approve(res.requestId, token)).statusCode).toBe(401);
		expect((await here(res.requestId, token)).statusCode).toBe(401);
		expect((await poll(res.requestId, res.pollSecret)).json() as object).toEqual({
			status: "expired",
		});
		// The rejected attempts did not spend the token.
		expect(peekToken(token, "magic_link").valid).toBe(true);
	});

	test("a request with no link behind it (deactivated, over the cap) can never be approved", async () => {
		const capped = uniqueEmail("capped");
		for (let i = 0; i < 3; i++) await requestLink(capped);
		const { token } = lastLink();
		const over = await requestLink(capped);
		expect(sent).toHaveLength(3);
		expect((await approve(over.requestId, token)).statusCode).toBe(401);
		expect((await poll(over.requestId, over.pollSecret)).json() as object).toEqual({
			status: "pending",
		});
	});

	test("a token can only approve its own request", async () => {
		const user = createUser({ email: uniqueEmail() });
		const a = await requestLink(user.email);
		const tokenA = lastLink().token;
		const b = await requestLink(user.email);
		expect((await approve(b.requestId, tokenA)).statusCode).toBe(401);
		expect(requestRow(b.requestId).status).toBe("pending");
		expect(requestRow(a.requestId).status).toBe("pending");
	});

	test("send another link: the old request expires and can't be approved", async () => {
		const user = createUser({ email: uniqueEmail() });
		const first = await requestLink(user.email);
		const firstToken = lastLink().token;
		const second = await requestLink(user.email, {
			replaces: { requestId: first.requestId, pollSecret: first.pollSecret },
		});
		expect((await poll(first.requestId, first.pollSecret)).json() as object).toEqual({
			status: "expired",
		});
		expect((await approve(first.requestId, firstToken)).statusCode).toBe(401);
		expect((await poll(second.requestId, second.pollSecret)).json() as object).toEqual({
			status: "pending",
		});
	});

	test("a forged replaces secret can't cancel someone else's request", async () => {
		const victim = await requestLink(createUser({ email: uniqueEmail() }).email);
		await requestLink(uniqueEmail(), {
			replaces: { requestId: victim.requestId, pollSecret: "nope" },
		});
		expect(requestRow(victim.requestId).status).toBe("pending");
	});

	test("deactivated between request and approval: nothing is delivered", async () => {
		const user = createUser({ email: uniqueEmail() });
		const res = await requestLink(user.email);
		getDb().prepare("UPDATE users SET is_active = 0 WHERE id = ?").run(user.id);
		const r = await approve(res.requestId, lastLink().token);
		expect(r.statusCode).toBe(401);
		expect((await poll(res.requestId, res.pollSecret)).json().token).toBeUndefined();
	});
});

describe("cross-device sign-up", () => {
	test("approving a sign-up link creates exactly one user with INITIAL_CREDITS + Free, delivered to A", async () => {
		const email = uniqueEmail("new.person");
		const res = await requestLink(email);
		expect(sent[0].subject).toContain("Create your");
		const { token } = lastLink();

		expect((await approve(res.requestId, token)).statusCode).toBe(200);
		const body = (await poll(res.requestId, res.pollSecret)).json();
		expect(body.status).toBe("approved");
		expect(body.isNewUser).toBe(true);

		const db = getDb();
		const users = db.prepare("SELECT id FROM users WHERE email = ?").all(email) as Array<{
			id: string;
		}>;
		expect(users).toHaveLength(1);
		expect(body.user.id).toBe(users[0].id);
		expect(creditBalance(users[0].id)).toBe(10);
		const subs = db
			.prepare(`SELECT sp.name FROM user_subscriptions us JOIN subscription_products sp ON sp.id = us.product_id
				WHERE us.user_id = ? AND us.status = 'active'`)
			.all(users[0].id) as Array<{ name: string }>;
		expect(subs.map((s) => s.name)).toEqual(["Free"]);

		// Replays don't make a second account.
		expect((await approve(res.requestId, token)).statusCode).toBe(401);
		expect(
			(db.prepare("SELECT COUNT(*) AS n FROM users WHERE email = ?").get(email) as { n: number }).n,
		).toBe(1);
	});

	test("sign in here instead on a sign-up link creates the account on B", async () => {
		const email = uniqueEmail("here");
		const res = await requestLink(email);
		const h = await here(res.requestId, lastLink().token);
		expect(h.statusCode).toBe(200);
		expect(h.json().isNewUser).toBe(true);
		expect(creditBalance(h.json().user.id)).toBe(10);
	});
});

describe("status endpoint rate limits", () => {
	test("per request: polling faster than the budget gets 429", async () => {
		const res = await requestLink(createUser({ email: uniqueEmail() }).email);
		const codes: number[] = [];
		for (let i = 0; i < 41; i++) codes.push((await poll(res.requestId, res.pollSecret)).statusCode);
		expect(codes.slice(0, 40).every((c) => c === 200)).toBe(true);
		expect(codes[40]).toBe(429);
	});

	test("per IP: one client can't sweep request ids", async () => {
		const client = "203.0.113.77";
		const codes: number[] = [];
		for (let i = 0; i < 61; i++)
			codes.push((await poll(crypto.randomUUID(), "x", client)).statusCode);
		expect(codes.slice(0, 60).every((c) => c === 404)).toBe(true);
		expect(codes[60]).toBe(429);
	});
});

describe("device summary", () => {
	test("summarizes common user agents without keeping them", () => {
		expect(summarizeUserAgent(IPHONE_SAFARI)).toBe("Safari on iPhone");
		expect(
			summarizeUserAgent(
				"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
			),
		).toBe("Chrome on Windows");
		expect(
			summarizeUserAgent(
				"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0",
			),
		).toBe("Edge on Windows");
		expect(
			summarizeUserAgent(
				"Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/129.0 Mobile/15E148 Safari/604.1",
			),
		).toBe("Chrome on iPhone");
		expect(
			summarizeUserAgent(
				"Mozilla/5.0 (Macintosh; Intel Mac OS X 14.6; rv:130.0) Gecko/20100101 Firefox/130.0",
			),
		).toBe("Firefox on Mac");
		expect(
			summarizeUserAgent(
				"Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36",
			),
		).toBe("Chrome on Android");
		expect(summarizeUserAgent(undefined)).toBe("Unknown browser");
		expect(summarizeUserAgent("curl/8.0")).toBe("Unknown browser");
	});
});

describe("device A polling schedule", () => {
	test("every 2s for a minute, then every 5s, stopping after the link expires", async () => {
		const { nextPollDelay } = await import("../src/hooks/useLoginRequestPoll");
		expect(nextPollDelay(0)).toBe(2000);
		expect(nextPollDelay(59_000)).toBe(2000);
		expect(nextPollDelay(61_000)).toBe(5000);
		expect(nextPollDelay(15 * 60_000)).toBe(5000);
		expect(nextPollDelay(16 * 60_000)).toBeNull();
	});

	test("poll results map to what the inbox step shows", async () => {
		const { waitStateFor } = await import("../src/hooks/useLoginRequestPoll");
		expect(waitStateFor({ status: "pending" }, false)).toBeNull();
		expect(waitStateFor({ status: "retry" }, false)).toBeNull();
		expect(waitStateFor({ status: "denied", reason: "denied" }, false)).toBe("denied");
		expect(waitStateFor({ status: "denied", reason: "elsewhere" }, false)).toBe("elsewhere");
		expect(waitStateFor({ status: "expired" }, false)).toBe("expired");
		expect(waitStateFor({ status: "consumed" }, true)).toBe("approved");
		expect(waitStateFor({ status: "consumed" }, false)).toBe("used");
	});
});
