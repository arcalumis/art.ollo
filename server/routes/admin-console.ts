/**
 * Admin console read models and moderation. Registered inside adminRoutes, so every route
 * here inherits its auth + admin preHandlers.
 */
import type { FastifyInstance } from "fastify";
import { getDb } from "../db";
import { listAudit, writeAudit } from "../services/admin-audit";
import { getHealth } from "../services/admin-health";
import {
	getModelEconomics,
	getOverview,
	getRecentImages,
	listPayments,
} from "../services/admin-metrics";
import { listCurrentSubscriptions } from "../services/admin-subscriptions";
import { checkReason } from "../services/admin-validation";
import { actorOf, rejected } from "./admin-helpers";

const int = (v: string | undefined, fallback: number) => {
	const n = Number.parseInt(v ?? "", 10);
	return Number.isFinite(n) ? n : fallback;
};

export async function adminConsoleRoutes(fastify: FastifyInstance): Promise<void> {
	fastify.get("/api/admin/overview", async () => getOverview());

	fastify.get<{ Querystring: { plan?: string; status?: string; source?: string } }>(
		"/api/admin/subscriptions",
		async (request) => {
			const all = listCurrentSubscriptions();
			const { plan, status, source } = request.query;
			const rows = all.filter(
				(s) =>
					(!plan || s.plan === plan) &&
					(!source || s.source === source) &&
					(!status ||
						(status === "paid"
							? s.mrrCents > 0
							: status === "past_due"
								? s.pastDue
								: s.status === status)),
			);
			return {
				subscriptions: rows,
				plans: Array.from(new Set(all.map((s) => s.plan))).sort(),
				totals: {
					users: all.length,
					paid: all.filter((s) => s.mrrCents > 0).length,
					mrrCents: all.reduce((sum, s) => sum + s.mrrCents, 0),
					pastDue: all.filter((s) => s.pastDue).length,
					stale: all.filter((s) => s.stale).length,
				},
			};
		},
	);

	fastify.get<{
		Querystring: {
			method?: string;
			status?: string;
			page?: string;
			limit?: string;
			userId?: string;
		};
	}>("/api/admin/payments", async (request) =>
		listPayments({
			method: request.query.method,
			status: request.query.status,
			userId: request.query.userId,
			page: int(request.query.page, 1),
			limit: int(request.query.limit, 50),
		}),
	);

	fastify.get<{ Querystring: { days?: string } }>(
		"/api/admin/models/economics",
		async (request) => {
			const days = Math.min(3650, Math.max(0, int(request.query.days, 30)));
			return getModelEconomics(days);
		},
	);

	fastify.get("/api/admin/health", async () => getHealth());

	fastify.get<{
		Querystring: { page?: string; limit?: string; userId?: string; includeRemoved?: string };
	}>("/api/admin/moderation/images", async (request) =>
		getRecentImages({
			page: int(request.query.page, 1),
			limit: int(request.query.limit, 48),
			userId: request.query.userId,
			includeRemoved: request.query.includeRemoved === "1",
		}),
	);

	// Remove an image: soft delete with a reason, revoke its public share links.
	fastify.post<{ Params: { id: string }; Body: { reason?: unknown } }>(
		"/api/admin/moderation/images/:id/remove",
		async (request, reply) => {
			const db = getDb();
			const reason = checkReason(request.body?.reason);
			if (rejected(reply, reason)) return;
			const gen = db
				.prepare(
					"SELECT id, user_id, deleted_at, moderated_at FROM generations WHERE id = ? AND purged_at IS NULL",
				)
				.get(request.params.id) as
				| {
						id: string;
						user_id: string | null;
						deleted_at: string | null;
						moderated_at: string | null;
				  }
				| undefined;
			if (!gen) return reply.status(404).send({ error: "Image not found", code: "NOT_FOUND" });
			if (gen.moderated_at)
				return reply.status(409).send({ error: "Already removed", code: "ALREADY_REMOVED" });
			db.transaction(() => {
				db.prepare(`
					UPDATE generations
					SET deleted_at = COALESCE(deleted_at, datetime('now')), moderated_at = datetime('now'),
						moderation_reason = ?, moderated_by = ?
					WHERE id = ?
				`).run(reason.value, request.user?.userId ?? null, gen.id);
				const revoked = db
					.prepare(
						"UPDATE share_links SET revoked_at = datetime('now') WHERE generation_id = ? AND revoked_at IS NULL",
					)
					.run(gen.id).changes;
				writeAudit(actorOf(request), {
					action: "moderation.remove",
					targetType: "generation",
					targetId: gen.id,
					before: { deleted: !!gen.deleted_at, userId: gen.user_id },
					after: { deleted: true, shareLinksRevoked: revoked },
					reason: reason.value,
					ip: request.ip,
				});
			})();
			return { success: true };
		},
	);

	fastify.get<{
		Querystring: {
			action?: string;
			targetType?: string;
			targetId?: string;
			adminUserId?: string;
			q?: string;
			page?: string;
			limit?: string;
		};
	}>("/api/admin/audit", async (request) => {
		const q = request.query;
		return listAudit({
			action: q.action || undefined,
			targetType: q.targetType || undefined,
			targetId: q.targetId || undefined,
			adminUserId: q.adminUserId || undefined,
			q: q.q ? q.q.slice(0, 100) : undefined,
			page: int(q.page, 1),
			limit: int(q.limit, 50),
		});
	});
}
