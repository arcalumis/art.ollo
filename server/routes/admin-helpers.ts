import type { FastifyReply, FastifyRequest } from "fastify";
import type { AuditActor } from "../services/admin-audit";
import type { Check } from "../services/admin-validation";

/** The signed-in admin, for audit rows. */
export function actorOf(request: FastifyRequest): AuditActor | undefined {
	return request.user
		? { userId: request.user.userId, username: request.user.username }
		: undefined;
}

/** Send a 400 for a failed check; returns true when the reply was sent. */
export function rejected<T>(
	reply: FastifyReply,
	check: Check<T>,
): check is { ok: false; code: string; error: string } {
	if (check.ok) return false;
	reply.status(400).send({ error: check.error, code: check.code });
	return true;
}
