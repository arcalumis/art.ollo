// Shared fakes for generation tests: a scriptable in-memory Replicate client,
// a fake output download, and temp image/upload directories. Nothing here
// touches the network.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Replicate from "replicate";
import { getDb } from "../server/db";
import { __testing } from "../server/services/replicate";

// A valid 1x1 PNG.
export const PNG_BYTES = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
	"base64",
);

export type Behavior =
	| { kind: "succeed"; outputs?: number; delayMs?: number }
	| { kind: "fail"; delayMs?: number }
	| { kind: "hang" }
	| { kind: "cancel" };

export const fake = {
	behavior: { kind: "succeed" } as Behavior,
	creates: 0,
	cancels: 0,
	inputs: [] as Record<string, unknown>[],
	apiKeys: [] as (string | undefined)[],
	enhanceCalls: 0,
	reset(behavior: Behavior = { kind: "succeed" }) {
		this.behavior = behavior;
		this.creates = 0;
		this.cancels = 0;
		this.inputs = [];
		this.apiKeys = [];
		this.enhanceCalls = 0;
	},
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const predictions = new Map<string, { outputs: number }>();

function makeClient(apiKey?: string) {
	fake.apiKeys.push(apiKey);
	return {
		predictions: {
			async create({ input }: { model: string; input: Record<string, unknown> }) {
				fake.creates++;
				fake.inputs.push(input);
				const b = fake.behavior;
				await sleep("delayMs" in b && b.delayMs ? b.delayMs : 10);
				const id = randomUUID();
				const count = input.num_outputs ?? input.number_of_images ?? input.num_images;
				const requested = typeof count === "number" ? count : 1;
				predictions.set(id, {
					outputs: b.kind === "succeed" && b.outputs !== undefined ? b.outputs : requested,
				});
				return { id, status: "starting" };
			},
			async get(id: string) {
				const b = fake.behavior;
				if (b.kind === "hang") return { id, status: "processing" };
				if (b.kind === "cancel") return { id, status: "canceled" };
				if (b.kind === "fail") return { id, status: "failed", error: "model exploded" };
				const n = predictions.get(id)?.outputs ?? 1;
				return {
					id,
					status: "succeeded",
					output: Array.from(
						{ length: n },
						(_, i) => `https://replicate.delivery/fake/${id}/out-${i}.png`,
					),
					metrics: { predict_time: 1.5 },
				};
			},
			async cancel(id: string) {
				fake.cancels++;
				return { id, status: "canceled" };
			},
		},
		async *stream() {
			fake.enhanceCalls++;
			yield "an enhanced prompt";
		},
	};
}

let installed = false;

/** Install the fakes and point image/upload storage at a temp dir. Idempotent. */
export function installFakes(): { imagesDir: string; uploadsDir: string } {
	if (!installed) {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ollo-gen-test-"));
		process.env.OLLO_IMAGES_DIR = path.join(tmp, "generated-images");
		process.env.OLLO_UPLOADS_DIR = path.join(tmp, "uploads");
		fs.mkdirSync(process.env.OLLO_IMAGES_DIR, { recursive: true });
		fs.mkdirSync(process.env.OLLO_UPLOADS_DIR, { recursive: true });
		__testing.setClientFactory((apiKey) => makeClient(apiKey) as unknown as Replicate);
		__testing.setFetch(
			(async () =>
				new Response(PNG_BYTES, {
					status: 200,
					headers: { "content-type": "image/png" },
				})) as unknown as typeof fetch,
		);
		__testing.setTiming({ pollIntervalMs: 5, timeoutMs: 2_000 });
		installed = true;
	}
	return {
		imagesDir: process.env.OLLO_IMAGES_DIR as string,
		uploadsDir: process.env.OLLO_UPLOADS_DIR as string,
	};
}

/** Create an upload row + file owned by `userId`; returns the "/uploads/<file>" reference. */
export function seedUpload(userId: string): string {
	const { uploadsDir } = installFakes();
	const id = randomUUID();
	const filename = `${id}.png`;
	fs.writeFileSync(path.join(uploadsDir, filename), PNG_BYTES);
	getDb()
		.prepare("INSERT INTO uploads (id, user_id, filename, original_name) VALUES (?, ?, ?, ?)")
		.run(id, userId, filename, "ref.png");
	return `/uploads/${filename}`;
}

/** Give a user the Free subscription (optionally with a custom last top-off time). */
export function assignFree(userId: string, lastTopoffSql: string | null = null): string {
	const db = getDb();
	const free = db.prepare("SELECT id FROM subscription_products WHERE name = 'Free'").get() as {
		id: string;
	};
	const subId = randomUUID();
	db.prepare(
		`INSERT INTO user_subscriptions (id, user_id, product_id, starts_at, last_credit_topoff_at)
		VALUES (?, ?, ?, datetime('now', '-60 days'), ${lastTopoffSql ? `datetime('now', '${lastTopoffSql}')` : "NULL"})`,
	).run(subId, userId, free.id);
	return subId;
}

export function addLedger(userId: string, amount: number, creditType: string): void {
	getDb()
		.prepare(
			"INSERT INTO user_credits (id, user_id, credit_type, amount, reason) VALUES (?, ?, ?, ?, ?)",
		)
		.run(randomUUID(), userId, creditType, amount, "test");
}

let ipCounter = 0;
/** A distinct client IP per request so the global per-IP rate limit never interferes. */
export function nextIp(): string {
	ipCounter++;
	return `10.${(ipCounter >> 16) & 255}.${(ipCounter >> 8) & 255}.${ipCounter & 255}`;
}
