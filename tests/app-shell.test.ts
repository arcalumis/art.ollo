import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { getDb } from "../server/db";
import { libraryPath, seriesPath, viewFromPath } from "../src/components/shell/routes";
import { type QueueEntry, buildToolRequest, queueReducer } from "../src/hooks/useGenerationQueue";
import { authHeader, createUser, getApp } from "./helpers";

function entry(id: string, extra: Partial<QueueEntry> = {}): QueueEntry {
	return {
		id,
		prompt: `prompt ${id}`,
		model: "black-forest-labs/flux-2-dev",
		status: "queued",
		createdAt: "2026-10-01T00:00:00.000Z",
		request: { prompt: `prompt ${id}` },
		...extra,
	};
}

describe("generation queue", () => {
	test("adds newest first and tracks each item on its own", () => {
		let q = queueReducer([], { type: "add", entry: entry("a") });
		q = queueReducer(q, { type: "add", entry: entry("b") });
		expect(q.map((e) => e.id)).toEqual(["b", "a"]);

		q = queueReducer(q, { type: "start", id: "a", startedAt: "t", estimatedDuration: 33 });
		q = queueReducer(q, {
			type: "fail",
			id: "b",
			failure: { errorCode: "INSUFFICIENT_CREDITS", creditsNeeded: 4, balanceAtFailure: 1 },
		});
		const [b, a] = q;
		expect(a.status).toBe("generating");
		expect(a.estimatedDuration).toBe(33);
		expect(a.errorCode).toBeUndefined();
		expect(b.status).toBe("failed");
		expect(b.errorCode).toBe("INSUFFICIENT_CREDITS");
		expect(b.creditsNeeded).toBe(4);
	});

	test("retry clears that item's error and keeps its request", () => {
		let q = [
			entry("a", { status: "failed", errorCode: "GENERATION_TIMEOUT", error: "x" }),
			entry("b"),
		];
		q = queueReducer(q, { type: "retry", id: "a", createdAt: "later" });
		expect(q[0]).toMatchObject({
			status: "queued",
			createdAt: "later",
			request: { prompt: "prompt a" },
		});
		expect(q[0].errorCode).toBeUndefined();
		expect(q[0].error).toBeUndefined();
		expect(q[1]).toBe(q[1]);
	});

	test("dismiss removes only that item; unknown ids change nothing", () => {
		const q = [entry("a"), entry("b")];
		expect(queueReducer(q, { type: "remove", id: "a" }).map((e) => e.id)).toEqual(["b"]);
		expect(queueReducer(q, { type: "remove", id: "zzz" })).toEqual(q);
	});

	test("upscale tool request re-renders the image at 4K in the same series", () => {
		const req = buildToolRequest(
			{ id: "g1", imageUrl: "/images/a.png", prompt: "a crow" },
			"upscale",
			{ threadId: "t1", aspectRatio: "1:1", outputFormat: "png" },
		);
		expect(req).toEqual({
			prompt: "a crow",
			model: "black-forest-labs/flux-2-dev",
			imageInputs: ["/images/a.png"],
			aspectRatio: "1:1",
			resolution: "4K",
			outputFormat: "png",
			threadId: "t1",
		});
		expect(buildToolRequest({ id: "g2", prompt: "no image" }, "upscale", {})).toBeNull();
	});
});

describe("app routes", () => {
	test("paths map to screens", () => {
		expect(viewFromPath("/create")).toEqual({ kind: "create" });
		expect(viewFromPath("/create/abc-1")).toEqual({ kind: "create", threadId: "abc-1" });
		expect(viewFromPath("/create/abc-1/")).toEqual({ kind: "create", threadId: "abc-1" });
		expect(viewFromPath("/gallery")).toEqual({ kind: "gallery", library: "all" });
		expect(viewFromPath("/gallery/trash")).toEqual({ kind: "gallery", library: "trash" });
		expect(viewFromPath("/gallery/archive")).toEqual({ kind: "gallery", library: "archive" });
		expect(viewFromPath("/billing")).toEqual({ kind: "billing" });
		expect(viewFromPath("/settings")).toEqual({ kind: "settings" });
		expect(viewFromPath("/gallery/nope")).toBeNull();
		expect(viewFromPath("/pricing")).toBeNull();
		expect(viewFromPath("/")).toBeNull();
	});

	test("path builders round-trip", () => {
		expect(viewFromPath(seriesPath("a b"))).toEqual({ kind: "create", threadId: "a b" });
		expect(libraryPath("all")).toBe("/gallery");
		expect(libraryPath("trash")).toBe("/gallery/trash");
	});
});

describe("GET /api/threads", () => {
	test("each series carries its newest visible image as the cover", async () => {
		const app = await getApp();
		const user = createUser();
		const db = getDb();
		const threadId = randomUUID();
		const empty = randomUUID();
		db.prepare("INSERT INTO threads (id, user_id, title) VALUES (?, ?, ?)").run(
			threadId,
			user.id,
			"Crows",
		);
		db.prepare("INSERT INTO threads (id, user_id, title) VALUES (?, ?, ?)").run(
			empty,
			user.id,
			"Empty",
		);
		const insert = db.prepare(
			"INSERT INTO generations (id, prompt, model, image_path, user_id, thread_id, created_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
		);
		insert.run(randomUUID(), "old", "m", "old.png", user.id, threadId, "2026-01-01 10:00:00", null);
		insert.run(randomUUID(), "new", "m", "new.png", user.id, threadId, "2026-01-02 10:00:00", null);
		insert.run(
			randomUUID(),
			"trashed",
			"m",
			"trashed.png",
			user.id,
			threadId,
			"2026-01-03 10:00:00",
			"2026-01-03 11:00:00",
		);

		const res = await app.inject({ method: "GET", url: "/api/threads", headers: authHeader(user) });
		expect(res.statusCode).toBe(200);
		const { threads } = res.json() as { threads: { id: string; coverImageUrl?: string }[] };
		expect(threads.find((t) => t.id === threadId)?.coverImageUrl).toBe("/images/new.png");
		expect(threads.find((t) => t.id === empty)?.coverImageUrl).toBeUndefined();
	});
});
