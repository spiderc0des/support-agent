import { notifyStaff, type Recipient, type StaffEvent } from "@relaypay/shared/notify";
import { supabaseAdmin } from "@relaypay/shared/supabase";

/**
 * Case emails from the web app. Only the person who has to act is emailed:
 * the assignee when someone else assigns them a case, and the admins when a
 * call ends leaving a case nobody owns. Never awaited by a caller-facing path.
 */
const record = async (row: Parameters<Parameters<typeof notifyStaff>[1]["record"]>[0]) => {
  const { error } = await supabaseAdmin().from("notifications").insert(row);
  if (error) console.error("[notify] failed to record notification:", error.message);
};

async function person(id: string): Promise<Recipient[]> {
  const { data } = await supabaseAdmin().from("profiles").select("email, full_name").eq("id", id).maybeSingle();
  return data ? [{ email: data.email as string, name: (data.full_name as string | null) ?? null }] : [];
}

async function admins(): Promise<Recipient[]> {
  const { data } = await supabaseAdmin().from("profiles").select("email, full_name").eq("role", "admin");
  return (data ?? []).map((p) => ({ email: p.email as string, name: (p.full_name as string | null) ?? null }));
}

/** Someone assigned a case to a colleague in the console: email that colleague. */
export async function notifyAssignee(opts: { ticketId: string; escalationId: string | null; assigneeId: string; actorName: string }) {
  const db = supabaseAdmin();
  const [{ data: t }, { data: e }] = await Promise.all([
    db.from("support_tickets").select("summary, conversation_id").eq("ticket_id", opts.ticketId).maybeSingle(),
    opts.escalationId ? db.from("escalations").select("reason, user_name").eq("escalation_id", opts.escalationId).maybeSingle() : Promise.resolve({ data: null }),
  ]);
  const ev: StaffEvent = {
    kind: "case_assigned",
    ticketId: opts.ticketId,
    escalationId: opts.escalationId,
    conversationId: (t?.conversation_id as string | null) ?? null,
    channel: "console",
    title: (e?.reason as string | undefined) ?? (t?.summary as string | undefined) ?? "A support case",
    assignedBy: opts.actorName,
    callerName: (e?.user_name as string | null | undefined) ?? null,
    callback: null,
  };
  await notifyStaff(ev, { recipients: () => person(opts.assigneeId), record });
}

/** A call ended: tell the admins about each open case from it that nobody owns. */
export async function notifyUnassignedCases(conversationId: string) {
  const db = supabaseAdmin();
  const [{ data: conv }, { data: tickets }] = await Promise.all([
    db.from("conversations").select("channel").eq("id", conversationId).maybeSingle(),
    db
      .from("support_tickets")
      .select("ticket_id, summary")
      .eq("conversation_id", conversationId)
      .is("assigned_to", null)
      .is("deleted_at", null)
      .neq("status", "closed"),
  ]);
  for (const t of tickets ?? []) {
    const { data: e } = await db
      .from("escalations")
      .select("escalation_id, reason, user_name, preferred_time_text, assigned_to")
      .eq("ticket_id", t.ticket_id)
      .is("deleted_at", null)
      .maybeSingle();
    if (e?.assigned_to) continue;
    await notifyStaff(
      {
        kind: "case_unassigned",
        ticketId: t.ticket_id as string,
        escalationId: (e?.escalation_id as string | undefined) ?? null,
        conversationId,
        channel: (conv?.channel as string) ?? "unknown",
        title: (e?.reason as string | undefined) ?? (t.summary as string),
        callerName: (e?.user_name as string | null | undefined) ?? null,
        preferredTime: (e?.preferred_time_text as string | null | undefined) ?? null,
      },
      { recipients: admins, record },
    );
  }
}
