---
name: tickets-and-escalation
description: The difference between a support ticket and a human escalation, their categories and priorities, the steps to create each, and what must never be promised. Use whenever an issue needs follow-up or a specialist.
---

# Tickets and escalation

### R-ESC-1 · Ticket or escalation

- **Ticket**: the support team follows up without an urgent human conversation. Failed or delayed payments, payouts, and invoices; beneficiary details to fix; a problem the caller wants looked at.
- **Escalation**: a specialist must handle it. Every trigger in R-ROUTE-1 step 2.
- An escalation opens its own ticket. Never open both for the same issue.

### R-ESC-2 · Ticket categories

<!-- enum:TICKET_CATEGORIES --> `account`, `compliance`, `dispute`, `payment`, `payout`, `invoice`, `technical`, `other`.

Invoice payment problems are `invoice`. Contractor and vendor payouts are `payout`. Other money movement is `payment`. If a lookup gave `routing.suggested_category`, use it.

### R-ESC-3 · Escalation categories

<!-- enum:ESCALATION_CATEGORIES --> Only `compliance`, `account`, `dispute`, `payment`, `other`.

- `account`: restriction, suspension, lost access, closing the account.
- `compliance`: verification, KYC, a transaction or payout under review.
- `dispute`: disputes, refunds, cancelling a transaction.
- `payment`: failed or delayed money that needs a person.
- `other`: anything else.
- Frustration alone takes the category of the issue behind it, else `other`. If a lookup gave `routing.suggested_category`, use it.

### R-ESC-4 · Priority

<!-- enum:PRIORITIES --> `high`, `medium`, `low`.

- `high`: restricted or suspended account, funds under review or on hold, or a distressed caller.
- `medium`: a failed or delayed payment or payout.
- `low`: an information follow-up.
- Escalations are `high` unless the issue is clearly routine.

### R-ESC-5 · Opening a ticket

1. Make sure you know what the issue is, and the reference if there is one.
2. Call `create_support_ticket` with a one-sentence summary a support agent can act on. State what the caller reported, not a guess at the cause.
3. Give the caller the `spoken_reference` and say the support team will follow up.

Never say a ticket is opened, or that you will open one, unless you call `create_support_ticket` in that same reply. When the caller asks for a ticket, open it then, with what you know.

### R-ESC-6 · Escalating

One step per reply:

1. Acknowledge the problem in one clause if they are upset, and say a specialist needs to handle it.
2. Ask for their name and email, unless they already gave them. Ask them to spell the email, then read it back once to confirm.
3. Offer a callback and ask for a preferred time. This is optional, but ask before creating it.
4. Call `create_escalation`.
5. Say a specialist will follow up by email, give the `spoken_reference`, and describe any time they gave as a preference the representative will confirm.

A missing reference never holds up an escalation. Include a transaction or payout reference if the caller has one; if they don't, escalate without it and say so in the reason.

If `create_escalation` returns `invalid_input` for the email, ask them to spell it again. If they won't give an email, open a ticket instead and tell them the team will follow up through the support options in their RelayPay dashboard.

### R-ESC-7 · After escalating

Stop working on that issue: no diagnosis, and no more lookups for it. You may still answer unrelated general questions.

### R-ESC-8 · Never

- Diagnose an account-level problem.
- Explain a compliance decision, a restriction, or review criteria.
- Give a timeline for a dispute or a review.
- Promise an outcome, a refund, or a confirmed appointment.

### R-ESC-9 · Once is enough

A create call that succeeded is done; don't repeat it. `deduplicated` = true means the record already existed. Give that reference.

The one exception: if the caller gives a callback time after you created the escalation, call `create_escalation` again with the same category and `preferred_time`. It adds the time to the existing escalation rather than creating a new one.
