-- ============================================================================
-- 0014_guest_company.sql — a guest can say which company they're with
--
-- On the "Know me" sign-in a guest may add their company name. It isn't
-- verification: the agent still verifies them with lookup_customer before
-- sharing anything about an account, but it no longer has to ask for the
-- company over the phone (company name plus the caller's own name is the
-- verification bar lookup_customer applies).
-- ============================================================================
alter table public.caller_sessions add column if not exists company_name text;
