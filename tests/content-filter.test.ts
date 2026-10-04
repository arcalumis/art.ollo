// Safety-filter blocks: Replicate's E005 "flagged as sensitive" (and NSFW
// checkers) are told apart from other failures, per output. Partly blocked
// runs keep what succeeded, refund the rest and say so; fully blocked runs
// return CONTENT_FILTERED. Nothing here touches the network.
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { getDb } from "../server/db";
import { __testing, isContentFilterMessage } from "../server/services/replicate";
import { describeBlockedOutputs, describeGenerationError } from "../src/components/billing/generationErrors";
import { fake, installFakes, nextIp, seedUpload } from "./generation-fakes";
import { type TestUser, authHeader, createUser, creditBalance, getApp } from "./helpers";

const FLUX2_PRO = "black-forest-labs/flux-2-pro"; // 2 credits at Standard, one image per prediction
const E005 =
	"The input or output was flagged as sensitive. Please try again with different inputs. (E005)";

beforeAll(() => {
	installFakes();
});

beforeEach(() => {
	fake.reset();
	__testing.setTiming({ pollIntervalMs: 5, timeoutMs: 2_000 });
});

async function post(user: TestUser, url: string, body: Record<string, unknown>) {
	const app = await getApp();
	return app.inject({
		method: "POST",
		url,
		headers: authHeader(user),
		payload: body,
		remoteAddress: nextIp(),
	});
}

function refunds(userId: string) {
	return getDb()
		.prepare(
			"SELECT amount, reason FROM user_credits WHERE user_id = ? AND credit_type = 'refund' ORDER BY rowid",
		)
		.all(userId) as { amount: number; reason: string }[];
}

async function filteredCount(model: string): Promise<number> {
	const admin = createUser({ isAdmin: true });
	const app = await getApp();
	const res = await app.inject({
		method: "GET",
		url: "/api/admin/models/economics?days=1",
		headers: authHeader(admin),
		remoteAddress: nextIp(),
	});
	expect(res.statusCode).toBe(200);
	const row = (res.json().models as { id: string; filtered: number }[]).find((m) => m.id === model);
	return row?.filtered ?? 0;
}

describe("classifying failures", () => {
	test("E005, 'flagged as sensitive' and NSFW messages are safety-filter blocks", () => {
		expect(isContentFilterMessage(E005)).toBe(true);
		expect(isContentFilterMessage("NSFW content detected. Try running it again.")).toBe(true);
		expect(isContentFilterMessage("Output blocked by the safety filter")).toBe(true);
		expect(isContentFilterMessage("Request rejected: content policy violation")).toBe(true);
	});

	test("ordinary failures are not", () => {
		expect(isContentFilterMessage("model exploded")).toBe(false);
		expect(isContentFilterMessage("CUDA out of memory")).toBe(false);
		expect(isContentFilterMessage("Prediction interrupted; please retry (code: PA)")).toBe(false);
	});
});

describe("/api/generate", () => {
	test("partial block (1 of 4 ok): 1 saved, 3 refunded, blocked in the response and parameters", async () => {
		const user = createUser({ credits: 20 });
		const before = await filteredCount(FLUX2_PRO);
		fake.reset({ kind: "mixed", errors: [E005, null, E005, E005] });

		const res = await post(user, "/api/generate", {
			prompt: "McDonald's prison break",
			model: FLUX2_PRO,
			tier: "standard",
			numOutputs: 4,
		});
		expect(res.statusCode).toBe(200);
		const body = res.json();
		expect(body.images).toHaveLength(1);
		expect(body.creditsCharged).toBe(2);
		expect(body.blocked).toEqual({ count: 3, reason: "content_filter", creditsReturned: 6 });
		expect(creditBalance(user.id)).toBe(18);
		expect(refunds(user.id).map((r) => r.amount)).toEqual([6]);
		expect(refunds(user.id)[0].reason).toMatch(/^Blocked by safety filter \(3 of 4\)/);

		const row = getDb()
			.prepare("SELECT parameters FROM generations WHERE id = ?")
			.get(body.id) as { parameters: string };
		const params = JSON.parse(row.parameters);
		expect(params.blocked).toEqual({ count: 3, reason: "content_filter", creditsReturned: 6 });
		expect(params.creditsCharged).toBe(2);

		// The step note, with the real numbers.
		expect(describeBlockedOutputs(params.blocked, params.numOutputs)).toBe(
			"3 of 4 images were blocked by the model's safety filter. 6 credits were returned.",
		);
		expect(await filteredCount(FLUX2_PRO)).toBe(before + 3);
	});

	test("all blocked: CONTENT_FILTERED (422) and a full refund", async () => {
		const user = createUser({ credits: 20 });
		const before = await filteredCount(FLUX2_PRO);
		fake.reset({ kind: "fail", error: E005 });

		const res = await post(user, "/api/generate", {
			prompt: "x",
			model: FLUX2_PRO,
			tier: "standard",
			numOutputs: 4,
		});
		expect(res.statusCode).toBe(422);
		expect(res.json()).toMatchObject({
			status: "failed",
			code: "CONTENT_FILTERED",
			error:
				"The model's safety filter blocked this image. Your credits were returned. Try rewording the prompt.",
		});
		expect(creditBalance(user.id)).toBe(20);
		expect(await filteredCount(FLUX2_PRO)).toBe(before + 4);
	});

	test("a single blocked image is CONTENT_FILTERED too", async () => {
		const user = createUser({ credits: 20 });
		fake.reset({ kind: "fail", error: E005 });
		const res = await post(user, "/api/generate", { prompt: "x", model: FLUX2_PRO });
		expect(res.statusCode).toBe(422);
		expect(res.json().code).toBe("CONTENT_FILTERED");
		expect(creditBalance(user.id)).toBe(20);
	});

	test("a non-filter failure isn't labelled as filtered", async () => {
		const user = createUser({ credits: 20 });
		const before = await filteredCount(FLUX2_PRO);

		// Partial: one output failed for another reason.
		fake.reset({ kind: "mixed", errors: [null, "CUDA out of memory"] });
		const partial = await post(user, "/api/generate", {
			prompt: "x",
			model: FLUX2_PRO,
			numOutputs: 2,
		});
		expect(partial.statusCode).toBe(200);
		expect(partial.json().images).toHaveLength(1);
		expect(partial.json().blocked).toBeUndefined();
		const row = getDb()
			.prepare("SELECT parameters FROM generations WHERE id = ?")
			.get(partial.json().id) as { parameters: string };
		expect(JSON.parse(row.parameters).blocked).toBeUndefined();

		// Total: everything failed for another reason.
		fake.reset({ kind: "fail" });
		const failed = await post(user, "/api/generate", { prompt: "x", model: FLUX2_PRO, numOutputs: 2 });
		expect(failed.statusCode).toBe(500);
		expect(failed.json().code).toBe("GENERATION_FAILED");

		// Mixed total failure: not reported as a filter block.
		fake.reset({ kind: "mixed", errors: [E005, "CUDA out of memory"] });
		const mixed = await post(user, "/api/generate", { prompt: "x", model: FLUX2_PRO, numOutputs: 2 });
		expect(mixed.json().code).toBe("GENERATION_FAILED");

		expect(creditBalance(user.id)).toBe(20 - 2);
		expect(await filteredCount(FLUX2_PRO)).toBe(before);
	});

	test("one blocked and one other failure of three: only the blocked one is reported", async () => {
		const user = createUser({ credits: 20 });
		fake.reset({ kind: "mixed", errors: [null, E005, "CUDA out of memory"] });
		const res = await post(user, "/api/generate", { prompt: "x", model: FLUX2_PRO, numOutputs: 3 });
		expect(res.statusCode).toBe(200);
		expect(res.json().blocked).toEqual({ count: 1, reason: "content_filter", creditsReturned: 2 });
		expect(res.json().creditsCharged).toBe(2);
		expect(creditBalance(user.id)).toBe(18);
	});
});

describe("/api/tools", () => {
	test("a blocked tool run returns CONTENT_FILTERED and refunds", async () => {
		const user = createUser({ credits: 5 });
		const image = seedUpload(user.id);
		fake.reset({ kind: "fail", error: E005 });
		const res = await post(user, "/api/tools/remove-background", { image });
		expect(res.statusCode).toBe(422);
		expect(res.json().code).toBe("CONTENT_FILTERED");
		expect(creditBalance(user.id)).toBe(5);
	});
});

describe("copy", () => {
	test("CONTENT_FILTERED has its own message with Retry", () => {
		const copy = describeGenerationError("CONTENT_FILTERED");
		expect(copy.title).toBe("The model's safety filter blocked this image");
		expect(copy.detail).toBe("Your credits were returned. Try rewording the prompt.");
		expect(copy.actions).toEqual(["retry"]);
	});

	test("the step note handles one image, own-key runs and bad records", () => {
		expect(describeBlockedOutputs({ count: 1, creditsReturned: 2 }, 2)).toBe(
			"1 of 2 images was blocked by the model's safety filter. 2 credits were returned.",
		);
		expect(describeBlockedOutputs({ count: 2, creditsReturned: 0 }, 4)).toBe(
			"2 of 4 images were blocked by the model's safety filter.",
		);
		expect(describeBlockedOutputs(undefined, 4)).toBeNull();
		expect(describeBlockedOutputs({ count: 0 }, 4)).toBeNull();
		expect(describeBlockedOutputs("junk", 4)).toBeNull();
	});
});
