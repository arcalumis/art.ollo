// Under Bun, light-my-request's fake ServerResponse never reports `writableEnded = true` after
// end(). Fastify's `reply.sent` reads that flag, so with app.inject() a preHandler that replies
// 401/403 does NOT stop the chain and the route handler runs anyway (then crashes with
// ERR_HTTP_HEADERS_SENT). A real Bun HTTP server is unaffected (verified with app.listen()).
// This shim makes injected responses report writableEnded once they have finished, so tests
// exercise the same control flow as production. Import it before building the app.
import http from "node:http";
// @ts-expect-error internal module without type declarations
import Response from "light-my-request/lib/response.js";

const FINISHED = Symbol.for("ollo.test.injectFinished");
const proto = (Response as unknown as { prototype: Record<string | symbol, unknown> }).prototype;

if (!proto[FINISHED]) {
	proto[FINISHED] = "patched";

	const nativeDescriptor =
		Object.getOwnPropertyDescriptor(http.ServerResponse.prototype, "writableEnded") ??
		Object.getOwnPropertyDescriptor(http.OutgoingMessage.prototype, "writableEnded");

	const originalEnd = proto.end as (...args: unknown[]) => unknown;
	proto.end = function (this: http.ServerResponse & Record<symbol, unknown>, ...args: unknown[]) {
		this.once("finish", () => {
			this[FINISHED] = true;
		});
		return originalEnd.apply(this, args);
	};

	Object.defineProperty(proto, "writableEnded", {
		configurable: true,
		get(this: Record<symbol, unknown>) {
			return this[FINISHED] === true || nativeDescriptor?.get?.call(this) === true;
		},
	});
}
