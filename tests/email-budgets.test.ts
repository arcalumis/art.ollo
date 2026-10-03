import "./inject-bun-fix";
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { getDb } from "../server/db";
import { type OutgoingEmail, reserveEmailSend, sendReceiptOnce, setEmailTransport } from "../server/services/email";
import { createUser } from "./helpers";

let sent: OutgoingEmail[] = [];
let fetchSpy: ReturnType<typeof spyOn>;

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
afterEach(() => {
	sent = [];
	Reflect.deleteProperty(process.env, "EMAIL_DAILY_CAP");
});

const addr = () => `r.${randomUUID().slice(0, 8)}@example.com`;

describe("email send budgets", () => {
	test("one IP can send at most 20 auth emails a day, across recipients", () => {
		const ip = "198.51.100.7";
		const results = Array.from({ length: 21 }, () => reserveEmailSend(addr(), "magic_link", ip));
		expect(results.slice(0, 20).every(Boolean)).toBe(true);
		expect(results[20]).toBe(false);
		// Other IPs are unaffected
		expect(reserveEmailSend(addr(), "magic_link", "198.51.100.8")).toBe(true);
	});

	test("an exhausted auth budget doesn't block receipts", () => {
		process.env.EMAIL_DAILY_CAP = "1";
		expect(reserveEmailSend(addr(), "magic_link", "198.51.100.9")).toBe(false);
		expect(reserveEmailSend(addr(), "receipt")).toBe(true);
	});

	test("auth floods to one address don't use up its receipt budget", () => {
		const to = addr();
		for (let i = 0; i < 3; i++) expect(reserveEmailSend(to, "magic_link", `203.0.113.${i + 1}`)).toBe(true);
		expect(reserveEmailSend(to, "magic_link", "203.0.113.9")).toBe(false);
		expect(reserveEmailSend(to, "receipt")).toBe(true);
	});
});

describe("receipt dedupe", () => {
	test("a receipt blocked by the send cap is not marked sent, so a later trigger retries it", async () => {
		const user = createUser();
		const db = getDb();
		const key = `receipt:in_${randomUUID().slice(0, 8)}`;
		const fill = db.prepare("INSERT INTO email_send_log (id, recipient, kind) VALUES (?, ?, 'receipt')");
		for (let i = 0; i < 20; i++) fill.run(randomUUID(), user.email);

		await sendReceiptOnce(user.id, key, { amountCents: 500, description: "Plan" });
		expect(sent).toHaveLength(0);
		expect(db.prepare("SELECT 1 FROM transactional_email_log WHERE dedupe_key = ?").get(key)).toBeNull();

		db.prepare("DELETE FROM email_send_log WHERE recipient = ?").run(user.email);
		await sendReceiptOnce(user.id, key, { amountCents: 500, description: "Plan" });
		expect(sent.map((m) => m.to)).toEqual([user.email]);

		// Sent once: a third trigger is a no-op
		await sendReceiptOnce(user.id, key, { amountCents: 500, description: "Plan" });
		expect(sent).toHaveLength(1);
	});
});
