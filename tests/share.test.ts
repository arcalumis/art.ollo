import "./inject-bun-fix";
import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { getDb } from "../server/db";
import { injectShareMeta } from "../server/routes/share";
import { type TestUser, authHeader, createUser, getApp } from "./helpers";

let ipSeq = 0;
const ip = () => {
	ipSeq++;
	return `203.0.${Math.floor(ipSeq / 250)}.${(ipSeq % 250) + 1}`;
};

function insertGeneration(
	user: TestUser,
	opts: { deleted?: boolean; grid?: boolean } = {},
): string {
	const id = randomUUID();
	const params: Record<string, unknown> = {
		aspectRatio: "4:3",
		creditsCharged: 2,
		// The owner's private reference upload: must never appear in a public response.
		imageInputs: [`/uploads/secret-${id}.png`],
	};
	if (opts.grid)
		params.images = [0, 1, 2, 3].map((i) => ({
			id: `${id}-${i}`,
			url: `/images/${id}-${i}.png`,
			path: `${id}-${i}.png`,
		}));
	getDb()
		.prepare(
			`INSERT INTO generations (id, prompt, model, image_path, width, height, parameters, user_id, cost, deleted_at)
			VALUES (?, ?, 'black-forest-labs/flux-2-dev', ?, 1024, 768, ?, ?, 0.03, ${opts.deleted ? "datetime('now')" : "NULL"})`,
		)
		.run(id, "a bronze crow on a plinth", `${id}.png`, JSON.stringify(params), user.id);
	return id;
}

async function share(user: TestUser, genId: string, method: "POST" | "DELETE" = "POST") {
	const app = await getApp();
	return app.inject({
		method,
		url: `/api/share/${genId}`,
		headers: authHeader(user),
		remoteAddress: ip(),
	});
}

async function publicGet(slug: string) {
	const app = await getApp();
	return app.inject({ method: "GET", url: `/api/share/${slug}`, remoteAddress: ip() });
}

describe("share links", () => {
	test("the owner gets an unguessable slug, and asking again returns the same one", async () => {
		const owner = createUser();
		const genId = insertGeneration(owner);
		const first = await share(owner, genId);
		expect(first.statusCode).toBe(200);
		const { slug, path } = first.json();
		expect(slug).toMatch(/^[A-Za-z0-9_-]{22}$/);
		expect(path).toBe(`/s/${slug}`);
		const again = await share(owner, genId);
		expect(again.json().slug).toBe(slug);
	});

	test("someone else can't share, or revoke, your image", async () => {
		const owner = createUser();
		const other = createUser();
		const genId = insertGeneration(owner);
		expect((await share(other, genId)).statusCode).toBe(404);
		const { slug } = (await share(owner, genId)).json();
		expect((await share(other, genId, "DELETE")).statusCode).toBe(404);
		expect((await publicGet(slug)).statusCode).toBe(200);
	});

	test("sharing needs a session", async () => {
		const owner = createUser();
		const genId = insertGeneration(owner);
		const app = await getApp();
		const res = await app.inject({
			method: "POST",
			url: `/api/share/${genId}`,
			remoteAddress: ip(),
		});
		expect(res.statusCode).toBe(401);
	});

	test("a trashed image can't be shared", async () => {
		const owner = createUser();
		const genId = insertGeneration(owner, { deleted: true });
		const res = await share(owner, genId);
		expect(res.statusCode).toBe(409);
		expect(res.json().code).toBe("IN_TRASH");
	});

	test("the public response has the image and prompt and nothing about the owner", async () => {
		const owner = createUser();
		const genId = insertGeneration(owner, { grid: true });
		const { slug } = (await share(owner, genId)).json();
		const res = await publicGet(slug);
		expect(res.statusCode).toBe(200);
		const body = res.json();
		expect(body.imageUrl).toBe(`/images/${genId}.png`);
		expect(body.prompt).toBe("a bronze crow on a plinth");
		expect(body.model).toBe("black-forest-labs/flux-2-dev");
		expect(body.images).toHaveLength(4);
		expect(body.aspectRatio).toBe("4:3");
		expect(Object.keys(body).sort()).toEqual(
			[
				"aspectRatio",
				"createdAt",
				"height",
				"imageUrl",
				"images",
				"model",
				"prompt",
				"slug",
				"width",
			].sort(),
		);
		const raw = res.body;
		for (const secret of [
			owner.id,
			owner.username,
			owner.email,
			"secret-",
			"imageInputs",
			"creditsCharged",
			"user",
		]) {
			expect(raw).not.toContain(secret);
		}
	});

	test("a revoked slug 404s, and sharing again makes a new slug", async () => {
		const owner = createUser();
		const genId = insertGeneration(owner);
		const { slug } = (await share(owner, genId)).json();
		const revoke = await share(owner, genId, "DELETE");
		expect(revoke.statusCode).toBe(200);
		expect(revoke.json().revoked).toBe(true);
		expect((await publicGet(slug)).statusCode).toBe(404);

		const { slug: fresh } = (await share(owner, genId)).json();
		expect(fresh).not.toBe(slug);
		expect((await publicGet(slug)).statusCode).toBe(404);
		expect((await publicGet(fresh)).statusCode).toBe(200);
	});

	test("moving the image to Trash takes the link down", async () => {
		const owner = createUser();
		const genId = insertGeneration(owner);
		const { slug } = (await share(owner, genId)).json();
		getDb().prepare("UPDATE generations SET deleted_at = datetime('now') WHERE id = ?").run(genId);
		expect((await publicGet(slug)).statusCode).toBe(404);
	});

	test("unknown and malformed slugs 404", async () => {
		expect((await publicGet("AAAAAAAAAAAAAAAAAAAAAA")).statusCode).toBe(404);
		expect((await publicGet("x")).statusCode).toBe(404);
	});
});

describe("share page meta", () => {
	const shell = `<!doctype html><html><head><title>ollo</title>
    <meta
      name="description"
      content="generic"
    />
    <link rel="canonical" href="https://ollo.art/" />
    <meta property="og:title" content="generic" />
    <meta name="twitter:card" content="summary_large_image" />
  </head><body><div id="root"></div></body></html>`;

	test("injects the image's own Open Graph tags and escapes the prompt", () => {
		const html = injectShareMeta(
			shell,
			{
				slug: "abc",
				imageUrl: "/images/x.png",
				prompt: 'a "crow" <script>alert(1)</script>',
				model: "m",
				width: 1024,
				height: 768,
				createdAt: "2026-10-01 10:00:00",
			},
			"abc",
		);
		expect(html).not.toContain("generic");
		expect(html).not.toContain("<script>");
		expect(html).toContain('property="og:image" content="http://localhost:5173/images/x.png"');
		expect(html).toContain('property="og:url" content="http://localhost:5173/s/abc"');
		expect(html).toContain('rel="canonical" href="http://localhost:5173/s/abc"');
		expect(html.match(/og:title/g)).toHaveLength(1);
		expect(html).toContain("&#34;crow&#34;");
	});

	test("a dead link gets generic, noindex meta", () => {
		const html = injectShareMeta(shell, null, "gone");
		expect(html).toContain('name="robots" content="noindex"');
		expect(html).not.toContain("og:image");
	});
});
