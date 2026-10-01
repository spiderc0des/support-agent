/**
 * What one staff action does to a case. Pure: no database, so it is tested
 * directly (tests/case-plan.test.ts).
 *
 * A ticket with an escalation on it is ONE case. Before this, the two had
 * separate statuses and owners, so a specialist could be working ESC-101
 * while TCK-1002 still read "open, unassigned" in the queue, and a
 * teammate could pick up the same customer. Now:
 *
 *   - status and owner changes apply to both records, whichever one the
 *     action came from, and bring them back in line if they had drifted;
 *   - each action is logged once for the case, not once per record;
 *   - the escalation is the record the case is judged by ("primary");
 *   - a callback time belongs to the escalation only.
 *
 * A ticket with no escalation behaves exactly as before.
 */
import type { RecordStatus } from "@relaypay/shared/enums";

export type CaseRecord = {
  status: RecordStatus;
  assigned_to: string | null;
  callback_at?: string | null;
};
export type TicketRow = CaseRecord & { ticket_id: string };
export type EscalationRow = CaseRecord & { escalation_id: string; ticket_id: string };

export type PlannedChange = {
  status?: RecordStatus;
  /** undefined = leave alone, null = unassign, string = this person. */
  assignee?: string | null;
  note?: string;
  callbackAt?: string;
};

export type CaseEvent = {
  ticket_id: string;
  escalation_id: string | null;
  actor_id: string;
  action: "status_changed" | "assigned" | "unassigned" | "note_added" | "callback_scheduled";
  from_value?: string | null;
  to_value?: string | null;
  note?: string | null;
};

export type CasePlan = {
  ticketUpdate: Record<string, unknown> | null;
  escalationUpdate: Record<string, unknown> | null;
  events: CaseEvent[];
};

export class CasePlanError extends Error {
  constructor(message: string, readonly status: 400 | 409) {
    super(message);
  }
}

export function planCaseChange(opts: {
  ticket: TicketRow;
  escalation: EscalationRow | null;
  change: PlannedChange;
  actorId: string;
  now: string;
}): CasePlan {
  const { ticket, escalation, change, actorId, now } = opts;
  const primary: CaseRecord = escalation ?? ticket;
  const ticketUpdate: Record<string, unknown> = {};
  const escalationUpdate: Record<string, unknown> = {};
  const events: CaseEvent[] = [];
  const base = { ticket_id: ticket.ticket_id, escalation_id: escalation?.escalation_id ?? null, actor_id: actorId };

  if (change.callbackAt && !escalation) throw new CasePlanError("Only escalations have a callback time", 400);

  // ---- status: one status for the whole case.
  if (change.status) {
    const target = change.status;
    const closing = target === "closed" && primary.status !== "closed";
    if (closing && !change.note) throw new CasePlanError("Add a resolution note to close this", 400);
    const statusFields = {
      status: target,
      closed_at: target === "closed" ? now : null,
      ...(closing ? { resolution_note: change.note } : {}),
    };
    if (ticket.status !== target || closing) Object.assign(ticketUpdate, statusFields);
    if (escalation && (escalation.status !== target || closing)) Object.assign(escalationUpdate, statusFields);
    const from = primary.status !== target ? primary.status : ticket.status;
    if (from !== target) {
      events.push({ ...base, action: "status_changed", from_value: from, to_value: target, note: closing ? change.note : null });
    }
  }

  // ---- owner: one owner for the whole case.
  if (change.assignee !== undefined) {
    const target = change.assignee;
    if (ticket.assigned_to !== target) ticketUpdate.assigned_to = target;
    if (escalation && escalation.assigned_to !== target) escalationUpdate.assigned_to = target;
    const from = primary.assigned_to !== target ? primary.assigned_to : ticket.assigned_to;
    if (from !== target) events.push({ ...base, action: target ? "assigned" : "unassigned", from_value: from, to_value: target });
  }

  // ---- callback: the escalation's alone.
  if (change.callbackAt && escalation) {
    escalationUpdate.callback_at = change.callbackAt;
    escalationUpdate.call_booked = true;
    events.push({ ...base, action: "callback_scheduled", from_value: escalation.callback_at ?? null, to_value: change.callbackAt });
  }

  // ---- note: once per case. A closing note is already on its status event.
  const closingNote = change.status === "closed" && primary.status !== "closed";
  if (change.note && !closingNote) events.push({ ...base, action: "note_added", note: change.note });

  const touched = (u: Record<string, unknown>) => (Object.keys(u).length ? { ...u, updated_at: now } : null);
  const plan = { ticketUpdate: touched(ticketUpdate), escalationUpdate: escalation ? touched(escalationUpdate) : null, events };
  if (!plan.ticketUpdate && !plan.escalationUpdate && events.length === 0) throw new CasePlanError("Nothing changed", 409);
  return plan;
}
