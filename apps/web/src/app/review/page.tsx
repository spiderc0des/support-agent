import Link from "next/link";
import { StatusPill } from "@/components/StatusPill";
import { When } from "@/components/When";
import { currentProfile, displayName } from "@/lib/auth";
import { supabaseServer } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const compact = (n: number) => new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(n);

/**
 * Where a support agent starts: what needs a person now (open escalations,
 * their own cases, unassigned tickets), then how the agent has been doing
 * over the last seven days.
 */
export default async function Overview() {
  const profile = (await currentProfile())!;
  const supabase = await supabaseServer();
  const since = new Date(Date.now() - 7 * 86400_000).toISOString();

  const [escalations, mine, unassigned, conversations, turns] = await Promise.all([
    supabase
      .from("escalations")
      .select("escalation_id, ticket_id, category, user_name, preferred_time_text, callback_at, status, created_at, assigned_to")
      .neq("status", "closed")
      .order("created_at", { ascending: true })
      .limit(8),
    supabase
      .from("support_tickets")
      .select("ticket_id, category, priority, summary, status, created_at")
      .eq("assigned_to", profile.id)
      .neq("status", "closed")
      .order("created_at", { ascending: true })
      .limit(8),
    unassignedTickets(supabase),
    supabase.from("conversations").select("id, channel, status, total_cost_usd").gte("started_at", since).neq("channel", "eval"),
    supabase.from("conversation_turns").select("answer_type, first_token_ms, conversation_id, conversations!inner(channel)").gte("created_at", since).neq("conversations.channel", "eval"),
  ]);

  const convs = conversations.data ?? [];
  const t = (turns.data ?? []) as { answer_type: string | null; first_token_ms: number | null }[];
  const escalatedCalls = convs.filter((c) => c.status === "escalated").length;
  const firstTokens = t.map((x) => x.first_token_ms).filter((x): x is number => typeof x === "number").sort((a, b) => a - b);
  const median = firstTokens.length ? firstTokens[Math.floor(firstTokens.length / 2)] : null;
  const spend = convs.reduce((s, c) => s + Number(c.total_cost_usd ?? 0), 0);
  const paths = ["answer", "clarify", "escalate", "decline"].map((p) => ({ p, n: t.filter((x) => x.answer_type === p).length }));

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Good to see you, {displayName(profile).split(" ")[0]}</h1>
          <p className="muted">Last 7 days, excluding eval runs.</p>
        </div>
        <Link href="/review/tickets?view=unassigned" className="btn secondary">
          {unassigned.count ?? 0} unassigned ticket{unassigned.count === 1 ? "" : "s"}
        </Link>
      </div>

      <section className="tiles" aria-label="Last 7 days">
        <div className="tile">
          <p className="tile-label">Calls</p>
          <p className="tile-value">{compact(convs.length)}</p>
          <p className="tile-note">{convs.filter((c) => c.channel === "phone").length} by phone</p>
        </div>
        <div className="tile">
          <p className="tile-label">Escalated to a specialist</p>
          <p className="tile-value">{convs.length ? `${Math.round((100 * escalatedCalls) / convs.length)}%` : "–"}</p>
          <p className="tile-note">{escalatedCalls} of {convs.length} calls</p>
        </div>
        <div className="tile">
          <p className="tile-label">Median time to first word</p>
          <p className="tile-value">{median !== null ? `${(median / 1000).toFixed(1)}s` : "–"}</p>
          <p className="tile-note">across {firstTokens.length} turns</p>
        </div>
        <div className="tile">
          <p className="tile-label">Model spend</p>
          <p className="tile-value">${spend.toFixed(2)}</p>
          <p className="tile-note">{convs.length ? `$${(spend / convs.length).toFixed(3)} per call` : "no calls yet"}</p>
        </div>
      </section>

      <div className="grid-2">
        <section className="panel">
          <div className="panel-head">
            <h2>Open escalations</h2>
            <Link href="/review/escalations">All escalations</Link>
          </div>
          {escalations.data?.length ? (
            <ul className="list">
              {escalations.data.map((e) => (
                <li key={e.escalation_id}>
                  <Link href={`/review/tickets/${e.ticket_id}`} className="list-main">
                    <strong>{e.escalation_id}</strong> · {e.category} · {e.user_name}
                  </Link>
                  <span className="list-meta">
                    <StatusPill value={e.status} />
                    {e.callback_at ? (
                      <>
                        callback <When iso={e.callback_at} />
                      </>
                    ) : e.preferred_time_text ? (
                      `prefers ${e.preferred_time_text}`
                    ) : (
                      <When iso={e.created_at} mode="relative" />
                    )}
                    {!e.assigned_to ? <span className="pill attention">unassigned</span> : null}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="empty">No open escalations.</p>
          )}
        </section>

        <section className="panel">
          <div className="panel-head">
            <h2>Your open tickets</h2>
            <Link href="/review/tickets?view=mine">All yours</Link>
          </div>
          {mine.data?.length ? (
            <ul className="list">
              {mine.data.map((k) => (
                <li key={k.ticket_id}>
                  <Link href={`/review/tickets/${k.ticket_id}`} className="list-main">
                    <strong>{k.ticket_id}</strong> · {k.summary}
                  </Link>
                  <span className="list-meta">
                    <StatusPill value={k.priority} label={`${k.priority} priority`} />
                    <StatusPill value={k.status} />
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="empty">
              Nothing assigned to you. <Link href="/review/tickets?view=unassigned">Pick up an unassigned ticket.</Link>
            </p>
          )}
        </section>
      </div>

      <section className="panel">
        <div className="panel-head">
          <h2>How turns were answered</h2>
          <span className="muted">{t.length} turns</span>
        </div>
        <table className="table compact-table">
          <tbody>
            {paths.map(({ p, n }) => (
              <tr key={p}>
                <td>
                  <StatusPill value={p} />
                </td>
                <td className="num">{n}</td>
                <td className="num muted">{t.length ? `${Math.round((100 * n) / t.length)}%` : "–"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}

/** Open, unassigned tickets that aren't already escalations (those show in Open escalations). */
async function unassignedTickets(supabase: Awaited<ReturnType<typeof supabaseServer>>) {
  const { data: escalated } = await supabase.from("escalations").select("ticket_id");
  const ids = (escalated ?? []).map((e) => `"${e.ticket_id}"`).join(",");
  let q = supabase.from("support_tickets").select("ticket_id", { count: "exact", head: true }).is("assigned_to", null).eq("status", "open");
  if (ids) q = q.not("ticket_id", "in", `(${ids})`);
  return q;
}
