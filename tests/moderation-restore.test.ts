import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { getDb } from "../server/db";
import { authHeader, createUser, getApp } from "./helpers";

// An image an admin removed must not come back through the owner's Trash.
describe("moderated images", () => {
	test("can't be restored by the owner and don't appear in their lists", async () => {
		const app = await getApp();
		const user = createUser();
		const id = randomUUID();
		getDb()
			.prepare(
				`INSERT INTO generations (id, prompt, model, image_path, user_id, deleted_at, moderated_at, moderation_reason)
				 VALUES (?, 'x', 'black-forest-labs/flux-2-dev', ?, ?, datetime('now'), datetime('now'), 'test')`,
			)
			.run(id, `${id}.png`, user.id);

		const restore = await app.inject({
			method: "PATCH",
			url: `/api/history/${id}`,
			headers: authHeader(user),
			payload: { deleted: false },
		});
		expect(restore.statusCode).toBe(403);
		expect(restore.json().code).toBe("MODERATED");

		const trash = await app.inject({ method: "GET", url: "/api/history?trash=true", headers: authHeader(user) });
		const ids = (trash.json().generations ?? []).map((g: { id: string }) => g.id);
		expect(ids).not.toContain(id);
	});
});
