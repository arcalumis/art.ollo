import type { FastifyReply, FastifyRequest } from "fastify";
import jwt from "jsonwebtoken";
import { getDb } from "../db";

const isProduction = process.env.NODE_ENV === "production";
const JWT_SECRET: string =
	process.env.JWT_SECRET ||
	(isProduction
		? (() => {
				throw new Error("CRITICAL: JWT_SECRET environment variable is required in production.");
			})()
		: "dev-secret-change-in-production");

export interface JwtPayload {
	userId: string;
	username: string;
	isAdmin: boolean;
	/** users.token_version at signing time. Missing on legacy tokens, which count as version 0. */
	tv?: number;
}

/** What route handlers see: always derived from the current DB row, never from stale claims. */
export interface AuthUser {
	userId: string;
	username: string;
	isAdmin: boolean;
}

declare module "fastify" {
	interface FastifyRequest {
		user?: AuthUser;
	}
}

/** "Remember me" sessions last 30 days (matches the login form copy); otherwise 1 day. */
export const REMEMBER_ME_EXPIRY = "30d";
export const DEFAULT_EXPIRY = "1d";

export function signToken(payload: JwtPayload, rememberMe = false): string {
	return jwt.sign(payload, JWT_SECRET, { expiresIn: rememberMe ? REMEMBER_ME_EXPIRY : DEFAULT_EXPIRY });
}

export function verifyToken(token: string): JwtPayload | null {
	try {
		return jwt.verify(token, JWT_SECRET) as JwtPayload;
	} catch {
		return null;
	}
}

interface SessionUserRow {
	id: string;
	username: string;
	is_admin: number;
	is_active: number | null;
	token_version: number | null;
}

/**
 * Resolve a bearer token to the current user. The JWT only proves identity; activation,
 * admin rights and revocation (token_version) are read from the DB on every request.
 */
export function resolveSession(token: string): AuthUser | null {
	const payload = verifyToken(token);
	if (!payload?.userId) return null;

	const row = getDb()
		.prepare("SELECT id, username, is_admin, is_active, token_version FROM users WHERE id = ?")
		.get(payload.userId) as SessionUserRow | undefined;

	if (!row) return null;
	if (row.is_active === 0) return null;
	if ((payload.tv ?? 0) !== (row.token_version ?? 0)) return null;

	return { userId: row.id, username: row.username, isAdmin: row.is_admin === 1 };
}

export async function authMiddleware(request: FastifyRequest, reply: FastifyReply): Promise<void> {
	const authHeader = request.headers.authorization;

	if (!authHeader?.startsWith("Bearer ")) {
		return reply.status(401).send({ error: "Missing or invalid authorization header" });
	}

	const user = resolveSession(authHeader.slice(7));
	if (!user) {
		return reply.status(401).send({ error: "Invalid or expired token" });
	}

	request.user = user;
}

export async function adminMiddleware(request: FastifyRequest, reply: FastifyReply): Promise<void> {
	await authMiddleware(request, reply);
	if (reply.sent) return;

	if (!request.user?.isAdmin) {
		return reply.status(403).send({ error: "Admin access required" });
	}
}

/**
 * Optional auth middleware - sets user if a valid session token is present, never rejects.
 */
export async function optionalAuthMiddleware(request: FastifyRequest): Promise<void> {
	const authHeader = request.headers.authorization;
	if (!authHeader?.startsWith("Bearer ")) return;

	const user = resolveSession(authHeader.slice(7));
	if (user) request.user = user;
}
