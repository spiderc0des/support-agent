import "server-only";
import { z } from "zod";
import { supabaseAdmin } from "@relaypay/shared/supabase";
import { RECORD_STATUSES } from "@relaypay/shared/enums";

/**
 * Working a ticket or an escalation. The only writes staff make.
 *
 * Every change is one update plus one case_events row, so the audit trail on
 * the ticket page is complete by construction. Status "closed" stamps
 * closed_at and requires a resolution note: a case closed with no record of
 * what was done is a case nobody can follow up on.
 */
export const CaseChange = z
  .object({
    status: z.enum(RECORD_STATUSES).optional(),
    /** "me" to take it, "none" to release it, or a staff member's id (admins). */
    assign: z.union([z.literal("me"), z.literal("none"), z.string().uuid()]).optional(),
    note: z.string().trim().min(2).max(2000).optional(),
    /** Escalations only: the confirmed callback time, ISO 8601. */
    callback_at: z.string().datetime({ offset: true }).optional(),
  })
  .refine((c) => c.status || c.assign || c.note || c.callback_at, { message: "Nothing to change" });
export type CaseChange = z.infer<typeof CaseChange>;

type Actor = { id: string; role: "support_agent" | "admin" };

export class CaseError extends Error {
  constructor(message: string, readonly status: 400 | 403 | 404 | 409) {
    super(message);
  }
}

export async function applyCaseChange(kind: "ticket" | "escalation", id: string, change: CaseChange, actor: Actor) {
  const db = supabaseAdmin();
  const table = kind === "ticket" ? "support_tickets" : "escalations";
  const key = kind === "ticket" ? "ticket_id" : "escalation_id";

  const { data: row, error: readErr } = await db.from(table).select("*").eq(key, id).maybeSingle();
  if (readErr) throw new Error(readErr.message);
  if (!row) throw new CaseError(`${kind === "ticket" ? "Ticket" : "Escalation"} ${id} not found`, 404);
  if (change.callback_at && kind !== "escalation") throw new CaseError("Only escalations have a callback time", 400);

  let assignee: string | null | undefined;
  if (change.assign === "me") assignee = actor.id;
  else if (change.assign === "none") assignee = null;
  else if (change.assign) {
    if (actor.role !== "admin" && change.assign !== actor.id) throw new CaseError("Only admins can assign cases to someone else", 403);
    const { data: person } = await db.from("profiles").select("id, role").eq("id", change.assign).maybeSingle();
    if (!person || !["support_agent", "admin"].includes(person.role)) throw new CaseError("That person is not on the support team", 400);
    assignee = person.id;
  }

  if (change.status === "closed" && row.status !== "closed" && !change.note) {
    throw new CaseError("Add a resolution note to close this", 400);
  }

  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  const events: Record<string, unknown>[] = [];
  const ticketId = kind === "ticket" ? id : (row.ticket_id as string);
  const base = { ticket_id: ticketId, escalation_id: kind === "escalation" ? id : null, actor_id: actor.id };

  if (change.status && change.status !== row.status) {
    update.status = change.status;
    update.closed_at = change.status === "closed" ? new Date().toISOString() : null;
    if (change.status === "closed") update.resolution_note = change.note;
    events.push({ ...base, action: "status_changed", from_value: row.status, to_value: change.status, note: change.status === "closed" ? change.note : null });
  }
  if (assignee !== undefined && assignee !== row.assigned_to) {
    update.assigned_to = assignee;
    events.push({ ...base, action: assignee ? "assigned" : "unassigned", from_value: row.assigned_to, to_value: assignee });
  }
  if (change.callback_at) {
    update.callback_at = change.callback_at;
    update.call_booked = true;
    events.push({ ...base, action: "callback_scheduled", from_value: row.callback_at, to_value: change.callback_at });
  }
  if (change.note && !(change.status === "closed" && row.status !== "closed")) {
    events.push({ ...base, action: "note_added", note: change.note });
  }
  if (events.length === 0) throw new CaseError("Nothing changed", 409);

  if (Object.keys(update).length > 1) {
    const { error } = await db.from(table).update(update).eq(key, id);
    if (error) throw new Error(error.message);
  }
  const { error: evErr } = await db.from("case_events").insert(events);
  if (evErr) throw new Error(`Saved, but the audit entry failed: ${evErr.message}`);
  return { changed: events.map((e) => e.action as string) };
}
