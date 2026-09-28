/**
 * How big the cached prefix is: system prompt (identity + six skills) plus
 * the MCP tool schemas the agent sees.
 *
 *   npm run prompt:size
 *
 * Haiku 4.5 only caches a prefix of 4,096 tokens or more (Sonnet 5: 1,024).
 * Below that, every request pays full input price, silently. This is an
 * estimate (~3.8 characters per token); the eval reports the real
 * cache_read_input_tokens.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildSystemPrompt } from "../apps/web/src/agent/system-prompt.ts";
import { buildServer } from "../apps/mcp-server/src/server.ts";
import type { Store } from "../apps/mcp-server/src/store.ts";

const prompt = buildSystemPrompt();
const server = buildServer({ store: {} as Store, conversationId: null });
const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: "prompt-size", version: "0" });
await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
const tools = JSON.stringify((await client.listTools()).tools);
await client.close();

const est = (chars: number) => Math.round(chars / 3.8);
const total = est(prompt.length + tools.length);
console.log(`system prompt  ${String(prompt.length).padStart(6)} chars  ~${est(prompt.length)} tokens`);
console.log(`tool schemas   ${String(tools.length).padStart(6)} chars  ~${est(tools.length)} tokens`);
console.log(`cached prefix  ~${total} tokens — ${total >= 4096 ? "above" : "BELOW"} the 4,096-token Haiku 4.5 cache minimum`);
