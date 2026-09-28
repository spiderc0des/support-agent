import Link from "next/link";
import { PRIORITIES, TICKET_CATEGORIES } from "@relaypay/shared/enums";
import { FilterSelect } from "@/components/FilterSelect";
import { StatusPill } from "@/components/StatusPill";
import { When } from "@/components/When";
import { currentProfile, displayName } from "@/lib/auth";
import { supabaseServer } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const VIEWS = [
  { key: "open", label: "Open" },
  { key: "mine", label: "Mine" },
  { key: "unassigned", label: "Unassigned" },
  { key: "closed", label: "Closed" },
  { key: "all", label: "All" },
] as const;

type Search = { view?: string; priority?: string; category?: string; q?: string };

/** Every ticket the agent or a person opened, with the call it came from. */
export default async function Tickets({ searchParams }: { searchParams: Promise<Search> }) {
  const sp = await searchParams;
  const view = VIEWS.some((v) => v.key === sp.view) ? sp.view! : "open";
  const me = (await currentProfile())!;
  const supabase = await supabaseServer();

  let q = supabase
    .from("support_tickets")
    .select("ticket_id, conversation_id, customer_id, transaction_id, payout_id, category, priority, summary, status, assigned_to, created_at, updated_at")
    .order("created_at", { ascending: false })
    .limit(200);
  if (view === "open") q = q.neq("status", "closed");
  if (view === "closed") q = q.eq("status", "closed");
  if (view === "mine") q = q.eq("assigned_to", me.id).neq("status", "closed");
  if (view === "unassigned") q = q.is("assigned_to", null).neq("status", "closed");
  if (sp.priority && (PRIORITIES as readonly string[]).includes(sp.priority)) q = q.eq("priority", sp.priority);
  if (sp.category && (TICKET_CATEGORIES as readonly string[]).includes(sp.category)) q = q.eq("category", sp.category);
  const search = sp.q?.trim().slice(0, 80);
  if (search) {
    const safe = search.replace(/[,()%]/g, " ");
    q = q.or(`ticket_id.ilike.%${safe}%,summary.ilike.%${safe}%,customer_id.ilike.%${safe}%,transaction_id.ilike.%${safe}%`);
  }
  const { data: rows, error } = await q;

  const ids = (rows ?? []).map((r) => r.ticket_id);
  const people = [...new Set((rows ?? []).map((r) => r.assigned_to).filter(Boolean))] as string[];
  const [{ data: escs }, { data: profiles }] = await Promise.all([
    ids.length ? supabase.from("escalations").select("escalation_id, ticket_id, status").in("ticket_id", ids) : Promise.resolve({ data: [] as { escalation_id: string; ticket_id: string; status: string }[] }),
    people.length ? supabase.from("profiles").select("id, full_name, email").in("id", people) : Promise.resolve({ data: [] as { id: string; full_name: string | null; email: string }[] }),
  ]);
  const escByTicket = new Map((escs ?? []).map((e) => [e.ticket_id, e]));
  const nameById = new Map((profiles ?? []).map((p) => [p.id, p.id === me.id ? "You" : displayName(p)]));

  const link = (over: Partial<Search>) => {
    const params = new URLSearchParams(Object.entries({ ...sp, view, ...over }).filter(([, v]) => v) as [string, string][]);
    return `/review/tickets?${params}`;
  };

  return (
    <>
      <div className="page-head">
        <h1>Tickets</h1>
        <form className="search" action="/review/tickets">
          <input type="hidden" name="view" value={view} />
          <input className="field" name="q" defaultValue={search ?? ""} placeholder="Ticket, customer, transaction or words" aria-label="Search tickets" />
          <button className="btn secondary" type="submit">
            Search
          </button>
        </form>
      </div>

      <div className="filters" role="tablist" aria-label="Ticket views">
        {VIEWS.map((v) => (
          <Link key={v.key} href={link({ view: v.key })} className={view === v.key ? "active" : ""} role="tab" aria-selected={view === v.key}>
            {v.label}
          </Link>
        ))}
        <span className="filter-sep" />
        {PRIORITIES.map((p) => (
          <Link key={p} href={link({ priority: sp.priority === p ? undefined : p })} className={sp.priority === p ? "active" : ""}>
            {p}
          </Link>
        ))}
        <FilterSelect name="category" label="Category" options={TICKET_CATEGORIES} anyLabel="Any category" />
      </div>

      {error ? <p className="notice bad">{error.message}</p> : null}

      <table className="table responsive">
        <thead>
          <tr>
            <th>Ticket</th>
            <th>Summary</th>
            <th>Priority</th>
            <th>Status</th>
            <th>Owner</th>
            <th>Opened</th>
            <th>Call</th>
          </tr>
        </thead>
        <tbody>
          {(rows ?? []).map((r) => {
            const esc = escByTicket.get(r.ticket_id);
            return (
              <tr key={r.ticket_id}>
                <td data-label="Ticket">
                  <Link href={`/review/tickets/${r.ticket_id}`}>
                    <strong>{r.ticket_id}</strong>
                  </Link>
                  <div className="muted">{r.category}</div>
                  {esc ? <StatusPill value="escalated" label={`escalated · ${esc.escalation_id}`} /> : null}
                </td>
                <td data-label="Summary" className="summary">
                  {r.summary}
                  {r.customer_id || r.transaction_id || r.payout_id ? (
                    <div className="muted">{[r.customer_id, r.transaction_id, r.payout_id].filter(Boolean).join(" · ")}</div>
                  ) : null}
                </td>
                <td data-label="Priority">
                  <StatusPill value={r.priority} />
                </td>
                <td data-label="Status">
                  <StatusPill value={r.status} />
                </td>
                <td data-label="Owner">{r.assigned_to ? nameById.get(r.assigned_to) ?? "someone" : <span className="muted">unassigned</span>}</td>
                <td data-label="Opened">
                  <When iso={r.created_at} mode="relative" />
                </td>
                <td data-label="Call">
                  {r.conversation_id ? <Link href={`/review/conversations/${r.conversation_id}`}>View call</Link> : <span className="muted">none</span>}
                </td>
              </tr>
            );
          })}
          {rows?.length === 0 ? (
            <tr>
              <td colSpan={7} className="empty">
                No tickets match.
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </>
  );
}
