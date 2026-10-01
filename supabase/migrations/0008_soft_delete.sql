-- ============================================================================
-- 0008_soft_delete.sql — admins can delete (and restore) cases, conversations
-- and eval runs, without losing them
--
-- What can be deleted, and why only these:
--   support_tickets + escalations  one case, deleted and restored together
--   conversations                  test calls, mistakes; takes its cases along
--   eval_runs                      noisy test runs, hidden from the evidence page
-- Seed data and the knowledge base are reference data, not records. Turns,
-- tool calls, retrievals and events belong to a conversation and are hidden
-- with it by the app.
--
-- A delete is a stamp (deleted_at, deleted_by, delete_reason), never a DELETE.
-- Support agents can't read deleted rows at all (RLS below); admins can, so
-- they can restore them. The ticket and escalation functions ignore deleted
-- rows, so a deleted ticket is never handed back to a new caller by dedupe.
-- ============================================================================

do $$
declare
  t text;
begin
  foreach t in array array['support_tickets', 'escalations', 'conversations', 'eval_runs'] loop
    execute format('alter table public.%I add column if not exists deleted_at timestamptz', t);
    execute format('alter table public.%I add column if not exists deleted_by uuid references public.profiles(id) on delete set null', t);
    execute format('alter table public.%I add column if not exists delete_reason text', t);
    execute format('create index if not exists %I on public.%I (deleted_at)', t || '_deleted_idx', t);

    -- Staff see live rows; admins also see deleted ones.
    execute format('drop policy if exists %I on public.%I', t || '_select_staff', t);
    execute format(
      'create policy %I on public.%I for select to authenticated using ((select public.is_staff()) and (deleted_at is null or (select public.is_admin())))',
      t || '_select_staff', t);
  end loop;
end;
$$;

-- Deleting and restoring a case are audited with the rest of its history.
alter table public.case_events drop constraint if exists case_events_action_check;
alter table public.case_events add constraint case_events_action_check
  check (action in ('status_changed', 'assigned', 'unassigned', 'note_added', 'callback_scheduled', 'deleted', 'restored'));

-- ------------------------------------------------- dedupe ignores deleted ---
drop index if exists public.support_tickets_open_dedupe;
create unique index support_tickets_open_dedupe
  on public.support_tickets (conversation_id, category)
  where status = 'open' and conversation_id is not null and deleted_at is null;

drop index if exists public.escalations_open_dedupe;
create unique index escalations_open_dedupe
  on public.escalations (conversation_id, category)
  where status = 'open' and conversation_id is not null and deleted_at is null;

create or replace function public.create_support_ticket(
  p_conversation_id uuid,
  p_category        text,
  p_priority        text,
  p_summary         text,
  p_customer_id     text default null,
  p_transaction_id  text default null,
  p_payout_id       text default null,
  p_turn_index      integer default null
)
returns table (ticket_id text, status text, deduplicated boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ticket public.support_tickets%rowtype;
begin
  select * into v_ticket
    from public.support_tickets t
   where t.conversation_id = p_conversation_id
     and t.category = p_category
     and t.status = 'open'
     and t.deleted_at is null
   limit 1;

  if found then
    return query select v_ticket.ticket_id, v_ticket.status, true;
    return;
  end if;

  insert into public.support_tickets (conversation_id, customer_id, transaction_id, payout_id, category, priority, summary)
  values (p_conversation_id, p_customer_id, p_transaction_id, p_payout_id, p_category, p_priority, p_summary)
  returning * into v_ticket;

  update public.conversations c
     set status = case when c.status = 'escalated' then c.status else 'ticketed' end
   where c.id = p_conversation_id;

  insert into public.conversation_events (conversation_id, turn_index, event_type, summary, metadata, source)
  values (p_conversation_id, p_turn_index, 'ticket_created',
          format('Ticket %s opened (%s, %s priority)', v_ticket.ticket_id, p_category, p_priority),
          jsonb_build_object('ticket_id', v_ticket.ticket_id, 'category', p_category, 'priority', p_priority),
          'system');

  return query select v_ticket.ticket_id, v_ticket.status, false;
end;
$$;

create or replace function public.create_escalation(
  p_conversation_id uuid,
  p_user_name       text,
  p_user_email      text,
  p_category        text,
  p_reason          text,
  p_priority        text default 'high',
  p_preferred_time  text default null,
  p_ticket_id       text default null,
  p_customer_id     text default null,
  p_transaction_id  text default null,
  p_payout_id       text default null,
  p_turn_index      integer default null
)
returns table (escalation_id text, ticket_id text, status text, call_booked boolean,
               contact_matches_record boolean, deduplicated boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_esc       public.escalations%rowtype;
  v_ticket_id text := p_ticket_id;
  v_matches   boolean;
  v_time      text := nullif(btrim(coalesce(p_preferred_time, '')), '');
begin
  select * into v_esc
    from public.escalations e
   where e.conversation_id = p_conversation_id
     and e.category = p_category
     and e.status = 'open'
     and e.deleted_at is null
   limit 1;

  if found then
    if (v_time is not null and v_esc.preferred_time_text is null)
       or (p_customer_id is not null and v_esc.customer_id is null) then
      update public.escalations e
         set preferred_time_text = coalesce(e.preferred_time_text, v_time),
             call_booked = e.call_booked or v_time is not null,
             customer_id = coalesce(e.customer_id, p_customer_id),
             updated_at = now()
       where e.escalation_id = v_esc.escalation_id
      returning * into v_esc;

      insert into public.conversation_events (conversation_id, turn_index, event_type, summary, metadata, source)
      values (p_conversation_id, p_turn_index, 'escalation_created',
              format('Escalation %s updated with details given later in the call', v_esc.escalation_id),
              jsonb_build_object('escalation_id', v_esc.escalation_id, 'preferred_time', v_time),
              'system');
    end if;
    return query select v_esc.escalation_id, v_esc.ticket_id, v_esc.status, v_esc.call_booked,
                        v_esc.contact_matches_record, true;
    return;
  end if;

  -- A ticket the model names must be live; a deleted one is never reused.
  if v_ticket_id is not null and not exists (
    select 1 from public.support_tickets t where t.ticket_id = v_ticket_id and t.deleted_at is null
  ) then
    v_ticket_id := null;
  end if;

  if v_ticket_id is null then
    select t.ticket_id into v_ticket_id
      from public.create_support_ticket(p_conversation_id, p_category, p_priority, p_reason,
                                        p_customer_id, p_transaction_id, p_payout_id, p_turn_index) t;
  end if;

  if p_customer_id is not null then
    select lower(btrim(c.contact_email)) = lower(btrim(p_user_email)) into v_matches
      from public.customers c where c.customer_id = p_customer_id;
  end if;

  insert into public.escalations (ticket_id, conversation_id, customer_id, user_name, user_email, category,
                                  reason, call_booked, preferred_time_text, contact_matches_record)
  values (v_ticket_id, p_conversation_id, p_customer_id, p_user_name, p_user_email, p_category,
          p_reason, v_time is not null, v_time, v_matches)
  returning * into v_esc;

  update public.conversations c
     set status = 'escalated',
         customer_id = coalesce(c.customer_id, p_customer_id)
   where c.id = p_conversation_id;

  insert into public.conversation_events (conversation_id, turn_index, event_type, summary, metadata, source)
  values (p_conversation_id, p_turn_index, 'escalation_created',
          format('Escalation %s opened (%s) on ticket %s', v_esc.escalation_id, p_category, v_ticket_id),
          jsonb_build_object('escalation_id', v_esc.escalation_id, 'ticket_id', v_ticket_id,
                             'category', p_category, 'call_booked', v_time is not null),
          'system');

  return query select v_esc.escalation_id, v_esc.ticket_id, v_esc.status, v_esc.call_booked,
                      v_esc.contact_matches_record, false;
end;
$$;

revoke all on function public.create_support_ticket(uuid, text, text, text, text, text, text, integer) from public, anon, authenticated;
revoke all on function public.create_escalation(uuid, text, text, text, text, text, text, text, text, text, text, integer) from public, anon, authenticated;
grant execute on function public.create_support_ticket(uuid, text, text, text, text, text, text, integer) to service_role;
grant execute on function public.create_escalation(uuid, text, text, text, text, text, text, text, text, text, text, integer) to service_role;
