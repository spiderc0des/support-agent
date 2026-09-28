-- ============================================================================
-- 0001_seed_tables.sql — the RelayPay records the agent looks things up in
--
-- Loaded from assets/seed-data/*.csv by `npm run db:seed`. The MCP server only
-- ever reads these; nothing the agent does writes to them.
--
-- CHECK constraints carry the value sets from the schema guide, so a bad seed
-- row fails loudly at load time instead of confusing a lookup later.
-- ============================================================================

create extension if not exists pg_trgm with schema extensions;

-- ----------------------------------------------------------- customers -----
create table public.customers (
  customer_id     text primary key check (customer_id ~ '^CUS-[0-9]+$'),
  company_name    text not null,
  -- Lookup key: "Lagos Ledger", "lagosledger" and "LagosLedger" all match.
  -- Speech-to-text rarely gets a joined-up company name right.
  company_key     text generated always as (regexp_replace(lower(company_name), '[^a-z0-9]', '', 'g')) stored,
  contact_name    text,
  contact_email   text,
  plan            text not null check (plan in ('Starter', 'Growth', 'Scale')),
  account_status  text not null check (account_status in ('active', 'restricted', 'pending verification')),
  region          text,
  kyc_status      text not null check (kyc_status in ('pending', 'approved', 'review required')),
  support_notes   text,
  created_at      timestamptz not null default now()
);

create index customers_company_key_trgm on public.customers using gin (company_key extensions.gin_trgm_ops);
create unique index customers_email_idx on public.customers (lower(contact_email));

-- -------------------------------------------------------- transactions -----
create table public.transactions (
  transaction_id      text primary key check (transaction_id ~ '^TXN-[0-9]+$'),
  customer_id         text not null references public.customers(customer_id),
  transaction_type    text not null check (transaction_type in ('incoming transfer', 'outgoing payout', 'invoice payment')),
  amount              numeric(14, 2) not null,
  currency            char(3) not null,
  destination_country text,
  status              text not null check (status in ('processing', 'completed', 'delayed', 'failed', 'review required')),
  created_at          timestamptz not null,
  estimated_arrival   date,
  -- Customer-safe by definition (schema guide). The only free text a lookup may paraphrase aloud.
  support_summary     text
);

create index transactions_customer_idx on public.transactions (customer_id);

-- ------------------------------------------------------------- payouts -----
create table public.payouts (
  payout_id       text primary key check (payout_id ~ '^PAY-[0-9]+$'),
  transaction_id  text references public.transactions(transaction_id),
  customer_id     text not null references public.customers(customer_id),
  recipient_name  text,
  amount          numeric(14, 2) not null,
  currency        char(3) not null,
  status          text not null check (status in ('scheduled', 'processing', 'completed', 'failed', 'review required')),
  scheduled_for   date,
  failure_reason  text
);

create index payouts_transaction_idx on public.payouts (transaction_id);
create index payouts_customer_idx on public.payouts (customer_id);

-- ------------------------------------------------ company name matching -----
-- Exact key match first; trigram similarity only as a fallback, and only above
-- a threshold, so "Lagos Ledger" finds LagosLedger but "Lagos" alone does not
-- quietly pick an account.
create or replace function public.match_customer_company(p_query text, p_min_similarity real default 0.45)
returns table (customer_id text, company_name text, similarity real)
language sql
stable
set search_path = public, extensions
as $$
  with q as (select regexp_replace(lower(coalesce(p_query, '')), '[^a-z0-9]', '', 'g') as key)
  select c.customer_id, c.company_name,
         case when c.company_key = q.key then 1.0::real else extensions.similarity(c.company_key, q.key) end as similarity
    from public.customers c, q
   where q.key <> ''
     and (c.company_key = q.key or extensions.similarity(c.company_key, q.key) >= p_min_similarity)
   order by similarity desc, c.customer_id
   limit 3;
$$;
