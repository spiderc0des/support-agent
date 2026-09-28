-- ============================================================================
-- 0004_auth_rls.sql — review-dashboard sign-in, admin role, row level security
--
-- Carried over from the week 5 lead agent, narrowed to what this app needs:
--   * Sign-in is invite-only (magic link, shouldCreateUser:false).
--   * Every table has RLS on. The ONLY policies are SELECT for admins, so the
--     review dashboard can read logs with a signed-in user's JWT.
--   * No INSERT / UPDATE / DELETE policy exists anywhere. The MCP server, the
--     orchestrator and the scripts write with the service-role key, server-side.
--   * The browser voice page needs no database access at all: it talks only to
--     Vapi.
-- ============================================================================

create table public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  email       text not null,
  full_name   text,
  role        text not null default 'member' check (role in ('member', 'admin')),
  created_at  timestamptz not null default now()
);

create table public.allowed_emails (
  email       text primary key,
  full_name   text,
  role        text not null default 'member' check (role in ('member', 'admin')),
  invited_by  uuid references auth.users(id) on delete set null,
  invited_at  timestamptz not null default now(),
  accepted_at timestamptz
);

-- Mirror each new auth user into profiles, taking name and role from the invite.
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
          coalesce(v_invite.role, 'member'))
  on conflict (id) do nothing;

  update public.allowed_emails set accepted_at = now()
   where email = lower(new.email) and accepted_at is null;

  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- SECURITY DEFINER: it reads profiles from inside the policies that guard
-- profiles, and would otherwise recurse. Fixed search_path prevents hijacking.
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin');
$$;

revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to authenticated;

-- ----------------------------------------------------------------- RLS -----
do $$
declare
  t text;
begin
  foreach t in array array[
    'customers', 'transactions', 'payouts', 'kb_chunks',
    'conversations', 'conversation_turns', 'retrieval_logs', 'tool_calls',
    'support_tickets', 'escalations', 'conversation_events',
    'eval_runs', 'evaluations', 'allowed_emails'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    -- (select ...) makes Postgres evaluate is_admin() once per query, not per row.
    execute format(
      'create policy %I on public.%I for select to authenticated using ((select public.is_admin()))',
      t || '_select_admin', t);
  end loop;
end;
$$;

alter table public.profiles enable row level security;
create policy profiles_select_self_or_admin on public.profiles
  for select to authenticated
  using (id = (select auth.uid()) or (select public.is_admin()));

-- Retrieval and matching RPCs run server-side only.
revoke all on function public.match_kb(text, integer) from public, anon, authenticated;
revoke all on function public.match_customer_company(text, real) from public, anon, authenticated;
grant execute on function public.match_kb(text, integer) to service_role;
grant execute on function public.match_customer_company(text, real) to service_role;
