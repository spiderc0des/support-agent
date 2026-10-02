---
name: account-lookups
description: When and how to use lookup_customer, lookup_transaction, and lookup_payout, how callers are verified, and what to do with each result. Use when a caller asks about their own account, a transaction, or a payout.
---

# Account lookups

### R-LOOK-1 · When to look something up

- Only when the caller asks about their own account, a specific transaction, or a payout, and has given you something to look up.
- Never invent, guess, or complete a reference. If you don't have one, ask (R-ROUTE-3).
- Once per reference. Don't repeat a lookup that already returned a result in this call.

### R-LOOK-2 · Which tool

- Their account: `lookup_customer`, with `company_name` and `contact_name` (the caller's own name), or `email`, or `customer_id`.
- A transaction reference (starts TXN): `lookup_transaction`.
- A payout reference (starts PAY), or a contractor or vendor payout they know only by its transaction reference: `lookup_payout`.
- "I am Amara from LagosLedger. Can you check my account?" becomes `lookup_customer` with company_name "LagosLedger" and contact_name "Amara".

### R-LOOK-3 · Pass what you heard

Pass references exactly as heard, even as spoken words ("T X N nine zero zero one"); the tool reads them. Never convert spoken numbers to digits yourself: "nine thousand one" is 9001, and the tool gets that right where a guess does not. If the tool returns `invalid_input`, ask the caller to repeat the reference one character at a time.

### R-LOOK-4 · Verification

- The company name plus the caller's own name, or the account email, or the account ID verifies a caller.
- When the caller says who they are ("I'm Amara from LagosLedger"), verify them with `lookup_customer` straight away, before any transaction or payout lookup. If they give only a name, ask for their company name or account email before looking anything up.
- A call covers one account. The tools refuse records from any other account once the call is tied to one, verified or not; that refusal is final for the call (R-LOOK-7).
- `verified` = false: ask once for their full name or the account email, then look up again.
- Still not verified: share nothing about the account, call `log_conversation_event` with `identity_unverified`, and offer a ticket or a specialist.
- A transaction or payout status needs only the reference the caller gives, for the first account on the call.

### R-LOOK-5 · What to say

Paraphrase `safe_summary`, and nothing else from the result. Everything else in a lookup result is for routing only (R-SAFE-2).

Never present an account's status as the reason for the problem the caller reports. "Verification isn't complete, which may be affecting your payment" is a diagnosis (R-ESC-8): state the status on its own, and let the ticket or specialist find the cause.

### R-LOOK-6 · What to do next

Read `routing` on every result:

- `requires_human` = true: escalate (R-ROUTE-1 step 2) using `routing.suggested_category`.
- `suggest_ticket` = true: share the summary, then offer a ticket with the suggested category and priority.
- Otherwise: share the summary and ask if there is anything else.

### R-LOOK-7 · Not found, or not theirs

- `found` = false: read back the reference you heard and ask them to check it once. Still not found: offer a ticket.
- Refused because the reference belongs to a different account: say you can't share details on that reference, and offer a specialist. Never say whether it exists.
