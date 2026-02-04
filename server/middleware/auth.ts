import type { FastifyReply, FastifyRequest } from "fastify";
import jwt from "jsonwebtoken";

const isProduction = process.env.NODE_ENV === "production";
const JWT_SECRET = process.env.JWT_SECRET || (isProduction ? undefined : "dev-secret-change-in-production");

if (!JWT_SECRET) {
	throw new Error("CRITICAL: JWT_SECRET environment variable is required in production.");
}

export interface JwtPayload {
	userId: string;
	username: string;
	isAdmin: boolean;
}

declare module "fastify" {
	interface FastifyRequest {
		user?: JwtPayload;
	}
}

export function signToken(payload: JwtPayload, rememberMe = false): string {
	const expiresIn = rememberMe ? "7d" : "1d";
	return jwt.sign(payload, JWT_SECRET, { expiresIn });
}

export function verifyToken(token: string): JwtPayload | null {
	try {
		return jwt.verify(token, JWT_SECRET) as JwtPayload;
	} catch {
		return null;
	}
}

export async function authMiddleware(request: FastifyRequest, reply: FastifyReply): Promise<void> {
	const authHeader = request.headers.authorization;

	if (!authHeader?.startsWith("Bearer ")) {
		return reply.status(401).send({ error: "Missing or invalid authorization header" });
	}

	const token = authHeader.slice(7);
	const payload = verifyToken(token);

	if (!payload) {
		return reply.status(401).send({ error: "Invalid or expired token" });
	}

	request.user = payload;
}

export async function adminMiddleware(request: FastifyRequest, reply: FastifyReply): Promise<void> {
	await authMiddleware(request, reply);
	if (reply.sent) return;

	if (!request.user?.isAdmin) {
		return reply.status(403).send({ error: "Admin access required" });
	}
}

/**
 * Optional auth middleware - sets user if token present, but doesn't reject if missing
 */
export async function optionalAuthMiddleware(request: FastifyRequest): Promise<void> {
	const authHeader = request.headers.authorization;

	if (!authHeader?.startsWith("Bearer ")) {
		return;
	}

	const token = authHeader.slice(7);
	const payload = verifyToken(token);

	if (payload) {
		request.user = payload;
	}
}
