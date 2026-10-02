-- ============================================================================
-- 0013_know_me_and_callbacks.sql — who is calling, and booking their callback
--
-- 1. "Know me": before a web call, the caller signs in on the voice page.
--    Customers give their account email and customer ID (both must match one
--    account), guests give a name and an email. The call then starts with
--    that identity attached, so the agent addresses them by name and never
--    asks them to spell a name or an email. A customer sign-in counts as
--    verification, the same bar lookup_customer applies on a call.
--
-- 2. Callbacks: when a caller asks for a callback at a time, the MCP server
--    books it with the first human agent, in the admin's order, who is
--    working then, free on their Google Calendar, and not already booked by
--    another caller. The case is assigned to that agent and an event goes on
--    their calendar with the caller invited.
-- ============================================================================

-- --------------------------------------------------------- caller_sessions -
create table if not exists public.caller_sessions (
  id            uuid primary key default gen_random_uuid(),   -- the bearer id in the caller's cookie
  kind          text not null check (kind in ('customer', 'guest')),
  customer_id   text references public.customers(customer_id),
  name          text not null,
  email         text not null,
  timezone      text,
  vapi_call_id  text,
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null default now() + interval '12 hours',
  check ((kind = 'customer') = (customer_id is not null))
);
create index if not exists caller_sessions_vapi_idx on public.caller_sessions (vapi_call_id);
-- Server only: no policies, so neither the anon nor the authenticated role
-- can read a session id (it is a bearer credential).
alter table public.caller_sessions enable row level security;

alter table public.conversations
  add column if not exists caller_session_id uuid references public.caller_sessions(id) on delete set null,
  add column if not exists caller_name text,
  add column if not exists caller_email text,
  add column if not exists caller_timezone text;

-- -------------------------------------------------------- callback routing -
-- Which staff take callbacks, in what order, and when they work.
create table if not exists public.callback_agents (
  profile_id      uuid primary key references public.profiles(id) on delete cascade,
  rank            integer not null,
  takes_callbacks boolean not null default true,
  timezone        text not null default 'Africa/Lagos',
  work_days       integer[] not null default '{1,2,3,4,5}',   -- ISO weekdays, 1 = Monday
  work_start      time not null default '09:00',
  work_end        time not null default '17:00',
  updated_at      timestamptz not null default now(),
  check (work_end > work_start)
);

-- A staff member's Google Calendar connection. The refresh token never
-- leaves the server: no policies, service role only.
create table if not exists public.staff_calendars (
  profile_id     uuid primary key references public.profiles(id) on delete cascade,
  google_email   text,
  refresh_token  text not null,
  connected_at   timestamptz not null default now(),
  last_error     text,
  last_error_at  timestamptz
);
alter table public.staff_calendars enable row level security;

create table if not exists public.callback_bookings (
  id                uuid primary key default gen_random_uuid(),
  escalation_id     text not null references public.escalations(escalation_id) on delete cascade,
  ticket_id         text not null references public.support_tickets(ticket_id) on delete cascade,
  conversation_id   uuid references public.conversations(id) on delete set null,
  profile_id        uuid not null references public.profiles(id),
  slot_start        timestamptz not null,
  slot_end          timestamptz not null,
  caller_timezone   text not null,
  status            text not null default 'booked' check (status in ('booked', 'cancelled')),
  google_event_id   text,
  google_event_link text,
  created_at        timestamptz not null default now(),
  cancelled_at      timestamptz
);
-- The double-booking guard: two callers racing for the same agent and slot,
-- only one insert succeeds.
create unique index if not exists callback_bookings_slot_unique
  on public.callback_bookings (profile_id, slot_start) where status = 'booked';
create unique index if not exists callback_bookings_one_per_escalation
  on public.callback_bookings (escalation_id) where status = 'booked';
create index if not exists callback_bookings_window_idx on public.callback_bookings (slot_start) where status = 'booked';

alter table public.callback_agents enable row level security;
alter table public.callback_bookings enable row level security;
drop policy if exists callback_agents_select_staff on public.callback_agents;
create policy callback_agents_select_staff on public.callback_agents
  for select to authenticated using ((select public.is_staff()));
drop policy if exists callback_bookings_select_staff on public.callback_bookings;
create policy callback_bookings_select_staff on public.callback_bookings
  for select to authenticated using ((select public.is_staff()));

-- ------------------------------------------------------ book_callback_slot -
-- Book one slot for an escalation with one agent, and assign the case to
-- them. Returns the booking id, or null when that agent's slot was taken by
-- another caller a moment earlier (the unique index decides), so the caller
-- can try the next agent. An earlier booking for the same escalation is
-- cancelled in the same transaction (the caller changed the time); its id is
-- returned so the old calendar event can be removed.
create or replace function public.book_callback_slot(
  p_escalation text,
  p_profile    uuid,
  p_start      timestamptz,
  p_end        timestamptz,
  p_timezone   text,
  p_label      text
)
returns table (booking_id uuid, replaced_booking_id uuid, replaced_profile_id uuid, replaced_event_id text)
language plpgsql
set search_path = public
as $$
declare
  v_esc     record;
  v_old     record;
  v_id      uuid;
begin
  select e.escalation_id, e.ticket_id, e.conversation_id, e.assigned_to, e.callback_at
    into v_esc from escalations e where e.escalation_id = p_escalation and e.deleted_at is null;
  if not found then
    raise exception 'escalation % not found', p_escalation;
  end if;

  select b.id, b.profile_id, b.google_event_id into v_old
    from callback_bookings b where b.escalation_id = p_escalation and b.status = 'booked' for update;
  if found then
    update callback_bookings set status = 'cancelled', cancelled_at = now() where id = v_old.id;
  end if;

  begin
    insert into callback_bookings (escalation_id, ticket_id, conversation_id, profile_id, slot_start, slot_end, caller_timezone)
    values (p_escalation, v_esc.ticket_id, v_esc.conversation_id, p_profile, p_start, p_end, p_timezone)
    returning id into v_id;
  exception when unique_violation then
    -- Taken. Undo the cancellation above too: the old booking stands.
    if v_old.id is not null then
      update callback_bookings set status = 'booked', cancelled_at = null where id = v_old.id;
    end if;
    return query select null::uuid, null::uuid, null::uuid, null::text;
    return;
  end;

  update escalations
     set callback_at = p_start, call_booked = true, preferred_time_text = p_label,
         assigned_to = p_profile, updated_at = now()
   where escalation_id = p_escalation;
  update support_tickets set assigned_to = p_profile, updated_at = now() where ticket_id = v_esc.ticket_id;

  insert into case_events (ticket_id, escalation_id, actor_id, action, from_value, to_value, note) values
    (v_esc.ticket_id, p_escalation, null, 'callback_scheduled', v_esc.callback_at::text, p_start::text, 'Booked by the support agent on the call: ' || p_label);
  if v_esc.assigned_to is distinct from p_profile then
    insert into case_events (ticket_id, escalation_id, actor_id, action, from_value, to_value, note) values
      (v_esc.ticket_id, p_escalation, null, 'assigned', v_esc.assigned_to::text, p_profile::text, 'Assigned automatically: first available agent for the callback');
  end if;

  return query select v_id, v_old.id, v_old.profile_id, v_old.google_event_id;
end;
$$;

revoke all on function public.book_callback_slot(text, uuid, timestamptz, timestamptz, text, text) from public, anon, authenticated;
grant execute on function public.book_callback_slot(text, uuid, timestamptz, timestamptz, text, text) to service_role;
