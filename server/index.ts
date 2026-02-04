import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import { closeDb } from "./db";
import { adminRoutes } from "./routes/admin";
import { adminFinancialsRoutes } from "./routes/admin-financials";
import { authRoutes } from "./routes/auth";
import { billingRoutes } from "./routes/billing";
import { generateRoutes } from "./routes/generate";
import { historyRoutes } from "./routes/history";
import { modelsRoutes } from "./routes/models";
import { solanaBillingRoutes } from "./routes/solana-billing";
import { solanaRpcRoutes } from "./routes/solana-rpc";
import { stripeWebhookRoutes } from "./routes/stripe-webhooks";
import { uploadsRoutes } from "./routes/uploads";
import { userRoutes } from "./routes/user";
import { threadRoutes } from "./routes/threads";
import { startCleanupJob } from "./services/cleanup";

const isProduction = process.env.NODE_ENV === "production";
const port = Number(process.env.PORT) || 3001;

const fastify = Fastify({
	logger: true,
});

async function start() {
	// Register CORS - in production, require explicit origin
	// In development, allow localhost and local network IPs (LAN + Tailscale)
	const corsOrigin = isProduction
		? process.env.CORS_ORIGIN || process.env.APP_URL
		: [
				"http://localhost:5173",
				"http://127.0.0.1:5173",
				/^http:\/\/192\.168\.\d+\.\d+:5173$/,
				/^http:\/\/100\.87\.\d+\.\d+:5173$/,
			];

	if (isProduction && !corsOrigin) {
		console.warn("WARNING: CORS_ORIGIN or APP_URL not set. Using permissive CORS.");
	}

	await fastify.register(cors, {
		origin: corsOrigin,
		methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
		allowedHeaders: ["Content-Type", "Authorization"],
		credentials: true,
	});

	// Security headers
	await fastify.register(helmet, {
		contentSecurityPolicy: isProduction ? {
			directives: {
				defaultSrc: ["'self'"],
				connectSrc: [
					"'self'",
					"https://*.alchemy.com",      // Alchemy RPC
					"https://*.solana.com",       // Public Solana RPC
					"wss://*.alchemy.com",        // WebSocket connections
				],
				imgSrc: ["'self'", "data:", "blob:"],
				scriptSrc: ["'self'", "'unsafe-inline'"],
				styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
				fontSrc: ["'self'", "https://fonts.gstatic.com"],
			},
		} : false, // Disable CSP in dev (different origins)
		crossOriginEmbedderPolicy: false,
		crossOriginResourcePolicy: { policy: "cross-origin" }, // Allow images to load cross-origin
	});

	// Global rate limiting
	await fastify.register(rateLimit, {
		max: 100, // 100 requests per minute per IP
		timeWindow: "1 minute",
	});

	// Register multipart for file uploads
	await fastify.register(multipart, {
		limits: {
			fileSize: 10 * 1024 * 1024, // 10MB max
		},
	});

	// Serve generated images
	await fastify.register(fastifyStatic, {
		root: path.join(process.cwd(), "generated-images"),
		prefix: "/images/",
		decorateReply: false,
	});

	// Serve uploaded images
	await fastify.register(fastifyStatic, {
		root: path.join(process.cwd(), "uploads"),
		prefix: "/uploads/",
		decorateReply: false,
	});

	// Register routes
	await fastify.register(authRoutes);
	await fastify.register(generateRoutes);
	await fastify.register(modelsRoutes);
	await fastify.register(historyRoutes);
	await fastify.register(uploadsRoutes);
	await fastify.register(userRoutes);
	await fastify.register(adminRoutes);
	await fastify.register(adminFinancialsRoutes);
	await fastify.register(billingRoutes);
	await fastify.register(solanaBillingRoutes);
	await fastify.register(solanaRpcRoutes);
	await fastify.register(stripeWebhookRoutes);
	await fastify.register(threadRoutes);

	// Health check
	fastify.get("/api/health", async () => ({
		status: "ok",
		environment: isProduction ? "production" : "development",
	}));

	// In production, serve the built React app
	if (isProduction) {
		const distPath = path.join(process.cwd(), "dist");

		// Serve static files from dist
		await fastify.register(fastifyStatic, {
			root: distPath,
			prefix: "/",
			decorateReply: false,
		});

		// SPA fallback - serve index.html for client routes (non-API, non-static)
		fastify.setNotFoundHandler(async (request, reply) => {
			// Don't serve index.html for API routes
			if (request.url.startsWith("/api/")) {
				return reply.status(404).send({ error: "Not found" });
			}
			// Don't serve index.html for image routes
			if (request.url.startsWith("/images/") || request.url.startsWith("/uploads/")) {
				return reply.status(404).send({ error: "Not found" });
			}
			// Serve index.html for client-side routes
			const indexPath = path.join(distPath, "index.html");
			if (fs.existsSync(indexPath)) {
				return reply.type("text/html").send(fs.readFileSync(indexPath));
			}
			return reply.status(404).send({ error: "Not found" });
		});
	}

	// Start cleanup job (runs every 5 minutes)
	const cleanupInterval = startCleanupJob();

	// Graceful shutdown
	const shutdown = async () => {
		clearInterval(cleanupInterval);
		await fastify.close();
		closeDb();
		process.exit(0);
	};

	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);

	try {
		await fastify.listen({ port, host: "0.0.0.0" });
		console.log(
			`Server running at http://localhost:${port} (${isProduction ? "production" : "development"})`,
		);
	} catch (err) {
		fastify.log.error(err);
		process.exit(1);
	}
}

start();
