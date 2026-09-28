/**
 * Streamable HTTP entrypoint — what the agent connects to, and the deployed
 * endpoint for the deliverable.
 *
 *   POST /mcp      MCP (stateless: a fresh server per request)
 *   GET  /health   liveness, no auth, no database
 *
 * Auth is a bearer token compared in constant time. The conversation comes
 * from the X-Conversation-Id header the orchestrator sets for each call, so
 * the model can never write into a conversation it was not given.
 */
import { loadEnv } from "@relaypay/shared/env";
import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { supabaseAdmin } from "@relaypay/shared/supabase";
import { buildServer } from "./server.ts";
import { SupabaseStore } from "./store.ts";

loadEnv();

const PORT = Number(process.env.PORT ?? process.env.MCP_PORT ?? 8788);
const TOKEN = process.env.MCP_AUTH_TOKEN;
if (!TOKEN || TOKEN.length < 24) {
  throw new Error("MCP_AUTH_TOKEN must be set to a random string of at least 24 characters.");
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BODY_BYTES = 256 * 1024;

function authorised(header: string | undefined): boolean {
  const expected = Buffer.from(`Bearer ${TOKEN}`);
  const given = Buffer.from(header ?? "");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function json(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

const store = new SupabaseStore(supabaseAdmin());

http
  .createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (url.pathname === "/health") return json(res, 200, { ok: true });
    if (url.pathname !== "/mcp") return json(res, 404, { error: "not found" });
    if (!authorised(req.headers.authorization)) return json(res, 401, { error: "unauthorized" });
    if (req.method !== "POST") {
      // Stateless server: no server-initiated SSE stream, no sessions to delete.
      return json(res, 405, { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
    }

    const header = req.headers["x-conversation-id"];
    const conversationId = typeof header === "string" && UUID.test(header) ? header : null;

    let size = 0;
    const chunks: Buffer[] = [];
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > MAX_BODY_BYTES) return json(res, 413, { error: "request too large" });
      chunks.push(c as Buffer);
    }
    let body: unknown;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      return json(res, 400, { jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null });
    }

    const server = buildServer({ store, conversationId });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      console.error("[mcp] request failed:", err instanceof Error ? err.message : err);
      if (!res.headersSent) json(res, 500, { jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
    }
  })
  .listen(PORT, () => console.log(`[mcp] RelayPay MCP server on :${PORT} (POST /mcp, GET /health)`));
