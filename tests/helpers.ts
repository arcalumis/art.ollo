import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../server/app";
import { getDb } from "../server/db";
import { signToken } from "../server/middleware/auth";

let app: FastifyInstance | null = null;

/** One in-process app per test file, backed by the :memory: DB from tests/setup.ts. */
export async function getApp(): Promise<FastifyInstance> {
	if (!app) {
		app = await buildApp({ logger: false });
		await app.ready();
	}
	return app;
}

export interface TestUser {
	id: string;
	username: string;
	email: string;
	token: string;
}

/** Insert a user with an optional starting credit balance and return a bearer token. */
export function createUser(opts: { credits?: number; isAdmin?: boolean; email?: string } = {}): TestUser {
	const db = getDb();
	const id = randomUUID();
	const username = `user_${id.slice(0, 8)}`;
	const email = opts.email ?? `${username}@example.com`;
	db.prepare("INSERT INTO users (id, username, password_hash, is_admin, email) VALUES (?, ?, ?, ?, ?)").run(
		id,
		username,
		"x",
		opts.isAdmin ? 1 : 0,
		email,
	);
	if (opts.credits) {
		db.prepare("INSERT INTO user_credits (id, user_id, amount, credit_type, reason) VALUES (?, ?, ?, ?, ?)").run(
			randomUUID(),
			id,
			opts.credits,
			"bonus",
			"test grant",
		);
	}
	const token = signToken({ userId: id, username, isAdmin: !!opts.isAdmin });
	return { id, username, email, token };
}

export function authHeader(user: TestUser): Record<string, string> {
	return { authorization: `Bearer ${user.token}` };
}

export function creditBalance(userId: string): number {
	const row = getDb()
		.prepare("SELECT COALESCE(SUM(amount), 0) AS balance FROM user_credits WHERE user_id = ?")
		.get(userId) as { balance: number };
	return row.balance;
}
