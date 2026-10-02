/**
 * The MCP server's only way into the database.
 *
 * A narrow interface rather than a Supabase client passed around: the tools
 * can reach exactly these reads and writes and nothing else, and the tests
 * run the same tools against PGlite (tests/lib/pglite-store.ts) with the real
 * SQL functions underneath.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CustomerRow, PayoutRow, TransactionRow } from "./lib/safe-summary.ts";
import type { NotificationRow, Recipient } from "@relaypay/shared/notify";

export type FullCustomer = CustomerRow & { contact_name: string | null; contact_email: string | null };
export type FullTransaction = TransactionRow & { amount: number; currency: string; destination_country: string | null };
export type FullPayout = PayoutRow & { amount: number; currency: string; recipient_name: string | null };

export type ConversationState = {
  id: string;
  /** The verified account (lookup_customer verified the caller). */
  customer_id: string | null;
  /** The account the call is bound to by an earlier lookup, before or without verification (0012). */
  linked_customer_id: string | null;
  /** From the caller's "Know me" sign-in (0013): the server, not the model, holds these. */
  caller_name: string | null;
  caller_email: string | null;
  caller_timezone: string | null;
  current_turn: number;
  status: string;
  channel: string;
};

export type KbHit = { id: string; source_title: string; summary: string; content: string; score: number };

export type TicketInput = {
  conversationId: string;
  category: string;
  priority: string;
  summary: string;
  customerId: string | null;
  transactionId: string | null;
  payoutId: string | null;
  turnIndex: number | null;
};

export type EscalationInput = {
  conversationId: string;
  userName: string;
  userEmail: string;
  category: string;
  reason: string;
  priority: string;
  preferredTime: string | null;
  ticketId: string | null;
  customerId: string | null;
  transactionId: string | null;
  payoutId: string | null;
  turnIndex: number | null;
};

export type TicketResult = { ticket_id: string; status: string; deduplicated: boolean };
export type EscalationResult = {
  escalation_id: string;
  ticket_id: string;
  status: string;
  call_booked: boolean;
  contact_matches_record: boolean | null;
  deduplicated: boolean;
};

export type ToolCallRow = {
  conversation_id: string | null;
  turn_index: number | null;
  tool_name: string;
  purpose: string | null;
  input_summary: unknown;
  result_summary: unknown;
  status: string;
  error_message: string | null;
  duration_ms: number;
};

export type RetrievalLogRow = {
  conversation_id: string;
  turn_index: number | null;
  query: string;
  chunk_ids: string[];
  source_titles: string[];
  source_summaries: string[];
  scores: number[];
  top_score: number | null;
  matched: boolean;
};

export type EventRow = {
  conversation_id: string;
  turn_index: number | null;
  event_type: string;
  summary: string;
  metadata: Record<string, unknown>;
  source: "agent" | "system";
};

export type CallEscalation = {
  escalation_id: string;
  ticket_id: string;
  user_name: string;
  user_email: string;
  category: string;
  reason: string;
  customer_id: string | null;
  company_name: string | null;
};

export type CallbackAgent = {
  profile_id: string;
  name: string;
  rank: number;
  timezone: string;
  work_days: number[];
  work_start: string;
  work_end: string;
  has_calendar: boolean;
};

export type BookedSlot = { profile_id: string; slot_start: string };

export type BookSlotResult = {
  booking_id: string | null;
  replaced_booking_id: string | null;
  replaced_profile_id: string | null;
  replaced_event_id: string | null;
};

export interface Store {
  getConversation(id: string): Promise<ConversationState | null>;
  /** For stdio / Inspector sessions that have no orchestrator creating the row. */
  ensureConversation(id: string, channel: string): Promise<void>;
  setVerifiedCustomer(conversationId: string, customerId: string): Promise<void>;
  /** Bind the call to this account unless already bound; returns the account it is bound to. */
  bindAccount(conversationId: string, customerId: string): Promise<string | null>;

  customerById(id: string): Promise<FullCustomer | null>;
  customerByEmail(email: string): Promise<FullCustomer | null>;
  matchCompany(query: string): Promise<{ customer_id: string; company_name: string; similarity: number }[]>;
  transactionById(id: string): Promise<FullTransaction | null>;
  payoutById(id: string): Promise<FullPayout | null>;
  payoutByTransaction(transactionId: string): Promise<FullPayout | null>;

  matchKb(query: string, k: number): Promise<KbHit[]>;

  createTicket(input: TicketInput): Promise<TicketResult>;
  createEscalation(input: EscalationInput): Promise<EscalationResult>;

  logToolCall(row: ToolCallRow): Promise<void>;
  logRetrieval(row: RetrievalLogRow): Promise<void>;
  /** Resolves false (never throws) when the row could not be written. */
  logEvent(row: EventRow): Promise<boolean>;

  /** The open escalation on this call, newest first, if any. */
  escalationForConversation(conversationId: string): Promise<CallEscalation | null>;
  /** Staff who take callbacks, in the admin's order. */
  callbackAgents(): Promise<CallbackAgent[]>;
  bookedSlots(from: Date, to: Date): Promise<BookedSlot[]>;
  /** Atomic book-and-assign (0013 book_callback_slot); booking_id null when the slot was just taken. */
  bookSlot(i: { escalationId: string; profileId: string; start: Date; end: Date; timezone: string; label: string }): Promise<BookSlotResult>;
  /** Release a booking whose calendar event could not be created. */
  releaseBooking(bookingId: string): Promise<void>;
  setBookingEvent(bookingId: string, eventId: string, link: string | null): Promise<void>;
  /** Keep a requested callback time as a preference when it can't be booked (never over a booked time). */
  recordPreferredTime(escalationId: string, label: string): Promise<void>;
  calendarToken(profileId: string): Promise<string | null>;
  recordCalendarError(profileId: string, message: string): Promise<void>;

  /** Every support agent and admin with an email, for team notifications. */
  staffRecipients(): Promise<Recipient[]>;
  logNotification(row: NotificationRow): Promise<void>;
}

// ------------------------------------------------------------ Supabase -----

function one<T>(rows: T[] | null): T | null {
  return rows && rows.length > 0 ? rows[0] : null;
}

function check(error: { message: string } | null, what: string) {
  if (error) throw new Error(`${what}: ${error.message}`);
}

const CUSTOMER_COLS = "customer_id, company_name, contact_name, contact_email, plan, account_status, kyc_status, support_notes";
const TXN_COLS =
  "transaction_id, customer_id, transaction_type, amount, currency, destination_country, status, estimated_arrival, support_summary";
const PAYOUT_COLS = "payout_id, transaction_id, customer_id, recipient_name, amount, currency, status, scheduled_for, failure_reason";

export class SupabaseStore implements Store {
  constructor(private readonly db: SupabaseClient) {}

  async getConversation(id: string) {
    const { data, error } = await this.db
      .from("conversations")
      .select("id, customer_id, linked_customer_id, caller_name, caller_email, caller_timezone, current_turn, status, channel")
      .eq("id", id)
      .maybeSingle();
    check(error, "read conversation");
    return data as ConversationState | null;
  }

  async ensureConversation(id: string, channel: string) {
    const { error } = await this.db
      .from("conversations")
      .upsert({ id, channel }, { onConflict: "id", ignoreDuplicates: true });
    check(error, "create conversation");
  }

  async setVerifiedCustomer(conversationId: string, customerId: string) {
    const { error } = await this.db
      .from("conversations")
      .update({ customer_id: customerId, verified_at: new Date().toISOString() })
      .eq("id", conversationId);
    check(error, "attach verified customer");
  }

  async bindAccount(conversationId: string, customerId: string) {
    const { data, error } = await this.db.rpc("bind_conversation_account", { p_conversation: conversationId, p_customer: customerId });
    check(error, "bind call to account");
    return (data as string | null) ?? null;
  }

  async customerById(id: string) {
    const { data, error } = await this.db.from("customers").select(CUSTOMER_COLS).eq("customer_id", id).limit(1);
    check(error, "read customer");
    return one(data) as FullCustomer | null;
  }

  async customerByEmail(email: string) {
    const { data, error } = await this.db.from("customers").select(CUSTOMER_COLS).ilike("contact_email", email).limit(1);
    check(error, "read customer by email");
    return one(data) as FullCustomer | null;
  }

  async matchCompany(query: string) {
    const { data, error } = await this.db.rpc("match_customer_company", { p_query: query });
    check(error, "match company");
    return (data ?? []) as { customer_id: string; company_name: string; similarity: number }[];
  }

  async transactionById(id: string) {
    const { data, error } = await this.db.from("transactions").select(TXN_COLS).eq("transaction_id", id).limit(1);
    check(error, "read transaction");
    return one(data) as FullTransaction | null;
  }

  async payoutById(id: string) {
    const { data, error } = await this.db.from("payouts").select(PAYOUT_COLS).eq("payout_id", id).limit(1);
    check(error, "read payout");
    return one(data) as FullPayout | null;
  }

  async payoutByTransaction(transactionId: string) {
    const { data, error } = await this.db.from("payouts").select(PAYOUT_COLS).eq("transaction_id", transactionId).limit(1);
    check(error, "read payout by transaction");
    return one(data) as FullPayout | null;
  }

  async matchKb(query: string, k: number) {
    const { data, error } = await this.db.rpc("match_kb", { p_query: query, p_k: k });
    check(error, "search knowledge base");
    return (data ?? []) as KbHit[];
  }

  async createTicket(i: TicketInput) {
    const { data, error } = await this.db.rpc("create_support_ticket", {
      p_conversation_id: i.conversationId,
      p_category: i.category,
      p_priority: i.priority,
      p_summary: i.summary,
      p_customer_id: i.customerId,
      p_transaction_id: i.transactionId,
      p_payout_id: i.payoutId,
      p_turn_index: i.turnIndex,
    });
    check(error, "create ticket");
    const row = one(data as TicketResult[]);
    if (!row) throw new Error("create ticket: no row returned");
    return row;
  }

  async createEscalation(i: EscalationInput) {
    const { data, error } = await this.db.rpc("create_escalation", {
      p_conversation_id: i.conversationId,
      p_user_name: i.userName,
      p_user_email: i.userEmail,
      p_category: i.category,
      p_reason: i.reason,
      p_priority: i.priority,
      p_preferred_time: i.preferredTime,
      p_ticket_id: i.ticketId,
      p_customer_id: i.customerId,
      p_transaction_id: i.transactionId,
      p_payout_id: i.payoutId,
      p_turn_index: i.turnIndex,
    });
    check(error, "create escalation");
    const row = one(data as EscalationResult[]);
    if (!row) throw new Error("create escalation: no row returned");
    return row;
  }

  // Log writes never throw: a lost audit row is bad, a failed customer turn is worse.
  async logToolCall(row: ToolCallRow) {
    const { error } = await this.db.from("tool_calls").insert(row);
    if (error) console.error("[mcp] failed to record tool call:", error.message);
  }

  async logRetrieval(row: RetrievalLogRow) {
    const { error } = await this.db.from("retrieval_logs").insert(row);
    if (error) console.error("[mcp] failed to record retrieval:", error.message);
  }

  async logEvent(row: EventRow) {
    const { error } = await this.db.from("conversation_events").insert(row);
    if (error) console.error("[mcp] failed to record event:", error.message);
    return !error;
  }

  async staffRecipients() {
    const { data, error } = await this.db.from("profiles").select("email, full_name").in("role", ["support_agent", "admin"]);
    check(error, "read support team");
    return (data ?? []).map((p) => ({ email: p.email as string, name: (p.full_name as string | null) ?? null }));
  }

  async logNotification(row: NotificationRow) {
    const { error } = await this.db.from("notifications").insert(row);
    if (error) console.error("[mcp] failed to record notification:", error.message);
  }

  async escalationForConversation(conversationId: string) {
    const { data, error } = await this.db
      .from("escalations")
      .select("escalation_id, ticket_id, user_name, user_email, category, reason, customer_id, customers(company_name)")
      .eq("conversation_id", conversationId)
      .neq("status", "closed")
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .limit(1);
    check(error, "read call escalation");
    const row = one(data as (Omit<CallEscalation, "company_name"> & { customers: { company_name: string } | null })[] | null);
    return row ? { ...row, company_name: row.customers?.company_name ?? null, customers: undefined } : null;
  }

  async callbackAgents() {
    const [{ data, error }, { data: cals, error: calErr }] = await Promise.all([
      this.db
        .from("callback_agents")
        .select("profile_id, rank, timezone, work_days, work_start, work_end, profiles!inner(full_name, email, role)")
        .eq("takes_callbacks", true)
        .order("rank"),
      this.db.from("staff_calendars").select("profile_id"),
    ]);
    check(error, "read callback agents");
    check(calErr, "read calendar connections");
    const connected = new Set((cals ?? []).map((c) => c.profile_id as string));
    type Row = { profile_id: string; rank: number; timezone: string; work_days: number[]; work_start: string; work_end: string; profiles: { full_name: string | null; email: string; role: string | null } };
    return ((data ?? []) as unknown as Row[])
      .filter((r) => r.profiles.role === "admin" || r.profiles.role === "support_agent")
      .map((r) => ({
        profile_id: r.profile_id,
        name: r.profiles.full_name?.trim() || r.profiles.email.split("@")[0],
        rank: r.rank,
        timezone: r.timezone,
        work_days: r.work_days,
        work_start: r.work_start,
        work_end: r.work_end,
        has_calendar: connected.has(r.profile_id),
      }));
  }

  async bookedSlots(from: Date, to: Date) {
    const { data, error } = await this.db
      .from("callback_bookings")
      .select("profile_id, slot_start")
      .eq("status", "booked")
      .gte("slot_start", from.toISOString())
      .lt("slot_start", to.toISOString());
    check(error, "read bookings");
    return (data ?? []) as BookedSlot[];
  }

  async bookSlot(i: { escalationId: string; profileId: string; start: Date; end: Date; timezone: string; label: string }) {
    const { data, error } = await this.db.rpc("book_callback_slot", {
      p_escalation: i.escalationId,
      p_profile: i.profileId,
      p_start: i.start.toISOString(),
      p_end: i.end.toISOString(),
      p_timezone: i.timezone,
      p_label: i.label,
    });
    check(error, "book callback");
    return one(data as BookSlotResult[]) ?? { booking_id: null, replaced_booking_id: null, replaced_profile_id: null, replaced_event_id: null };
  }

  async releaseBooking(bookingId: string) {
    const { error } = await this.db.from("callback_bookings").update({ status: "cancelled", cancelled_at: new Date().toISOString() }).eq("id", bookingId);
    check(error, "release booking");
  }

  async setBookingEvent(bookingId: string, eventId: string, link: string | null) {
    const { error } = await this.db.from("callback_bookings").update({ google_event_id: eventId, google_event_link: link }).eq("id", bookingId);
    check(error, "record calendar event");
  }

  async recordPreferredTime(escalationId: string, label: string) {
    const { error } = await this.db
      .from("escalations")
      .update({ call_booked: true, preferred_time_text: label, updated_at: new Date().toISOString() })
      .eq("escalation_id", escalationId)
      .is("callback_at", null);
    check(error, "record preferred time");
  }

  async calendarToken(profileId: string) {
    const { data, error } = await this.db.from("staff_calendars").select("refresh_token").eq("profile_id", profileId).maybeSingle();
    check(error, "read calendar connection");
    return (data?.refresh_token as string | undefined) ?? null;
  }

  async recordCalendarError(profileId: string, message: string) {
    await this.db.from("staff_calendars").update({ last_error: message.slice(0, 500), last_error_at: new Date().toISOString() }).eq("profile_id", profileId);
  }

}
