import Link from "next/link";
import { notFound } from "next/navigation";
import { CaseActions } from "@/components/CaseActions";
import { DeleteControl, DeletedBanner } from "@/components/DeleteControl";
import { StatusPill } from "@/components/StatusPill";
import { When } from "@/components/When";
import { currentProfile, displayName } from "@/lib/auth";
import { supabaseServer } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const ACTION_TEXT: Record<string, string> = {
  status_changed: "changed status",
  assigned: "assigned",
  unassigned: "released",
  note_added: "added a note",
  callback_scheduled: "scheduled the callback",
  deleted: "deleted the case",
  restored: "restored the case",
};

/**
 * One case: the ticket, the escalation on it (if any), the call it came
 * from, what the agent said, and everything people have done since.
 */
export default async function TicketPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const me = (await currentProfile())!;
  const supabase = await supabaseServer();

  const { data: ticket } = await supabase.from("support_tickets").select("*").eq("ticket_id", id).maybeSingle();
  if (!ticket) notFound();

  // Everything else in one round trip. The team is small, so all profiles
  // are fetched up front rather than waiting to learn whose names we need.
  const [{ data: escalation }, { data: events }, { data: conv }, { data: turns }, { data: customer }, { data: notices }, { data: people }] = await Promise.all([
    supabase.from("escalations").select("*").eq("ticket_id", id).maybeSingle(),
    supabase.from("case_events").select("*").eq("ticket_id", id).order("created_at"),
    ticket.conversation_id
      ? supabase.from("conversations").select("id, channel, started_at, ended_at, status, summary, caller_identifier").eq("id", ticket.conversation_id).maybeSingle()
      : Promise.resolve({ data: null }),
    ticket.conversation_id
      ? supabase.from("conversation_turns").select("turn_index, user_transcript, assistant_response, answer_type").eq("conversation_id", ticket.conversation_id).order("turn_index")
      : Promise.resolve({ data: [] }),
    ticket.customer_id ? supabase.from("customers").select("customer_id, company_name, plan, account_status, region").eq("customer_id", ticket.customer_id).maybeSingle() : Promise.resolve({ data: null }),
    supabase.from("notifications").select("id, kind, recipients, status, detail, created_at").eq("ticket_id", id).order("created_at"),
    supabase.from("profiles").select("id, full_name, email"),
  ]);

  const name = (pid: string | null | undefined) => {
    if (!pid) return null;
    if (pid === me.id) return "You";
    const p = (people ?? []).find((x) => x.id === pid);
    return p ? displayName(p) : "a former teammate";
  };

  return (
    <>
      <p className="crumbs">
        <Link href="/review/tickets">Tickets</Link> / {ticket.ticket_id}
      </p>
      {ticket.deleted_at ? <DeletedBanner when={ticket.deleted_at} by={name(ticket.deleted_by)} reason={ticket.delete_reason} /> : null}
      <div className="page-head">
        <div>
          <h1>
            {ticket.ticket_id}
            {escalation ? <span className="muted"> + {escalation.escalation_id}</span> : null} <StatusPill value={(escalation ?? ticket).status} />{" "}
            <StatusPill value={ticket.priority} label={`${ticket.priority} priority`} />
          </h1>
          <p className="muted">
            {escalation ? "escalated case · " : ""}
            {ticket.category} · opened <When iso={ticket.created_at} /> · owner: {name((escalation ?? ticket).assigned_to) ?? "unassigned"}
          </p>
        </div>
        {ticket.conversation_id ? (
          <Link href={`/review/conversations/${ticket.conversation_id}`} className="btn secondary">
            Open the call
          </Link>
        ) : null}
      </div>

      <div className="grid-2 wide-left">
        <div className="stack">
          <section className="panel">
            <h2>What the customer needs</h2>
            <p className="lead-text">{ticket.summary}</p>
            {ticket.resolution_note ? (
              <p className="notice ok">
                <strong>Resolution:</strong> {ticket.resolution_note}
              </p>
            ) : null}
            <dl className="facts">
              <dt>Customer</dt>
              <dd>{customer ? `${customer.company_name} (${customer.customer_id}) · ${customer.plan} · ${customer.account_status} · ${customer.region}` : (ticket.customer_id ?? "not identified")}</dd>
              <dt>Transaction</dt>
              <dd>{ticket.transaction_id ?? "none"}</dd>
              <dt>Payout</dt>
              <dd>{ticket.payout_id ?? "none"}</dd>
            </dl>
          </section>

          {escalation ? (
            <section className="panel highlight">
              <div className="panel-head">
                <h2>
                  Escalation {escalation.escalation_id} <StatusPill value={escalation.status} />
                </h2>
                <span className="muted">a specialist contacts the caller</span>
              </div>
              <dl className="facts">
                <dt>Why</dt>
                <dd>{escalation.reason}</dd>
                <dt>Category</dt>
                <dd>{escalation.category}</dd>
                <dt>Contact</dt>
                <dd>
                  {escalation.user_name} · <a href={`mailto:${escalation.user_email}`}>{escalation.user_email}</a>
                  {escalation.contact_matches_record === false ? <span className="pill attention">not the email on file</span> : null}
                  {escalation.contact_matches_record ? <span className="pill done">matches the account</span> : null}
                </dd>
                <dt>Callback</dt>
                <dd>
                  {escalation.callback_at ? (
                    <>
                      confirmed for <When iso={escalation.callback_at} />
                    </>
                  ) : escalation.call_booked ? (
                    `requested: ${escalation.preferred_time_text}`
                  ) : (
                    "not requested"
                  )}
                </dd>
                {escalation.resolution_note ? (
                  <>
                    <dt>Resolution</dt>
                    <dd>{escalation.resolution_note}</dd>
                  </>
                ) : null}
              </dl>
            </section>
          ) : null}

          {conv ? (
            <section className="panel">
              <div className="panel-head">
                <h2>The call</h2>
                <Link href={`/review/conversations/${conv.id}`}>Full record</Link>
              </div>
              <p className="muted">
                {conv.channel.replace("_", " ")} · <When iso={conv.started_at} /> · {conv.caller_identifier ?? "anonymous caller"} · <StatusPill value={conv.status} />
              </p>
              {conv.summary ? <p>{conv.summary}</p> : null}
              <div className="transcript">
                {(turns ?? []).map((t) => (
                  <div key={t.turn_index} className="exchange">
                    <p>
                      <span className="who">Caller</span>
                      {t.user_transcript}
                    </p>
                    <p>
                      <span className="who">Agent</span>
                      {t.assistant_response} <StatusPill value={t.answer_type} />
                    </p>
                  </div>
                ))}
              </div>
            </section>
          ) : null}
        </div>

        <div className="stack">
          <section className="panel">
            <h2>{escalation ? "Case actions" : "Ticket actions"}</h2>
            {escalation ? (
              <p className="muted">
                {ticket.ticket_id} and {escalation.escalation_id} are one case: assigning, starting or closing applies to both.
              </p>
            ) : null}
            {escalation ? (
              <CaseActions
                kind="escalation"
                id={escalation.escalation_id}
                caseLabel={`${ticket.ticket_id} and ${escalation.escalation_id}`}
                status={escalation.status}
                assignedToMe={escalation.assigned_to === me.id}
                assigneeName={escalation.assigned_to && escalation.assigned_to !== me.id ? name(escalation.assigned_to) : null}
                meId={me.id}
              />
            ) : (
              <CaseActions
                kind="ticket"
                id={ticket.ticket_id}
                status={ticket.status}
                assignedToMe={ticket.assigned_to === me.id}
                assigneeName={ticket.assigned_to && ticket.assigned_to !== me.id ? name(ticket.assigned_to) : null}
                meId={me.id}
              />
            )}
          </section>

          {me.role === "admin" ? (
            <section className="panel">
              <h2>{ticket.deleted_at ? "Restore" : "Delete"}</h2>
              <p className="muted">
                {ticket.deleted_at
                  ? "Restoring puts the case back in the queues and counts."
                  : "For test cases and mistakes. The case is hidden from every queue and count, not erased, and can be restored."}
              </p>
              <DeleteControl
                kind="case"
                id={ticket.ticket_id}
                label={escalation ? `${ticket.ticket_id} and ${escalation.escalation_id}` : ticket.ticket_id}
                detail={escalation ? "The ticket and its escalation are deleted together." : "The ticket is hidden from the queue."}
                deleted={Boolean(ticket.deleted_at)}
                afterDelete="/review/tickets"
              />
            </section>
          ) : null}

          <section className="panel">
            <h2>Activity</h2>
            <ol className="timeline">
              <li>
                <span className="t-when">
                  <When iso={ticket.created_at} />
                </span>
                <span>Opened by the support agent{conv ? " during the call" : ""}</span>
              </li>
              {escalation ? (
                <li>
                  <span className="t-when">
                    <When iso={escalation.created_at} />
                  </span>
                  <span>Escalated to a specialist ({escalation.escalation_id})</span>
                </li>
              ) : null}
              {(notices ?? []).map((n) => (
                <li key={n.id}>
                  <span className="t-when">
                    <When iso={n.created_at} />
                  </span>
                  <span>
                    {n.status === "sent"
                      ? `Support team emailed (${n.recipients.length})`
                      : n.status === "partial"
                        ? `Support team emailed, some failed (${n.recipients.length})`
                        : n.status === "failed"
                          ? "Team email failed"
                          : "Team email not sent"}
                    {n.detail ? <span className="t-note">{n.detail}</span> : null}
                  </span>
                </li>
              ))}
              {(events ?? []).map((e) => (
                <li key={e.id}>
                  <span className="t-when">
                    <When iso={e.created_at} />
                  </span>
                  <span>
                    <strong>{name(e.actor_id) ?? "Someone"}</strong> {ACTION_TEXT[e.action] ?? e.action}
                    {e.action === "status_changed" ? ` from ${String(e.from_value).replace("_", " ")} to ${String(e.to_value).replace("_", " ")}` : ""}
                    {e.action === "assigned" ? ` to ${name(e.to_value)}` : ""}
                    {e.action === "callback_scheduled" && e.to_value ? (
                      <>
                        {" "}
                        for <When iso={e.to_value} />
                      </>
                    ) : null}
                    {e.note ? <span className="t-note">{e.note}</span> : null}
                  </span>
                </li>
              ))}
            </ol>
          </section>
        </div>
      </div>
    </>
  );
}
