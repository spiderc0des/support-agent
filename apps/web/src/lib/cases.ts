import "server-only";
import { z } from "zod";
import { supabaseAdmin } from "@relaypay/shared/supabase";
import { RECORD_STATUSES } from "@relaypay/shared/enums";
import { CasePlanError, planCaseChange, type EscalationRow, type TicketRow } from "./case-plan";

/**
 * Working a ticket or an escalation. The only writes staff make.
 *
 * A ticket and the escalation on it are one case: see case-plan.ts for the
 * rules. Every action is logged once in case_events, so the audit trail on
 * the ticket page is complete by construction. Closing stamps closed_at and
 * requires a resolution note: a case closed with no record of what was done
 * is a case nobody can follow up on.
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

  // Load the whole case, whichever record the action came from.
  let ticket: TicketRow | null = null;
  let escalation: EscalationRow | null = null;
  if (kind === "escalation") {
    const { data, error } = await db.from("escalations").select("escalation_id, ticket_id, status, assigned_to, callback_at").eq("escalation_id", id).maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new CaseError(`Escalation ${id} not found`, 404);
    escalation = data as EscalationRow;
  }
  const ticketId = escalation?.ticket_id ?? id;
  const { data: t, error: tErr } = await db.from("support_tickets").select("ticket_id, status, assigned_to").eq("ticket_id", ticketId).maybeSingle();
  if (tErr) throw new Error(tErr.message);
  if (!t) throw new CaseError(`Ticket ${ticketId} not found`, 404);
  ticket = t as TicketRow;
  if (!escalation) {
    const { data: e } = await db
      .from("escalations")
      .select("escalation_id, ticket_id, status, assigned_to, callback_at")
      .eq("ticket_id", ticketId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    escalation = (e as EscalationRow | null) ?? null;
  }

  let assignee: string | null | undefined;
  if (change.assign === "me") assignee = actor.id;
  else if (change.assign === "none") assignee = null;
  else if (change.assign) {
    if (actor.role !== "admin" && change.assign !== actor.id) throw new CaseError("Only admins can assign cases to someone else", 403);
    const { data: person } = await db.from("profiles").select("id, role").eq("id", change.assign).maybeSingle();
    if (!person || !["support_agent", "admin"].includes(person.role)) throw new CaseError("That person is not on the support team", 400);
    assignee = person.id;
  }

  let plan;
  try {
    plan = planCaseChange({
      ticket,
      escalation,
      change: { status: change.status, assignee, note: change.note, callbackAt: change.callback_at },
      actorId: actor.id,
      now: new Date().toISOString(),
    });
  } catch (err) {
    if (err instanceof CasePlanError) throw new CaseError(err.message, err.status);
    throw err;
  }

  if (plan.escalationUpdate && escalation) {
    const { error } = await db.from("escalations").update(plan.escalationUpdate).eq("escalation_id", escalation.escalation_id);
    if (error) throw new Error(error.message);
  }
  if (plan.ticketUpdate) {
    const { error } = await db.from("support_tickets").update(plan.ticketUpdate).eq("ticket_id", ticket.ticket_id);
    if (error) throw new Error(error.message);
  }
  if (plan.events.length) {
    const { error: evErr } = await db.from("case_events").insert(plan.events);
    if (evErr) throw new Error(`Saved, but the audit entry failed: ${evErr.message}`);
  }
  return { changed: plan.events.map((e) => e.action), case: { ticket_id: ticket.ticket_id, escalation_id: escalation?.escalation_id ?? null } };
}
