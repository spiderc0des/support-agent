-- ============================================================================
-- 0003_support_tables.sql — everything the system records while it runs
--
-- Who writes what (so a missing row points at one component):
--   orchestrator (apps/web)  conversations, conversation_turns
--   MCP server               tool_calls, retrieval_logs, support_tickets,
--                            escalations, conversation_events
--   eval runner              eval_runs, evaluations
--
-- Value sets mirror packages/shared/src/enums.ts. `npm run lint:skills` checks
-- the skills against the same enums, so a category that exists in a skill but
-- not here (or the reverse) fails before it reaches a call.
-- ============================================================================

-- --------------------------------------------------------- eval_runs -------
create table public.eval_runs (
  id           uuid primary key default gen_random_uuid(),
  model        text not null,
  git_sha      text,
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  total        integer,
  passed       integer,
  cost_usd     numeric(12, 6),
  notes        text
);

-- ----------------------------------------------------- conversations -------
create table public.conversations (
  id                 uuid primary key default gen_random_uuid(),
  vapi_call_id       text unique,
  channel            text not null check (channel in ('web_voice', 'phone', 'text', 'eval', 'dev')),
  -- Never a raw phone number: phone callers are stored as '***1234'.
  caller_identifier  text,
  -- Set by lookup_customer only when the caller was verified. Lookups on
  -- other customers' references are refused against this.
  customer_id        text references public.customers(customer_id),
  verified_at        timestamptz,
  status             text not null default 'active'
                       check (status in ('active', 'resolved', 'ticketed', 'escalated', 'abandoned', 'error')),
  -- The orchestrator bumps this before each user turn; MCP tools stamp their
  -- rows with it, so tool calls and retrievals join to the turn they served.
  current_turn       integer not null default 0,
  started_at         timestamptz not null default now(),
  ended_at           timestamptz,
  ended_reason       text,
  summary            text,
  model              text,
  num_turns          integer not null default 0,
  total_cost_usd     numeric(12, 6) not null default 0,
  eval_run_id        uuid references public.eval_runs(id) on delete set null,
  metadata           jsonb not null default '{}'::jsonb
);

create index conversations_started_idx on public.conversations (started_at desc);
create index conversations_status_idx on public.conversations (status, started_at desc);

-- ------------------------------------------------ conversation_turns -------
create table public.conversation_turns (
  id                  uuid primary key default gen_random_uuid(),
  conversation_id     uuid not null references public.conversations(id) on delete cascade,
  turn_index          integer not null,
  user_transcript     text not null,
  assistant_response  text,
  -- The four paths from the support decision rules.
  answer_type         text check (answer_type in ('answer', 'clarify', 'escalate', 'decline')),
  confidence          text check (confidence in ('high', 'medium', 'low')),
  uncertainty_note    text,
  tools_used          text[] not null default '{}',
  interrupted         boolean not null default false,
  status              text not null default 'ok' check (status in ('ok', 'interrupted', 'error', 'timeout')),
  error_message       text,
  first_token_ms      integer,
  latency_ms          integer,
  input_tokens        integer,
  output_tokens       integer,
  cache_read_tokens   integer,
  cache_write_tokens  integer,
  cost_usd            numeric(12, 6),
  created_at          timestamptz not null default now(),
  unique (conversation_id, turn_index)
);

-- ---------------------------------------------------- retrieval_logs -------
create table public.retrieval_logs (
  id                uuid primary key default gen_random_uuid(),
  conversation_id   uuid not null references public.conversations(id) on delete cascade,
  turn_index        integer,
  query             text not null,
  chunk_ids         text[] not null default '{}',
  source_titles     text[] not null default '{}',
  source_summaries  text[] not null default '{}',
  scores            real[] not null default '{}',
  top_score         real,
  matched           boolean not null,
  created_at        timestamptz not null default now()
);

create index retrieval_logs_conversation_idx on public.retrieval_logs (conversation_id, created_at);

-- -------------------------------------------------------- tool_calls -------
create table public.tool_calls (
  id               uuid primary key default gen_random_uuid(),
  conversation_id  uuid references public.conversations(id) on delete cascade,
  turn_index       integer,
  tool_name        text not null,
  purpose          text,
  input_summary    jsonb,
  result_summary   jsonb,
  status           text not null check (status in ('success', 'not_found', 'invalid_input', 'denied', 'error')),
  error_message    text,
  duration_ms      integer,
  created_at       timestamptz not null default now()
);

create index tool_calls_conversation_idx on public.tool_calls (conversation_id, created_at);
create index tool_calls_status_idx on public.tool_calls (status, created_at desc);

-- --------------------------------------------------- support_tickets -------
create sequence public.ticket_seq start 1001;

create table public.support_tickets (
  ticket_id        text primary key default ('TCK-' || nextval('public.ticket_seq')::text),
  conversation_id  uuid references public.conversations(id) on delete set null,
  customer_id      text references public.customers(customer_id),
  transaction_id   text references public.transactions(transaction_id),
  payout_id        text references public.payouts(payout_id),
  category         text not null check (category in ('account', 'compliance', 'dispute', 'payment', 'payout', 'invoice', 'technical', 'other')),
  priority         text not null check (priority in ('low', 'medium', 'high')),
  summary          text not null,
  status           text not null default 'open' check (status in ('open', 'in_progress', 'closed')),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- One open ticket per issue per conversation: a retried or barged-in tool call
-- returns the existing ticket instead of filing a duplicate.
create unique index support_tickets_open_dedupe
  on public.support_tickets (conversation_id, category)
  where status = 'open' and conversation_id is not null;

-- ------------------------------------------------------- escalations -------
create sequence public.escalation_seq start 101;

create table public.escalations (
  escalation_id           text primary key default ('ESC-' || nextval('public.escalation_seq')::text),
  ticket_id               text not null references public.support_tickets(ticket_id),
  conversation_id         uuid references public.conversations(id) on delete set null,
  customer_id             text references public.customers(customer_id),
  user_name               text not null,
  user_email              text not null,
  category                text not null check (category in ('compliance', 'account', 'dispute', 'payment', 'other')),
  reason                  text not null,
  call_booked             boolean not null default false,
  -- As the caller said it ("tomorrow afternoon"). Not a confirmed slot: a
  -- representative confirms the time when they follow up.
  preferred_time_text     text,
  callback_at             timestamptz,
  -- Caller-supplied email agrees with the account's contact on file.
  contact_matches_record  boolean,
  status                  text not null default 'open' check (status in ('open', 'in_progress', 'closed')),
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

create unique index escalations_open_dedupe
  on public.escalations (conversation_id, category)
  where status = 'open' and conversation_id is not null;

-- ----------------------------------------------- conversation_events -------
create table public.conversation_events (
  id               uuid primary key default gen_random_uuid(),
  conversation_id  uuid not null references public.conversations(id) on delete cascade,
  turn_index       integer,
  event_type       text not null,
  summary          text not null,
  metadata         jsonb not null default '{}'::jsonb,
  -- 'agent' = the model called log_conversation_event; 'system' = code wrote it.
  source           text not null check (source in ('agent', 'system')),
  created_at       timestamptz not null default now()
);

create index conversation_events_conversation_idx on public.conversation_events (conversation_id, created_at);

-- ------------------------------------------------------- evaluations -------
create table public.evaluations (
  id                 uuid primary key default gen_random_uuid(),
  eval_run_id        uuid references public.eval_runs(id) on delete cascade,
  scenario_id        text not null,
  scenario_name      text not null,
  repeat_index       integer not null default 0,
  conversation_id    uuid references public.conversations(id) on delete set null,
  expected_behavior  text not null,
  actual_behavior    text,
  checks             jsonb not null default '[]'::jsonb,
  passed             boolean not null,
  notes              text,
  model              text,
  cost_usd           numeric(12, 6),
  created_at         timestamptz not null default now()
);

create index evaluations_run_idx on public.evaluations (eval_run_id, scenario_id);

-- ============================================================================
-- Ticket and escalation creation
--
-- In SQL rather than the MCP server so the dedupe, the automatic ticket behind
-- every escalation, and the conversation status change happen in one
-- transaction. Business rules that need judgement (category, priority, what to
-- say) stay with the agent and its skills; these only make the writes safe.
-- ============================================================================

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
  v_booked    boolean := coalesce(btrim(p_preferred_time), '') <> '';
begin
  select * into v_esc
    from public.escalations e
   where e.conversation_id = p_conversation_id
     and e.category = p_category
     and e.status = 'open'
   limit 1;

  if found then
    return query select v_esc.escalation_id, v_esc.ticket_id, v_esc.status, v_esc.call_booked,
                        v_esc.contact_matches_record, true;
    return;
  end if;

  -- Every escalation sits on a ticket, so support has one queue to work from.
  -- Escalation categories are a subset of ticket categories.
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
          p_reason, v_booked, nullif(btrim(p_preferred_time), ''), v_matches)
  returning * into v_esc;

  update public.conversations c
     set status = 'escalated',
         customer_id = coalesce(c.customer_id, p_customer_id)
   where c.id = p_conversation_id;

  insert into public.conversation_events (conversation_id, turn_index, event_type, summary, metadata, source)
  values (p_conversation_id, p_turn_index, 'escalation_created',
          format('Escalation %s opened (%s) on ticket %s', v_esc.escalation_id, p_category, v_ticket_id),
          jsonb_build_object('escalation_id', v_esc.escalation_id, 'ticket_id', v_ticket_id,
                             'category', p_category, 'call_booked', v_booked),
          'system');

  return query select v_esc.escalation_id, v_esc.ticket_id, v_esc.status, v_esc.call_booked,
                      v_esc.contact_matches_record, false;
end;
$$;

-- The orchestrator calls this before each user turn. Atomic, so a barge-in
-- that overlaps the previous turn can never reuse its index.
create or replace function public.begin_turn(p_conversation_id uuid)
returns integer
language sql
security definer
set search_path = public
as $$
  update public.conversations
     set current_turn = current_turn + 1,
         num_turns = current_turn + 1
   where id = p_conversation_id
  returning current_turn;
$$;

-- Service role only. The anon and authenticated roles must never be able to
-- file tickets or escalations directly through PostgREST.
revoke all on function public.create_support_ticket(uuid, text, text, text, text, text, text, integer) from public, anon, authenticated;
revoke all on function public.create_escalation(uuid, text, text, text, text, text, text, text, text, text, text, integer) from public, anon, authenticated;
grant execute on function public.create_support_ticket(uuid, text, text, text, text, text, text, integer) to service_role;
grant execute on function public.create_escalation(uuid, text, text, text, text, text, text, text, text, text, text, integer) to service_role;
revoke all on function public.begin_turn(uuid) from public, anon, authenticated;
grant execute on function public.begin_turn(uuid) to service_role;
