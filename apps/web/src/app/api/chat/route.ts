/**
 * Text channel over the same agent pipeline as voice, for development and
 * manual testing without spending Vapi minutes.
 *
 *   POST /api/chat   { message, conversationId? }  -> { conversationId, reply, path, ... }
 *   POST /api/chat   { conversationId, end: true } -> closes the conversation
 *
 * Requires Authorization: Bearer $DEV_API_TOKEN. Disabled when that is unset.
 */
import { timingSafeEqual } from "node:crypto";
import { createConversation } from "@/agent/conversations";
import { DEFAULT_MODEL } from "@/agent/support-session";
import { endCall, runTurn } from "@/agent/turns";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function authorised(req: Request): boolean {
  const token = process.env.DEV_API_TOKEN;
  if (!token) return false;
  const given = Buffer.from(req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "");
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(req: Request) {
  if (!authorised(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { message?: string; conversationId?: string; end?: boolean };

  if (body.end) {
    if (!body.conversationId || !UUID.test(body.conversationId)) {
      return Response.json({ error: "conversationId required" }, { status: 400 });
    }
    await endCall(body.conversationId, "text-session-ended");
    return Response.json({ ended: true });
  }

  const message = body.message?.trim();
  if (!message) return Response.json({ error: "message required" }, { status: 400 });

  const conversationId =
    body.conversationId && UUID.test(body.conversationId)
      ? body.conversationId
      : await createConversation({ channel: "text", model: process.env.AGENT_MODEL ?? DEFAULT_MODEL });

  const result = await runTurn({ conversationId, channel: "text", userText: message, onText: () => {} });
  return Response.json({
    conversationId,
    turn: result.turnIndex,
    reply: result.text,
    path: result.path,
    confidence: result.tag?.confidence ?? null,
    tools: result.toolsUsed,
    status: result.status,
    firstTokenMs: result.firstTokenMs,
    latencyMs: result.latencyMs,
    costUsd: result.costUsd,
    cacheReadTokens: result.usage.cacheRead,
  });
}
