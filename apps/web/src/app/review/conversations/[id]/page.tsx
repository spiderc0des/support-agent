import Link from "next/link";
import { notFound } from "next/navigation";
import { StatusPill } from "@/components/StatusPill";
import { When } from "@/components/When";
import { supabaseServer } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const json = (v: unknown) => (v == null ? "" : JSON.stringify(v));
type Row = Record<string, any>;

/**
 * One call's full record. The transcript and the cases it produced come
 * first, because that is what an agent picking up a ticket needs; the
 * technical trail (tool calls, retrievals, events) is folded below for
 * review and debugging.
 */
export default async function Conversation({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await supabaseServer();
  const by = (table: string, cols: string, order = "created_at") => supabase.from(table).select(cols).eq("conversation_id", id).order(order);

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

  const T = (turns.data ?? []) as Row[];
  const C = (tools.data ?? []) as Row[];
  const R = (retrievals.data ?? []) as Row[];
  const K = (tickets.data ?? []) as Row[];
  const E = (escalations.data ?? []) as Row[];
  const V = (events.data ?? []) as Row[];
  const escByTicket = new Map(E.map((e) => [e.ticket_id, e]));

  return (
    <>
      <p className="crumbs">
        <Link href="/review/conversations">Conversations</Link> / {conv.channel.replace("_", " ")} call
      </p>
      <div className="page-head">
        <div>
          <h1>
            {conv.channel === "phone" ? "Phone call" : conv.channel === "web_voice" ? "Web voice call" : `${conv.channel} conversation`} <StatusPill value={conv.status} />
          </h1>
          <p className="muted">
            <When iso={conv.started_at} /> · {conv.caller_identifier ?? "anonymous caller"}
            {conv.customer_id ? ` · verified as ${conv.customer_id}` : ""} · {conv.num_turns} turns · ${Number(conv.total_cost_usd).toFixed(4)}
          </p>
        </div>
      </div>

      {conv.summary ? <p className="panel lead-text">{conv.summary}</p> : null}

      {K.length ? (
        <section className="panel highlight">
          <h2>Cases from this call</h2>
          <ul className="list">
            {K.map((k) => {
              const esc = escByTicket.get(k.ticket_id);
              return (
                <li key={k.ticket_id}>
                  <Link href={`/review/tickets/${k.ticket_id}`} className="list-main">
                    <strong>{k.ticket_id}</strong> · {k.summary}
                  </Link>
                  <span className="list-meta">
                    {esc ? <StatusPill value="escalated" label={`escalation ${esc.escalation_id}`} /> : null}
                    <StatusPill value={k.priority} label={`${k.priority} priority`} />
                    <StatusPill value={k.status} />
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      <section className="panel">
        <h2>Transcript</h2>
        <div className="transcript">
          {T.map((t) => (
            <div key={t.id} className="exchange">
              <p>
                <span className="who">Caller</span>
                {t.user_transcript}
              </p>
              <p>
                <span className="who">Agent</span>
                {t.assistant_response}
              </p>
              <p className="turn-meta">
                <StatusPill value={t.answer_type} /> {t.confidence ?? "?"} confidence · first word {t.first_token_ms ?? "–"}ms · {t.latency_ms}ms total · $
                {Number(t.cost_usd ?? 0).toFixed(4)}
                {t.tools_used?.length ? ` · ${t.tools_used.join(", ")}` : ""}
                {t.status !== "ok" ? (
                  <>
                    {" "}
                    <StatusPill value="error" label={t.status} />
                  </>
                ) : null}
              </p>
              {t.uncertainty_note ? <p className="turn-meta">Note: {t.uncertainty_note}</p> : null}
              {t.error_message ? <p className="notice bad">{t.error_message}</p> : null}
            </div>
          ))}
          {T.length === 0 ? <p className="empty">No turns recorded.</p> : null}
        </div>
      </section>

      <details className="panel fold">
        <summary>
          Tool calls <span className="muted">({C.length})</span>
        </summary>
        <table className="table responsive">
          <thead>
            <tr>
              <th>Time</th>
              <th>Tool</th>
              <th>Status</th>
              <th>Input</th>
              <th>Result</th>
              <th>ms</th>
            </tr>
          </thead>
          <tbody>
            {C.map((c) => (
              <tr key={c.id}>
                <td data-label="Time">
                  <When iso={c.created_at} mode="time" /> <span className="muted">turn {c.turn_index}</span>
                </td>
                <td data-label="Tool">
                  {c.tool_name}
                  <div className="muted">{c.purpose}</div>
                </td>
                <td data-label="Status">
                  <StatusPill value={c.status} />
                </td>
                <td data-label="Input" className="code">
                  {json(c.input_summary)}
                </td>
                <td data-label="Result" className="code">
                  {c.error_message ?? json(c.result_summary)}
                </td>
                <td data-label="ms" className="num">
                  {c.duration_ms}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>

      <details className="panel fold">
        <summary>
          Knowledge retrieved <span className="muted">({R.length})</span>
        </summary>
        <table className="table responsive">
          <thead>
            <tr>
              <th>Turn</th>
              <th>Query</th>
              <th>Matched</th>
              <th>Sources</th>
            </tr>
          </thead>
          <tbody>
            {R.map((r) => (
              <tr key={r.id}>
                <td data-label="Turn">{r.turn_index}</td>
                <td data-label="Query">{r.query}</td>
                <td data-label="Matched">{r.matched ? "yes" : "no"} <span className="muted">top {r.top_score}</span></td>
                <td data-label="Sources">
                  {(r.source_titles as string[]).map((s, i) => (
                    <div key={i}>
                      <strong>{s}</strong> <span className="muted">{r.source_summaries[i]}</span>
                    </div>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>

      <details className="panel fold">
        <summary>
          Events <span className="muted">({V.length})</span>
        </summary>
        <ol className="timeline">
          {V.map((v) => (
            <li key={v.id}>
              <span className="t-when">
                <When iso={v.created_at} mode="time" />
              </span>
              <span>
                <strong>{v.event_type.replace(/_/g, " ")}</strong> <span className="muted">({v.source})</span> {v.summary}
              </span>
            </li>
          ))}
        </ol>
      </details>

      <details className="panel fold">
        <summary>Call facts</summary>
        <dl className="facts">
          <dt>Conversation ID</dt>
          <dd>{conv.id}</dd>
          <dt>Vapi call ID</dt>
          <dd>{conv.vapi_call_id ?? "none"}</dd>
          <dt>Ended</dt>
          <dd>
            {conv.ended_at ? <When iso={conv.ended_at} /> : "still open"}
            {conv.ended_reason ? ` (${conv.ended_reason})` : ""}
          </dd>
          <dt>Model</dt>
          <dd>{conv.model}</dd>
        </dl>
      </details>
    </>
  );
}
