// The model catalog: official prices, the credit rule, ratio snapping, tier ->
// input mapping, the allowed_models migration and /api/models. Pure where
// possible; nothing touches the network.
import { Database } from "bun:sqlite";
import { describe, expect, spyOn, test } from "bun:test";
import { getDb } from "../server/db";
import {
	PHASE35_LINEUP,
	migrateAllowedModelsToLineup,
	phase35AllowedModels,
} from "../server/db/schema";
import {
	type BuildContext,
	CATALOG,
	type Tier,
	catalogCredits,
	creditsForCost,
	currentModelId,
	customDimensions,
	getCatalogModel,
	isTierAllowed,
	priceOfOutput,
	resolveTier,
	snapRatio,
	tierFromResolution,
	visibleModels,
} from "../server/services/model-catalog";
import {
	deleteModelCreditCost,
	getModelCreditCost,
	reserveCredits,
	setModelCreditCost,
} from "../server/services/usage";
import { createUser, getApp } from "./helpers";

const model = (id: string) => {
	const m = getCatalogModel(id);
	if (!m) throw new Error(`missing ${id}`);
	return m;
};
const build = (id: string, ctx: Partial<BuildContext>) =>
	model(id).build?.({
		prompt: "p",
		ratio: "1:1",
		tier: "standard",
		refs: [],
		outputs: 1,
		...ctx,
	}) ?? {};

describe("credit rule", () => {
	test("max(1, ceil(cost x 42)), without float noise", () => {
		expect(creditsForCost(0)).toBe(1);
		expect(creditsForCost(0.006)).toBe(1);
		expect(creditsForCost(0.024)).toBe(2); // 1.008
		expect(creditsForCost(0.25)).toBe(11); // 10.5
		expect(creditsForCost(1 / 42)).toBe(1); // exactly 1, not 1.0000000001 -> 2
		expect(creditsForCost(0.5)).toBe(21);
	});

	// LINEUP.md "Suggested credits" are the golden values.
	const golden: [string, Tier, number, number][] = [
		["black-forest-labs/flux-2-klein-4b", "draft", 0, 1],
		["black-forest-labs/flux-2-klein-4b", "max", 4, 1],
		["black-forest-labs/flux-2-dev", "draft", 0, 1],
		["black-forest-labs/flux-2-dev", "draft", 1, 2],
		["black-forest-labs/flux-2-dev", "standard", 1, 2],
		["google/nano-banana-2-lite", "standard", 0, 2],
		["xai/grok-imagine-image-2", "standard", 0, 2],
		["xai/grok-imagine-image-2", "draft", 0, 2],
		["openai/gpt-image-2.5-flare", "draft", 0, 2],
		["openai/gpt-image-2.5-flare", "standard", 0, 6],
		["openai/gpt-image-2.5-flare", "max", 0, 11],
		["openai/gpt-image-2.5-sunburst", "draft", 1, 2],
		["openai/gpt-image-2.5-sunburst", "standard", 1, 6],
		["openai/gpt-image-2.5-sunburst", "max", 1, 11],
		["bytedance/seedream-5-pro", "draft", 0, 2],
		["bytedance/seedream-5-pro", "standard", 0, 4],
		["google/nano-banana-2", "draft", 0, 3],
		["google/nano-banana-2", "standard", 0, 5],
		["google/nano-banana-2", "max", 0, 7],
		["black-forest-labs/flux-2-pro", "standard", 0, 2],
		["black-forest-labs/flux-2-pro", "max", 0, 4],
		["black-forest-labs/flux-2-pro", "standard", 1, 3],
		["ideogram-ai/ideogram-4-5", "standard", 0, 3],
		["ideogram-ai/ideogram-4-5", "max", 0, 5],
		["ideogram-ai/ideogram-4-5", "max", 1, 10],
		["recraft-ai/recraft-v4.1", "standard", 0, 2],
		["recraft-ai/recraft-v4.1", "max", 0, 11],
		["recraft-ai/recraft-v4.1-svg", "standard", 0, 2],
		["prunaai/p-image-edit", "standard", 1, 1],
		["recraft-ai/recraft-crisp-upscale", "standard", 1, 1],
		["prunaai/p-image-upscale", "standard", 1, 1],
		["recraft-ai/recraft-remove-background", "standard", 1, 1],
	];
	for (const [id, tier, refs, credits] of golden) {
		test(`${id.split("/")[1]} ${tier}${refs ? ` +${refs} ref` : ""} = ${credits}`, () => {
			expect(catalogCredits(model(id), tier, refs)).toBe(credits);
		});
	}

	test("official prices: per-run, per-MP and per-input-MP fees all count", () => {
		const pro = model("black-forest-labs/flux-2-pro");
		// $0.015/run + $0.015 x 2 MP out + $0.015 x 1 MP in.
		expect(priceOfOutput(pro, "standard", { outputMp: 2, inputMps: [1] })).toBeCloseTo(0.06, 9);
		const dev = model("black-forest-labs/flux-2-dev");
		expect(priceOfOutput(dev, "standard", { outputMp: 2, inputMps: [1, 0.5] })).toBeCloseTo(
			0.012 * 3.5,
			9,
		);
		const ideo = model("ideogram-ai/ideogram-4-5");
		expect(priceOfOutput(ideo, "max", { refs: 0 })).toBe(0.1);
		expect(priceOfOutput(ideo, "max", { refs: 2 })).toBe(0.22);
		expect(priceOfOutput(ideo, "standard", { refs: 2 })).toBe(0.06);
		expect(priceOfOutput(model("google/nano-banana-pro"), "max")).toBe(0.3);
	});

	test("every visible model and tool has a price at every tier it offers", () => {
		for (const m of CATALOG) {
			for (const t of ["draft", "standard", "max"] as Tier[]) {
				if (m.tiers[t]) expect(priceOfOutput(m, t)).toBeGreaterThan(0);
			}
			expect(m.tiers[m.defaultTier]).toBeDefined();
		}
		expect(visibleModels()).toHaveLength(13);
	});

	test("admin overrides win: per tier, then per model", () => {
		const id = "google/nano-banana-2";
		expect(getModelCreditCost(id, "max")).toBe(7);
		setModelCreditCost(id, 9);
		setModelCreditCost(`${id}:max`, 12);
		try {
			expect(getModelCreditCost(id, "max")).toBe(12);
			expect(getModelCreditCost(id, "draft")).toBe(9);
		} finally {
			deleteModelCreditCost(id);
			deleteModelCreditCost(`${id}:max`);
		}
		expect(getModelCreditCost(id, "draft")).toBe(3);
		expect(getModelCreditCost("nobody/unknown")).toBe(2);
	});

	test("a plain override prices the default tier and keeps tier and reference proportions", () => {
		const id = "ideogram-ai/ideogram-4-5"; // default standard: 3; max: 5 (10 with 2 refs)
		setModelCreditCost(id, 6);
		try {
			expect(getModelCreditCost(id)).toBe(6);
			expect(getModelCreditCost(id, "standard")).toBe(6);
			expect(getModelCreditCost(id, "max")).toBe(10);
			expect(getModelCreditCost(id, "max", 2)).toBe(20);
			expect(getModelCreditCost(id, "draft")).toBe(4);
			// A tier override sets that tier's no-reference price; references still scale it
			setModelCreditCost(`${id}:max`, 8);
			expect(getModelCreditCost(id, "max")).toBe(8);
			expect(getModelCreditCost(id, "max", 2)).toBe(16);
		} finally {
			deleteModelCreditCost(id);
			deleteModelCreditCost(`${id}:max`);
		}
	});

	test("overrides that aren't positive integers are ignored, never free or throwing", () => {
		const id = "ideogram-ai/ideogram-4-5";
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		try {
			for (const bad of [0, -3, 2.5]) {
				setModelCreditCost(id, bad);
				expect(getModelCreditCost(id, "standard")).toBe(3);
				expect(getModelCreditCost(id, "max", 2)).toBe(10);
			}
			expect(warn).toHaveBeenCalled();
			const user = createUser({ credits: 10 });
			expect(() => reserveCredits(user.id, getModelCreditCost(id), "test")).not.toThrow();
		} finally {
			deleteModelCreditCost(id);
			warn.mockRestore();
		}
	});
});

describe("ratios and tiers", () => {
	test("unsupported ratios snap to the nearest by |log ratio|", () => {
		const grok = model("xai/grok-imagine-image-2");
		expect(snapRatio(grok, "16:9")).toEqual({ ratio: "16:9", snapped: false, off: 0 });
		const s = snapRatio(grok, "5:4");
		expect(s.ratio).toBe("4:3");
		expect(s.snapped).toBe(true);
		expect(s.off).toBeCloseTo(4 / 3 / 1.25 - 1, 6);
		expect(snapRatio(grok, "21:9").ratio).toBe("20:9");
		const gpt = model("openai/gpt-image-2.5-flare");
		expect(snapRatio(gpt, "21:9").ratio).toBe("16:9");
		expect(snapRatio(gpt, "4:5").ratio).toBe("3:4");
		expect(snapRatio(model("recraft-ai/recraft-v4.1"), "21:9").ratio).toBe("2:1");
	});

	test("custom-size models render any ratio that fits their limits", () => {
		const dev = model("black-forest-labs/flux-2-dev");
		expect(snapRatio(dev, "21:9").snapped).toBe(false);
		expect(snapRatio(dev, "4:1").snapped).toBe(false); // 1440 / 256 > 4
		expect(snapRatio(dev, "8:1").snapped).toBe(true);
		expect(customDimensions("1:1", 1, { min: 256, max: 1440, multiple: 32 })).toEqual({
			width: 1024,
			height: 1024,
		});
		expect(customDimensions("16:9", 4, { min: 256, max: 2048, multiple: 32 })).toEqual({
			width: 2048,
			height: 1152,
		});
	});

	test("missing tiers resolve to the nearest available one", () => {
		expect(resolveTier(model("black-forest-labs/flux-2-dev"), "max")).toBe("standard");
		expect(resolveTier(model("google/nano-banana-2-lite"), "draft")).toBe("standard");
		expect(resolveTier(model("recraft-ai/recraft-v4.1"), "draft")).toBe("standard");
		expect(resolveTier(model("openai/gpt-image-2.5-flare"), undefined)).toBe("draft");
		expect(tierFromResolution("4K")).toBe("max");
		expect(tierFromResolution("1 MP")).toBe("draft");
		expect(tierFromResolution("2K")).toBe("standard");
	});

	test("dropped models resolve to their replacements", () => {
		expect(currentModelId("black-forest-labs/flux-schnell")).toBe(
			"black-forest-labs/flux-2-klein-4b",
		);
		expect(currentModelId("google/nano-banana-pro")).toBe("google/nano-banana-2");
		expect(currentModelId("black-forest-labs/flux-kontext-pro")).toBe("prunaai/p-image-edit");
		expect(currentModelId("black-forest-labs/flux-2-dev")).toBe("black-forest-labs/flux-2-dev");
	});
});

describe("tier -> model input", () => {
	test("FLUX 2 Klein: output_megapixels and images", () => {
		expect(
			build("black-forest-labs/flux-2-klein-4b", { tier: "max", refs: ["d"], seed: 7 }),
		).toMatchObject({
			output_megapixels: "4",
			images: ["d"],
			seed: 7,
			aspect_ratio: "1:1",
		});
	});
	test("FLUX 2 Dev: custom width/height (it used to get no size at all)", () => {
		expect(build("black-forest-labs/flux-2-dev", { tier: "draft", ratio: "16:9" })).toMatchObject({
			aspect_ratio: "custom",
			width: 1344,
			height: 768,
		});
	});
	test("FLUX 2 Pro: preset ratio + resolution, custom size otherwise", () => {
		expect(build("black-forest-labs/flux-2-pro", { tier: "max", ratio: "4:3" })).toMatchObject({
			aspect_ratio: "4:3",
			resolution: "4 MP",
		});
		const wide = build("black-forest-labs/flux-2-pro", { tier: "standard", ratio: "21:9" });
		expect(wide.aspect_ratio).toBe("custom");
		expect(wide.width).toBe(2048);
	});
	test("Nano Banana 2: resolution 1K/2K/4K", () => {
		expect(build("google/nano-banana-2", { tier: "max", ratio: "8:1" })).toMatchObject({
			resolution: "4K",
			aspect_ratio: "8:1",
		});
	});
	test("GPT Image: quality per tier, largest fixed size at Max, native outputs", () => {
		expect(build("openai/gpt-image-2.5-flare", { tier: "draft", outputs: 3 })).toMatchObject({
			quality: "medium",
			aspect_ratio: "1:1",
			number_of_images: 3,
		});
		expect(build("openai/gpt-image-2.5-flare", { tier: "max", ratio: "16:9" })).toMatchObject({
			quality: "xhigh",
			aspect_ratio: "3840x2160",
		});
		expect(build("openai/gpt-image-2.5-sunburst", { tier: "standard", refs: ["a"] })).toMatchObject(
			{
				quality: "high",
				input_images: ["a"],
			},
		);
	});
	test("Grok: 1k/2k and a single image", () => {
		expect(build("xai/grok-imagine-image-2", { tier: "draft", refs: ["a", "b"] })).toMatchObject({
			resolution: "1k",
			image: "a",
		});
		expect(build("xai/grok-imagine-image-2", { ratio: "match_input_image" }).aspect_ratio).toBe(
			"auto",
		);
	});
	test("Seedream: size 1K/2K", () => {
		expect(build("bytedance/seedream-5-pro", { tier: "standard" })).toMatchObject({ size: "2K" });
	});
	test("Ideogram: quality per tier, nearest fixed size, source for Match input", () => {
		expect(
			build("ideogram-ai/ideogram-4-5", { tier: "draft", ratio: "16:9", outputs: 2 }),
		).toMatchObject({
			quality: "low",
			size: "1344x768",
			num_images: 2,
		});
		expect(build("ideogram-ai/ideogram-4-5", { ratio: "match_input_image" }).size).toBe("source");
	});
	test("Recraft: fixed sizes; Max runs the Pro model at 2048-class sizes", () => {
		expect(build("recraft-ai/recraft-v4.1", { ratio: "3:4" })).toEqual({
			prompt: "p",
			size: "896x1216",
		});
		expect(build("recraft-ai/recraft-v4.1", { tier: "max", ratio: "1:1" })).toEqual({
			prompt: "p",
			size: "2048x2048",
		});
		expect(model("recraft-ai/recraft-v4.1").tiers.max?.slug).toBe("recraft-ai/recraft-v4.1-pro");
	});
	test("Quick Edit and tools take images under their real param names", () => {
		expect(build("prunaai/p-image-edit", { refs: ["a"] })).toMatchObject({ images: ["a"] });
		expect(build("recraft-ai/recraft-crisp-upscale", { refs: ["a"] })).toEqual({ image: "a" });
		expect(build("recraft-ai/recraft-remove-background", { refs: ["a"] })).toEqual({ image: "a" });
	});
});

describe("plan access", () => {
	test("premium Max tiers need an explicit grant; tools are on every plan", () => {
		const starter = PHASE35_LINEUP;
		expect(isTierAllowed(starter, "google/nano-banana-2", "standard")).toBe(true);
		expect(isTierAllowed(starter, "google/nano-banana-2", "max")).toBe(false);
		expect(isTierAllowed(starter, "openai/gpt-image-2.5-flare", "max")).toBe(false);
		expect(isTierAllowed(starter, "recraft-ai/recraft-v4.1", "max")).toBe(false);
		expect(isTierAllowed(starter, "black-forest-labs/flux-2-pro", "max")).toBe(true);
		expect(
			isTierAllowed([...starter, "google/nano-banana-2:max"], "google/nano-banana-2", "max"),
		).toBe(true);
		expect(isTierAllowed(null, "google/nano-banana-2", "max")).toBe(true);
		expect(isTierAllowed([], "recraft-ai/recraft-remove-background", "standard")).toBe(true);
	});
});

describe("allowed_models migration", () => {
	const LIVE_FREE = [
		"black-forest-labs/flux-schnell",
		"black-forest-labs/flux-dev",
		"black-forest-labs/flux-redux-schnell",
		"black-forest-labs/flux-kontext-pro",
		"black-forest-labs/flux-2-dev",
	];
	const LIVE_STARTER = [
		...LIVE_FREE,
		"black-forest-labs/flux-1.1-pro",
		"black-forest-labs/flux-2-pro",
	];
	const LIVE_PREMIUM = [
		...LIVE_STARTER,
		"google/nano-banana-pro",
		"black-forest-labs/flux-redux-dev",
		"black-forest-labs/flux-1.1-pro-ultra",
	];

	test("maps the live product rows", () => {
		expect(phase35AllowedModels("Free", LIVE_FREE)?.sort()).toEqual(
			[
				"black-forest-labs/flux-2-klein-4b",
				"black-forest-labs/flux-2-dev",
				"prunaai/p-image-edit",
				"google/nano-banana-2-lite",
			].sort(),
		);
		expect(phase35AllowedModels("Starter", LIVE_STARTER)?.sort()).toEqual(
			[...PHASE35_LINEUP].sort(),
		);
		expect(phase35AllowedModels("Premium Tier", LIVE_PREMIUM)).toBeNull();
		expect(phase35AllowedModels("Creator", ["x"])).toBeNull();
		expect(
			phase35AllowedModels("Custom", ["black-forest-labs/flux-dev", "google/nano-banana-pro"]),
		).toEqual(["black-forest-labs/flux-2-dev", "google/nano-banana-2"]);
		// Every migrated id is a real, current catalog model.
		for (const id of phase35AllowedModels("Starter", LIVE_STARTER) ?? []) {
			expect(getCatalogModel(id)?.hidden).toBeFalsy();
		}
	});

	test("rewrites a fixture DB once, leaves NULL rows alone, and is idempotent", () => {
		const db = new Database(":memory:");
		db.exec(
			"CREATE TABLE subscription_products (id TEXT PRIMARY KEY, name TEXT, allowed_models TEXT)",
		);
		const insert = db.prepare("INSERT INTO subscription_products VALUES (?, ?, ?)");
		insert.run("free", "Free", JSON.stringify(LIVE_FREE));
		insert.run("starter", "Starter", JSON.stringify(LIVE_STARTER));
		insert.run("premium", "Premium Tier", JSON.stringify(LIVE_PREMIUM));
		insert.run("pro", "Pro", null);
		insert.run("bad", "Broken", "not json");

		expect(migrateAllowedModelsToLineup(db)).toBe(3);
		const rows = Object.fromEntries(
			(
				db.prepare("SELECT id, allowed_models FROM subscription_products").all() as {
					id: string;
					allowed_models: string | null;
				}[]
			).map((r) => [r.id, r.allowed_models]),
		);
		expect(rows.pro).toBeNull();
		expect(rows.premium).toBeNull();
		expect(rows.bad).toBe("not json");
		expect(JSON.parse(rows.starter as string)).toHaveLength(13);
		// Running it again changes nothing.
		expect(migrateAllowedModelsToLineup(db)).toBe(0);
	});

	test("is recorded in schema_migrations so it runs once per database", () => {
		const row = getDb()
			.prepare("SELECT name FROM schema_migrations WHERE name = '3.5_allowed_models_lineup'")
			.get();
		expect(row).toBeTruthy();
	});
});

describe("/api/models", () => {
	test("returns the visible catalog with per-tier credits and no dollar prices", async () => {
		const app = await getApp();
		const body = (await app.inject({ method: "GET", url: "/api/models" })).json();
		expect(body.models).toHaveLength(13);
		expect(body.models.some((m: { hidden: boolean }) => m.hidden)).toBe(false);
		const nb2 = body.models.find((m: { id: string }) => m.id === "google/nano-banana-2");
		expect(nb2.creditCost).toBe(3);
		expect(nb2.group).toBe("Best quality");
		expect(
			nb2.tiers.map((t: { tier: string; credits: number[] }) => [t.tier, t.credits[0]]),
		).toEqual([
			["draft", 3],
			["standard", 5],
			["max", 7],
		]);
		expect(nb2.ratioChoices.landscape).toContain("8:1");
		expect(JSON.stringify(body)).not.toMatch(/perImage|perOutputMp|price/);
		expect(body.tools.map((t: { creditCost: number }) => t.creditCost)).toEqual([1, 1, 1]);

		const legacy = (await app.inject({ method: "GET", url: "/api/models?all=1" })).json();
		expect(legacy.models).toHaveLength(13); // ?all=1 is admin-only
	});
});
