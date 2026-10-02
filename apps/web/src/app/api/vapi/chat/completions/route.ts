/**
 * Vapi's Custom LLM endpoint. Vapi does speech-to-text and text-to-speech;
 * every caller utterance arrives here and the Agent SDK answers it.
 *
 * Streams OpenAI-style chunks as soon as each sentence is ready, so the
 * caller hears the first sentence (often "Let me check that for you.") while
 * tools are still running.
 */
import { randomUUID } from "node:crypto";
import { runTurn, FALLBACK_REPLY } from "@/agent/turns";
import { conversationByVapiCall, createConversation } from "@/agent/conversations";
import { DEFAULT_MODEL } from "@/agent/support-session";
import { callerSessionIdOf, channelOf, historyPrimer, newUserText, sseChunk, vapiAuthorised, type VapiChatRequest } from "@/lib/vapi";
import { callerForConversation } from "@/agent/caller-identity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (!vapiAuthorised(req.headers)) return Response.json({ error: "unauthorized" }, { status: 401 });

  let body: VapiChatRequest;
  try {
    body = (await req.json()) as VapiChatRequest;
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }

  const messages = body.messages ?? [];
  const userText = newUserText(messages);
  const callId = body.call?.id ?? null;
  const channel = channelOf(body.call);
  const id = `chatcmpl-${randomUUID()}`;
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let open = true;
      const send = (s: string) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(s));
        } catch {
          open = false;
        }
      };
      send(sseChunk(id, { role: "assistant" }));

      try {
        if (!callId || !userText) {
          // Nothing to answer (no call id, or only silence): say nothing.
          return;
        }
        const existing = await conversationByVapiCall(callId);
        const conversationId =
          existing?.id ??
          (await createConversation({
            channel,
            model: process.env.AGENT_MODEL ?? DEFAULT_MODEL,
            vapiCallId: callId,
            callerIdentifier: body.call?.customer?.number ?? null,
          }));

        const caller = await callerForConversation(conversationId, callId, callerSessionIdOf(body.call));

        await runTurn({
          conversationId,
          channel,
          userText,
          caller,
          primer: historyPrimer(messages),
          onText: (text) => send(sseChunk(id, { content: text })),
        });
      } catch (err) {
        console.error("[vapi] turn failed:", err instanceof Error ? err.message : err);
        send(sseChunk(id, { content: FALLBACK_REPLY }));
      } finally {
        send(sseChunk(id, {}, "stop"));
        send("data: [DONE]\n\n");
        if (open) controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
