-- ============================================================================
-- 0007_sync_escalated_tickets.sql — a ticket and its escalation are one case
--
-- Until now the console let staff work a ticket and the escalation on it
-- separately, so they drifted: ESC-101 in progress and owned while TCK-1002
-- stayed open and unassigned. The app now changes both together
-- (apps/web/src/lib/case-plan.ts). This brings existing records into line,
-- once, with the escalation as the case's record of truth.
--
-- Safe to re-run: it only updates tickets that differ from their escalation.
-- ============================================================================

update public.support_tickets t
   set status          = e.status,
       assigned_to     = e.assigned_to,
       closed_at       = e.closed_at,
       resolution_note = coalesce(t.resolution_note, e.resolution_note),
       updated_at      = now()
  from public.escalations e
 where e.ticket_id = t.ticket_id
   and (t.status is distinct from e.status
        or t.assigned_to is distinct from e.assigned_to
        or t.closed_at is distinct from e.closed_at);
