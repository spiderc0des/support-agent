-- ============================================================================
-- 0015_three_day_invites.sql — invite links that last three days
--
-- Supabase's own invite and magic links expire within a day (its maximum),
-- and a mail scanner opening one uses it up. The invite email now links to
-- the app (/invite/<token>) instead: valid for three days, usable more than
-- once, and each visit asks Supabase for a fresh one-time sign-in. Only a
-- hash of the token is stored. Removing someone's access deletes their
-- allowed_emails row, which ends the link too.
-- ============================================================================
alter table public.allowed_emails
  add column if not exists invite_token_hash text,
  add column if not exists invite_expires_at timestamptz;
create unique index if not exists allowed_emails_invite_token_idx on public.allowed_emails (invite_token_hash) where invite_token_hash is not null;
