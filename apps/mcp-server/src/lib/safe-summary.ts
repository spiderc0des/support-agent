/**
 * What a lookup may say out loud, and what it means for routing.
 *
 * The lookup tools return a `safe_summary` built here — the only sentence the
 * agent should paraphrase to a caller — and a `routing` block that is for
 * deciding the next step only. Contact names, contact emails, recipient names,
 * amounts and internal notes never appear in a safe summary, so the agent has
 * nothing sensitive to read aloud even if it tries.
 *
 * Routing follows the resolutions in docs/PLAN.md §2 (C1, C6, C7): a record
 * that needs human judgement says so, with the escalation category that
 * tickets-and-escalation would pick, so the agent and the code agree.
 */
import type { EscalationCategory, Priority, TicketCategory } from "@relaypay/shared/enums";
import { spokenDate } from "./normalize.ts";

export type Routing = {
  /** A person must take this further; the agent should escalate, not diagnose. */
  requires_human: boolean;
  /** A follow-up ticket is the right next step (without a human callback). */
  suggest_ticket: boolean;
  reason_code: string;
  suggested_category: EscalationCategory | TicketCategory | null;
  suggested_priority: Priority | null;
  next_step: string;
};

const NONE: Routing = {
  requires_human: false,
  suggest_ticket: false,
  reason_code: "ok",
  suggested_category: null,
  suggested_priority: null,
  next_step: "Share the safe summary and ask what else they need.",
};

export type CustomerRow = {
  customer_id: string;
  company_name: string;
  plan: string;
  account_status: string;
  kyc_status: string;
  support_notes: string | null;
};

export function customerSummary(c: CustomerRow): { safe_summary: string; routing: Routing } {
  if (c.account_status === "restricted" || c.kyc_status === "review required") {
    return {
      safe_summary: `I found the ${c.company_name} account. It needs attention from our specialist team, so I can't go into the details here.`,
      routing: {
        requires_human: true,
        suggest_ticket: false,
        reason_code: c.account_status === "restricted" ? "account_restricted" : "compliance_review",
        suggested_category: c.account_status === "restricted" ? "account" : "compliance",
        suggested_priority: "high",
        next_step:
          "Escalate. Do not explain the restriction or review, and give no timeline. Collect name, email and a preferred callback time.",
      },
    };
  }
  if (c.account_status === "pending verification" || c.kyc_status === "pending") {
    return {
      safe_summary: `I found the ${c.company_name} account on the ${c.plan} plan. Business verification isn't complete yet, so full payment access opens once it is.`,
      routing: {
        ...NONE,
        reason_code: "verification_pending",
        next_step:
          "General verification questions can be answered from the knowledge base (no timelines). If they have a concern about their own verification, escalate as compliance.",
      },
    };
  }
  return {
    safe_summary: `I found the ${c.company_name} account. It's active on the ${c.plan} plan and verification is complete.`,
    routing: NONE,
  };
}

export type TransactionRow = {
  transaction_id: string;
  customer_id: string;
  transaction_type: string;
  status: string;
  estimated_arrival: string | null;
  support_summary: string | null;
};

export function transactionSummary(t: TransactionRow): { safe_summary: string; routing: Routing } {
  const base = (t.support_summary ?? `The ${t.transaction_type} is ${t.status}.`).trim();
  const eta = spokenDate(t.estimated_arrival);

  switch (t.status) {
    case "processing":
      return {
        safe_summary: eta
          ? `${base} The estimated arrival on record is ${eta}. That's an estimate, not a guarantee.`
          : base,
        routing: NONE,
      };
    case "delayed":
      return {
        safe_summary: eta
          ? `${base} The latest estimate on record is ${eta}, but that can still change.`
          : base,
        routing: {
          ...NONE,
          reason_code: "delayed",
          next_step: "Share the summary. If they need someone to chase it, offer a support ticket (payment, medium).",
        },
      };
    case "completed":
      return { safe_summary: base, routing: NONE };
    case "failed":
      return {
        safe_summary: base,
        routing: {
          requires_human: false,
          suggest_ticket: true,
          reason_code: "failed",
          suggested_category: t.transaction_type === "invoice payment" ? "invoice" : "payment",
          suggested_priority: "medium",
          next_step: "Offer to open a support ticket so the team can look at it. Do not diagnose the failure.",
        },
      };
    case "review required":
    default:
      return {
        safe_summary: "That transaction is currently under review, so it's on hold for now.",
        routing: {
          requires_human: true,
          suggest_ticket: false,
          reason_code: "under_review",
          suggested_category: "compliance",
          suggested_priority: "high",
          next_step:
            "Escalate. Do not explain the review or give a timeline. Collect name, email and a preferred callback time.",
        },
      };
  }
}

export type PayoutRow = {
  payout_id: string;
  transaction_id: string | null;
  customer_id: string;
  status: string;
  scheduled_for: string | null;
  failure_reason: string | null;
};

export function payoutSummary(p: PayoutRow): { safe_summary: string; routing: Routing } {
  const when = spokenDate(p.scheduled_for);

  switch (p.status) {
    case "scheduled":
      return { safe_summary: `That payout is scheduled${when ? ` for ${when}` : ""}.`, routing: NONE };
    case "processing":
      return {
        safe_summary: `That payout is processing${when ? `; it was scheduled for ${when}` : ""}. Timing still depends on the receiving bank.`,
        routing: NONE,
      };
    case "completed":
      return { safe_summary: "That payout has completed.", routing: NONE };
    case "failed":
      return {
        safe_summary: `That payout didn't go through${p.failure_reason ? ` because the ${p.failure_reason.replace(/^the\s+/i, "")}` : ""}.`,
        routing: {
          requires_human: false,
          suggest_ticket: true,
          reason_code: "failed",
          suggested_category: "payout",
          suggested_priority: "medium",
          next_step: "Offer to open a support ticket so the team can help fix it. Do not guess what is wrong with the details.",
        },
      };
    case "review required":
    default:
      return {
        safe_summary: "That payout is currently under review, so it hasn't been sent yet.",
        routing: {
          requires_human: true,
          suggest_ticket: false,
          reason_code: "under_review",
          suggested_category: "compliance",
          suggested_priority: "high",
          next_step:
            "Escalate as compliance. Do not explain the review or give a timeline. Collect name, email and a preferred callback time.",
        },
      };
  }
}
