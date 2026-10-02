/**
 * The MCP server's Store over PGlite, for tests. Same interface as
 * SupabaseStore, with the same SQL functions doing the work, so a tool test
 * exercises the real dedupe, auto-ticket and constraint behaviour.
 */
import type { PGlite } from "@electric-sql/pglite";
import type {
  ConversationState,
  EscalationInput,
  EscalationResult,
  EventRow,
  FullCustomer,
  FullPayout,
  FullTransaction,
  KbHit,
  RetrievalLogRow,
  Store,
  TicketInput,
  TicketResult,
  ToolCallRow,
} from "../../apps/mcp-server/src/store.ts";
import type { BookedSlot, BookSlotResult, CallbackAgent, CallEscalation } from "../../apps/mcp-server/src/store.ts";
import type { NotificationRow } from "../../packages/shared/src/notify.ts";

const dateOnly = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : (v as string | null));

export class PgliteStore implements Store {
  constructor(readonly db: PGlite) {}

  private async one<T>(sql: string, params: unknown[] = []): Promise<T | null> {
    const { rows } = await this.db.query<T>(sql, params);
    return rows[0] ?? null;
  }

  getConversation(id: string) {
    return this.one<ConversationState>("select id, customer_id, linked_customer_id, caller_name, caller_email, caller_timezone, current_turn, status, channel from conversations where id = $1", [id]);
  }

  async ensureConversation(id: string, channel: string) {
    await this.db.query("insert into conversations (id, channel) values ($1, $2) on conflict (id) do nothing", [id, channel]);
  }

  async setVerifiedCustomer(conversationId: string, customerId: string) {
    await this.db.query("update conversations set customer_id = $2, verified_at = now() where id = $1", [conversationId, customerId]);
  }

  async bindAccount(conversationId: string, customerId: string) {
    return (await this.one<{ b: string | null }>("select public.bind_conversation_account($1, $2) as b", [conversationId, customerId]))?.b ?? null;
  }

  customerById(id: string) {
    return this.one<FullCustomer>("select * from customers where customer_id = $1", [id]);
  }

  customerByEmail(email: string) {
    return this.one<FullCustomer>("select * from customers where lower(contact_email) = lower($1)", [email]);
  }

  async matchCompany(query: string) {
    const { rows } = await this.db.query<{ customer_id: string; company_name: string; similarity: number }>(
      "select * from match_customer_company($1)",
      [query],
    );
    return rows;
  }

  async transactionById(id: string) {
    const row = await this.one<FullTransaction>("select * from transactions where transaction_id = $1", [id]);
    return row ? { ...row, amount: Number(row.amount), estimated_arrival: dateOnly(row.estimated_arrival) } : null;
  }

  async payoutById(id: string) {
    const row = await this.one<FullPayout>("select * from payouts where payout_id = $1", [id]);
    return row ? { ...row, amount: Number(row.amount), scheduled_for: dateOnly(row.scheduled_for) } : null;
  }

  async payoutByTransaction(transactionId: string) {
    const row = await this.one<FullPayout>("select * from payouts where transaction_id = $1 limit 1", [transactionId]);
    return row ? { ...row, amount: Number(row.amount), scheduled_for: dateOnly(row.scheduled_for) } : null;
  }

  async matchKb(query: string, k: number) {
    const { rows } = await this.db.query<KbHit>("select * from match_kb($1, $2)", [query, k]);
    return rows;
  }

  async createTicket(i: TicketInput) {
    const row = await this.one<TicketResult>("select * from create_support_ticket($1,$2,$3,$4,$5,$6,$7,$8)", [
      i.conversationId, i.category, i.priority, i.summary, i.customerId, i.transactionId, i.payoutId, i.turnIndex,
    ]);
    if (!row) throw new Error("create ticket: no row");
    return row;
  }

  async createEscalation(i: EscalationInput) {
    const row = await this.one<EscalationResult>(
      "select * from create_escalation($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",
      [
        i.conversationId, i.userName, i.userEmail, i.category, i.reason, i.priority, i.preferredTime,
        i.ticketId, i.customerId, i.transactionId, i.payoutId, i.turnIndex,
      ],
    );
    if (!row) throw new Error("create escalation: no row");
    return row;
  }

  async logToolCall(r: ToolCallRow) {
    await this.db.query(
      `insert into tool_calls (conversation_id, turn_index, tool_name, purpose, input_summary, result_summary, status, error_message, duration_ms)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [r.conversation_id, r.turn_index, r.tool_name, r.purpose, JSON.stringify(r.input_summary), JSON.stringify(r.result_summary),
        r.status, r.error_message, r.duration_ms],
    );
  }

  async logRetrieval(r: RetrievalLogRow) {
    await this.db.query(
      `insert into retrieval_logs (conversation_id, turn_index, query, chunk_ids, source_titles, source_summaries, scores, top_score, matched)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [r.conversation_id, r.turn_index, r.query, r.chunk_ids, r.source_titles, r.source_summaries, r.scores, r.top_score, r.matched],
    );
  }

  async logEvent(r: EventRow) {
    await this.db.query(
      `insert into conversation_events (conversation_id, turn_index, event_type, summary, metadata, source)
       values ($1,$2,$3,$4,$5,$6)`,
      [r.conversation_id, r.turn_index, r.event_type, r.summary, JSON.stringify(r.metadata), r.source],
    );
    return true;
  }

  async staffRecipient(profileId: string) {
    const r = await this.one<{ email: string; full_name: string | null }>("select email, full_name from profiles where id = $1", [profileId]);
    return r ? { email: r.email, name: r.full_name } : null;
  }

  async logNotification(r: NotificationRow) {
    await this.db.query(
      `insert into notifications (kind, ticket_id, escalation_id, conversation_id, subject, recipients, status, detail)
       values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [r.kind, r.ticket_id, r.escalation_id, r.conversation_id, r.subject, r.recipients, r.status, r.detail],
    );
  }

  escalationForConversation(conversationId: string) {
    return this.one<CallEscalation>(
      `select e.escalation_id, e.ticket_id, e.user_name, e.user_email, e.category, e.reason, e.customer_id, c.company_name
         from escalations e left join customers c on c.customer_id = e.customer_id
        where e.conversation_id = $1 and e.status <> 'closed' and e.deleted_at is null
        order by e.created_at desc limit 1`,
      [conversationId],
    );
  }

  async callbackAgents() {
    const { rows } = await this.db.query<CallbackAgent & { work_start: string; work_end: string }>(
      `select a.profile_id, coalesce(nullif(trim(p.full_name), ''), split_part(p.email, '@', 1)) as name, a.rank, a.timezone, a.work_days,
              a.work_start::text as work_start, a.work_end::text as work_end,
              exists (select 1 from staff_calendars s where s.profile_id = a.profile_id) as has_calendar
         from callback_agents a join profiles p on p.id = a.profile_id
        where a.takes_callbacks and p.role in ('admin', 'support_agent')
        order by a.rank`,
    );
    return rows;
  }

  async bookedSlots(from: Date, to: Date) {
    const { rows } = await this.db.query<{ profile_id: string; slot_start: Date }>(
      "select profile_id, slot_start from callback_bookings where status = 'booked' and slot_start >= $1 and slot_start < $2",
      [from.toISOString(), to.toISOString()],
    );
    return rows.map((r): BookedSlot => ({ profile_id: r.profile_id, slot_start: new Date(r.slot_start).toISOString() }));
  }

  async bookSlot(i: { escalationId: string; profileId: string; start: Date; end: Date; timezone: string; label: string }) {
    const row = await this.one<BookSlotResult>("select * from book_callback_slot($1,$2,$3,$4,$5,$6)", [
      i.escalationId, i.profileId, i.start.toISOString(), i.end.toISOString(), i.timezone, i.label,
    ]);
    return row ?? { booking_id: null, replaced_booking_id: null, replaced_profile_id: null, replaced_event_id: null };
  }

  async releaseBooking(bookingId: string) {
    await this.db.query("update callback_bookings set status = 'cancelled', cancelled_at = now() where id = $1", [bookingId]);
  }

  async setBookingEvent(bookingId: string, eventId: string, link: string | null) {
    await this.db.query("update callback_bookings set google_event_id = $2, google_event_link = $3 where id = $1", [bookingId, eventId, link]);
  }

  async recordPreferredTime(escalationId: string, label: string) {
    await this.db.query("update escalations set call_booked = true, preferred_time_text = $2, updated_at = now() where escalation_id = $1 and callback_at is null", [escalationId, label]);
  }

  async calendarToken(profileId: string) {
    return (await this.one<{ refresh_token: string }>("select refresh_token from staff_calendars where profile_id = $1", [profileId]))?.refresh_token ?? null;
  }

  async recordCalendarError(profileId: string, message: string) {
    await this.db.query("update staff_calendars set last_error = $2, last_error_at = now() where profile_id = $1", [profileId, message]);
  }

}
