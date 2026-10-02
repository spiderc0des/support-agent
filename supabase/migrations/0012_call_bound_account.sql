-- ============================================================================
-- 0012_call_bound_account.sql — one call, one account, verified or not
--
-- Ownership checks used to start only once a caller was verified
-- (conversations.customer_id). Before that, anyone holding references could
-- hear the status of any account's records, one after another: a caller said
-- "I'm Amina Jacobs", was never verified, and heard the status of CapeCloud's
-- transaction, then KigaliWorks', then NairobiOps' (conversation fc229aa7).
--
-- Now the first record a lookup discloses binds the call to that record's
-- account (linked_customer_id), and every lookup after that is held to it,
-- exactly as a verified account is. A reference alone still works for one
-- account (scenario 4: "Can you check transaction TXN-9001?"), but it can no
-- longer be used to walk through other customers' records.
--
-- linked_customer_id is not verification: verified_at stays null, and
-- account details still need lookup_customer to verify the caller first.
-- ============================================================================

alter table public.conversations
  add column if not exists linked_customer_id text references public.customers(customer_id);

-- Bind the call to p_customer unless it is already bound, and return the
-- account the call is bound to. Atomic under the row lock, so two lookups in
-- the same turn can't each bind a different account.
create or replace function public.bind_conversation_account(p_conversation uuid, p_customer text)
returns text
language plpgsql
set search_path = public
as $$
declare
  v_bound text;
begin
  update public.conversations
     set linked_customer_id = coalesce(customer_id, linked_customer_id, p_customer)
   where id = p_conversation
  returning coalesce(customer_id, linked_customer_id) into v_bound;
  return v_bound;
end;
$$;

revoke all on function public.bind_conversation_account(uuid, text) from public, anon, authenticated;
grant execute on function public.bind_conversation_account(uuid, text) to service_role;
