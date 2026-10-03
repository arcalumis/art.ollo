import { describe, expect, test } from "bun:test";
import { authHeader, createUser, creditBalance, getApp } from "./helpers";

describe("harness", () => {
	test("health endpoint responds", async () => {
		const app = await getApp();
		const res = await app.inject({ method: "GET", url: "/api/health" });
		expect(res.statusCode).toBe(200);
	});

	test("a seeded user can call an authenticated route", async () => {
		const app = await getApp();
		const user = createUser({ credits: 5 });
		expect(creditBalance(user.id)).toBe(5);
		const res = await app.inject({ method: "GET", url: "/api/me", headers: authHeader(user) });
		expect(res.statusCode).toBe(200);
	});
});
