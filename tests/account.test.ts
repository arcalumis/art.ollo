import "./inject-bun-fix";
import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { getDb } from "../server/db";
import { hashPassword } from "../server/routes/auth";
import { type OutgoingEmail, setEmailTransport } from "../server/services/email";
import * as stripeService from "../server/services/stripe";
import { type TestUser, authHeader, createUser, getApp } from "./helpers";

let sent: OutgoingEmail[] = [];
let fetchSpy: ReturnType<typeof spyOn>;
let ipSeq = 0;
const ip = () => {
	ipSeq++;
	return `192.0.${Math.floor(ipSeq / 250)}.${(ipSeq % 250) + 1}`;
};

beforeAll(() => {
	fetchSpy = spyOn(globalThis, "fetch").mockImplementation((() => {
		throw new Error("network access in tests");
	}) as unknown as typeof fetch);
	setEmailTransport(async (mail) => {
		sent.push(mail);
		return { success: true };
	});
});
afterAll(() => {
	fetchSpy.mockRestore();
	setEmailTransport(null);
});
beforeEach(() => {
	sent = [];
});

async function call(
	method: "GET" | "POST" | "PUT" | "PATCH",
	url: string,
	user?: TestUser | null,
	payload?: Record<string, unknown>,
	token?: string,
) {
	const app = await getApp();
	const headers: Record<string, string> = user ? authHeader(user) : {};
	if (token) headers.authorization = `Bearer ${token}`;
	return app.inject({ method, url, headers, payload, remoteAddress: ip() });
}

const tokenFrom = (mail: OutgoingEmail) => {
	const m = mail.devLink?.match(/confirmEmail=([a-f0-9]+)/);
	if (!m) throw new Error("no token in email");
	return m[1];
};

const reauthTokenFrom = (mail: OutgoingEmail) => {
	const m = mail.devLink?.match(/reauth=([a-f0-9]+)/);
	if (!m) throw new Error("no re-auth token in email");
	return m[1];
};

/** Confirm it's you via a link to the current address; returns a sudo token. */
async function sudoFor(user: TestUser): Promise<string> {
	const before = sent.length;
	const res = await call("POST", "/api/account/reauth", user, { method: "email" });
	expect(res.statusCode).toBe(200);
	const mail = sent[before];
	expect(mail.to).toBe(user.email);
	const confirm = await call("POST", "/api/account/reauth/confirm", user, { token: reauthTokenFrom(mail) });
	expect(confirm.statusCode).toBe(200);
	sent.splice(before, 1);
	return confirm.json().sudoToken;
}

describe("account: auth required", () => {
	test("every account endpoint rejects a missing session", async () => {
		const cases: Array<["GET" | "POST" | "PUT" | "PATCH", string]> = [
			["GET", "/api/account"],
			["PATCH", "/api/account/profile"],
			["POST", "/api/account/email"],
			["POST", "/api/account/reauth"],
			["POST", "/api/account/reauth/confirm"],
			["PUT", "/api/account/password"],
			["GET", "/api/account/export"],
			["POST", "/api/account/delete"],
		];
		for (const [method, url] of cases) {
			const res = await call(method, url, null, {});
			expect(res.statusCode).toBe(401);
		}
	});
});

describe("account: profile", () => {
	test("returns the profile without the password hash", async () => {
		const user = createUser();
		const res = await call("GET", "/api/account", user);
		expect(res.statusCode).toBe(200);
		expect(res.json()).toMatchObject({
			username: user.username,
			email: user.email,
			hasPassword: false,
		});
		expect(res.body).not.toContain("password_hash");
	});

	test("changes the username, refusing taken and reserved names", async () => {
		const a = createUser();
		const b = createUser();
		expect(
			(await call("PATCH", "/api/account/profile", a, { username: b.username.toUpperCase() }))
				.statusCode,
		).toBe(409);
		expect((await call("PATCH", "/api/account/profile", a, { username: "admin" })).statusCode).toBe(
			400,
		);
		expect(
			(await call("PATCH", "/api/account/profile", a, { username: "no spaces" })).statusCode,
		).toBe(400);
		const fresh = `crow_${randomUUID().slice(0, 6)}`;
		const ok = await call("PATCH", "/api/account/profile", a, { username: fresh });
		expect(ok.statusCode).toBe(200);
		expect((await call("GET", "/api/account", a)).json().username).toBe(fresh);
	});
});

describe("account: change email", () => {
	test("nothing changes until the link sent to the NEW address is opened", async () => {
		const user = createUser();
		const sudoToken = await sudoFor(user);
		const next = `new.${randomUUID().slice(0, 8)}@example.com`;
		const res = await call("POST", "/api/account/email", user, { email: next, sudoToken });
		expect(res.statusCode).toBe(200);
		expect(sent).toHaveLength(1);
		expect(sent[0].to).toBe(next);

		const before = (await call("GET", "/api/account", user)).json();
		expect(before.email).toBe(user.email);
		expect(before.pendingEmail).toBe(next);

		const confirm = await call("POST", "/api/account/email/confirm", user, {
			token: tokenFrom(sent[0]),
		});
		expect(confirm.statusCode).toBe(200);
		// Every session is signed out; the acting one gets a fresh token.
		expect((await call("GET", "/api/account", user)).statusCode).toBe(401);
		const fresh = confirm.json().token;
		expect(typeof fresh).toBe("string");
		const after = (await call("GET", "/api/account", null, undefined, fresh)).json();
		expect(after.email).toBe(next);
		expect(after.pendingEmail).toBeNull();

		// The OLD address is told, with a way to get help.
		const notice = sent.find((m) => m.to === user.email);
		expect(notice?.subject).toContain("email was changed");
		expect(notice?.html).toContain("support@matahari.dev");
		expect(notice?.html).toContain(next);

		// A link works once.
		const replay = await call("POST", "/api/account/email/confirm", null, {
			token: tokenFrom(sent[0]),
		});
		expect(replay.statusCode).toBe(400);
	});

	test("confirming without the owner's session changes the email but returns no token", async () => {
		const user = createUser();
		const sudoToken = await sudoFor(user);
		const next = `new.${randomUUID().slice(0, 8)}@example.com`;
		await call("POST", "/api/account/email", user, { email: next, sudoToken });
		const other = createUser();
		const confirm = await call("POST", "/api/account/email/confirm", other, { token: tokenFrom(sent[0]) });
		expect(confirm.statusCode).toBe(200);
		expect(confirm.json().token).toBeUndefined();
		expect((await call("GET", "/api/account", user)).statusCode).toBe(401);
		expect((await call("GET", "/api/account", other)).statusCode).toBe(200);
	});

	test("a session alone can't start an email change", async () => {
		const user = createUser();
		const res = await call("POST", "/api/account/email", user, {
			email: `x.${randomUUID().slice(0, 8)}@example.com`,
		});
		expect(res.statusCode).toBe(403);
		expect(res.json().code).toBe("REAUTH_REQUIRED");
		expect(res.json().methods).toEqual(["email"]);
		expect(sent).toHaveLength(0);
		// A made-up sudo token doesn't help either.
		const fake = await call("POST", "/api/account/email", user, {
			email: `x.${randomUUID().slice(0, 8)}@example.com`,
			sudoToken: "a".repeat(64),
		});
		expect(fake.statusCode).toBe(403);
	});

	test("an account with a password can confirm with it", async () => {
		const user = createUser();
		getDb().prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hashPassword("OldPass123"), user.id);
		const next = `pw.${randomUUID().slice(0, 8)}@example.com`;
		const wrong = await call("POST", "/api/account/email", user, { email: next, currentPassword: "Nope12345" });
		expect(wrong.statusCode).toBe(403);
		expect(wrong.json().code).toBe("WRONG_PASSWORD");
		const ok = await call("POST", "/api/account/email", user, { email: next, currentPassword: "OldPass123" });
		expect(ok.statusCode).toBe(200);
		expect(sent.map((m) => m.to)).toEqual([next]);
	});

	test("a bad token is refused", async () => {
		const res = await call("POST", "/api/account/email/confirm", null, { token: "f".repeat(64) });
		expect(res.statusCode).toBe(400);
	});

	test("only the newest request's link works", async () => {
		const user = createUser();
		const sudoToken = await sudoFor(user);
		await call("POST", "/api/account/email", user, {
			email: `a.${randomUUID().slice(0, 8)}@example.com`,
			sudoToken,
		});
		await call("POST", "/api/account/email", user, {
			email: `b.${randomUUID().slice(0, 8)}@example.com`,
			sudoToken,
		});
		expect(sent).toHaveLength(2);
		expect(
			(await call("POST", "/api/account/email/confirm", null, { token: tokenFrom(sent[0]) }))
				.statusCode,
		).toBe(400);
		expect(
			(await call("POST", "/api/account/email/confirm", null, { token: tokenFrom(sent[1]) }))
				.statusCode,
		).toBe(200);
	});

	test("an address another account uses gets the same reply but no email", async () => {
		const user = createUser();
		const other = createUser();
		const sudoToken = await sudoFor(user);
		const res = await call("POST", "/api/account/email", user, { email: other.email, sudoToken });
		expect(res.statusCode).toBe(200);
		expect(sent).toHaveLength(0);
		// Same pending state as a free address
		expect((await call("GET", "/api/account", user)).json().pendingEmail).toBe(other.email);
	});

	test("an address in use hits the send cap exactly like a free one", async () => {
		const owner = createUser();
		const statuses: number[] = [];
		for (let i = 0; i < 4; i++) {
			const user = createUser();
			const sudoToken = await sudoFor(user);
			statuses.push(
				(await call("POST", "/api/account/email", user, { email: owner.email, sudoToken })).statusCode,
			);
		}
		expect(statuses).toEqual([200, 200, 200, 429]);
		expect(sent).toHaveLength(0);
	});

	test("respects the per-recipient send cap", async () => {
		const target = `capped.${randomUUID().slice(0, 8)}@example.com`;
		const statuses: number[] = [];
		for (let i = 0; i < 4; i++) {
			const user = createUser();
			const sudoToken = await sudoFor(user);
			statuses.push((await call("POST", "/api/account/email", user, { email: target, sudoToken })).statusCode);
		}
		expect(statuses.slice(0, 3)).toEqual([200, 200, 200]);
		expect(statuses[3]).toBe(429);
	});

	test("is rate limited per client", async () => {
		const user = createUser();
		const app = await getApp();
		const statuses: number[] = [];
		for (let i = 0; i < 7; i++) {
			const res = await app.inject({
				method: "POST",
				url: "/api/account/email",
				headers: authHeader(user),
				payload: { email: "not-an-email" },
				remoteAddress: "192.0.2.250",
			});
			statuses.push(res.statusCode);
		}
		expect(statuses).toContain(429);
	});
});

describe("account: password", () => {
	test("a magic-link account can set a password; other sessions are signed out", async () => {
		const user = createUser();
		const blocked = await call("PUT", "/api/account/password", user, { newPassword: "Bronze1234" });
		expect(blocked.statusCode).toBe(403);
		expect(blocked.json().code).toBe("REAUTH_REQUIRED");
		const sudoToken = await sudoFor(user);
		const res = await call("PUT", "/api/account/password", user, { newPassword: "Bronze1234", sudoToken });
		expect(res.statusCode).toBe(200);
		const { token } = res.json();
		expect(typeof token).toBe("string");
		// The old token is revoked, the new one works.
		expect((await call("GET", "/api/account", user)).statusCode).toBe(401);
		const me = await call("GET", "/api/account", null, undefined, token);
		expect(me.statusCode).toBe(200);
		expect(me.json().hasPassword).toBe(true);
	});

	test("changing an existing password needs the current one", async () => {
		const user = createUser();
		getDb()
			.prepare("UPDATE users SET password_hash = ? WHERE id = ?")
			.run(hashPassword("OldPass123"), user.id);
		expect(
			(await call("PUT", "/api/account/password", user, { newPassword: "NewPass123" })).statusCode,
		).toBe(403);
		expect(
			(
				await call("PUT", "/api/account/password", user, {
					currentPassword: "wrong",
					newPassword: "NewPass123",
				})
			).statusCode,
		).toBe(403);
		expect(
			(
				await call("PUT", "/api/account/password", user, {
					currentPassword: "OldPass123",
					newPassword: "weak",
				})
			).statusCode,
		).toBe(400);
		const ok = await call("PUT", "/api/account/password", user, {
			currentPassword: "OldPass123",
			newPassword: "NewPass123",
		});
		expect(ok.statusCode).toBe(200);
	});
});

describe("account: re-authentication", () => {
	test("the emailed link only works for the same account's session, once", async () => {
		const user = createUser();
		const other = createUser();
		await call("POST", "/api/account/reauth", user, { method: "email" });
		const token = reauthTokenFrom(sent[0]);
		expect((await call("POST", "/api/account/reauth/confirm", other, { token })).statusCode).toBe(400);
		const ok = await call("POST", "/api/account/reauth/confirm", user, { token });
		expect(ok.statusCode).toBe(200);
		expect(typeof ok.json().sudoToken).toBe("string");
		expect((await call("POST", "/api/account/reauth/confirm", user, { token })).statusCode).toBe(400);
	});

	test("a sudo token is bound to its account and expires", async () => {
		const user = createUser();
		const other = createUser();
		const sudoToken = await sudoFor(user);
		const stolen = await call("PUT", "/api/account/password", other, { newPassword: "Bronze1234", sudoToken });
		expect(stolen.statusCode).toBe(403);
		getDb().prepare("UPDATE account_reauth_tokens SET expires_at = ? WHERE user_id = ?").run(
			new Date(Date.now() - 1000).toISOString(),
			user.id,
		);
		const expired = await call("PUT", "/api/account/password", user, { newPassword: "Bronze1234", sudoToken });
		expect(expired.statusCode).toBe(403);
	});

	test("password re-auth issues a sudo token; methods the account lacks are refused", async () => {
		const user = createUser();
		expect((await call("POST", "/api/account/reauth", user, { method: "password", password: "x" })).statusCode).toBe(400);
		expect((await call("POST", "/api/account/reauth", user, { method: "wallet" })).statusCode).toBe(400);
		getDb().prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hashPassword("OldPass123"), user.id);
		expect(
			(await call("POST", "/api/account/reauth", user, { method: "password", password: "Wrong1234" })).statusCode,
		).toBe(403);
		const ok = await call("POST", "/api/account/reauth", user, { method: "password", password: "OldPass123" });
		expect(ok.statusCode).toBe(200);
		const next = `s.${randomUUID().slice(0, 8)}@example.com`;
		expect(
			(await call("POST", "/api/account/email", user, { email: next, sudoToken: ok.json().sudoToken })).statusCode,
		).toBe(200);
	});

	test("a wallet-only account re-authenticates with a signed challenge", async () => {
		const nacl = (await import("tweetnacl")).default;
		const bs58 = (await import("bs58")).default;
		const { Keypair } = await import("@solana/web3.js");
		const kp = Keypair.generate();
		const user = createUser();
		getDb()
			.prepare("UPDATE users SET email = NULL, wallet_address = ? WHERE id = ?")
			.run(kp.publicKey.toBase58(), user.id);
		const blocked = await call("POST", "/api/account/email", user, { email: `w.${randomUUID().slice(0, 8)}@example.com` });
		expect(blocked.json().methods).toEqual(["wallet"]);

		const app = await getApp();
		const challenge = (
			await app.inject({
				method: "POST",
				url: "/api/auth/wallet/challenge",
				payload: { walletAddress: kp.publicKey.toBase58() },
				remoteAddress: ip(),
			})
		).json();
		const signature = bs58.encode(nacl.sign.detached(new TextEncoder().encode(challenge.message), kp.secretKey));
		const bad = await call("POST", "/api/account/reauth", user, {
			method: "wallet",
			challenge: challenge.challenge,
			signature: bs58.encode(new Uint8Array(64)),
		});
		expect(bad.statusCode).toBe(401);
		const ok = await call("POST", "/api/account/reauth", user, {
			method: "wallet",
			challenge: challenge.challenge,
			signature,
		});
		expect(ok.statusCode).toBe(200);
		// Single use
		const replay = await call("POST", "/api/account/reauth", user, {
			method: "wallet",
			challenge: challenge.challenge,
			signature,
		});
		expect(replay.statusCode).toBe(401);
	});
});

describe("account: export", () => {
	test("downloads prompts and absolute image URLs, only your own", async () => {
		const user = createUser();
		const other = createUser();
		const db = getDb();
		const mine = randomUUID();
		db.prepare(
			"INSERT INTO generations (id, prompt, model, image_path, parameters, user_id) VALUES (?, 'my crow', 'm', ?, ?, ?)",
		).run(mine, `${mine}.png`, JSON.stringify({ creditsCharged: 2 }), user.id);
		db.prepare(
			"INSERT INTO generations (id, prompt, model, image_path, user_id) VALUES (?, 'their crow', 'm', 'x.png', ?)",
		).run(randomUUID(), other.id);
		const res = await call("GET", "/api/account/export", user);
		expect(res.statusCode).toBe(200);
		expect(res.headers["content-disposition"]).toContain("attachment");
		const body = JSON.parse(res.body);
		expect(body.images).toHaveLength(1);
		expect(body.images[0]).toMatchObject({ prompt: "my crow", creditsCharged: 2 });
		expect(body.images[0].imageUrls[0]).toBe(`http://localhost:5173/images/${mine}.png`);
		expect(res.body).not.toContain("their crow");
	});
});

describe("account: delete", () => {
	test("needs the username typed exactly", async () => {
		const user = createUser();
		const res = await call("POST", "/api/account/delete", user, { confirm: "yes" });
		expect(res.statusCode).toBe(400);
		expect(res.json().code).toBe("CONFIRMATION_MISMATCH");
		expect((await call("GET", "/api/account", user)).statusCode).toBe(200);
	});

	test("soft-deletes, revokes every session, frees the email and queues images for purge", async () => {
		const user = createUser();
		const db = getDb();
		const genId = randomUUID();
		db.prepare(
			"INSERT INTO generations (id, prompt, model, image_path, user_id) VALUES (?, 'p', 'm', ?, ?)",
		).run(genId, `${genId}.png`, user.id);
		db.prepare("INSERT INTO share_links (slug, generation_id, user_id) VALUES (?, ?, ?)").run(
			`slug${randomUUID().replaceAll("-", "")}`,
			genId,
			user.id,
		);
		const res = await call("POST", "/api/account/delete", user, { confirm: user.username });
		expect(res.statusCode).toBe(200);

		expect((await call("GET", "/api/account", user)).statusCode).toBe(401);
		const row = db
			.prepare("SELECT is_active, deleted_at, email, username FROM users WHERE id = ?")
			.get(user.id) as {
			is_active: number;
			deleted_at: string | null;
			email: string | null;
			username: string;
		};
		expect(row.is_active).toBe(0);
		expect(row.deleted_at).not.toBeNull();
		expect(row.email).toBeNull();
		expect(row.username).toStartWith("deleted-");
		const gen = db
			.prepare(
				"SELECT deleted_at < datetime('now', '-30 days') AS due FROM generations WHERE id = ?",
			)
			.get(genId) as { due: number };
		expect(gen.due).toBe(1);
		const live = db
			.prepare("SELECT COUNT(*) AS n FROM share_links WHERE user_id = ? AND revoked_at IS NULL")
			.get(user.id) as {
			n: number;
		};
		expect(live.n).toBe(0);
	});

	test("cancels a live Stripe subscription first, and refuses if that fails", async () => {
		const user = createUser();
		const db = getDb();
		const free = db.prepare("SELECT id FROM subscription_products WHERE name = 'Free'").get() as {
			id: string;
		};
		db.prepare(
			"INSERT INTO user_subscriptions (id, user_id, product_id, stripe_subscription_id, status) VALUES (?, ?, ?, 'sub_test_1', 'active')",
		).run(randomUUID(), user.id, free.id);

		const cancel = spyOn(stripeService, "cancelSubscription").mockImplementation(async () => false);
		const refused = await call("POST", "/api/account/delete", user, { confirm: user.username });
		expect(refused.statusCode).toBe(502);
		expect((await call("GET", "/api/account", user)).statusCode).toBe(200);

		cancel.mockImplementation(async () => true);
		const ok = await call("POST", "/api/account/delete", user, { confirm: user.username });
		expect(ok.statusCode).toBe(200);
		expect(cancel).toHaveBeenCalledWith("sub_test_1");
		const sub = db
			.prepare("SELECT status FROM user_subscriptions WHERE user_id = ?")
			.get(user.id) as { status: string };
		expect(sub.status).toBe("canceled");
		cancel.mockRestore();
	});

	test("admin accounts can't self-delete", async () => {
		const admin = createUser({ isAdmin: true });
		const res = await call("POST", "/api/account/delete", admin, { confirm: admin.username });
		expect(res.statusCode).toBe(403);
	});
});
