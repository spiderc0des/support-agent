/**
 * Vapi's Server URL: call lifecycle events.
 *
 *   status-update in-progress  create the conversation and start the agent
 *                              session now, so its startup overlaps the
 *                              spoken greeting instead of the first answer
 *   user-interrupted           stop the reply being generated
 *   end-of-call-report / ended close the session and the conversation record
 *
 * Always answers 200 quickly; Vapi does not wait on these.
 */
import { conversationByVapiCall, createConversation } from "@/agent/conversations";
import { DEFAULT_MODEL } from "@/agent/support-session";
import { endCall, sessionFor } from "@/agent/turns";
import { channelOf, vapiAuthorised, type VapiServerMessage } from "@/lib/vapi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (!vapiAuthorised(req.headers)) return Response.json({ error: "unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as VapiServerMessage;
  const msg = body.message;
  const call = msg?.call;
  if (!msg?.type || !call?.id) return Response.json({});

  try {
    const channel = channelOf(call);

    if (msg.type === "status-update" && msg.status === "in-progress") {
      const existing = await conversationByVapiCall(call.id);
      const conversationId =
        existing?.id ??
        (await createConversation({
          channel,
          model: process.env.AGENT_MODEL ?? DEFAULT_MODEL,
          vapiCallId: call.id,
          callerIdentifier: call.customer?.number ?? null,
        }));
      sessionFor(conversationId, channel); // pre-warm
    } else if (msg.type === "user-interrupted") {
      const existing = await conversationByVapiCall(call.id);
      if (existing) await sessionFor(existing.id, channel).interrupt();
    } else if (msg.type === "end-of-call-report" || (msg.type === "status-update" && msg.status === "ended")) {
      const existing = await conversationByVapiCall(call.id);
      if (existing) await endCall(existing.id, msg.endedReason ?? "ended");
    }
  } catch (err) {
    console.error(`[vapi] ${msg.type} handling failed:`, err instanceof Error ? err.message : err);
  }
  return Response.json({});
}
