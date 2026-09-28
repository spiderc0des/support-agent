/**
 * The orchestrator's writes: conversations and their turns.
 *
 * Tool calls, retrievals, tickets and escalations are written by the MCP
 * server, so this file only records what the orchestrator alone knows: the
 * call's lifecycle, each turn's transcript, reply, path, confidence, latency
 * and cost.
 *
 * Logging never takes a turn down. A failed log write is reported and the
 * caller still gets an answer.
 */
import { supabaseAdmin } from "@relaypay/shared/supabase";
import type { AnswerPath, Channel, Confidence } from "@relaypay/shared/enums";

const db = () => supabaseAdmin();

function warn(what: string, error: { message: string } | null) {
  if (error) console.error(`[conversations] ${what}: ${error.message}`);
}

/** Phone numbers are never stored whole. */
export function maskCaller(identifier: string | null | undefined): string | null {
  if (!identifier) return null;
  const digits = identifier.replace(/\D/g, "");
  return digits.length >= 7 ? `***${digits.slice(-4)}` : identifier.slice(0, 64);
}

export async function createConversation(opts: {
  channel: Channel;
  model: string;
  vapiCallId?: string | null;
  callerIdentifier?: string | null;
  evalRunId?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<string> {
  const row = {
    channel: opts.channel,
    model: opts.model,
    vapi_call_id: opts.vapiCallId ?? null,
    caller_identifier: maskCaller(opts.callerIdentifier),
    eval_run_id: opts.evalRunId ?? null,
    metadata: opts.metadata ?? {},
  };
  if (opts.vapiCallId) {
    // Vapi may reach us first by a webhook or by the first model request;
    // whichever arrives first creates the row, the other finds it.
    const { data, error } = await db()
      .from("conversations")
      .upsert(row, { onConflict: "vapi_call_id", ignoreDuplicates: false })
      .select("id")
      .single();
    if (error || !data) throw new Error(`Could not create conversation: ${error?.message ?? "no row"}`);
    return data.id as string;
  }
  const { data, error } = await db().from("conversations").insert(row).select("id").single();
  if (error || !data) throw new Error(`Could not create conversation: ${error?.message ?? "no row"}`);
  return data.id as string;
}

export async function conversationByVapiCall(callId: string): Promise<{ id: string; status: string } | null> {
  const { data, error } = await db().from("conversations").select("id, status").eq("vapi_call_id", callId).maybeSingle();
  warn("find conversation by call", error);
  return data as { id: string; status: string } | null;
}

export async function beginTurn(conversationId: string): Promise<number> {
  const { data, error } = await db().rpc("begin_turn", { p_conversation_id: conversationId });
  if (error || typeof data !== "number") throw new Error(`Could not start turn: ${error?.message ?? "no index"}`);
  return data;
}

export async function recordTurn(row: {
  conversationId: string;
  turnIndex: number;
  userTranscript: string;
  assistantResponse: string;
  answerType: AnswerPath | null;
  confidence: Confidence | null;
  uncertaintyNote: string | null;
  toolsUsed: string[];
  status: "ok" | "interrupted" | "error" | "timeout";
  errorMessage: string | null;
  firstTokenMs: number | null;
  latencyMs: number;
  costUsd: number;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number };
}): Promise<void> {
  const { error } = await db().from("conversation_turns").insert({
    conversation_id: row.conversationId,
    turn_index: row.turnIndex,
    user_transcript: row.userTranscript,
    assistant_response: row.assistantResponse,
    answer_type: row.answerType,
    confidence: row.confidence,
    uncertainty_note: row.uncertaintyNote,
    tools_used: row.toolsUsed,
    interrupted: row.status === "interrupted",
    status: row.status,
    error_message: row.errorMessage,
    first_token_ms: row.firstTokenMs,
    latency_ms: row.latencyMs,
    input_tokens: row.usage.input,
    output_tokens: row.usage.output,
    cache_read_tokens: row.usage.cacheRead,
    cache_write_tokens: row.usage.cacheWrite,
    cost_usd: row.costUsd,
  });
  warn("record turn", error);

  // Running cost on the conversation, for the dashboard and the budget view.
  const { data } = await db().from("conversations").select("total_cost_usd").eq("id", row.conversationId).single();
  const { error: costErr } = await db()
    .from("conversations")
    .update({ total_cost_usd: Number(data?.total_cost_usd ?? 0) + row.costUsd })
    .eq("id", row.conversationId);
  warn("update conversation cost", costErr);
}

export async function recordSystemEvent(
  conversationId: string,
  eventType: "session_started" | "turn_error" | "call_ended",
  summary: string,
  metadata: Record<string, unknown> = {},
  turnIndex: number | null = null,
): Promise<void> {
  const { error } = await db().from("conversation_events").insert({
    conversation_id: conversationId,
    turn_index: turnIndex,
    event_type: eventType,
    summary,
    metadata,
    source: "system",
  });
  warn("record event", error);
}

/** The permission gate refused a tool: logged exactly like a tool call, as `denied`. */
export async function recordDeniedTool(conversationId: string, toolName: string): Promise<void> {
  const { error } = await db().from("tool_calls").insert({
    conversation_id: conversationId,
    tool_name: toolName,
    purpose: "blocked by permission gate",
    input_summary: { attempted: toolName },
    status: "denied",
    error_message: `'${toolName}' is not part of the support agent's tool surface`,
    duration_ms: 0,
  });
  warn("record denied tool", error);
}

export async function callerTranscripts(conversationId: string): Promise<string[]> {
  const { data } = await db()
    .from("conversation_turns")
    .select("user_transcript")
    .eq("conversation_id", conversationId)
    .order("turn_index");
  return (data ?? []).map((r) => r.user_transcript as string);
}

/** Open a ticket from the orchestrator itself, when the agent could not finish a turn. */
export async function openFallbackTicket(conversationId: string, turnIndex: number, reason: string): Promise<string | null> {
  const { data, error } = await db().rpc("create_support_ticket", {
    p_conversation_id: conversationId,
    p_category: "technical",
    p_priority: "medium",
    p_summary: `The support agent could not complete a caller's request (${reason}). Please review the conversation and follow up.`,
    p_turn_index: turnIndex,
  });
  warn("open fallback ticket", error);
  return (data as { ticket_id: string }[] | null)?.[0]?.ticket_id ?? null;
}

export async function endConversation(
  conversationId: string,
  opts: { endedReason: string; summary: string | null; error?: boolean },
): Promise<boolean> {
  const { data } = await db().from("conversations").select("status, ended_at").eq("id", conversationId).single();
  if (!data || data.ended_at) return false; // already closed by the other path (webhook vs. idle sweep)
  const status = opts.error ? "error" : data?.status === "active" ? "resolved" : data?.status;
  const { error } = await db()
    .from("conversations")
    .update({ ended_at: new Date().toISOString(), ended_reason: opts.endedReason, summary: opts.summary, status })
    .eq("id", conversationId)
    .is("ended_at", null);
  warn("end conversation", error);
  return !error;
}
