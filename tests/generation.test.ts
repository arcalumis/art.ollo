import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { getDb } from "../server/db";
import { encrypt } from "../server/services/encryption";
import { __testing, resolveImageInputPath } from "../server/services/replicate";
import { assignFree, fake, installFakes, nextIp, PNG_BYTES, seedUpload } from "./generation-fakes";
import { authHeader, createUser, creditBalance, getApp, type TestUser } from "./helpers";

const SCHNELL = "black-forest-labs/flux-schnell"; // 1 credit, native num_outputs
const DEV = "black-forest-labs/flux-dev"; // 2 credits
const PRO = "black-forest-labs/flux-1.1-pro"; // 3 credits, no num_outputs (parallel calls)
const FLUX2_DEV = "black-forest-labs/flux-2-dev"; // 2 credits, image inputs
const REDUX_SCHNELL = "black-forest-labs/flux-redux-schnell"; // 2 credits, variation
const REDUX_DEV = "black-forest-labs/flux-redux-dev"; // 5 credits, variation

let imagesDir: string;

beforeAll(() => {
	({ imagesDir } = installFakes());
});

beforeEach(() => {
	fake.reset();
	__testing.setTiming({ pollIntervalMs: 5, timeoutMs: 2_000 });
});

async function generate(user: TestUser, body: Record<string, unknown>) {
	const app = await getApp();
	return app.inject({
		method: "POST",
		url: "/api/generate",
		headers: authHeader(user),
		payload: body,
		remoteAddress: nextIp(),
	});
}

function ledger(userId: string) {
	return getDb()
		.prepare("SELECT credit_type, amount FROM user_credits WHERE user_id = ? ORDER BY rowid")
		.all(userId) as { credit_type: string; amount: number }[];
}

describe("C2: credits are reserved atomically", () => {
	test("20 concurrent generations on 1 credit: exactly one succeeds, balance never negative", async () => {
		const user = createUser({ credits: 1 });
		fake.reset({ kind: "succeed", delayMs: 50 });

		const responses = await Promise.all(
			Array.from({ length: 20 }, () => generate(user, { prompt: "a cat", model: SCHNELL })),
		);

		const ok = responses.filter((r) => r.statusCode === 200);
		const rejected = responses.filter((r) => r.statusCode === 402);
		expect(ok.length).toBe(1);
		expect(rejected.length).toBe(19);
		for (const r of rejected) expect(r.json().code).toBe("INSUFFICIENT_CREDITS");
		expect(fake.creates).toBe(1);
		expect(creditBalance(user.id)).toBe(0);
		expect(ledger(user.id).filter((l) => l.credit_type === "used")).toHaveLength(1);
	});
});

describe("C1: image inputs are restricted to the user's own files", () => {
	test("traversal payloads and foreign uploads are rejected before anything is read", async () => {
		const user = createUser({ credits: 50 });
		const other = createUser({ credits: 0 });
		const foreignUpload = seedUpload(other.id);

		const payloads = [
			"/uploads/../../etc/passwd",
			"/images/../data/generations.db",
			"/uploads/../../proc/self/environ",
			"http://evil.example/uploads/../../etc/passwd",
			"/uploads/..%2F..%2Fetc%2Fpasswd",
			"/etc/passwd",
			"/images/does-not-exist.png",
			foreignUpload,
		];
		for (const input of payloads) {
			const res = await generate(user, { prompt: "x", model: FLUX2_DEV, imageInputs: [input] });
			expect(res.statusCode).toBe(400);
			expect(res.json().code).toBe("INVALID_IMAGE_INPUT");
		}
		expect(fake.creates).toBe(0);
		expect(creditBalance(user.id)).toBe(50);
	});

	test("defense in depth: replicate.ts refuses paths outside its directories", () => {
		for (const bad of [
			"/uploads/../../etc/passwd",
			"/images/../data/generations.db",
			"/uploads/sub/dir.png",
			"/uploads/evil.sh",
			"/other/x.png",
			"relative.png",
		]) {
			expect(() => resolveImageInputPath(bad)).toThrow();
		}
		expect(resolveImageInputPath("/images/abc-123.png")).toBe(path.join(imagesDir, "abc-123.png"));
	});

	test("trashed uploads are rejected", async () => {
		const user = createUser({ credits: 10 });
		const ref = seedUpload(user.id);
		getDb().prepare("UPDATE uploads SET deleted_at = datetime('now') WHERE filename = ?").run(path.basename(ref));
		const res = await generate(user, { prompt: "x", model: FLUX2_DEV, imageInputs: [ref] });
		expect(res.statusCode).toBe(400);
	});

	test("own uploads, own generated images and own grid images are accepted", async () => {
		const user = createUser({ credits: 50 });
		const upload = seedUpload(user.id);

		// A 4-up grid generation owned by the user.
		const grid = await generate(user, { prompt: "grid", model: SCHNELL, numOutputs: 4 });
		expect(grid.statusCode).toBe(200);
		const images = grid.json().images as { url: string }[];
		expect(images).toHaveLength(4);

		const res = await generate(user, {
			prompt: "combine",
			model: FLUX2_DEV,
			imageInputs: [upload, images[0].url, `http://localhost:3001${images[3].url}`],
		});
		expect(res.statusCode).toBe(200);
		const input = fake.inputs.at(-1) as { input_images: string[] };
		expect(input.input_images).toHaveLength(3);
		for (const uri of input.input_images) expect(uri.startsWith("data:image/png;base64,")).toBe(true);
	});

	test("image count is capped at the model's maxImages", async () => {
		const user = createUser({ credits: 10 });
		const refs = [seedUpload(user.id), seedUpload(user.id)];
		const res = await generate(user, { model: REDUX_SCHNELL, imageInputs: refs });
		expect(res.statusCode).toBe(400);
		const noImages = await generate(user, { prompt: "x", model: SCHNELL, imageInputs: [refs[0]] });
		expect(noImages.statusCode).toBe(400);
	});
});

describe("refunds", () => {
	test("Replicate failure refunds the reservation", async () => {
		const user = createUser({ credits: 5 });
		fake.reset({ kind: "fail" });
		const res = await generate(user, { prompt: "boom", model: DEV });
		expect(res.statusCode).toBe(500);
		expect(res.json().code).toBe("GENERATION_FAILED");
		expect(creditBalance(user.id)).toBe(5);
		const types = ledger(user.id).map((l) => `${l.credit_type}:${l.amount}`);
		expect(types).toEqual(["bonus:5", "used:-2", "refund:2"]);
	});

	test("timeout cancels the prediction and refunds", async () => {
		const user = createUser({ credits: 5 });
		fake.reset({ kind: "hang" });
		__testing.setTiming({ pollIntervalMs: 5, timeoutMs: 80 });
		const res = await generate(user, { prompt: "slow", model: DEV });
		expect(res.statusCode).toBe(504);
		expect(res.json().code).toBe("GENERATION_TIMEOUT");
		expect(fake.cancels).toBe(1);
		expect(creditBalance(user.id)).toBe(5);
	});

	test("canceled prediction refunds instead of hanging", async () => {
		const user = createUser({ credits: 5 });
		fake.reset({ kind: "cancel" });
		const res = await generate(user, { prompt: "nope", model: DEV });
		expect(res.statusCode).toBe(502);
		expect(res.json().code).toBe("GENERATION_CANCELED");
		expect(creditBalance(user.id)).toBe(5);
	});

	test("empty output refunds and does not crash", async () => {
		const user = createUser({ credits: 5 });
		fake.reset({ kind: "succeed", outputs: 0 });
		const res = await generate(user, { prompt: "empty", model: DEV });
		expect(res.statusCode).toBe(502);
		expect(res.json().code).toBe("GENERATION_NO_OUTPUT");
		expect(creditBalance(user.id)).toBe(5);
	});

	test("fewer outputs than requested refunds the missing ones", async () => {
		const user = createUser({ credits: 10 });
		fake.reset({ kind: "succeed", outputs: 2 });
		const res = await generate(user, { prompt: "some", model: SCHNELL, numOutputs: 4 });
		expect(res.statusCode).toBe(200);
		expect(res.json().images).toHaveLength(2);
		expect(res.json().creditsCharged).toBe(2);
		expect(creditBalance(user.id)).toBe(8);
	});

	test("failed output download refunds", async () => {
		const user = createUser({ credits: 5 });
		__testing.setFetch((async () => new Response("nope", { status: 403 })) as unknown as typeof fetch);
		try {
			const res = await generate(user, { prompt: "dl", model: DEV });
			expect(res.statusCode).toBe(500);
			expect(creditBalance(user.id)).toBe(5);
		} finally {
			__testing.setFetch((async () =>
				new Response(PNG_BYTES, { headers: { "content-type": "image/png" } })) as unknown as typeof fetch);
		}
	});
});

describe("C3: numOutputs and parameter validation", () => {
	test("numOutputs=200 is clamped to 4 and charged per output", async () => {
		const user = createUser({ credits: 10 });
		const res = await generate(user, { prompt: "many", model: SCHNELL, numOutputs: 200 });
		expect(res.statusCode).toBe(200);
		expect(res.json().images).toHaveLength(4);
		expect(res.json().creditsCharged).toBe(4);
		expect(fake.inputs[0].num_outputs).toBe(4);
		expect(creditBalance(user.id)).toBe(6);
	});

	test("models without native num_outputs make at most 4 parallel calls", async () => {
		const user = createUser({ credits: 20 });
		const res = await generate(user, { prompt: "many", model: PRO, numOutputs: 200 });
		expect(res.statusCode).toBe(200);
		expect(fake.creates).toBe(4);
		expect(creditBalance(user.id)).toBe(20 - 12);
	});

	test("cannot afford all outputs -> 402, nothing charged", async () => {
		const user = createUser({ credits: 3 });
		const res = await generate(user, { prompt: "many", model: SCHNELL, numOutputs: 4 });
		expect(res.statusCode).toBe(402);
		expect(res.json().code).toBe("INSUFFICIENT_CREDITS");
		expect(creditBalance(user.id)).toBe(3);
		expect(fake.creates).toBe(0);
	});

	test("rejects unknown models and bad parameters, accepts the frontend's values", async () => {
		const user = createUser({ credits: 20 });
		const bad = [
			{ prompt: "x", model: "attacker/expensive-model" },
			{ prompt: "x", model: SCHNELL, aspectRatio: "999:1" },
			{ prompt: "x", model: SCHNELL, resolution: "16K" },
			{ prompt: "x", model: SCHNELL, outputFormat: "exe" },
			{ prompt: "x", model: SCHNELL, width: 100000 },
			{ prompt: "x", model: SCHNELL, seed: -1 },
			{ prompt: "x".repeat(10_001), model: SCHNELL },
		];
		for (const body of bad) {
			const res = await generate(user, body);
			expect(res.statusCode).toBe(400);
		}
		const ok = await generate(user, {
			prompt: "x",
			model: SCHNELL,
			aspectRatio: "4:3",
			resolution: "2K",
			outputFormat: "png",
			seed: 2147483646,
		});
		expect(ok.statusCode).toBe(200);
		expect(fake.creates).toBe(1);
	});
});

describe("variations", () => {
	test("prompt-less variation succeeds and gets a default thread title", async () => {
		const user = createUser({ credits: 10 });
		const ref = seedUpload(user.id);
		const res = await generate(user, { model: REDUX_SCHNELL, imageInputs: [ref], numOutputs: 4 });
		expect(res.statusCode).toBe(200);
		const body = res.json();
		expect(body.images).toHaveLength(4);
		const thread = getDb().prepare("SELECT title FROM threads WHERE id = ?").get(body.threadId) as { title: string };
		expect(thread.title).toBe("Variation");
		expect(creditBalance(user.id)).toBe(10 - 8);
	});

	test("variation: true picks the best variation model the Free tier allows", async () => {
		const db = getDb();
		const free = db.prepare("SELECT id, allowed_models FROM subscription_products WHERE name = 'Free'").get() as {
			id: string;
			allowed_models: string | null;
		};
		db.prepare("UPDATE subscription_products SET allowed_models = ? WHERE id = ?").run(
			JSON.stringify([SCHNELL, DEV, FLUX2_DEV, REDUX_SCHNELL, "black-forest-labs/flux-kontext-pro"]),
			free.id,
		);
		try {
			const user = createUser({ credits: 20 });
			assignFree(user.id, "-1 hours");
			const ref = seedUpload(user.id);

			const blocked = await generate(user, { prompt: "p", model: REDUX_DEV, imageInputs: [ref], numOutputs: 4 });
			expect(blocked.statusCode).toBe(403);
			expect(blocked.json().code).toBe("MODEL_NOT_ALLOWED");

			const res = await generate(user, {
				prompt: "p",
				model: REDUX_DEV,
				variation: true,
				imageInputs: [ref],
				numOutputs: 4,
			});
			expect(res.statusCode).toBe(200);
			expect(res.json().model).toBe(REDUX_SCHNELL);
			expect(creditBalance(user.id)).toBe(20 - 8);
		} finally {
			db.prepare("UPDATE subscription_products SET allowed_models = ? WHERE id = ?").run(free.allowed_models, free.id);
		}
	});
});

describe("own Replicate key (BYO)", () => {
	test("own-key generations cost no credits and skip the platform cost limit", async () => {
		const db = getDb();
		const user = createUser({ credits: 0 });
		db.prepare("INSERT INTO user_api_keys (id, user_id, provider, api_key_encrypted) VALUES (?, ?, 'replicate', ?)").run(
			randomUUID(),
			user.id,
			encrypt("r8_user_own_key"),
		);
		const res = await generate(user, { prompt: "mine", model: DEV });
		expect(res.statusCode).toBe(200);
		expect(res.json().usedOwnKey).toBe(true);
		expect(res.json().creditsCharged).toBe(0);
		expect(fake.apiKeys).toContain("r8_user_own_key");
		expect(creditBalance(user.id)).toBe(0);

		const usage = db.prepare("SELECT total_cost, used_own_key, image_count FROM usage_monthly WHERE user_id = ?").get(
			user.id,
		) as { total_cost: number; used_own_key: number; image_count: number };
		expect(usage.total_cost).toBe(0);
		expect(usage.used_own_key).toBe(1);
		expect(usage.image_count).toBe(1);
		const pc = db.prepare("SELECT COUNT(*) as n FROM platform_costs WHERE generation_id = ?").get(res.json().id) as {
			n: number;
		};
		expect(pc.n).toBe(0);
	});

	test("an undecryptable saved key returns a clear error instead of a 500", async () => {
		const user = createUser({ credits: 5 });
		getDb()
			.prepare("INSERT INTO user_api_keys (id, user_id, provider, api_key_encrypted) VALUES (?, ?, 'replicate', ?)")
			.run(randomUUID(), user.id, "garbage:not:encrypted");
		const res = await generate(user, { prompt: "x", model: DEV });
		expect(res.statusCode).toBe(400);
		expect(res.json().code).toBe("API_KEY_UNREADABLE");
		expect(creditBalance(user.id)).toBe(5);
	});
});

describe("platform cost tracking and output files", () => {
	test("platform-key success records a reconciled platform_costs row and saves a real file", async () => {
		const user = createUser({ credits: 5 });
		const res = await generate(user, { prompt: "cost", model: DEV, outputFormat: "jpeg" });
		expect(res.statusCode).toBe(200);
		const id = res.json().id;
		const pc = getDb()
			.prepare("SELECT estimated_cost, actual_cost, model FROM platform_costs WHERE generation_id = ?")
			.get(id) as { estimated_cost: number; actual_cost: number; model: string };
		expect(pc.model).toBe(DEV);
		expect(pc.estimated_cost).toBeCloseTo(0.025);
		expect(pc.actual_cost).toBeCloseTo(0.025);

		// Content-Type wins over the requested format for the extension.
		const url = res.json().images[0].url as string;
		expect(url.endsWith(".png")).toBe(true);
		expect(fs.existsSync(path.join(imagesDir, url.replace("/images/", "")))).toBe(true);
	});
});

describe("/api/enhance-prompt", () => {
	test("is rate limited per user", async () => {
		const app = await getApp();
		const user = createUser();
		const statuses: number[] = [];
		for (let i = 0; i < 11; i++) {
			const res = await app.inject({
				method: "POST",
				url: "/api/enhance-prompt",
				headers: authHeader(user),
				payload: { prompt: "a dog" },
				remoteAddress: nextIp(),
			});
			statuses.push(res.statusCode);
		}
		expect(statuses.slice(0, 10).every((s) => s === 200)).toBe(true);
		expect(statuses[10]).toBe(429);

		// A different user is unaffected.
		const other = createUser();
		const res = await app.inject({
			method: "POST",
			url: "/api/enhance-prompt",
			headers: authHeader(other),
			payload: { prompt: "a dog" },
			remoteAddress: nextIp(),
		});
		expect(res.statusCode).toBe(200);
	});
});
