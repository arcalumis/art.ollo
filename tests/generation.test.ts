import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { getDb } from "../server/db";
import { encrypt } from "../server/services/encryption";
import { __testing, resolveImageInputPath } from "../server/services/replicate";
import { PNG_BYTES, assignFree, fake, installFakes, nextIp, seedUpload } from "./generation-fakes";
import { type TestUser, authHeader, createUser, creditBalance, getApp } from "./helpers";

const KLEIN = "black-forest-labs/flux-2-klein-4b"; // 1 credit, parallel outputs, up to 4 refs
const FLUX2_DEV = "black-forest-labs/flux-2-dev"; // 2 credits at Standard, up to 5 refs
const GPT = "openai/gpt-image-2.5-flare"; // 2 credits at Draft, native number_of_images
const RECRAFT = "recraft-ai/recraft-v4.1"; // no reference images
const QUICK_EDIT = "prunaai/p-image-edit"; // requires an input image
const SCHNELL = "black-forest-labs/flux-schnell"; // dropped: served by Klein
const REDUX_DEV = "black-forest-labs/flux-redux-dev"; // dropped: Vary uses FLUX 2 Dev / Klein

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
			Array.from({ length: 20 }, () => generate(user, { prompt: "a cat", model: KLEIN })),
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
		getDb()
			.prepare("UPDATE uploads SET deleted_at = datetime('now') WHERE filename = ?")
			.run(path.basename(ref));
		const res = await generate(user, { prompt: "x", model: FLUX2_DEV, imageInputs: [ref] });
		expect(res.statusCode).toBe(400);
	});

	test("own uploads, own generated images and own grid images are accepted", async () => {
		const user = createUser({ credits: 50 });
		const upload = seedUpload(user.id);

		// A 4-up grid generation owned by the user.
		const grid = await generate(user, { prompt: "grid", model: KLEIN, numOutputs: 4 });
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
		for (const uri of input.input_images)
			expect(uri.startsWith("data:image/png;base64,")).toBe(true);
	});

	test("image count is capped at the model's maxImages", async () => {
		const user = createUser({ credits: 10 });
		const refs = [seedUpload(user.id), seedUpload(user.id)];
		const tooMany = await generate(user, {
			prompt: "x",
			model: KLEIN,
			imageInputs: [...refs, seedUpload(user.id), seedUpload(user.id), seedUpload(user.id)],
		});
		expect(tooMany.statusCode).toBe(400);
		const noImages = await generate(user, { prompt: "x", model: RECRAFT, imageInputs: [refs[0]] });
		expect(noImages.statusCode).toBe(400);
		const needsImage = await generate(user, { prompt: "x", model: QUICK_EDIT });
		expect(needsImage.statusCode).toBe(400);
		expect(needsImage.json().code).toBe("INVALID_IMAGE_INPUT");
		expect(fake.creates).toBe(0);
		expect(creditBalance(user.id)).toBe(10);
	});
});

describe("refunds", () => {
	test("Replicate failure refunds the reservation", async () => {
		const user = createUser({ credits: 5 });
		fake.reset({ kind: "fail" });
		const res = await generate(user, { prompt: "boom", model: FLUX2_DEV });
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
		const res = await generate(user, { prompt: "slow", model: FLUX2_DEV });
		expect(res.statusCode).toBe(504);
		expect(res.json().code).toBe("GENERATION_TIMEOUT");
		expect(fake.cancels).toBe(1);
		expect(creditBalance(user.id)).toBe(5);
	});

	test("canceled prediction refunds instead of hanging", async () => {
		const user = createUser({ credits: 5 });
		fake.reset({ kind: "cancel" });
		const res = await generate(user, { prompt: "nope", model: FLUX2_DEV });
		expect(res.statusCode).toBe(502);
		expect(res.json().code).toBe("GENERATION_CANCELED");
		expect(creditBalance(user.id)).toBe(5);
	});

	test("empty output refunds and does not crash", async () => {
		const user = createUser({ credits: 5 });
		fake.reset({ kind: "succeed", outputs: 0 });
		const res = await generate(user, { prompt: "empty", model: FLUX2_DEV });
		expect(res.statusCode).toBe(502);
		expect(res.json().code).toBe("GENERATION_NO_OUTPUT");
		expect(creditBalance(user.id)).toBe(5);
	});

	test("fewer outputs than requested refunds the missing ones", async () => {
		const user = createUser({ credits: 10 });
		fake.reset({ kind: "succeed", outputs: 2 });
		// GPT Image returns all outputs from one prediction (Draft = 2 credits each).
		const res = await generate(user, { prompt: "some", model: GPT, numOutputs: 4 });
		expect(res.statusCode).toBe(200);
		expect(res.json().images).toHaveLength(2);
		expect(res.json().creditsCharged).toBe(4);
		expect(creditBalance(user.id)).toBe(6);
	});

	test("failed output download refunds", async () => {
		const user = createUser({ credits: 5 });
		__testing.setFetch(
			(async () => new Response("nope", { status: 403 })) as unknown as typeof fetch,
		);
		try {
			const res = await generate(user, { prompt: "dl", model: FLUX2_DEV });
			expect(res.statusCode).toBe(500);
			expect(creditBalance(user.id)).toBe(5);
		} finally {
			__testing.setFetch(
				(async () =>
					new Response(PNG_BYTES, {
						headers: { "content-type": "image/png" },
					})) as unknown as typeof fetch,
			);
		}
	});
});

describe("C3: numOutputs and parameter validation", () => {
	test("numOutputs=200 is clamped to 4 and charged per output", async () => {
		const user = createUser({ credits: 10 });
		const res = await generate(user, { prompt: "many", model: GPT, numOutputs: 200 });
		expect(res.statusCode).toBe(200);
		expect(res.json().images).toHaveLength(4);
		expect(res.json().creditsCharged).toBe(8);
		expect(fake.creates).toBe(1);
		expect(fake.inputs[0].number_of_images).toBe(4);
		expect(creditBalance(user.id)).toBe(2);
	});

	test("models without native outputs make at most 4 parallel calls with distinct seeds", async () => {
		const user = createUser({ credits: 20 });
		const res = await generate(user, { prompt: "many", model: KLEIN, numOutputs: 200, seed: 100 });
		expect(res.statusCode).toBe(200);
		expect(fake.creates).toBe(4);
		expect(fake.inputs.map((i) => i.seed).sort()).toEqual([100, 101, 102, 103]);
		expect(creditBalance(user.id)).toBe(20 - 4);
	});

	test("dropped models are served by their replacement", async () => {
		const user = createUser({ credits: 10 });
		const res = await generate(user, { prompt: "old client", model: SCHNELL });
		expect(res.statusCode).toBe(200);
		expect(res.json().model).toBe(KLEIN);
		expect(creditBalance(user.id)).toBe(9);
	});

	test("cannot afford all outputs -> 402, nothing charged", async () => {
		const user = createUser({ credits: 3 });
		const res = await generate(user, { prompt: "many", model: KLEIN, numOutputs: 4 });
		expect(res.statusCode).toBe(402);
		expect(res.json().code).toBe("INSUFFICIENT_CREDITS");
		expect(creditBalance(user.id)).toBe(3);
		expect(fake.creates).toBe(0);
	});

	test("rejects unknown models and bad parameters, accepts the frontend's values", async () => {
		const user = createUser({ credits: 20 });
		const bad = [
			{ prompt: "x", model: "attacker/expensive-model" },
			{ prompt: "x", model: KLEIN, aspectRatio: "999:1" },
			{ prompt: "x", model: KLEIN, resolution: "16K" },
			{ prompt: "x", model: KLEIN, outputFormat: "exe" },
			{ prompt: "x", model: KLEIN, width: 100000 },
			{ prompt: "x", model: KLEIN, seed: -1 },
			{ prompt: "x".repeat(10_001), model: KLEIN },
		];
		for (const body of bad) {
			const res = await generate(user, body);
			expect(res.statusCode).toBe(400);
		}
		const ok = await generate(user, {
			prompt: "x",
			model: KLEIN,
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
		const res = await generate(user, {
			model: REDUX_DEV,
			variation: true,
			imageInputs: [ref],
			numOutputs: 4,
		});
		expect(res.statusCode).toBe(200);
		const body = res.json();
		expect(body.images).toHaveLength(4);
		// FLUX 2 Dev at Standard with the image as a reference: 2 credits each.
		expect(body.model).toBe(FLUX2_DEV);
		expect(String(fake.inputs[0].prompt)).toContain("variation of the reference image");
		expect(fake.inputs[0].input_images).toHaveLength(1);
		const thread = getDb().prepare("SELECT title FROM threads WHERE id = ?").get(body.threadId) as {
			title: string;
		};
		expect(thread.title).toBe("Variation");
		expect(creditBalance(user.id)).toBe(10 - 8);
	});

	test("Free can always Vary: cheaper model, then fewer outputs", async () => {
		const user = createUser({ credits: 5 });
		const ref = seedUpload(user.id);
		// FLUX 2 Dev x4 = 8 > 5, so Klein x4 = 4.
		const res = await generate(user, {
			prompt: "p",
			variation: true,
			imageInputs: [ref],
			numOutputs: 4,
		});
		expect(res.statusCode).toBe(200);
		expect(res.json().model).toBe(KLEIN);
		expect(res.json().creditsCharged).toBe(4);
		// 1 credit left: one output.
		const res2 = await generate(user, {
			prompt: "p",
			variation: true,
			imageInputs: [ref],
			numOutputs: 4,
		});
		expect(res2.statusCode).toBe(200);
		expect(res2.json().images).toHaveLength(1);
		expect(creditBalance(user.id)).toBe(0);
	});

	test("variation: true picks the best variation model the Free tier allows", async () => {
		const db = getDb();
		const free = db
			.prepare("SELECT id, allowed_models FROM subscription_products WHERE name = 'Free'")
			.get() as {
			id: string;
			allowed_models: string | null;
		};
		db.prepare("UPDATE subscription_products SET allowed_models = ? WHERE id = ?").run(
			JSON.stringify([KLEIN, "google/nano-banana-2-lite"]),
			free.id,
		);
		try {
			const user = createUser({ credits: 20 });
			assignFree(user.id, "-1 hours");
			const ref = seedUpload(user.id);

			const blocked = await generate(user, {
				prompt: "p",
				model: REDUX_DEV,
				imageInputs: [ref],
				numOutputs: 4,
			});
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
			expect(res.json().model).toBe(KLEIN);
			expect(creditBalance(user.id)).toBe(20 - 4);
		} finally {
			db.prepare("UPDATE subscription_products SET allowed_models = ? WHERE id = ?").run(
				free.allowed_models,
				free.id,
			);
		}
	});
});

describe("own Replicate key (BYO)", () => {
	test("own-key generations cost no credits and skip the platform cost limit", async () => {
		const db = getDb();
		const user = createUser({ credits: 0 });
		db.prepare(
			"INSERT INTO user_api_keys (id, user_id, provider, api_key_encrypted) VALUES (?, ?, 'replicate', ?)",
		).run(randomUUID(), user.id, encrypt("r8_user_own_key"));
		const res = await generate(user, { prompt: "mine", model: FLUX2_DEV });
		expect(res.statusCode).toBe(200);
		expect(res.json().usedOwnKey).toBe(true);
		expect(res.json().creditsCharged).toBe(0);
		expect(fake.apiKeys).toContain("r8_user_own_key");
		expect(creditBalance(user.id)).toBe(0);

		const usage = db
			.prepare("SELECT total_cost, used_own_key, image_count FROM usage_monthly WHERE user_id = ?")
			.get(user.id) as { total_cost: number; used_own_key: number; image_count: number };
		expect(usage.total_cost).toBe(0);
		expect(usage.used_own_key).toBe(1);
		expect(usage.image_count).toBe(1);
		const pc = db
			.prepare("SELECT COUNT(*) as n FROM platform_costs WHERE generation_id = ?")
			.get(res.json().id) as {
			n: number;
		};
		expect(pc.n).toBe(0);
	});

	test("an undecryptable saved key returns a clear error instead of a 500", async () => {
		const user = createUser({ credits: 5 });
		getDb()
			.prepare(
				"INSERT INTO user_api_keys (id, user_id, provider, api_key_encrypted) VALUES (?, ?, 'replicate', ?)",
			)
			.run(randomUUID(), user.id, "garbage:not:encrypted");
		const res = await generate(user, { prompt: "x", model: FLUX2_DEV });
		expect(res.statusCode).toBe(400);
		expect(res.json().code).toBe("API_KEY_UNREADABLE");
		expect(creditBalance(user.id)).toBe(5);
	});
});

describe("platform cost tracking and output files", () => {
	test("platform-key success records a reconciled platform_costs row and saves a real file", async () => {
		const user = createUser({ credits: 5 });
		const out = await sharp({
			create: { width: 1024, height: 768, channels: 3, background: "#808080" },
		})
			.png()
			.toBuffer();
		__testing.setFetch(
			(async () =>
				new Response(out, { headers: { "content-type": "image/png" } })) as unknown as typeof fetch,
		);
		let res: Awaited<ReturnType<typeof generate>>;
		try {
			res = await generate(user, {
				prompt: "cost",
				model: FLUX2_DEV,
				outputFormat: "jpeg",
				aspectRatio: "4:3",
			});
		} finally {
			__testing.setFetch(
				(async () =>
					new Response(PNG_BYTES, {
						headers: { "content-type": "image/png" },
					})) as unknown as typeof fetch,
			);
		}
		expect(res.statusCode).toBe(200);
		const id = res.json().id;
		const db = getDb();
		const pc = db
			.prepare(
				"SELECT estimated_cost, actual_cost, model FROM platform_costs WHERE generation_id = ?",
			)
			.get(id) as { estimated_cost: number; actual_cost: number; model: string };
		// Official formula on the real output: $0.012 per MP x 0.786432 MP.
		expect(pc.model).toBe(FLUX2_DEV);
		expect(pc.estimated_cost).toBeCloseTo(0.012 * 0.786432, 6);
		expect(pc.actual_cost).toBeCloseTo(0.012 * 0.786432, 6);
		// Real output dimensions are recorded, not 1024x1024.
		const gen = db.prepare("SELECT width, height FROM generations WHERE id = ?").get(id) as {
			width: number;
			height: number;
		};
		expect(gen).toEqual({ width: 1024, height: 768 });
		expect(res.json().images[0]).toMatchObject({ width: 1024, height: 768 });
		// FLUX 2 Dev gets an explicit size now (Standard at 4:3 inside its 1440 px limit).
		expect(fake.inputs[0]).toMatchObject({ aspect_ratio: "custom", width: 1440, height: 1056 });

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
