-- ============================================================================
-- 0009_abandoned_calls.sql — calls where the caller never spoke are abandoned
--
-- Ended calls were marked 'resolved' whenever no ticket or escalation had
-- been filed, including calls where the caller never said a word. The app now
-- ends those as 'abandoned' (apps/web/src/agent/conversations.ts); this
-- corrects the ones already recorded. Safe to re-run.
-- ============================================================================

update public.conversations c
   set status = 'abandoned'
 where c.status = 'resolved'
   and c.ended_at is not null
   and not exists (select 1 from public.conversation_turns t where t.conversation_id = c.id);
