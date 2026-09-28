/**
 * stdio entrypoint, for MCP Inspector and local debugging:
 *
 *   npx @modelcontextprotocol/inspector npm run stdio -w @relaypay/mcp-server
 *
 * There is no orchestrator here to create the conversation, so this opens a
 * `dev` conversation of its own (or reuses RELAYPAY_CONVERSATION_ID), and
 * every tool call made from Inspector is logged against it like a real call.
 */
import { loadEnv } from "@relaypay/shared/env";
import { randomUUID } from "node:crypto";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { supabaseAdmin } from "@relaypay/shared/supabase";
import { buildServer } from "./server.ts";
import { SupabaseStore } from "./store.ts";

loadEnv();

const store = new SupabaseStore(supabaseAdmin());
const conversationId = process.env.RELAYPAY_CONVERSATION_ID ?? randomUUID();
await store.ensureConversation(conversationId, "dev");

// stdout is the protocol channel; anything human-readable goes to stderr.
console.error(`[mcp] stdio server ready; logging to dev conversation ${conversationId}`);
await buildServer({ store, conversationId }).connect(new StdioServerTransport());
