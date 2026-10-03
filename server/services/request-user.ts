import type { FastifyRequest } from "fastify";

/**
 * The authenticated user's id on a route guarded by authMiddleware.
 * authMiddleware replies 401 before the handler runs when there is no user, so
 * a missing id here is a wiring bug and throws (-> 500) rather than querying
 * with `undefined`.
 */
export function requireUserId(request: FastifyRequest): string {
	const id = request.user?.userId;
	if (!id) throw new Error("requireUserId called on a route without authMiddleware");
	return id;
}
