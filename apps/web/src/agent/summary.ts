/**
 * The conversation summary written when a call ends.
 *
 * Always builds a deterministic summary from the records (paths taken,
 * lookups, tickets, escalations), so a summary exists even with no model
 * call. When SUMMARY_MODEL is set (default claude-haiku-4-5), one short model
 * call turns the transcript into two plain sentences for a human reviewer,
 * at roughly a tenth of a cent. SUMMARY_MODEL=off disables it.
 */
import Anthropic from "@anthropic-ai/sdk";
import { supabaseAdmin } from "@relaypay/shared/supabase";

type TurnRow = { turn_index: number; user_transcript: string; assistant_response: string | null; answer_type: string | null; tools_used: string[] };

export async function summariseConversation(conversationId: string): Promise<string | null> {
  const db = supabaseAdmin();
  const [{ data: turns }, { data: tickets }, { data: escalations }] = await Promise.all([
    db.from("conversation_turns").select("turn_index, user_transcript, assistant_response, answer_type, tools_used").eq("conversation_id", conversationId).order("turn_index"),
    db.from("support_tickets").select("ticket_id, category, priority").eq("conversation_id", conversationId),
    db.from("escalations").select("escalation_id, category, call_booked").eq("conversation_id", conversationId),
  ]);
  const rows = (turns ?? []) as TurnRow[];
  if (rows.length === 0) return "Call ended before the caller asked anything.";

  const paths = rows.map((t) => t.answer_type ?? "?").join(" → ");
  const tools = [...new Set(rows.flatMap((t) => t.tools_used))];
  const facts = [
    `${rows.length} turn${rows.length === 1 ? "" : "s"}; paths: ${paths}.`,
    tools.length ? `Tools: ${tools.join(", ")}.` : "No tools used.",
    ...(tickets ?? []).map((t) => `Ticket ${t.ticket_id} (${t.category}, ${t.priority}).`),
    ...(escalations ?? []).map((e) => `Escalation ${e.escalation_id} (${e.category}${e.call_booked ? ", callback requested" : ""}).`),
  ].join(" ");

  const model = process.env.SUMMARY_MODEL ?? "claude-haiku-4-5";
  if (model === "off" || !process.env.ANTHROPIC_API_KEY) return facts;

  const transcript = rows
    .map((t) => `Caller: ${t.user_transcript}\nAgent: ${t.assistant_response ?? ""}`)
    .join("\n")
    .slice(0, 12_000);
  try {
    const client = new Anthropic();
    const res = await client.messages.create({
      model,
      max_tokens: 200,
      system:
        "Summarise a customer support call for a support team reviewer in at most two plain sentences: what the caller needed and how it was left. No names, emails or account numbers.",
      messages: [{ role: "user", content: `<transcript>\n${transcript}\n</transcript>` }],
    });
    const text = res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join(" ").trim();
    return text ? `${text} (${facts})` : facts;
  } catch (err) {
    console.error("[summary] model summary failed, using the record summary:", err instanceof Error ? err.message : err);
    return facts;
  }
}
