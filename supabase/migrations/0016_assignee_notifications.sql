-- ============================================================================
-- 0016_assignee_notifications.sql — email the person who has to act
--
-- Every new ticket and escalation used to email the whole team. Now:
--   case_assigned    only the person a case was assigned to (a booked
--                    callback, or someone else assigning it in the console)
--   case_unassigned  only admins, when a call ends leaving a case nobody owns
-- The old kinds stay valid so earlier rows still render.
-- ============================================================================
alter table public.notifications drop constraint if exists notifications_kind_check;
alter table public.notifications add constraint notifications_kind_check
  check (kind in ('ticket_created', 'escalation_created', 'agent_error', 'case_assigned', 'case_unassigned'));
