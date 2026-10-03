import "dotenv/config";
import { buildApp } from "./app";
import { closeDb } from "./db";
import { startCleanupJob } from "./services/cleanup";

const isProduction = process.env.NODE_ENV === "production";
const port = Number(process.env.PORT) || 3001;

async function start() {
	const fastify = await buildApp();

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
