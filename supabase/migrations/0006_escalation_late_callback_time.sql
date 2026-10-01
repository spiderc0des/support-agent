-- ============================================================================
-- 0006_escalation_late_callback_time.sql — keep a callback time given late
--
-- Found by the eval (scenario S7): the agent created the escalation as soon as
-- it had the caller's name and email, then asked for a callback time. The
-- caller's answer ("tomorrow at 10am") reached create_escalation as a repeat
-- call, which the dedupe returned unchanged, so the time was lost and
-- call_booked stayed false.
--
-- Now a repeat call for the same open escalation fills in what the first call
-- lacked: the preferred time (setting call_booked), and the customer link. It
-- never overwrites a value already recorded, and it still creates nothing new.
-- ============================================================================

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
   limit 1;

  if found then
    -- Fill gaps only; never overwrite what the caller already gave.
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

revoke all on function public.create_escalation(uuid, text, text, text, text, text, text, text, text, text, text, integer) from public, anon, authenticated;
grant execute on function public.create_escalation(uuid, text, text, text, text, text, text, text, text, text, text, integer) to service_role;
