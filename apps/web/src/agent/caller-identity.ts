import "server-only";
import { supabaseAdmin } from "@relaypay/shared/supabase";
import { callerSessionForCall, conversationCallerFields } from "@/lib/caller";
import type { CallerContext } from "./turns";

/**
 * Who is on this call, from the "Know me" sign-in. The page reports the
 * Vapi call id as soon as the call starts, and the call metadata carries the
 * session id too; whichever reaches us first fills in the conversation.
 *
 * Checked on each turn until found (the report can land after the first
 * utterance), then remembered for the rest of the call.
 */
const known: Map<string, CallerContext | null> = ((globalThis as unknown as { __relaypayCallers?: Map<string, CallerContext | null> }).__relaypayCallers ??= new Map());

export async function callerForConversation(conversationId: string, vapiCallId: string, metadataSessionId: string | null): Promise<CallerContext | null> {
  const hit = known.get(conversationId);
  if (hit) return hit;

  const db = supabaseAdmin();
  const { data: conv } = await db.from("conversations").select("caller_session_id").eq("id", conversationId).maybeSingle();
  const session = await callerSessionForCall(vapiCallId, (conv?.caller_session_id as string | null) ?? metadataSessionId);
  if (!session) return null;

  if (!conv?.caller_session_id) {
    await db.from("conversations").update(conversationCallerFields(session)).eq("id", conversationId).is("caller_session_id", null);
  }
  const ctx: CallerContext = { kind: session.kind, name: session.name, customer_id: session.customer_id, company_name: session.company_name, timezone: session.timezone };
  known.set(conversationId, ctx);
  if (known.size > 500) known.delete(known.keys().next().value as string);
  return ctx;
}
