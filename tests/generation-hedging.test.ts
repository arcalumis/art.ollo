// GPU wait handling: same-model hedging, the no-GPU cap (GPU_BUSY) and the
// live status channel. Replicate is the scripted fake from generation-fakes:
// each prediction sits in `starting` for a scripted time, then renders.
// Time is scaled 1 s -> 10 ms: hedges at 5/10/15 s run at 50/100/150 ms and the
// 45 s cap at 450 ms.
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { getDb } from "../server/db";
import { __testing as statusTesting, STATUS_TTL_MS } from "../server/services/generation-status";
import { __testing } from "../server/services/replicate";
import { fake, installFakes, nextIp, seedUpload } from "./generation-fakes";
import { type TestUser, authHeader, createUser, creditBalance, getApp } from "./helpers";

const FLUX2_DEV = "black-forest-labs/flux-2-dev"; // 2 credits at Standard
const GPT = "openai/gpt-image-2.5-flare"; // a premium model, native outputs
const KLEIN = "black-forest-labs/flux-2-klein-4b"; // 1 credit, parallel outputs

const SCALE = 10; // ms per simulated second

beforeAll(() => {
	installFakes();
});

beforeEach(() => {
	fake.reset();
	__testing.setTiming({
		pollIntervalMs: 2,
		timeoutMs: 2_000,
		hedgeAtMs: [5 * SCALE, 10 * SCALE, 15 * SCALE],
		gpuCapMs: 45 * SCALE,
	});
});

afterEach(() => {
	__testing.setTiming({ hedgeAtMs: [5_000, 10_000, 15_000], gpuCapMs: 45_000 });
	statusTesting.setNow(null);
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

async function status(user: TestUser, id: string) {
	const app = await getApp();
	return app.inject({
		method: "GET",
		url: `/api/generate/status/${id}`,
		headers: authHeader(user),
		remoteAddress: nextIp(),
	});
}

function ledger(userId: string) {
	return getDb()
		.prepare("SELECT credit_type, amount FROM user_credits WHERE user_id = ? ORDER BY rowid")
		.all(userId) as { credit_type: string; amount: number }[];
}

function savedGeneration(id: string) {
	const row = getDb()
		.prepare("SELECT model, replicate_id, cost, parameters FROM generations WHERE id = ?")
		.get(id) as { model: string; replicate_id: string; cost: number; parameters: string };
	return { ...row, parameters: JSON.parse(row.parameters) as Record<string, unknown> };
}

function platformCosts(generationId: string) {
	return getDb()
		.prepare("SELECT replicate_prediction_id FROM platform_costs WHERE generation_id = ?")
		.all(generationId) as { replicate_prediction_id: string }[];
}

describe("same-model hedging", () => {
	test("a normal start submits no hedges", async () => {
		const user = createUser({ credits: 10 });
		fake.reset({ kind: "timeline", startAfterMs: [0] });
		const res = await generate(user, { prompt: "a fox", model: FLUX2_DEV });
		expect(res.statusCode).toBe(200);
		expect(fake.created).toHaveLength(1);
		expect(fake.cancels).toBe(0);
		const gen = savedGeneration(res.json().id);
		expect(gen.parameters.predictionAttempts).toBe(1);
		expect(gen.parameters.winningAttempt).toBe(1);
		expect(typeof gen.parameters.queueWaitMs).toBe("number");
	});

	test("stuck at 5 s: an identical second prediction is submitted", async () => {
		const user = createUser({ credits: 10 });
		// The original starts at 7 s, after the hedge went out but before the 10 s one.
		fake.reset({ kind: "timeline", startAfterMs: [7 * SCALE, null] });
		const res = await generate(user, { prompt: "a fox", model: FLUX2_DEV, seed: 42 });
		expect(res.statusCode).toBe(200);
		expect(fake.created).toHaveLength(2);
		const [first, second] = fake.created;
		expect(second.at - first.at).toBeGreaterThanOrEqual(5 * SCALE - 5);
		expect(second.at - first.at).toBeLessThan(10 * SCALE);
		expect(second.model).toBe(first.model);
		expect(second.input).toEqual(first.input);
		expect(second.input.seed).toBe(42);
		// The original won, so the hedge was canceled before it started.
		expect(second.canceledAt).toBeDefined();
		expect(first.canceledAt).toBeUndefined();
		expect(savedGeneration(res.json().id).parameters.winningAttempt).toBe(1);
	});

	test("the hedge starts first: the original is canceled and the user is charged once", async () => {
		const user = createUser({ credits: 10 });
		fake.reset({ kind: "timeline", startAfterMs: [null, 2 * SCALE] });
		const res = await generate(user, { prompt: "a fox", model: FLUX2_DEV });
		expect(res.statusCode).toBe(200);
		expect(fake.created).toHaveLength(2);
		const [original, hedge] = fake.created;
		expect(original.canceledAt).toBeDefined();
		expect(hedge.canceledAt).toBeUndefined();

		// One charge, no refund: 2 credits for one Standard FLUX 2 Dev image.
		expect(creditBalance(user.id)).toBe(8);
		expect(ledger(user.id).map((l) => `${l.credit_type}:${l.amount}`)).toEqual([
			"bonus:10",
			"used:-2",
		]);
		const gen = savedGeneration(res.json().id);
		expect(gen.model).toBe(FLUX2_DEV);
		expect(gen.replicate_id).toBe(hedge.id);
		expect(gen.parameters.predictionAttempts).toBe(2);
		expect(gen.parameters.winningAttempt).toBe(2);
		// Only the winner's cost is on record.
		expect(platformCosts(res.json().id)).toEqual([{ replicate_prediction_id: hedge.id }]);
	});

	test("escalates to at most four identical attempts of the same model", async () => {
		const user = createUser({ credits: 10 });
		fake.reset({ kind: "timeline", startAfterMs: [null, null, null, 2 * SCALE] });
		const res = await generate(user, { prompt: "a heron", model: GPT });
		expect(res.statusCode).toBe(200);
		expect(fake.created).toHaveLength(4);
		const gaps = fake.created.map((c) => c.at - fake.created[0].at);
		expect(gaps[2]).toBeGreaterThanOrEqual(10 * SCALE - 5);
		expect(gaps[3]).toBeGreaterThanOrEqual(15 * SCALE - 5);
		for (const c of fake.created) {
			expect(c.model).toBe(GPT);
			expect(c.input).toEqual(fake.created[0].input);
		}
		expect(fake.created.slice(0, 3).every((c) => c.canceledAt !== undefined)).toBe(true);
		expect(fake.created[3].canceledAt).toBeUndefined();
		expect(savedGeneration(res.json().id).model).toBe(GPT);
	});

	test("two attempts starting together: the first is kept, the rest canceled", async () => {
		const user = createUser({ credits: 10 });
		// Both get a GPU within the same poll.
		fake.reset({ kind: "timeline", startAfterMs: [6 * SCALE, 1 * SCALE] });
		const res = await generate(user, { prompt: "twins", model: FLUX2_DEV });
		expect(res.statusCode).toBe(200);
		const kept = fake.created.filter((c) => c.canceledAt === undefined);
		expect(kept).toHaveLength(1);
		expect(creditBalance(user.id)).toBe(8);
	});

	test("nothing starts by 45 s: everything is canceled, refunded, GPU_BUSY", async () => {
		const user = createUser({ credits: 10 });
		fake.reset({ kind: "timeline", startAfterMs: [] });
		const started = Date.now();
		const res = await generate(user, { prompt: "a fox", model: FLUX2_DEV });
		expect(Date.now() - started).toBeGreaterThanOrEqual(45 * SCALE - 5);
		expect(res.statusCode).toBe(503);
		expect(res.json()).toMatchObject({
			code: "GPU_BUSY",
			error: "Image generation is busy right now. Your credits were returned.",
		});
		expect(fake.created).toHaveLength(4);
		expect(fake.created.every((c) => c.canceledAt !== undefined)).toBe(true);
		expect(creditBalance(user.id)).toBe(10);
		expect(ledger(user.id).map((l) => l.credit_type)).toEqual(["bonus", "used", "refund"]);
	});

	test("parallel outputs hedge each prediction with its own seed", async () => {
		const user = createUser({ credits: 10 });
		// Two outputs -> two predictions (indices 0, 1); output 1 is stuck, its hedge (index 2) starts.
		fake.reset({ kind: "timeline", startAfterMs: [0, null, 1 * SCALE] });
		const res = await generate(user, { prompt: "pair", model: KLEIN, numOutputs: 2, seed: 7 });
		expect(res.statusCode).toBe(200);
		expect(res.json().images).toHaveLength(2);
		expect(fake.created).toHaveLength(3);
		expect(fake.created[2].input).toEqual(fake.created[1].input);
		expect(fake.created[1].canceledAt).toBeDefined();
		expect(creditBalance(user.id)).toBe(8);
	});

	test("tools hedge too and return GPU_BUSY when nothing starts", async () => {
		const user = createUser({ credits: 10 });
		const upload = seedUpload(user.id);
		const app = await getApp();
		fake.reset({ kind: "timeline", startAfterMs: [null, 1 * SCALE] });
		const ok = await app.inject({
			method: "POST",
			url: "/api/tools/remove-background",
			headers: authHeader(user),
			payload: { image: upload },
			remoteAddress: nextIp(),
		});
		expect(ok.statusCode).toBe(200);
		expect(fake.created).toHaveLength(2);
		expect(fake.created[0].canceledAt).toBeDefined();

		fake.reset({ kind: "timeline", startAfterMs: [] });
		const before = creditBalance(user.id);
		const busy = await app.inject({
			method: "POST",
			url: "/api/tools/remove-background",
			headers: authHeader(user),
			payload: { image: upload },
			remoteAddress: nextIp(),
		});
		expect(busy.statusCode).toBe(503);
		expect(busy.json().code).toBe("GPU_BUSY");
		expect(creditBalance(user.id)).toBe(before);
	});

	test("the render deadline starts when rendering starts, not at submission", async () => {
		const user = createUser({ credits: 10 });
		// Waits 30 s for a GPU (no hedge gets one), then renders 3 s: well inside a 10 s render deadline.
		__testing.setTiming({ timeoutMs: 10 * SCALE });
		fake.reset({ kind: "timeline", startAfterMs: [30 * SCALE], renderMs: 3 * SCALE });
		const res = await generate(user, { prompt: "slow queue", model: FLUX2_DEV });
		expect(res.statusCode).toBe(200);
	});
});

describe("live status", () => {
	test("reports waiting_gpu while queued, then done; owner-only", async () => {
		const user = createUser({ credits: 10 });
		const other = createUser({ credits: 10 });
		const id = randomUUID();
		fake.reset({ kind: "timeline", startAfterMs: [20 * SCALE, null, null] });
		const pending = generate(user, { prompt: "a fox", model: FLUX2_DEV, clientRequestId: id });

		await new Promise((r) => setTimeout(r, 8 * SCALE));
		const waiting = await status(user, id);
		expect(waiting.statusCode).toBe(200);
		expect(waiting.json()).toMatchObject({ phase: "waiting_gpu", model: FLUX2_DEV });
		expect(waiting.json().waitingForMs).toBeGreaterThan(0);
		expect(waiting.json().waitingSince).toBeString();

		// Another user can't read it (and can't tell it exists).
		expect((await status(other, id)).statusCode).toBe(404);

		const res = await pending;
		expect(res.statusCode).toBe(200);
		const done = (await status(user, id)).json();
		expect(done.phase).toBe("done");
		expect(done.renderingSince).toBeString();
		expect(done.waitingForMs).toBeGreaterThanOrEqual(15 * SCALE);
	});

	test("GPU_BUSY ends in failed", async () => {
		const user = createUser({ credits: 10 });
		const id = randomUUID();
		fake.reset({ kind: "timeline", startAfterMs: [] });
		const res = await generate(user, { prompt: "x", model: FLUX2_DEV, clientRequestId: id });
		expect(res.json().code).toBe("GPU_BUSY");
		expect((await status(user, id)).json().phase).toBe("failed");
	});

	test("entries expire 10 minutes after the request finished", async () => {
		const user = createUser({ credits: 10 });
		const id = randomUUID();
		fake.reset({ kind: "timeline", startAfterMs: [0] });
		await generate(user, { prompt: "x", model: FLUX2_DEV, clientRequestId: id });
		const finishedAt = Date.now();
		statusTesting.setNow(() => finishedAt + STATUS_TTL_MS - 1_000);
		expect((await status(user, id)).statusCode).toBe(200);
		statusTesting.setNow(() => finishedAt + STATUS_TTL_MS + 1_000);
		expect((await status(user, id)).statusCode).toBe(404);
	});

	test("rejects a malformed id and an id that is still running", async () => {
		const user = createUser({ credits: 10 });
		const bad = await generate(user, { prompt: "x", model: FLUX2_DEV, clientRequestId: "nope" });
		expect(bad.statusCode).toBe(400);
		expect(fake.created).toHaveLength(0);

		const id = randomUUID();
		fake.reset({ kind: "timeline", startAfterMs: [5 * SCALE] });
		const first = generate(user, { prompt: "x", model: FLUX2_DEV, clientRequestId: id });
		await new Promise((r) => setTimeout(r, SCALE));
		const dup = await generate(user, { prompt: "x", model: FLUX2_DEV, clientRequestId: id });
		expect(dup.statusCode).toBe(409);
		expect((await first).statusCode).toBe(200);
		expect(creditBalance(user.id)).toBe(8);
	});
});

describe("admin queue wait", () => {
	test("the Models economics report GPU queue wait p50/p95 per model", async () => {
		const user = createUser({ credits: 20 });
		fake.reset({ kind: "timeline", startAfterMs: [3 * SCALE] });
		expect((await generate(user, { prompt: "a fox", model: FLUX2_DEV })).statusCode).toBe(200);

		const admin = createUser({ isAdmin: true });
		const app = await getApp();
		const res = await app.inject({
			method: "GET",
			url: "/api/admin/models/economics?days=1",
			headers: authHeader(admin),
			remoteAddress: nextIp(),
		});
		expect(res.statusCode).toBe(200);
		const dev = (res.json().models as { id: string; queueWaitP50Seconds: number | null }[]).find(
			(m) => m.id === FLUX2_DEV,
		);
		expect(dev?.queueWaitP50Seconds).toBeGreaterThan(0);
	});
});
