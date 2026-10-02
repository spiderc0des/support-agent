/**
 * lookup_customer, lookup_transaction, lookup_payout.
 *
 * Three rules apply to all of them, enforced here rather than in a prompt:
 *   1. Only a verified caller attaches a verified account to the conversation.
 *   2. One call, one account. The first record disclosed binds the call to
 *      its account (verified or not, 0012); references belonging to any
 *      other account are then refused without confirming that they exist.
 *      Without this, an unverified caller could read any customer's records
 *      by reciting references, one after another.
 *   3. Contact names, contact emails and recipient names are never returned.
 *      What the agent may say is `safe_summary`; `routing` is for deciding.
 */
import { z } from "zod";
import type { ConversationState } from "../store.ts";
import type { ToolContext, ToolHandler, ToolOutcome } from "../lib/tooling.ts";
import { customerSummary, payoutSummary, transactionSummary } from "../lib/safe-summary.ts";
import { firstName, normalizeEmail, normalizeReference } from "../lib/normalize.ts";

const DO_NOT_SAY = "Fields other than safe_summary are for routing. Do not read them aloud.";

async function refuseOtherAccount(
  ctx: ToolContext,
  conversation: ConversationState,
  what: string,
  reference: string,
): Promise<ToolOutcome> {
  await ctx.store.logEvent({
    conversation_id: conversation.id,
    turn_index: conversation.current_turn,
    event_type: "ownership_blocked",
    summary: `Refused ${what} ${reference}: it belongs to a different account than the one this call is about`,
    metadata: { reference },
    source: "system",
  });
  return {
    status: "denied",
    result: {
      found: false,
      safe_summary: "I'm not able to share details on that reference on this call.",
      message:
        "Say the safe_summary, then offer a specialist. Don't say whether the reference exists, isn't found, or belongs to anyone, and don't ask the caller to double-check it.",
    },
    error: `${reference} belongs to another customer`,
  };
}

/**
 * Bind the call to the record's account, or refuse if it is bound to another.
 * The bind is atomic in the database, so parallel lookups can't each claim a
 * different account.
 */
async function holdToOneAccount(ctx: ToolContext, conversation: ConversationState, owner: string, what: string, reference: string) {
  const bound = await ctx.store.bindAccount(conversation.id, owner);
  return bound && bound !== owner ? refuseOtherAccount(ctx, conversation, what, reference) : null;
}

// ------------------------------------------------------ lookup_customer -----

export const lookupCustomerShape = {
  customer_id: z.string().max(40).optional().describe("Account ID if the caller gives one, e.g. CUS-1001."),
  email: z.string().max(200).optional().describe("The account email the caller gives, as heard."),
  company_name: z.string().max(200).optional().describe("The company name the caller gives, as heard."),
  contact_name: z.string().max(200).optional().describe("The caller's own name, used to verify them against the account."),
};
type CustomerArgs = { customer_id?: string; email?: string; company_name?: string; contact_name?: string };

export const lookupCustomer: ToolHandler<CustomerArgs> = async (args, conversation, ctx) => {
  const { store } = ctx;
  if (!args.customer_id && !args.email && !args.company_name) {
    return {
      status: "invalid_input",
      result: { error: "Give at least one of customer_id, email or company_name. Ask the caller for their company name or account email." },
      error: "no identifying field",
    };
  }

  const email = normalizeEmail(args.email);
  const customerId = normalizeReference("CUS", args.customer_id);
  let customer = customerId ? await store.customerById(customerId) : null;
  let matchedBy: "customer_id" | "email" | "company" | null = customer ? "customer_id" : null;

  if (!customer && email) {
    customer = await store.customerByEmail(email);
    if (customer) matchedBy = "email";
  }

  if (!customer && args.company_name) {
    const matches = await store.matchCompany(args.company_name);
    const [best, second] = matches;
    const ambiguous = best && best.similarity < 1 && second && second.similarity > best.similarity - 0.1;
    if (best && !ambiguous) {
      customer = await store.customerById(best.customer_id);
      if (customer) matchedBy = "company";
    } else if (ambiguous) {
      return {
        status: "not_found",
        result: { found: false, message: "More than one account could match that name. Ask for the account email instead." },
        summary: { found: false, ambiguous: true },
        error: "ambiguous company match",
      };
    }
  }

  if (!customer) {
    return {
      status: "not_found",
      result: {
        found: false,
        message: "No account matched. Ask the caller to confirm the company name or account email once, then offer a support ticket.",
      },
      error: "no matching customer",
    };
  }

  // Verification: something only the account holder would reliably know, on
  // top of a company name anyone could say.
  const emailMatches = Boolean(email && customer.contact_email && email === customer.contact_email.toLowerCase());
  const nameMatches = Boolean(args.contact_name && firstName(args.contact_name) === firstName(customer.contact_name));
  const verified =
    matchedBy === "customer_id" || matchedBy === "email" || (matchedBy === "company" && (nameMatches || emailMatches));

  const callAccount = conversation.customer_id ?? conversation.linked_customer_id;
  if (callAccount && callAccount !== customer.customer_id) {
    return refuseOtherAccount(ctx, conversation, "account lookup for", customer.customer_id);
  }

  if (!verified) {
    await store.logEvent({
      conversation_id: conversation.id,
      turn_index: conversation.current_turn,
      event_type: "identity_unverified",
      summary: `Company matched (${customer.company_name}) but the caller's name or email did not verify`,
      metadata: { matched_by: matchedBy, name_given: Boolean(args.contact_name) },
      source: "system",
    });
    return {
      status: "success",
      result: {
        found: true,
        verified: false,
        company_name: customer.company_name,
        message:
          "An account matches that company, but the caller isn't verified. Share nothing about the account. Ask for their full name or the account email.",
      },
      summary: { found: true, verified: false, matched_by: matchedBy },
    };
  }

  if (conversation.customer_id !== customer.customer_id) {
    await store.setVerifiedCustomer(conversation.id, customer.customer_id);
    await store.logEvent({
      conversation_id: conversation.id,
      turn_index: conversation.current_turn,
      event_type: "customer_verified",
      summary: `Caller verified for ${customer.company_name} by ${matchedBy === "company" ? "company and name" : matchedBy}`,
      metadata: { customer_id: customer.customer_id, matched_by: matchedBy },
      source: "system",
    });
  }

  const { safe_summary, routing } = customerSummary(customer);
  return {
    status: "success",
    result: {
      found: true,
      verified: true,
      customer_id: customer.customer_id,
      company_name: customer.company_name,
      plan: customer.plan,
      account_status: customer.account_status,
      kyc_status: customer.kyc_status,
      support_notes: customer.support_notes,
      safe_summary,
      routing,
      note: DO_NOT_SAY,
    },
    summary: {
      found: true,
      verified: true,
      customer_id: customer.customer_id,
      matched_by: matchedBy,
      account_status: customer.account_status,
      requires_human: routing.requires_human,
    },
  };
};

// --------------------------------------------------- lookup_transaction -----

export const lookupTransactionShape = {
  transaction_id: z
    .string()
    .min(2)
    .max(80)
    .describe("The transaction reference exactly as the caller said it, e.g. 'TXN-9001' or 'T X N nine zero zero one'."),
};
type TransactionArgs = { transaction_id: string };

export const lookupTransaction: ToolHandler<TransactionArgs> = async ({ transaction_id }, conversation, ctx) => {
  const ref = normalizeReference("TXN", transaction_id);
  if (!ref) {
    return {
      status: "invalid_input",
      result: { error: "Couldn't read a transaction reference from that. Ask the caller to repeat it one character at a time." },
      error: `unreadable reference "${transaction_id}"`,
    };
  }

  const txn = await ctx.store.transactionById(ref);
  if (!txn) {
    return {
      status: "not_found",
      result: {
        found: false,
        transaction_id: ref,
        message:
          "No transaction has that reference. If the caller said the number in words, call again passing their exact words (for example 'nine thousand one'), not digits you converted. Otherwise read back what you heard and ask them to check it once.",
      },
      error: `no transaction ${ref}`,
    };
  }
  const refused = await holdToOneAccount(ctx, conversation, txn.customer_id, "transaction", ref);
  if (refused) return refused;

  const payout = await ctx.store.payoutByTransaction(ref);
  const { safe_summary, routing } = transactionSummary(txn);
  return {
    status: "success",
    result: {
      found: true,
      transaction_id: txn.transaction_id,
      customer_id: txn.customer_id,
      type: txn.transaction_type,
      status: txn.status,
      amount: String(txn.amount),
      currency: txn.currency,
      estimated_arrival: txn.estimated_arrival,
      support_summary: txn.support_summary,
      related_payout_id: payout?.payout_id ?? null,
      safe_summary,
      routing,
      note: `${DO_NOT_SAY} Only mention the amount if the caller said it first.`,
    },
    summary: { found: true, transaction_id: ref, status: txn.status, requires_human: routing.requires_human },
  };
};

// -------------------------------------------------------- lookup_payout -----

export const lookupPayoutShape = {
  payout_id: z.string().max(80).optional().describe("The payout reference as the caller said it, e.g. 'PAY-7002'."),
  transaction_id: z.string().max(80).optional().describe("A transaction reference, if that is what the caller has."),
};
type PayoutArgs = { payout_id?: string; transaction_id?: string };

export const lookupPayout: ToolHandler<PayoutArgs> = async (args, conversation, ctx) => {
  const payoutRef = normalizeReference("PAY", args.payout_id);
  const txnRef = normalizeReference("TXN", args.transaction_id);
  if (!payoutRef && !txnRef) {
    return {
      status: "invalid_input",
      result: { error: "Need a payout or transaction reference. Ask the caller for it, one character at a time." },
      error: "no readable reference",
    };
  }

  const payout = payoutRef ? await ctx.store.payoutById(payoutRef) : await ctx.store.payoutByTransaction(txnRef!);
  const ref = payoutRef ?? txnRef!;
  if (!payout) {
    return {
      status: "not_found",
      result: { found: false, reference: ref, message: "No payout matches that reference. Read back what you heard and ask them to check it once." },
      error: `no payout for ${ref}`,
    };
  }
  const refused = await holdToOneAccount(ctx, conversation, payout.customer_id, "payout", ref);
  if (refused) return refused;

  const { safe_summary, routing } = payoutSummary(payout);
  return {
    status: "success",
    result: {
      found: true,
      payout_id: payout.payout_id,
      transaction_id: payout.transaction_id,
      customer_id: payout.customer_id,
      status: payout.status,
      scheduled_for: payout.scheduled_for,
      failure_reason: payout.failure_reason,
      support_summary: safe_summary,
      safe_summary,
      routing,
      note: DO_NOT_SAY,
    },
    summary: { found: true, payout_id: payout.payout_id, status: payout.status, requires_human: routing.requires_human },
  };
};
