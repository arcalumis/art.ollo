import type { FastifyInstance } from "fastify";
import { authMiddleware } from "../middleware/auth";

const SOLANA_RPC_URL =
	process.env.SOLANA_RPC_URL ||
	(process.env.SOLANA_NETWORK === "devnet" ? "https://api.devnet.solana.com" : "https://api.mainnet-beta.solana.com");

/**
 * JSON-RPC methods the in-browser SOL purchase actually uses: a blockhash for the transfer, and
 * sendTransaction for wallets that sign locally and submit through our Connection
 * (sendRawTransaction). Payment verification runs server side and doesn't use this proxy.
 * Everything else is refused so the proxy can't be used as a free general-purpose RPC on our
 * (paid, origin-locked) Alchemy key.
 *
 * Purchases only happen signed in, so the proxy requires a session (the frontend's Connection
 * attaches the bearer token through a custom fetch), plus a per-IP rate limit.
 */
export const ALLOWED_RPC_METHODS = new Set(["getLatestBlockhash", "sendTransaction"]);

const MAX_BATCH = 3;

interface RpcRequest {
	jsonrpc?: string;
	id?: string | number | null;
	method?: unknown;
	params?: unknown;
}

function rpcError(id: RpcRequest["id"], code: number, message: string) {
	return { jsonrpc: "2.0", error: { code, message }, id: id ?? null };
}

export async function solanaRpcRoutes(fastify: FastifyInstance) {
	fastify.post(
		"/api/solana/rpc",
		{
			bodyLimit: 64 * 1024,
			preHandler: authMiddleware,
			config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
		},
		async (request, reply) => {
			const body = request.body as RpcRequest | RpcRequest[] | undefined;
			const calls = Array.isArray(body) ? body : body ? [body] : [];

			if (calls.length === 0 || calls.length > MAX_BATCH) {
				return reply.status(400).send(rpcError(null, -32600, "Invalid request"));
			}
			const rejected = calls.find((c) => typeof c?.method !== "string" || !ALLOWED_RPC_METHODS.has(c.method));
			if (rejected) {
				return reply.status(403).send(rpcError(rejected?.id, -32601, "Method not allowed"));
			}

			try {
				const response = await fetch(SOLANA_RPC_URL, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Origin: "https://ollo.art",
						Referer: "https://ollo.art/",
					},
					body: JSON.stringify(body),
				});

				const data = await response.json();
				return reply.status(response.status).send(data);
			} catch (error) {
				request.log.error({ err: error instanceof Error ? error.message : String(error) }, "Solana RPC proxy error");
				return reply.status(502).send(rpcError(Array.isArray(body) ? null : body?.id, -32603, "Failed to reach Solana RPC"));
			}
		},
	);
}
