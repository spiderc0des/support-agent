/**
 * A ticket and its escalation are one case: one status, one owner, one log.
 * The first test is the situation that prompted this: ESC-101 in progress
 * and owned, TCK-1002 still open and unassigned.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { CasePlanError, planCaseChange, type EscalationRow, type TicketRow } from "../apps/web/src/lib/case-plan.ts";

const NOW = "2026-10-01T19:00:00.000Z";
const ME = "user-me";
const ticket = (o: Partial<TicketRow> = {}): TicketRow => ({ ticket_id: "TCK-1002", status: "open", assigned_to: null, ...o });
const esc = (o: Partial<EscalationRow> = {}): EscalationRow => ({ escalation_id: "ESC-101", ticket_id: "TCK-1002", status: "open", assigned_to: null, callback_at: null, ...o });

test("taking the escalation also takes its ticket, logged once", () => {
  const plan = planCaseChange({ ticket: ticket(), escalation: esc(), change: { assignee: ME, status: "in_progress" }, actorId: ME, now: NOW });
  assert.equal(plan.ticketUpdate?.assigned_to, ME);
  assert.equal(plan.escalationUpdate?.assigned_to, ME);
  assert.equal(plan.ticketUpdate?.status, "in_progress");
  assert.equal(plan.escalationUpdate?.status, "in_progress");
  assert.deepEqual(plan.events.map((e) => e.action), ["status_changed", "assigned"]);
  assert.ok(plan.events.every((e) => e.ticket_id === "TCK-1002" && e.escalation_id === "ESC-101"));
});

test("acting from the ticket page changes the escalation too", () => {
  const plan = planCaseChange({ ticket: ticket(), escalation: esc(), change: { status: "closed", note: "Called back; account unlocked." }, actorId: ME, now: NOW });
  for (const u of [plan.ticketUpdate, plan.escalationUpdate]) {
    assert.equal(u?.status, "closed");
    assert.equal(u?.closed_at, NOW);
    assert.equal(u?.resolution_note, "Called back; account unlocked.");
  }
  assert.equal(plan.events.length, 1, "closing is one event carrying the note");
});

test("records that had drifted apart are brought back in line", () => {
  // The screenshot: escalation in progress and mine, ticket open and unassigned.
  const plan = planCaseChange({
    ticket: ticket(),
    escalation: esc({ status: "in_progress", assigned_to: ME }),
    change: { status: "in_progress", assignee: ME },
    actorId: ME,
    now: NOW,
  });
  assert.equal(plan.escalationUpdate, null, "the escalation already matches");
  assert.equal(plan.ticketUpdate?.status, "in_progress");
  assert.equal(plan.ticketUpdate?.assigned_to, ME);
});

test("closing needs a resolution note", () => {
  assert.throws(() => planCaseChange({ ticket: ticket(), escalation: esc(), change: { status: "closed" }, actorId: ME, now: NOW }), CasePlanError);
});

test("the callback time stays on the escalation", () => {
  const plan = planCaseChange({ ticket: ticket(), escalation: esc(), change: { callbackAt: NOW }, actorId: ME, now: NOW });
  assert.equal(plan.ticketUpdate, null);
  assert.equal(plan.escalationUpdate?.callback_at, NOW);
  assert.equal(plan.escalationUpdate?.call_booked, true);
  assert.throws(() => planCaseChange({ ticket: ticket(), escalation: null, change: { callbackAt: NOW }, actorId: ME, now: NOW }), /Only escalations/);
});

test("a ticket without an escalation works as before", () => {
  const plan = planCaseChange({ ticket: ticket(), escalation: null, change: { assignee: ME }, actorId: ME, now: NOW });
  assert.equal(plan.ticketUpdate?.assigned_to, ME);
  assert.equal(plan.escalationUpdate, null);
  assert.equal(plan.events[0].escalation_id, null);
});

test("repeating the current state changes nothing", () => {
  assert.throws(
    () => planCaseChange({ ticket: ticket({ assigned_to: ME }), escalation: esc({ assigned_to: ME }), change: { assignee: ME }, actorId: ME, now: NOW }),
    /Nothing changed/,
  );
});
