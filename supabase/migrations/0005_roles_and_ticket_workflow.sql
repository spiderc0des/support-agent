-- ============================================================================
-- 0005_roles_and_ticket_workflow.sql — two staff roles, and working tickets
--
-- Roles:
--   support_agent  reads every support record, works tickets and escalations
--   admin          everything an agent can do, plus people and system settings
-- ('member' from 0004 becomes 'support_agent'.)
--
-- Tickets and escalations gain an assignee, a resolution note and an audit
-- trail (case_events). Staff never write tables directly: the app's API routes
-- check the role, write with the service role, and record a case_events row
-- for every change, so the trail cannot be skipped from the browser.
-- ============================================================================

-- ----------------------------------------------------------------- roles ---
alter table public.profiles drop constraint if exists profiles_role_check;
update public.profiles set role = 'support_agent' where role not in ('support_agent', 'admin');
alter table public.profiles alter column role set default 'support_agent';
alter table public.profiles add constraint profiles_role_check check (role in ('support_agent', 'admin'));
alter table public.profiles add column if not exists updated_at timestamptz not null default now();

alter table public.allowed_emails drop constraint if exists allowed_emails_role_check;
update public.allowed_emails set role = 'support_agent' where role not in ('support_agent', 'admin');
alter table public.allowed_emails alter column role set default 'support_agent';
alter table public.allowed_emails add constraint allowed_emails_role_check check (role in ('support_agent', 'admin'));

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invite public.allowed_emails%rowtype;
begin
  select * into v_invite from public.allowed_emails where email = lower(new.email);

  insert into public.profiles (id, email, full_name, role)
  values (new.id, new.email,
          coalesce(v_invite.full_name, new.raw_user_meta_data ->> 'full_name'),
          coalesce(v_invite.role, 'support_agent'))
  on conflict (id) do nothing;

  update public.allowed_emails set accepted_at = now()
   where email = lower(new.email) and accepted_at is null;

  return new;
end;
$$;

-- Any signed-in staff member (both roles).
create or replace function public.is_staff()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role in ('support_agent', 'admin'));
$$;

revoke all on function public.is_staff() from public;
grant execute on function public.is_staff() to authenticated;

-- ----------------------------------------------------- ticket workflow -----
alter table public.support_tickets
  add column if not exists assigned_to uuid references public.profiles(id) on delete set null,
  add column if not exists resolution_note text,
  add column if not exists closed_at timestamptz;

alter table public.escalations
  add column if not exists assigned_to uuid references public.profiles(id) on delete set null,
  add column if not exists resolution_note text,
  add column if not exists closed_at timestamptz;

create index if not exists support_tickets_status_idx on public.support_tickets (status, created_at desc);
create index if not exists support_tickets_assignee_idx on public.support_tickets (assigned_to, status);
create index if not exists escalations_status_idx on public.escalations (status, created_at desc);

-- Every change a person makes to a ticket or escalation.
create table if not exists public.case_events (
  id             uuid primary key default gen_random_uuid(),
  ticket_id      text not null references public.support_tickets(ticket_id) on delete cascade,
  escalation_id  text references public.escalations(escalation_id) on delete cascade,
  actor_id       uuid references public.profiles(id) on delete set null,
  action         text not null check (action in ('status_changed', 'assigned', 'unassigned', 'note_added', 'callback_scheduled')),
  from_value     text,
  to_value       text,
  note           text,
  created_at     timestamptz not null default now()
);

create index if not exists case_events_ticket_idx on public.case_events (ticket_id, created_at);

-- ------------------------------------------------------------------ RLS -----
-- Operational records: readable by all staff. People and invites: admins only.
do $$
declare
  t text;
begin
  foreach t in array array[
    'customers', 'transactions', 'payouts', 'kb_chunks',
    'conversations', 'conversation_turns', 'retrieval_logs', 'tool_calls',
    'support_tickets', 'escalations', 'conversation_events',
    'eval_runs', 'evaluations'
  ] loop
    execute format('drop policy if exists %I on public.%I', t || '_select_admin', t);
    execute format('drop policy if exists %I on public.%I', t || '_select_staff', t);
    execute format(
      'create policy %I on public.%I for select to authenticated using ((select public.is_staff()))',
      t || '_select_staff', t);
  end loop;
end;
$$;

alter table public.case_events enable row level security;
drop policy if exists case_events_select_staff on public.case_events;
create policy case_events_select_staff on public.case_events
  for select to authenticated using ((select public.is_staff()));

-- Staff see each other's names (for assignees); only admins see the invite list.
drop policy if exists profiles_select_self_or_admin on public.profiles;
drop policy if exists profiles_select_staff on public.profiles;
create policy profiles_select_staff on public.profiles
  for select to authenticated
  using (id = (select auth.uid()) or (select public.is_staff()));
