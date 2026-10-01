import Link from "next/link";
import { CHANNELS, CONVERSATION_STATUSES } from "@relaypay/shared/enums";
import { FilterSelect } from "@/components/FilterSelect";
import { StatusPill } from "@/components/StatusPill";
import { When } from "@/components/When";
import { supabaseServer } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const PAGE = 50;

export default async function Conversations({ searchParams }: { searchParams: Promise<{ channel?: string; status?: string; page?: string }> }) {
  const sp = await searchParams;
  const page = Math.max(1, Number(sp.page) || 1);
  const supabase = await supabaseServer();

  let q = supabase
    .from("conversations")
    .select("id, channel, status, started_at, ended_at, num_turns, total_cost_usd, summary, caller_identifier, customer_id", { count: "exact" })
    .is("deleted_at", null)
    .order("started_at", { ascending: false })
    .range((page - 1) * PAGE, page * PAGE - 1);
  if (sp.channel && (CHANNELS as readonly string[]).includes(sp.channel)) q = q.eq("channel", sp.channel);
  else q = q.neq("channel", "eval"); // eval runs have their own page
  if (sp.status && (CONVERSATION_STATUSES as readonly string[]).includes(sp.status)) q = q.eq("status", sp.status);
  const { data: rows, error, count } = await q;

  const ids = (rows ?? []).map((r) => r.id);
  const { data: tickets } = ids.length
    ? await supabase.from("support_tickets").select("ticket_id, conversation_id").in("conversation_id", ids).is("deleted_at", null)
    : { data: [] as { ticket_id: string; conversation_id: string }[] };
  const ticketsBy = new Map<string, string[]>();
  for (const t of tickets ?? []) ticketsBy.set(t.conversation_id, [...(ticketsBy.get(t.conversation_id) ?? []), t.ticket_id]);
  const pages = Math.max(1, Math.ceil((count ?? 0) / PAGE));
  const qs = (p: number) => {
    const n = new URLSearchParams(Object.entries(sp).filter(([, v]) => v) as [string, string][]);
    n.set("page", String(p));
    return `/review/conversations?${n}`;
  };

  return (
    <>
      <div className="page-head">
        <h1>Conversations</h1>
        <span className="muted">{count ?? 0} total</span>
      </div>
      <div className="filters">
        <FilterSelect name="channel" label="Channel" options={CHANNELS} anyLabel="Calls and text (no evals)" />
        <FilterSelect name="status" label="Status" options={CONVERSATION_STATUSES} anyLabel="Any status" />
      </div>
      {error ? <p className="notice bad">{error.message}</p> : null}
      <table className="table responsive">
        <thead>
          <tr>
            <th>Started</th>
            <th>Channel</th>
            <th>Status</th>
            <th>Turns</th>
            <th>Tickets</th>
            <th>Summary</th>
            <th>Cost</th>
          </tr>
        </thead>
        <tbody>
          {(rows ?? []).map((r) => (
            <tr key={r.id}>
              <td data-label="Started">
                <Link href={`/review/conversations/${r.id}`}>
                  <When iso={r.started_at} />
                </Link>
                <div className="muted">{r.caller_identifier ?? "anonymous"}</div>
              </td>
              <td data-label="Channel">{r.channel.replace("_", " ")}</td>
              <td data-label="Status">
                <StatusPill value={r.status} />
              </td>
              <td data-label="Turns">{r.num_turns}</td>
              <td data-label="Tickets">
                {(ticketsBy.get(r.id) ?? []).map((t) => (
                  <Link key={t} href={`/review/tickets/${t}`} className="chip">
                    {t}
                  </Link>
                ))}
                {!ticketsBy.get(r.id) ? <span className="muted">none</span> : null}
              </td>
              <td data-label="Summary" className="summary">
                {r.summary ?? (r.ended_at ? "" : <span className="muted">in progress</span>)}
              </td>
              <td data-label="Cost" className="num">
                ${Number(r.total_cost_usd).toFixed(4)}
              </td>
            </tr>
          ))}
          {rows?.length === 0 ? (
            <tr>
              <td colSpan={7} className="empty">
                No conversations yet.
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
      {pages > 1 ? (
        <nav className="pager" aria-label="Pages">
          {page > 1 ? <Link href={qs(page - 1)}>← Newer</Link> : <span />}
          <span className="muted">
            Page {page} of {pages}
          </span>
          {page < pages ? <Link href={qs(page + 1)}>Older →</Link> : <span />}
        </nav>
      ) : null}
    </>
  );
}
