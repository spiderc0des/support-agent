/**
 * create_support_ticket, create_escalation, log_conversation_event.
 *
 * The conversation these write to always comes from the connection, never
 * from the model's `conversation_id` argument (accepted because the spec
 * names it, and recorded if it disagrees).
 *
 * Which account a record is filed against is decided here too: the verified
 * account on the call wins; otherwise an account the model names must exist;
 * otherwise the owner of a referenced transaction or payout.
 */
import { z } from "zod";
import {
  AgentEventType,
  EscalationCategory,
  Priority,
  TicketCategory,
} from "@relaypay/shared/enums";
import type { ConversationState } from "../store.ts";
import { spokenReference, type ToolContext, type ToolHandler } from "../lib/tooling.ts";
import { isPlausibleEmail, normalizeEmail, normalizeReference } from "../lib/normalize.ts";

type Links = { customerId: string | null; transactionId: string | null; payoutId: string | null; notes: string[] };

async function resolveLinks(
  ctx: ToolContext,
  conversation: ConversationState,
  raw: { customer_id?: string; transaction_id?: string; payout_id?: string },
): Promise<Links> {
  const notes: string[] = [];
  const txnRef = normalizeReference("TXN", raw.transaction_id);
  const payoutRef = normalizeReference("PAY", raw.payout_id);
  const txn = txnRef ? await ctx.store.transactionById(txnRef) : null;
  const payout = payoutRef ? await ctx.store.payoutById(payoutRef) : null;
  if (raw.transaction_id && !txn) notes.push(`transaction "${raw.transaction_id}" not found; not linked`);
  if (raw.payout_id && !payout) notes.push(`payout "${raw.payout_id}" not found; not linked`);

  const callAccount = conversation.customer_id ?? conversation.linked_customer_id;
  let customerId = callAccount;
  if (!customerId && raw.customer_id) {
    const ref = normalizeReference("CUS", raw.customer_id);
    const customer = ref ? await ctx.store.customerById(ref) : null;
    if (customer) customerId = customer.customer_id;
    else notes.push(`customer "${raw.customer_id}" not found; not linked`);
  } else if (customerId && raw.customer_id && normalizeReference("CUS", raw.customer_id) !== customerId) {
    notes.push(`model named ${raw.customer_id}; filed against this call's account instead`);
  }
  customerId = customerId ?? txn?.customer_id ?? payout?.customer_id ?? null;

  // Never link another account's records to this call's account.
  const own = (owner: string | undefined) => !callAccount || owner === callAccount;
  return {
    customerId,
    transactionId: txn && own(txn.customer_id) ? txn.transaction_id : null,
    payoutId: payout && own(payout.customer_id) ? payout.payout_id : null,
    notes,
  };
}

function conversationIdNote(arg: string | undefined, conversation: ConversationState): string[] {
  return arg && arg !== conversation.id ? [`ignored model-supplied conversation_id "${arg}"`] : [];
}

// ------------------------------------------------ create_support_ticket -----

export const createSupportTicketShape = {
  category: TicketCategory.describe("What the issue is about."),
  priority: Priority.describe("high: restricted account, funds on hold, or distressed customer. medium: failed or delayed payment/payout. low: information follow-up."),
  summary: z.string().min(10).max(600).describe("One or two plain sentences a support agent can act on. No guesses about the cause."),
  customer_id: z.string().max(40).optional(),
  transaction_id: z.string().max(80).optional(),
  payout_id: z.string().max(80).optional(),
  conversation_id: z.string().max(80).optional().describe("Optional; the live conversation is used automatically."),
};
type TicketArgs = {
  category: z.infer<typeof TicketCategory>;
  priority: z.infer<typeof Priority>;
  summary: string;
  customer_id?: string;
  transaction_id?: string;
  payout_id?: string;
  conversation_id?: string;
};

export const createSupportTicket: ToolHandler<TicketArgs> = async (args, conversation, ctx) => {
  const links = await resolveLinks(ctx, conversation, args);
  const ticket = await ctx.store.createTicket({
    conversationId: conversation.id,
    category: args.category,
    priority: args.priority,
    summary: args.summary.trim(),
    customerId: links.customerId,
    transactionId: links.transactionId,
    payoutId: links.payoutId,
    turnIndex: conversation.current_turn,
  });
  const notes = [...links.notes, ...conversationIdNote(args.conversation_id, conversation)];

  return {
    status: "success",
    result: {
      ticket_id: ticket.ticket_id,
      status: ticket.status,
      deduplicated: ticket.deduplicated,
      spoken_reference: spokenReference(ticket.ticket_id),
      guidance: ticket.deduplicated
        ? "A ticket for this issue already exists on this call; give that reference, do not open another."
        : "Tell the caller the ticket reference and that the support team will follow up. Do not promise a time or an outcome.",
    },
    summary: { ...ticket, customer_id: links.customerId, notes },
  };
};

// ---------------------------------------------------- create_escalation -----

export const createEscalationShape = {
  user_name: z.string().min(1).max(120).optional().describe("The caller's name, as they gave it. Omit when the call context says the server has it."),
  user_email: z
    .string()
    .min(3)
    .max(200)
    .optional()
    .describe("The caller's email as they spelled it; spoken forms like 'amara at lagosledger dot example' are fine. Omit when the call context says the server has it."),
  category: EscalationCategory.describe(
    "account: restriction, suspension, access. compliance: verification or review. dispute: dispute, refund, cancellation. payment: failed or delayed money needing a person. other: anything else.",
  ),
  reason: z.string().min(10).max(600).describe("Why a specialist is needed, in plain words. No diagnosis."),
  preferred_time: z.string().max(120).optional().describe("Callback time as the caller said it, e.g. 'tomorrow afternoon'."),
  priority: Priority.optional().describe("Defaults to high."),
  ticket_id: z.string().max(40).optional().describe("An existing ticket from this call, if one was opened. Otherwise one is created."),
  customer_id: z.string().max(40).optional(),
  transaction_id: z.string().max(80).optional(),
  payout_id: z.string().max(80).optional(),
};
type EscalationArgs = {
  user_name?: string;
  user_email?: string;
  category: z.infer<typeof EscalationCategory>;
  reason: string;
  preferred_time?: string;
  priority?: z.infer<typeof Priority>;
  ticket_id?: string;
  customer_id?: string;
  transaction_id?: string;
  payout_id?: string;
};

export const createEscalation: ToolHandler<EscalationArgs> = async (args, conversation, ctx) => {
  // A caller who signed in on the voice page gave their name and email
  // there; the server holds them, so the agent never asks or spells them.
  const userName = (args.user_name?.trim() || conversation.caller_name?.trim() || "").trim();
  const rawEmail = args.user_email ?? conversation.caller_email ?? undefined;
  if (!userName || !rawEmail) {
    return {
      status: "invalid_input",
      result: {
        error: `This caller didn't sign in before the call, so the server doesn't have their ${!userName && !rawEmail ? "name and email" : !userName ? "name" : "email"}. If they already said it on this call, call create_escalation again now passing user_name and user_email as they gave them; otherwise ask for what's missing.`,
      },
      error: "missing caller name or email",
    };
  }
  const email = normalizeEmail(rawEmail);
  if (!email || !isPlausibleEmail(email)) {
    return {
      status: "invalid_input",
      result: {
        error: `"${rawEmail}" doesn't look like a complete email address. Ask the caller to spell it again, then read it back once.`,
      },
      error: "implausible email",
    };
  }

  const links = await resolveLinks(ctx, conversation, args);
  const ticketId = args.ticket_id?.toUpperCase().replace(/\s+/g, "") ?? null;
  const escalation = await ctx.store.createEscalation({
    conversationId: conversation.id,
    userName,
    userEmail: email,
    category: args.category,
    reason: args.reason.trim(),
    priority: args.priority ?? "high",
    preferredTime: args.preferred_time?.trim() || null,
    ticketId: ticketId && /^TCK-\d+$/.test(ticketId) ? ticketId : null,
    customerId: links.customerId,
    transactionId: links.transactionId,
    payoutId: links.payoutId,
    turnIndex: conversation.current_turn,
  });


  const followUp = args.preferred_time?.trim()
    ? `A callback with a RelayPay specialist is being booked for ${userName}. The reference is ${escalation.escalation_id}.`
    : `The case is with a RelayPay specialist. The reference is ${escalation.escalation_id}.`;

  return {
    status: "success",
    result: {
      escalation_id: escalation.escalation_id,
      ticket_id: escalation.ticket_id,
      status: escalation.status,
      call_booked: escalation.call_booked,
      deduplicated: escalation.deduplicated,
      follow_up_summary: followUp,
      spoken_reference: spokenReference(escalation.escalation_id),
      guidance: args.preferred_time?.trim()
        ? `Now, in this same reply, call book_callback with "${args.preferred_time.trim()}" as YYYY-MM-DDTHH:MM in the caller's local time to confirm the callback, and give the reference. Don't say a callback is booked until book_callback says booked. Do not promise an outcome.`
        : escalation.deduplicated
          ? "This escalation already existed; give that reference. Do not promise an outcome, a timeline, or a confirmed appointment."
          : "Give the reference and ask what day and time suits them for a callback with a specialist (then book it with book_callback). Don't say a specialist will email them; only if they don't want a callback, say a specialist will follow up by email. Stop working on the issue itself. Do not promise an outcome or a timeline.",
    },
    summary: {
      ...escalation,
      customer_id: links.customerId,
      notes: [...links.notes, ...(ticketId && !/^TCK-\d+$/.test(ticketId) ? [`ignored malformed ticket_id "${args.ticket_id}"`] : [])],
    },
  };
};

// ----------------------------------------------- log_conversation_event -----

export const logConversationEventShape = {
  event_type: AgentEventType.describe(
    "policy_refusal: refused an unsafe or out-of-policy request. identity_unverified: couldn't verify the caller. sensitive_data_withheld: withheld data the caller asked for. clarification_limit_reached: asked twice and still unclear. note: anything else a reviewer should see.",
  ),
  summary: z.string().min(5).max(400).describe("One sentence for the reviewer."),
  metadata: z.record(z.string(), z.unknown()).optional(),
  conversation_id: z.string().max(80).optional().describe("Optional; the live conversation is used automatically."),
};
type EventArgs = {
  event_type: z.infer<typeof AgentEventType>;
  summary: string;
  metadata?: Record<string, unknown>;
  conversation_id?: string;
};

export const logConversationEvent: ToolHandler<EventArgs> = async (args, conversation, ctx) => {
  const logged = await ctx.store.logEvent({
    conversation_id: conversation.id,
    turn_index: conversation.current_turn,
    event_type: args.event_type,
    summary: args.summary.trim(),
    metadata: { ...(args.metadata ?? {}), ...(conversationIdNote(args.conversation_id, conversation).length ? { note: "model-supplied conversation_id ignored" } : {}) },
    source: "agent",
  });
  return logged
    ? { status: "success", result: { logged: true } }
    : { status: "error", result: { logged: false }, error: "conversation_events insert failed" };
};
