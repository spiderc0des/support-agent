import Link from "next/link";
import { ESCALATION_CATEGORIES } from "@relaypay/shared/enums";
import { FilterSelect } from "@/components/FilterSelect";
import { StatusPill } from "@/components/StatusPill";
import { When } from "@/components/When";
import { currentProfile, displayName } from "@/lib/auth";
import { supabaseServer } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const VIEWS = [
  { key: "open", label: "Open" },
  { key: "callback", label: "Callback requested" },
  { key: "mine", label: "Mine" },
  { key: "closed", label: "Closed" },
  { key: "all", label: "All" },
] as const;

/** Cases that need a specialist, oldest first: they have been waiting longest. */
export default async function Escalations({ searchParams }: { searchParams: Promise<{ view?: string; category?: string }> }) {
  const sp = await searchParams;
  const view = VIEWS.some((v) => v.key === sp.view) ? sp.view! : "open";
  const me = (await currentProfile())!;
  const supabase = await supabaseServer();

  let q = supabase
    .from("escalations")
    .select("escalation_id, ticket_id, conversation_id, customer_id, user_name, user_email, category, reason, call_booked, preferred_time_text, callback_at, status, assigned_to, created_at")
    .is("deleted_at", null)
    .order("created_at", { ascending: view === "closed" || view === "all" ? false : true })
    .limit(200);
  if (view === "open") q = q.neq("status", "closed");
  if (view === "callback") q = q.eq("call_booked", true).neq("status", "closed");
  if (view === "mine") q = q.eq("assigned_to", me.id).neq("status", "closed");
  if (view === "closed") q = q.eq("status", "closed");
  if (sp.category && (ESCALATION_CATEGORIES as readonly string[]).includes(sp.category)) q = q.eq("category", sp.category);
  const { data: rows, error } = await q;

  const people = [...new Set((rows ?? []).map((r) => r.assigned_to).filter(Boolean))] as string[];
  const { data: profiles } = people.length ? await supabase.from("profiles").select("id, full_name, email").in("id", people) : { data: [] as { id: string; full_name: string | null; email: string }[] };
  const nameById = new Map((profiles ?? []).map((p) => [p.id, p.id === me.id ? "You" : displayName(p)]));

  return (
    <>
      <div className="page-head">
        <h1>Escalations</h1>
      </div>
      <div className="filters">
        {VIEWS.map((v) => (
          <Link key={v.key} href={`/review/escalations?view=${v.key}${sp.category ? `&category=${sp.category}` : ""}`} className={view === v.key ? "active" : ""}>
            {v.label}
          </Link>
        ))}
        <FilterSelect name="category" label="Category" options={ESCALATION_CATEGORIES} anyLabel="Any category" />
      </div>
      {error ? <p className="notice bad">{error.message}</p> : null}

      <table className="table responsive">
        <thead>
          <tr>
            <th>Escalation</th>
            <th>Reason</th>
            <th>Contact</th>
            <th>Callback</th>
            <th>Status</th>
            <th>Owner</th>
            <th>Waiting since</th>
          </tr>
        </thead>
        <tbody>
          {(rows ?? []).map((e) => (
            <tr key={e.escalation_id}>
              <td data-label="Escalation">
                <Link href={`/review/tickets/${e.ticket_id}`}>
                  <strong>{e.escalation_id}</strong>
                </Link>
                <div className="muted">
                  {e.category} · on {e.ticket_id}
                </div>
              </td>
              <td data-label="Reason" className="summary">
                {e.reason}
              </td>
              <td data-label="Contact">
                {e.user_name}
                <div className="muted">{e.user_email}</div>
              </td>
              <td data-label="Callback">
                {e.callback_at ? <When iso={e.callback_at} /> : e.call_booked ? <span>{e.preferred_time_text} <span className="muted">(requested)</span></span> : <span className="muted">none</span>}
              </td>
              <td data-label="Status">
                <StatusPill value={e.status} />
              </td>
              <td data-label="Owner">{e.assigned_to ? nameById.get(e.assigned_to) ?? "someone" : <span className="pill attention">unassigned</span>}</td>
              <td data-label="Waiting since">
                <When iso={e.created_at} mode="relative" />
                {e.conversation_id ? (
                  <div>
                    <Link href={`/review/conversations/${e.conversation_id}`}>View call</Link>
                  </div>
                ) : null}
              </td>
            </tr>
          ))}
          {rows?.length === 0 ? (
            <tr>
              <td colSpan={7} className="empty">
                No escalations here.
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </>
  );
}
