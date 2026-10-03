import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
// POST /api/tools/:tool (upscale, remove background): owned image only, priced
// by the credit rule, refunded on failure, saved in the source thread.
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { getDb } from "../server/db";
import { __testing } from "../server/services/replicate";
import { PNG_BYTES, fake, installFakes, nextIp, seedUpload } from "./generation-fakes";
import { type TestUser, authHeader, createUser, creditBalance, getApp } from "./helpers";

let uploadsDir: string;

beforeAll(() => {
	({ uploadsDir } = installFakes());
});

beforeEach(() => {
	fake.reset();
	__testing.setTiming({ pollIntervalMs: 5, timeoutMs: 2_000 });
});

async function tool(user: TestUser, name: string, body: Record<string, unknown>) {
	const app = await getApp();
	return app.inject({
		method: "POST",
		url: `/api/tools/${name}`,
		headers: authHeader(user),
		payload: body,
		remoteAddress: nextIp(),
	});
}

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

/** An owned upload of a given pixel size. */
async function seedSizedUpload(userId: string, width: number, height: number): Promise<string> {
	const filename = `${randomUUID()}.png`;
	const png = await sharp({ create: { width, height, channels: 3, background: "#336699" } })
		.png()
		.toBuffer();
	fs.writeFileSync(path.join(uploadsDir, filename), png);
	getDb()
		.prepare("INSERT INTO uploads (id, user_id, filename, original_name) VALUES (?, ?, ?, ?)")
		.run(randomUUID(), userId, filename, "big.png");
	return `/uploads/${filename}`;
}

describe("/api/tools", () => {
	test("upscale runs Recraft Crisp on the owned image, costs 1 credit, lands in the source thread", async () => {
		const user = createUser({ credits: 10 });
		const gen = await generate(user, {
			prompt: "a fox",
			model: "black-forest-labs/flux-2-klein-4b",
		});
		expect(gen.statusCode).toBe(200);
		const { threadId, images } = gen.json();
		const before = creditBalance(user.id);
		fake.reset();

		const res = await tool(user, "upscale", { image: images[0].url });
		expect(res.statusCode).toBe(200);
		const body = res.json();
		expect(body).toMatchObject({
			status: "succeeded",
			tool: "upscale",
			model: "recraft-ai/recraft-crisp-upscale",
			creditsCharged: 1,
			threadId,
		});
		expect(fake.creates).toBe(1);
		expect(String(fake.inputs[0].image).startsWith("data:image/png;base64,")).toBe(true);
		expect(creditBalance(user.id)).toBe(before - 1);

		const row = getDb()
			.prepare("SELECT model, prompt, thread_id, parameters FROM generations WHERE id = ?")
			.get(body.id) as {
			model: string;
			prompt: string;
			thread_id: string;
			parameters: string;
		};
		expect(row.thread_id).toBe(threadId);
		expect(row.prompt).toBe("a fox");
		expect(JSON.parse(row.parameters)).toMatchObject({
			tool: "upscale",
			sourceImage: images[0].url,
			creditsCharged: 1,
		});
	});

	test("large inputs go to the large-image upscaler", async () => {
		const user = createUser({ credits: 5 });
		const big = await seedSizedUpload(user.id, 2600, 2000); // 5.2 MP
		const res = await tool(user, "upscale", { image: big });
		expect(res.statusCode).toBe(200);
		expect(res.json().model).toBe("prunaai/p-image-upscale");
		expect(res.json().creditsCharged).toBe(1);
		expect(fake.inputs[0]).toMatchObject({ upscale_mode: "target", target: 16 });
	});

	test("remove background runs Recraft and starts a thread for an upload", async () => {
		const user = createUser({ credits: 5 });
		const ref = seedUpload(user.id);
		const res = await tool(user, "remove-background", { image: ref });
		expect(res.statusCode).toBe(200);
		expect(res.json().model).toBe("recraft-ai/recraft-remove-background");
		const thread = getDb()
			.prepare("SELECT title FROM threads WHERE id = ?")
			.get(res.json().threadId) as { title: string };
		expect(thread.title).toBe("Background removed");
		expect(creditBalance(user.id)).toBe(4);
	});

	test("only the user's own images; unknown tools rejected; nothing charged", async () => {
		const user = createUser({ credits: 5 });
		const other = createUser({ credits: 5 });
		const foreign = seedUpload(other.id);
		for (const body of [
			{ image: foreign },
			{ image: "/uploads/../../etc/passwd" },
			{ image: 42 },
			{},
		]) {
			const res = await tool(user, "upscale", body);
			expect(res.statusCode).toBe(400);
			expect(res.json().code).toBe("INVALID_IMAGE_INPUT");
		}
		const unknown = await tool(user, "make-it-pop", { image: seedUpload(user.id) });
		expect(unknown.statusCode).toBe(400);
		expect(fake.creates).toBe(0);
		expect(creditBalance(user.id)).toBe(5);
	});

	test("refunded when Replicate fails; 402 with no balance", async () => {
		const user = createUser({ credits: 1 });
		const ref = seedUpload(user.id);
		fake.reset({ kind: "fail" });
		const failed = await tool(user, "upscale", { image: ref });
		expect(failed.statusCode).toBe(500);
		expect(failed.json().code).toBe("GENERATION_FAILED");
		expect(creditBalance(user.id)).toBe(1);

		const broke = createUser({ credits: 0 });
		const res = await tool(broke, "remove-background", { image: seedUpload(broke.id) });
		expect(res.statusCode).toBe(402);
		expect(res.json().code).toBe("INSUFFICIENT_CREDITS");
	});

	test("Recraft Vector saves an .svg with its real size; unsafe SVG is refused and refunded", async () => {
		const svg = (body: string) =>
			(async () =>
				new Response(
					`<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="768">${body}</svg>`,
					{
						headers: { "content-type": "image/svg+xml" },
					},
				)) as unknown as typeof fetch;
		const user = createUser({ credits: 5 });
		try {
			__testing.setFetch(svg('<rect width="10" height="10" fill="red"/>'));
			const res = await generate(user, {
				prompt: "a logo",
				model: "recraft-ai/recraft-v4.1-svg",
				aspectRatio: "4:3",
			});
			expect(res.statusCode).toBe(200);
			expect(res.json().images[0].url.endsWith(".svg")).toBe(true);
			expect(res.json().images[0]).toMatchObject({ width: 1024, height: 768 });
			expect(res.json().creditsCharged).toBe(2);

			__testing.setFetch(svg("<script>alert(1)</script>"));
			const bad = await generate(user, { prompt: "a logo", model: "recraft-ai/recraft-v4.1-svg" });
			expect(bad.statusCode).toBe(500);
			expect(creditBalance(user.id)).toBe(3);
		} finally {
			__testing.setFetch(
				(async () =>
					new Response(PNG_BYTES, {
						headers: { "content-type": "image/png" },
					})) as unknown as typeof fetch,
			);
		}
	});

	test("a foreign thread id is refused before charging", async () => {
		const user = createUser({ credits: 5 });
		const res = await tool(user, "upscale", { image: seedUpload(user.id), threadId: randomUUID() });
		expect(res.statusCode).toBe(400);
		expect(res.json().code).toBe("THREAD_NOT_FOUND");
		expect(creditBalance(user.id)).toBe(5);
	});
});
