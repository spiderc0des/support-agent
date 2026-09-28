import Link from "next/link";
import { notFound } from "next/navigation";
import { supabaseServer } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const time = (iso: string) => new Date(iso).toLocaleTimeString("en-GB");
const json = (v: unknown) => (v == null ? "" : JSON.stringify(v));

/** One conversation's full trail: what the caller said, what the agent did, and why. */
export default async function Conversation({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await supabaseServer();
  const by = (table: string, cols: string, order = "created_at") =>
    supabase.from(table).select(cols).eq("conversation_id", id).order(order);

  const [{ data: conv }, turns, tools, retrievals, tickets, escalations, events] = await Promise.all([
    supabase.from("conversations").select("*").eq("id", id).maybeSingle(),
    by("conversation_turns", "*", "turn_index"),
    by("tool_calls", "*"),
    by("retrieval_logs", "*"),
    by("support_tickets", "*"),
    by("escalations", "*"),
    by("conversation_events", "*"),
  ]);
  if (!conv) notFound();

  type Row = Record<string, any>;
  const T = (turns.data ?? []) as Row[];
  const C = (tools.data ?? []) as Row[];
  const R = (retrievals.data ?? []) as Row[];
  const K = (tickets.data ?? []) as Row[];
  const E = (escalations.data ?? []) as Row[];
  const V = (events.data ?? []) as Row[];

  return (
    <>
      <p>
        <Link href="/review">← Conversations</Link>
      </p>
      <div className="toolbar">
        <h1>
          {conv.channel.replace("_", " ")} conversation <span className={`pill ${conv.status}`}>{conv.status}</span>
        </h1>
      </div>
      <dl className="facts">
        <dt>ID</dt>
        <dd>{conv.id}</dd>
        <dt>Started / ended</dt>
        <dd>
          {new Date(conv.started_at).toLocaleString("en-GB")} / {conv.ended_at ? new Date(conv.ended_at).toLocaleString("en-GB") : "open"}
          {conv.ended_reason ? ` (${conv.ended_reason})` : ""}
        </dd>
        <dt>Caller</dt>
        <dd>
          {conv.caller_identifier ?? "anonymous"}
          {conv.customer_id ? ` · verified as ${conv.customer_id}` : ""}
        </dd>
        <dt>Model / cost</dt>
        <dd>
          {conv.model} · ${Number(conv.total_cost_usd).toFixed(4)} over {conv.num_turns} turns
        </dd>
        <dt>Summary</dt>
        <dd>{conv.summary ?? ""}</dd>
      </dl>

      <h2>Turns</h2>
      {T.map((t) => (
        <div key={t.id} className="turn">
          <div className="turn-meta">
            #{t.turn_index} · <span className={`pill ${t.answer_type}`}>{t.answer_type ?? "?"}</span> · {t.confidence ?? "?"} confidence ·{" "}
            {t.first_token_ms ?? "–"}ms first / {t.latency_ms}ms total · ${Number(t.cost_usd ?? 0).toFixed(4)} · cache read{" "}
            {t.cache_read_tokens ?? 0}
            {t.status !== "ok" ? <span className="pill error"> {t.status}</span> : null}
          </div>
          <p>
            <span className="who">Caller</span>
            {t.user_transcript}
          </p>
          <p>
            <span className="who">Agent</span>
            {t.assistant_response}
          </p>
          {t.tools_used?.length ? <p className="muted">Tools: {t.tools_used.join(", ")}</p> : null}
          {t.uncertainty_note ? <p className="muted">Note: {t.uncertainty_note}</p> : null}
          {t.error_message ? <p className="error">{t.error_message}</p> : null}
        </div>
      ))}

      <h2>Tool calls</h2>
      <table className="table">
        <thead>
          <tr><th>Time</th><th>Turn</th><th>Tool</th><th>Status</th><th>Purpose</th><th>Input</th><th>Result</th><th>ms</th></tr>
        </thead>
        <tbody>
          {C.map((c) => (
            <tr key={c.id}>
              <td>{time(c.created_at)}</td>
              <td>{c.turn_index}</td>
              <td>{c.tool_name}</td>
              <td><span className={`pill ${c.status}`}>{c.status}</span></td>
              <td>{c.purpose}</td>
              <td className="code">{json(c.input_summary)}</td>
              <td className="code">{c.error_message ?? json(c.result_summary)}</td>
              <td>{c.duration_ms}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Knowledge retrieved</h2>
      <table className="table">
        <thead>
          <tr><th>Turn</th><th>Query</th><th>Matched</th><th>Sources</th><th>Top score</th></tr>
        </thead>
        <tbody>
          {R.map((r) => (
            <tr key={r.id}>
              <td>{r.turn_index}</td>
              <td>{r.query}</td>
              <td>{r.matched ? "yes" : "no"}</td>
              <td>
                {(r.source_titles as string[]).map((s, i) => (
                  <div key={i}>
                    <strong>{s}</strong> — {r.source_summaries[i]}
                  </div>
                ))}
              </td>
              <td>{r.top_score}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Tickets and escalations</h2>
      <table className="table">
        <thead>
          <tr><th>ID</th><th>Category</th><th>Priority / callback</th><th>Summary / reason</th><th>Contact</th><th>Status</th></tr>
        </thead>
        <tbody>
          {K.map((k) => (
            <tr key={k.ticket_id}>
              <td>{k.ticket_id}</td>
              <td>{k.category}</td>
              <td>{k.priority}</td>
              <td>{k.summary}</td>
              <td>{[k.customer_id, k.transaction_id, k.payout_id].filter(Boolean).join(" · ")}</td>
              <td>{k.status}</td>
            </tr>
          ))}
          {E.map((e) => (
            <tr key={e.escalation_id}>
              <td>{e.escalation_id} (on {e.ticket_id})</td>
              <td>{e.category}</td>
              <td>{e.call_booked ? `callback: ${e.preferred_time_text}` : "no callback"}</td>
              <td>{e.reason}</td>
              <td>
                {e.user_name} · {e.user_email}
                {e.contact_matches_record === false ? " (does not match record)" : e.contact_matches_record ? " (matches record)" : ""}
              </td>
              <td>{e.status}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Events</h2>
      <table className="table">
        <thead>
          <tr><th>Time</th><th>Turn</th><th>Type</th><th>Source</th><th>Summary</th></tr>
        </thead>
        <tbody>
          {V.map((v) => (
            <tr key={v.id}>
              <td>{time(v.created_at)}</td>
              <td>{v.turn_index}</td>
              <td>{v.event_type}</td>
              <td>{v.source}</td>
              <td>{v.summary}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
