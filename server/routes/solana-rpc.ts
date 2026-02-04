import type { FastifyInstance } from "fastify";

const SOLANA_RPC_URL =
	process.env.SOLANA_RPC_URL ||
	(process.env.SOLANA_NETWORK === "devnet"
		? "https://api.devnet.solana.com"
		: "https://api.mainnet-beta.solana.com");

export async function solanaRpcRoutes(fastify: FastifyInstance) {
	// Proxy JSON-RPC requests to Solana
	fastify.post("/api/solana/rpc", async (request, reply) => {
		try {
			const response = await fetch(SOLANA_RPC_URL, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"Origin": "https://ollo.art",
					"Referer": "https://ollo.art/",
				},
				body: JSON.stringify(request.body),
			});

			const data = await response.json();
			return reply.status(response.status).send(data);
		} catch (error) {
			fastify.log.error({ err: error, rpcUrl: SOLANA_RPC_URL }, "Solana RPC proxy error");
			return reply.status(502).send({
				jsonrpc: "2.0",
				error: {
					code: -32603,
					message: "Failed to reach Solana RPC",
				},
				id: (request.body as { id?: number })?.id || null,
			});
		}
	});
}
