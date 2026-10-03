import type { SQLQueryBindings } from "bun:sqlite";
import crypto from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getDb } from "../db";
import { authMiddleware } from "../middleware/auth";
import { writeAudit } from "../services/admin-audit";
import { getUserDetail, listUsers } from "../services/admin-metrics";
import {
	checkBoostDays,
	checkCreditAmount,
	checkCreditCost,
	checkCreditPackage,
	checkOverrideKey,
	checkProductFields,
	checkReason,
} from "../services/admin-validation";
import { reserveEmailSend, sendMagicLinkEmail } from "../services/email";
import {
	createCreditPackage,
	deleteCreditPackage,
	getAllCreditPackages,
	updateCreditPackage,
} from "../services/solana";
import {
	cancelBoost,
	getActiveBoost,
	getAllActiveBoosts,
	grantSubscriptionBoost,
} from "../services/subscription-boost";
import { createEmailToken } from "../services/tokens";
import {
	addCredits,
	assignSubscription,
	deleteModelCreditCost,
	setModelCreditCost,
} from "../services/usage";
import { adminConsoleRoutes } from "./admin-console";
import { actorOf, rejected } from "./admin-helpers";
import { hashPassword, normalizeEmail } from "./auth";

const MAGIC_LINK_EXPIRY_MINUTES = Number(process.env.MAGIC_LINK_EXPIRY_MINUTES) || 15;

interface ProductRow {
	id: string;
	name: string;
	description: string | null;
	monthly_image_limit: number | null;
	monthly_cost_limit: number | null;
	daily_image_limit: number | null;
	bonus_credits: number;
	price: number;
	price_sol: number | null;
	available_for_usd: number;
	available_for_sol: number;
	is_active: number;
	allowed_models: string | null;
	credit_refill_amount: number;
	topoff_interval_hours: number;
	stripe_price_id: string | null;
	created_at: string;
}

interface UserStateRow {
	id: string;
	username: string;
	email: string | null;
	is_admin: number;
	is_active: number | null;
	deleted_at: string | null;
	token_version: number | null;
}

async function adminOnly(request: FastifyRequest, reply: FastifyReply): Promise<void> {
	if (!request.user?.isAdmin) {
		return reply.status(403).send({ error: "Admin access required", code: "ADMIN_REQUIRED" });
	}
}

function userState(id: string): UserStateRow | undefined {
	return getDb()
		.prepare(
			"SELECT id, username, email, is_admin, is_active, deleted_at, token_version FROM users WHERE id = ?",
		)
		.get(id) as UserStateRow | undefined;
}

function balanceOf(userId: string): number {
	return (
		getDb()
			.prepare("SELECT COALESCE(SUM(amount), 0) AS total FROM user_credits WHERE user_id = ?")
			.get(userId) as {
			total: number;
		}
	).total;
}

/** Other admins who can still sign in (active, not deleted). */
function otherActiveAdmins(excludeId: string): number {
	return (
		getDb()
			.prepare(
				"SELECT COUNT(*) AS n FROM users WHERE is_admin = 1 AND COALESCE(is_active, 1) = 1 AND deleted_at IS NULL AND id != ?",
			)
			.get(excludeId) as { n: number }
	).n;
}

function productDto(product: ProductRow, activeUsers: number) {
	let allowedModels: string[] | null = null;
	try {
		allowedModels = product.allowed_models ? JSON.parse(product.allowed_models) : null;
	} catch {
		allowedModels = null;
	}
	return {
		id: product.id,
		name: product.name,
		description: product.description,
		monthlyImageLimit: product.monthly_image_limit,
		monthlyCostLimit: product.monthly_cost_limit,
		dailyImageLimit: product.daily_image_limit,
		bonusCredits: product.bonus_credits,
		price: product.price,
		priceSol: product.price_sol,
		availableForUsd: product.available_for_usd === 1,
		availableForSol: product.available_for_sol === 1,
		isActive: product.is_active === 1,
		allowedModels,
		creditRefillAmount: product.credit_refill_amount || 0,
		topoffIntervalHours: product.topoff_interval_hours || 24,
		stripePriceId: product.stripe_price_id || null,
		createdAt: product.created_at,
		activeUsers,
	};
}

function getProduct(id: string) {
	const row = getDb().prepare("SELECT * FROM subscription_products WHERE id = ?").get(id) as
		| ProductRow
		| undefined;
	return row ? productDto(row, 0) : null;
}

/** Create a sign-in link for a user and email it (respects the per-recipient and global caps). */
async function sendSignInLink(
	user: { id: string; username: string; email: string | null },
	ip: string,
): Promise<{ ok: true } | { ok: false; status: number; code: string; error: string }> {
	if (!user.email)
		return { ok: false, status: 400, code: "NO_EMAIL", error: "This user has no email address." };
	if (!reserveEmailSend(user.email, "admin_magic_link", ip)) {
		return {
			ok: false,
			status: 429,
			code: "EMAIL_CAP",
			error: "This address has had too many emails recently. Try again later.",
		};
	}
	const token = createEmailToken({
		userId: user.id,
		type: "magic_link",
		rememberMe: false,
		expiresInMinutes: MAGIC_LINK_EXPIRY_MINUTES,
	});
	const result = await sendMagicLinkEmail(user.email, user.username, token, false);
	if (!result.success) {
		return {
			ok: false,
			status: 502,
			code: "EMAIL_FAILED",
			error: "The email couldn't be sent. Try again later.",
		};
	}
	return { ok: true };
}

export async function adminRoutes(fastify: FastifyInstance): Promise<void> {
	fastify.addHook("preHandler", authMiddleware);
	fastify.addHook("preHandler", adminOnly);

	// Overview, subscriptions, payments, models, health, moderation, audit log.
	await fastify.register(adminConsoleRoutes);

	// Small totals (kept for older callers and session tests).
	fastify.get("/api/admin/stats", async () => {
		const db = getDb();
		const row = db
			.prepare(
				"SELECT (SELECT COUNT(*) FROM users) AS users, (SELECT COUNT(*) FROM generations WHERE deleted_at IS NULL) AS generations",
			)
			.get() as { users: number; generations: number };
		return { totalUsers: row.users, totalGenerations: row.generations };
	});

	// ============================================
	// USERS
	// ============================================

	fastify.get<{ Querystring: { search?: string; page?: string; limit?: string; filter?: string } }>(
		"/api/admin/users",
		async (request) => {
			return listUsers({
				search: request.query.search,
				page: Number.parseInt(request.query.page || "1", 10) || 1,
				limit: Number.parseInt(request.query.limit || "25", 10) || 25,
				filter: request.query.filter,
			});
		},
	);

	// Create a user. No password is generated or shown: the user gets a sign-in link by email.
	fastify.post<{
		Body: { username?: unknown; email?: unknown; sendLink?: boolean; reason?: unknown };
	}>("/api/admin/users", async (request, reply) => {
		const db = getDb();
		const username = typeof request.body?.username === "string" ? request.body.username.trim() : "";
		const email = normalizeEmail(request.body?.email);
		if (!username || username.length > 50 || !email) {
			return reply
				.status(400)
				.send({ error: "Username and a valid email are required", code: "INVALID_USER" });
		}
		const reason = checkReason(request.body?.reason ?? "Created from the admin console");
		if (rejected(reply, reason)) return;
		if (db.prepare("SELECT id FROM users WHERE username = ?").get(username)) {
			return reply.status(409).send({ error: "Username already exists", code: "USERNAME_TAKEN" });
		}
		if (db.prepare("SELECT id FROM users WHERE email = ?").get(email)) {
			return reply.status(409).send({ error: "Email already in use", code: "EMAIL_TAKEN" });
		}

		const userId = crypto.randomUUID();
		db.transaction(() => {
			// A random password nobody ever sees (bcrypt, like every other hash); they sign in by link.
			db.prepare(
				"INSERT INTO users (id, username, password_hash, email, is_admin, is_active) VALUES (?, ?, ?, ?, 0, 1)",
			).run(userId, username, hashPassword(crypto.randomBytes(24).toString("base64url")), email);
			const free = db
				.prepare(
					"SELECT id FROM subscription_products WHERE name = 'Free' AND is_active = 1 LIMIT 1",
				)
				.get() as { id: string } | undefined;
			if (free) assignSubscription(userId, free.id);
			writeAudit(actorOf(request), {
				action: "user.create",
				targetType: "user",
				targetId: userId,
				after: { username, email },
				reason: reason.value,
				ip: request.ip,
			});
		})();

		let linkSent = false;
		let linkError: string | undefined;
		if (request.body?.sendLink !== false) {
			const sent = await sendSignInLink({ id: userId, username, email }, request.ip);
			linkSent = sent.ok;
			if (!sent.ok) linkError = sent.error;
		}
		return { id: userId, username, email, linkSent, linkError };
	});

	fastify.get<{ Params: { id: string } }>("/api/admin/users/:id", async (request, reply) => {
		const detail = getUserDetail(request.params.id);
		if (!detail) return reply.status(404).send({ error: "User not found", code: "NOT_FOUND" });
		return detail;
	});

	// Change admin rights, active state or email. Blocks self-demotion, self-deactivation and
	// removing the last admin who can sign in.
	fastify.patch<{
		Params: { id: string };
		Body: { isAdmin?: unknown; isActive?: unknown; email?: unknown; reason?: unknown };
	}>("/api/admin/users/:id", async (request, reply) => {
		const db = getDb();
		const { id } = request.params;
		const body = request.body ?? {};
		const target = userState(id);
		if (!target) return reply.status(404).send({ error: "User not found", code: "NOT_FOUND" });
		const reason = checkReason(body.reason);
		if (rejected(reply, reason)) return;

		if (body.isAdmin !== undefined && typeof body.isAdmin !== "boolean") {
			return reply
				.status(400)
				.send({ error: "isAdmin must be true or false", code: "INVALID_FIELD" });
		}
		if (body.isActive !== undefined && typeof body.isActive !== "boolean") {
			return reply
				.status(400)
				.send({ error: "isActive must be true or false", code: "INVALID_FIELD" });
		}
		const selfId = request.user?.userId;
		if (id === selfId && body.isAdmin === false) {
			return reply
				.status(400)
				.send({ error: "You can't remove your own admin access.", code: "SELF_DEMOTION" });
		}
		if (id === selfId && body.isActive === false) {
			return reply
				.status(400)
				.send({ error: "You can't deactivate your own account.", code: "SELF_DEACTIVATION" });
		}
		const targetIsLiveAdmin = target.is_admin === 1 && target.is_active !== 0 && !target.deleted_at;
		if (
			targetIsLiveAdmin &&
			(body.isAdmin === false || body.isActive === false) &&
			otherActiveAdmins(id) === 0
		) {
			return reply
				.status(400)
				.send({
					error: "This is the last admin who can sign in. Make someone else an admin first.",
					code: "LAST_ADMIN",
				});
		}

		let email: string | null | undefined;
		if (body.email !== undefined) {
			if (body.email === null || body.email === "") email = null;
			else {
				email = normalizeEmail(body.email);
				if (!email)
					return reply.status(400).send({ error: "Invalid email address", code: "INVALID_EMAIL" });
				if (db.prepare("SELECT id FROM users WHERE email = ? AND id != ?").get(email, id)) {
					return reply.status(409).send({ error: "Email already in use", code: "EMAIL_TAKEN" });
				}
			}
		}

		const updates: string[] = [];
		const params: SQLQueryBindings[] = [];
		if (body.isAdmin !== undefined) {
			updates.push("is_admin = ?");
			params.push(body.isAdmin ? 1 : 0);
		}
		if (body.isActive !== undefined) {
			updates.push("is_active = ?");
			params.push(body.isActive ? 1 : 0);
			// Deactivation revokes every outstanding session immediately.
			if (!body.isActive) updates.push("token_version = COALESCE(token_version, 0) + 1");
		}
		if (email !== undefined) {
			updates.push("email = ?");
			params.push(email);
		}
		if (updates.length === 0) return { success: true };

		db.transaction(() => {
			db.prepare(`UPDATE users SET ${updates.join(", ")} WHERE id = ?`).run(...params, id);
			const after = userState(id);
			writeAudit(actorOf(request), {
				action:
					body.isActive !== undefined
						? body.isActive
							? "user.reactivate"
							: "user.deactivate"
						: body.isAdmin !== undefined
							? body.isAdmin
								? "user.grant_admin"
								: "user.revoke_admin"
							: "user.update_email",
				targetType: "user",
				targetId: id,
				before: {
					isAdmin: target.is_admin === 1,
					isActive: target.is_active !== 0,
					email: target.email,
				},
				after: {
					isAdmin: after?.is_admin === 1,
					isActive: after?.is_active !== 0,
					email: after?.email ?? null,
				},
				reason: reason.value,
				ip: request.ip,
			});
		})();
		return { success: true };
	});

	// Grant or deduct credits: an integer within ±10,000 that never takes the balance below 0.
	fastify.post<{ Params: { id: string }; Body: { amount?: unknown; reason?: unknown } }>(
		"/api/admin/users/:id/credits",
		async (request, reply) => {
			const db = getDb();
			const { id } = request.params;
			if (!userState(id))
				return reply.status(404).send({ error: "User not found", code: "NOT_FOUND" });
			const amount = checkCreditAmount(request.body?.amount);
			if (rejected(reply, amount)) return;
			const reason = checkReason(request.body?.reason);
			if (rejected(reply, reason)) return;

			const apply = db.transaction(
				(): { ok: true; before: number; after: number } | { ok: false; before: number } => {
					const before = balanceOf(id);
					if (before + amount.value < 0) return { ok: false, before };
					addCredits(
						id,
						amount.value,
						amount.value > 0 ? "admin_grant" : "admin_deduct",
						reason.value,
					);
					const after = before + amount.value;
					writeAudit(actorOf(request), {
						action: amount.value > 0 ? "credits.grant" : "credits.deduct",
						targetType: "user",
						targetId: id,
						before: { balance: before },
						after: { balance: after, amount: amount.value },
						reason: reason.value,
						ip: request.ip,
					});
					return { ok: true, before, after };
				},
			);
			const result = apply.immediate();
			if (!result.ok) {
				return reply.status(400).send({
					error: `That would leave a negative balance (they have ${result.before} credits).`,
					code: "NEGATIVE_BALANCE",
					balance: result.before,
				});
			}
			return { success: true, newBalance: result.after };
		},
	);

	// Change plan. Stripe-billed plans are changed in Stripe, not here.
	fastify.post<{
		Params: { id: string };
		Body: { productId?: unknown; reason?: unknown; grantBonus?: unknown };
	}>("/api/admin/users/:id/subscription", async (request, reply) => {
		const db = getDb();
		const { id } = request.params;
		if (!userState(id))
			return reply.status(404).send({ error: "User not found", code: "NOT_FOUND" });
		const reason = checkReason(request.body?.reason);
		if (rejected(reply, reason)) return;
		const productId = typeof request.body?.productId === "string" ? request.body.productId : "";
		const product = db
			.prepare("SELECT id, name FROM subscription_products WHERE id = ? AND is_active = 1")
			.get(productId) as { id: string; name: string } | undefined;
		if (!product)
			return reply.status(404).send({ error: "Plan not found", code: "PRODUCT_NOT_FOUND" });

		const current = db
			.prepare(`
					SELECT us.id, us.stripe_subscription_id, us.status, sp.name
					FROM user_subscriptions us JOIN subscription_products sp ON sp.id = us.product_id
					WHERE us.user_id = ? AND us.status IN ('active', 'trialing', 'past_due')
					ORDER BY us.created_at DESC LIMIT 1
				`)
			.get(id) as
			| { id: string; stripe_subscription_id: string | null; status: string; name: string }
			| undefined;
		if (current?.stripe_subscription_id) {
			return reply.status(409).send({
				error: "This user pays through Stripe. Change or cancel the plan in Stripe first.",
				code: "STRIPE_MANAGED",
				stripeSubscriptionId: current.stripe_subscription_id,
			});
		}

		const subscriptionId = db.transaction(() => {
			const sid = assignSubscription(id, product.id, {
				grantBonus: request.body?.grantBonus === true,
				bonusReason: `Plan change by admin: ${product.name}`,
			});
			writeAudit(actorOf(request), {
				action: "subscription.change",
				targetType: "user",
				targetId: id,
				before: current ? { plan: current.name, status: current.status } : { plan: "Free" },
				after: {
					plan: product.name,
					subscriptionId: sid,
					grantBonus: request.body?.grantBonus === true,
				},
				reason: reason.value,
				ip: request.ip,
			});
			return sid;
		})();
		return { success: true, subscriptionId };
	});

	// Sign out everywhere: bump token_version so every outstanding session stops working.
	fastify.post<{ Params: { id: string }; Body: { reason?: unknown } }>(
		"/api/admin/users/:id/sign-out",
		async (request, reply) => {
			const db = getDb();
			const { id } = request.params;
			const target = userState(id);
			if (!target) return reply.status(404).send({ error: "User not found", code: "NOT_FOUND" });
			const reason = checkReason(request.body?.reason);
			if (rejected(reply, reason)) return;
			db.transaction(() => {
				db.prepare(
					"UPDATE users SET token_version = COALESCE(token_version, 0) + 1 WHERE id = ?",
				).run(id);
				writeAudit(actorOf(request), {
					action: "user.sign_out_everywhere",
					targetType: "user",
					targetId: id,
					before: { sessionVersion: target.token_version ?? 0 },
					after: { sessionVersion: (target.token_version ?? 0) + 1 },
					reason: reason.value,
					ip: request.ip,
				});
			})();
			return { success: true };
		},
	);

	// Email the user a sign-in link (replaces showing a generated password).
	fastify.post<{ Params: { id: string }; Body: { reason?: unknown } }>(
		"/api/admin/users/:id/sign-in-link",
		async (request, reply) => {
			const target = userState(request.params.id);
			if (!target) return reply.status(404).send({ error: "User not found", code: "NOT_FOUND" });
			if (target.is_active === 0 || target.deleted_at) {
				return reply
					.status(400)
					.send({ error: "Reactivate this account first.", code: "USER_INACTIVE" });
			}
			const reason = checkReason(request.body?.reason);
			if (rejected(reply, reason)) return;
			const sent = await sendSignInLink(target, request.ip);
			if (!sent.ok) return reply.status(sent.status).send({ error: sent.error, code: sent.code });
			writeAudit(actorOf(request), {
				action: "user.send_sign_in_link",
				targetType: "user",
				targetId: target.id,
				after: { email: target.email },
				reason: reason.value,
				ip: request.ip,
			});
			return { success: true };
		},
	);

	// ============================================
	// BOOSTS
	// ============================================

	fastify.get("/api/admin/boosts", async () => {
		const db = getDb();
		return {
			boosts: getAllActiveBoosts().map((boost) => {
				const user = db
					.prepare("SELECT username, email FROM users WHERE id = ?")
					.get(boost.userId) as { username: string; email: string | null } | undefined;
				return { ...boost, username: user?.username || "Unknown", email: user?.email };
			}),
		};
	});

	fastify.get<{ Params: { id: string } }>("/api/admin/users/:id/boost", async (request, reply) => {
		if (!userState(request.params.id))
			return reply.status(404).send({ error: "User not found", code: "NOT_FOUND" });
		return { boost: getActiveBoost(request.params.id) };
	});

	// Comp a boost: 1 to 365 days, with a reason.
	fastify.post<{
		Params: { id: string };
		Body: { productId?: unknown; durationDays?: unknown; reason?: unknown };
	}>("/api/admin/users/:id/boost", async (request, reply) => {
		const db = getDb();
		const { id } = request.params;
		if (!userState(id))
			return reply.status(404).send({ error: "User not found", code: "NOT_FOUND" });
		const days = checkBoostDays(request.body?.durationDays);
		if (rejected(reply, days)) return;
		const reason = checkReason(request.body?.reason);
		if (rejected(reply, reason)) return;
		const productId = typeof request.body?.productId === "string" ? request.body.productId : "";
		if (!productId)
			return reply
				.status(400)
				.send({ error: "Choose a plan for the boost", code: "PRODUCT_REQUIRED" });

		const before = getActiveBoost(id);
		const boost = db.transaction(() => {
			const b = grantSubscriptionBoost(
				id,
				productId,
				days.value,
				request.user?.userId ?? null,
				reason.value,
			);
			if (!b) return null;
			writeAudit(actorOf(request), {
				action: "boost.grant",
				targetType: "user",
				targetId: id,
				before: before ? { plan: before.boostProductName, endsAt: before.endsAt } : null,
				after: { plan: b.boostProductName, endsAt: b.endsAt, days: days.value },
				reason: reason.value,
				ip: request.ip,
			});
			return b;
		})();
		if (!boost)
			return reply.status(404).send({ error: "Plan not found", code: "PRODUCT_NOT_FOUND" });
		return { success: true, boost };
	});

	fastify.delete<{ Params: { id: string }; Body: { reason?: unknown } }>(
		"/api/admin/users/:id/boost",
		async (request, reply) => {
			const { id } = request.params;
			if (!userState(id))
				return reply.status(404).send({ error: "User not found", code: "NOT_FOUND" });
			const reason = checkReason(request.body?.reason);
			if (rejected(reply, reason)) return;
			const boost = getActiveBoost(id);
			if (!boost) return reply.status(404).send({ error: "No active boost", code: "NO_BOOST" });
			const success = cancelBoost(boost.id);
			writeAudit(actorOf(request), {
				action: "boost.cancel",
				targetType: "user",
				targetId: id,
				before: { plan: boost.boostProductName, endsAt: boost.endsAt },
				reason: reason.value,
				ip: request.ip,
			});
			return { success };
		},
	);

	// ============================================
	// PRODUCTS (plans)
	// ============================================

	fastify.get("/api/admin/products", async () => {
		const db = getDb();
		const products = db
			.prepare("SELECT * FROM subscription_products ORDER BY price ASC, created_at ASC")
			.all() as ProductRow[];
		const counts = new Map(
			(
				db
					.prepare(
						"SELECT product_id, COUNT(DISTINCT user_id) AS n FROM user_subscriptions WHERE status IN ('active', 'trialing', 'past_due') GROUP BY product_id",
					)
					.all() as Array<{ product_id: string; n: number }>
			).map((r) => [r.product_id, r.n]),
		);
		return { products: products.map((p) => productDto(p, counts.get(p.id) ?? 0)) };
	});

	fastify.post<{ Body: Record<string, unknown> }>("/api/admin/products", async (request, reply) => {
		const db = getDb();
		const body = request.body ?? {};
		const valid = checkProductFields(body, true);
		if (rejected(reply, valid)) return;
		const id = crypto.randomUUID();
		const num = (v: unknown) => (typeof v === "number" ? v : null);
		db.transaction(() => {
			db.prepare(
				`INSERT INTO subscription_products
				(id, name, description, monthly_image_limit, monthly_cost_limit, daily_image_limit, bonus_credits, price, price_sol,
				 available_for_usd, available_for_sol, allowed_models, credit_refill_amount, topoff_interval_hours, stripe_price_id)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			).run(
				id,
				String(body.name).trim(),
				typeof body.description === "string" && body.description ? body.description : null,
				num(body.monthlyImageLimit),
				num(body.monthlyCostLimit),
				num(body.dailyImageLimit),
				num(body.bonusCredits) ?? 0,
				num(body.price) ?? 0,
				num(body.priceSol),
				body.availableForUsd !== false ? 1 : 0,
				body.availableForSol === true ? 1 : 0,
				Array.isArray(body.allowedModels) ? JSON.stringify(body.allowedModels) : null,
				num(body.creditRefillAmount) ?? 0,
				num(body.topoffIntervalHours) ?? 24,
				typeof body.stripePriceId === "string" && body.stripePriceId ? body.stripePriceId : null,
			);
			writeAudit(actorOf(request), {
				action: "product.create",
				targetType: "product",
				targetId: id,
				after: getProduct(id),
				ip: request.ip,
			});
		})();
		return reply.status(201).send(getProduct(id));
	});

	fastify.patch<{ Params: { id: string }; Body: Record<string, unknown> }>(
		"/api/admin/products/:id",
		async (request, reply) => {
			const db = getDb();
			const { id } = request.params;
			const before = getProduct(id);
			if (!before) return reply.status(404).send({ error: "Plan not found", code: "NOT_FOUND" });
			const body = request.body ?? {};
			const valid = checkProductFields(body, false);
			if (rejected(reply, valid)) return;

			const columns: Record<string, [string, (v: unknown) => SQLQueryBindings]> = {
				name: ["name", (v) => String(v).trim()],
				description: ["description", (v) => (typeof v === "string" && v ? v : null)],
				monthlyImageLimit: ["monthly_image_limit", (v) => (v as number | null) ?? null],
				monthlyCostLimit: ["monthly_cost_limit", (v) => (v as number | null) ?? null],
				dailyImageLimit: ["daily_image_limit", (v) => (v as number | null) ?? null],
				bonusCredits: ["bonus_credits", (v) => (v as number | null) ?? 0],
				price: ["price", (v) => (v as number | null) ?? 0],
				priceSol: ["price_sol", (v) => (v as number | null) ?? null],
				availableForUsd: ["available_for_usd", (v) => (v ? 1 : 0)],
				availableForSol: ["available_for_sol", (v) => (v ? 1 : 0)],
				isActive: ["is_active", (v) => (v ? 1 : 0)],
				allowedModels: ["allowed_models", (v) => (Array.isArray(v) ? JSON.stringify(v) : null)],
				creditRefillAmount: ["credit_refill_amount", (v) => (v as number | null) ?? 0],
				topoffIntervalHours: ["topoff_interval_hours", (v) => (v as number | null) ?? 24],
				stripePriceId: ["stripe_price_id", (v) => (typeof v === "string" && v ? v : null)],
			};
			const updates: string[] = [];
			const params: SQLQueryBindings[] = [];
			for (const [key, [col, map]] of Object.entries(columns)) {
				if (body[key] === undefined) continue;
				updates.push(`${col} = ?`);
				params.push(map(body[key]));
			}
			if (updates.length === 0) return { success: true };
			db.transaction(() => {
				db.prepare(`UPDATE subscription_products SET ${updates.join(", ")} WHERE id = ?`).run(
					...params,
					id,
				);
				writeAudit(actorOf(request), {
					action: "product.update",
					targetType: "product",
					targetId: id,
					before,
					after: getProduct(id),
					ip: request.ip,
				});
			})();
			return { success: true };
		},
	);

	fastify.delete<{ Params: { id: string } }>("/api/admin/products/:id", async (request, reply) => {
		const db = getDb();
		const { id } = request.params;
		const before = getProduct(id);
		if (!before) return reply.status(404).send({ error: "Plan not found", code: "NOT_FOUND" });
		db.transaction(() => {
			db.prepare("UPDATE subscription_products SET is_active = 0 WHERE id = ?").run(id);
			writeAudit(actorOf(request), {
				action: "product.deactivate",
				targetType: "product",
				targetId: id,
				before: { isActive: before.isActive },
				after: { isActive: false },
				ip: request.ip,
			});
		})();
		return { success: true };
	});

	// ============================================
	// CREDIT PACKAGES
	// ============================================

	fastify.get("/api/admin/credit-packages", async () => ({ packages: getAllCreditPackages() }));

	fastify.post<{ Body: Record<string, unknown> }>(
		"/api/admin/credit-packages",
		async (request, reply) => {
			const b = request.body ?? {};
			const check = checkCreditPackage({
				name: b.name as string,
				credits: b.credits as number,
				priceSol: (b.priceSol as number | null | undefined) ?? null,
				priceCents: (b.priceCents as number | null | undefined) ?? null,
				stripePriceId: (b.stripePriceId as string | null | undefined) ?? null,
				availableForUsd: b.availableForUsd === true,
				availableForSol: b.availableForSol === true,
				isActive: b.isActive !== false,
			});
			if (rejected(reply, check)) return;
			const v = check.value;
			const pkg = createCreditPackage({
				name: v.name,
				credits: v.credits,
				priceSol: v.priceSol ?? 0,
				priceCents: v.priceCents,
				stripePriceId: v.stripePriceId,
				availableForUsd: v.availableForUsd,
				availableForSol: v.availableForSol,
				isActive: v.isActive,
			});
			if (!pkg)
				return reply.status(500).send({ error: "Failed to create package", code: "CREATE_FAILED" });
			writeAudit(actorOf(request), {
				action: "credit_package.create",
				targetType: "credit_package",
				targetId: pkg.id,
				after: pkg,
				ip: request.ip,
			});
			return reply.status(201).send(pkg);
		},
	);

	fastify.patch<{ Params: { id: string }; Body: Record<string, unknown> }>(
		"/api/admin/credit-packages/:id",
		async (request, reply) => {
			const { id } = request.params;
			const before = getAllCreditPackages().find((p) => p.id === id);
			if (!before) return reply.status(404).send({ error: "Package not found", code: "NOT_FOUND" });
			const b = request.body ?? {};
			// Validate the package as it will be after the edit.
			const check = checkCreditPackage({
				name: (b.name as string | undefined) ?? before.name,
				credits: (b.credits as number | undefined) ?? before.credits,
				priceSol: b.priceSol !== undefined ? (b.priceSol as number | null) : before.priceSol,
				priceCents:
					b.priceCents !== undefined ? (b.priceCents as number | null) : before.priceCents,
				stripePriceId:
					b.stripePriceId !== undefined ? (b.stripePriceId as string | null) : before.stripePriceId,
				availableForUsd:
					b.availableForUsd !== undefined ? b.availableForUsd === true : before.availableForUsd,
				availableForSol:
					b.availableForSol !== undefined ? b.availableForSol === true : before.availableForSol,
				isActive: b.isActive !== undefined ? b.isActive !== false : before.isActive,
			});
			if (rejected(reply, check)) return;
			const v = check.value;
			updateCreditPackage(id, {
				name: v.name,
				credits: v.credits,
				priceSol: v.priceSol ?? 0,
				priceCents: v.priceCents,
				stripePriceId: v.stripePriceId,
				availableForUsd: v.availableForUsd,
				availableForSol: v.availableForSol,
				isActive: v.isActive,
			});
			writeAudit(actorOf(request), {
				action: "credit_package.update",
				targetType: "credit_package",
				targetId: id,
				before,
				after: getAllCreditPackages().find((p) => p.id === id),
				ip: request.ip,
			});
			return { success: true };
		},
	);

	fastify.delete<{ Params: { id: string } }>(
		"/api/admin/credit-packages/:id",
		async (request, reply) => {
			const { id } = request.params;
			if (!deleteCreditPackage(id))
				return reply.status(404).send({ error: "Package not found", code: "NOT_FOUND" });
			writeAudit(actorOf(request), {
				action: "credit_package.deactivate",
				targetType: "credit_package",
				targetId: id,
				after: { isActive: false },
				ip: request.ip,
			});
			return { success: true };
		},
	);

	// ============================================
	// MODEL CREDIT COSTS (overrides; `<model>` or `<model>:<tier>`)
	// ============================================

	fastify.patch<{ Params: { key: string }; Body: { creditCost?: unknown; reason?: unknown } }>(
		"/api/admin/model-costs/:key",
		async (request, reply) => {
			const key = decodeURIComponent(request.params.key);
			const parsed = checkOverrideKey(key);
			if (rejected(reply, parsed)) return;
			const cost = checkCreditCost(request.body?.creditCost);
			if (rejected(reply, cost)) return;
			const db = getDb();
			const before = db
				.prepare("SELECT credit_cost FROM model_credit_costs WHERE model_id = ?")
				.get(key) as { credit_cost: number } | undefined;
			db.transaction(() => {
				setModelCreditCost(key, cost.value);
				writeAudit(actorOf(request), {
					action: "model_cost.set",
					targetType: "model",
					targetId: key,
					before: before ? { creditCost: before.credit_cost } : null,
					after: { creditCost: cost.value },
					reason:
						typeof request.body?.reason === "string" ? request.body.reason.slice(0, 500) : null,
					ip: request.ip,
				});
			})();
			return { success: true, key, creditCost: cost.value };
		},
	);

	fastify.delete<{ Params: { key: string } }>(
		"/api/admin/model-costs/:key",
		async (request, reply) => {
			const key = decodeURIComponent(request.params.key);
			const db = getDb();
			const before = db
				.prepare("SELECT credit_cost FROM model_credit_costs WHERE model_id = ?")
				.get(key) as { credit_cost: number } | undefined;
			if (!before || !deleteModelCreditCost(key)) {
				return reply.status(404).send({ error: "No override for this model", code: "NOT_FOUND" });
			}
			writeAudit(actorOf(request), {
				action: "model_cost.reset",
				targetType: "model",
				targetId: key,
				before: { creditCost: before.credit_cost },
				after: null,
				ip: request.ip,
			});
			return { success: true, key };
		},
	);
}
