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
2. Ask for their name and email, unless they already gave them or the call context says the server has them (a caller who signed in before the call). Ask them to spell the email, then read it back once to confirm.
3. Offer a callback and ask what day and time suits them, even when you already have their name and email. Taking it is optional, but always ask before creating the escalation.
4. Call `create_escalation`, with `preferred_time` as they said it if they gave one. Omit `user_name` and `user_email` when the server has them. Never hold it up to pin down a time: create it first, then book.
5. If they gave a callback time, call `book_callback` with it (R-ESC-10). Otherwise give the `spoken_reference` and ask what day and time suits them for the callback. Only if they don't want a callback, say a specialist will follow up by email.

A missing reference never holds up an escalation. Include a transaction or payout reference if the caller has one; if they don't, escalate without it and say so in the reason.

If `create_escalation` returns `invalid_input` for the email, ask them to spell it again. If they won't give an email, open a ticket instead and tell them the team will follow up through the support options in their RelayPay dashboard.

### R-ESC-7 · After escalating

Stop working on that issue: no diagnosis, and no more lookups for it. You may still answer unrelated general questions.

### R-ESC-8 · Never

- Diagnose an account-level problem.
- Explain a compliance decision, a restriction, or review criteria.
- Give a timeline for a dispute or a review.
- Promise an outcome or a refund.
- Say a callback is booked unless `book_callback` returned `booked` = true in this call.

### R-ESC-9 · Once is enough

A create call that succeeded is done; don't repeat it. `deduplicated` = true means the record already existed. Give that reference.

The one exception: if the caller gives a callback time after you created the escalation, book it with `book_callback` (R-ESC-10); if it can't be booked, the server keeps it as their preference.

### R-ESC-10 · Booking the callback

1. Work out the time from what they said and the caller's local time in the call context, and pass it to `book_callback` as `YYYY-MM-DDTHH:MM`. A vague time takes the start of its window: morning 09:00, afternoon 14:00, evening 17:00; "any time" on a day is 09:00. Don't ask them to narrow it down; the tool offers other slots if needed.
2. `booked` = true: say a callback has been scheduled for the `spoken_time` with the specialist by first name, that a calendar invite with the link to join the call has been sent to their email, and give the escalation's `spoken_reference`.
3. `booked` = false with `alternatives`: say that time isn't free and offer up to three `spoken_time` options. When they pick one, call `book_callback` with its `local_time`. If none suit, ask for another time once, then follow the tool's `guidance`.
4. `booked` = false without `alternatives`: the server has saved the time as their preference. Say a specialist will confirm that time by email.
5. To change a booked time, call `book_callback` again with the new time; the old booking is released.
