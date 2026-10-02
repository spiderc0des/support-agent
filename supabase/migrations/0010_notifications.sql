-- ============================================================================
-- 0010_notifications.sql — every email sent to the support team, and why
--
-- The team is emailed (through Brevo's HTTPS API; Railway blocks SMTP) when
-- something needs a person: a new ticket, a new escalation, or the agent
-- failing mid-call. Each attempt is recorded here, so "was anyone told?" has
-- an answer on the ticket page, including when sending was skipped (no API
-- key, an eval or test channel) or failed (Brevo's own error is kept).
-- ============================================================================

create table if not exists public.notifications (
  id               uuid primary key default gen_random_uuid(),
  kind             text not null check (kind in ('ticket_created', 'escalation_created', 'agent_error')),
  ticket_id        text references public.support_tickets(ticket_id) on delete cascade,
  escalation_id    text references public.escalations(escalation_id) on delete cascade,
  conversation_id  uuid references public.conversations(id) on delete set null,
  subject          text not null,
  recipients       text[] not null default '{}',
  status           text not null check (status in ('sent', 'partial', 'failed', 'skipped')),
  detail           text,
  created_at       timestamptz not null default now()
);

create index if not exists notifications_ticket_idx on public.notifications (ticket_id, created_at);

alter table public.notifications enable row level security;
drop policy if exists notifications_select_staff on public.notifications;
create policy notifications_select_staff on public.notifications
  for select to authenticated using ((select public.is_staff()));
