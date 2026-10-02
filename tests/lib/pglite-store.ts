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
import type { NotificationRow } from "../../packages/shared/src/notify.ts";

const dateOnly = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : (v as string | null));

export class PgliteStore implements Store {
  constructor(readonly db: PGlite) {}

  private async one<T>(sql: string, params: unknown[] = []): Promise<T | null> {
    const { rows } = await this.db.query<T>(sql, params);
    return rows[0] ?? null;
  }

  getConversation(id: string) {
    return this.one<ConversationState>("select id, customer_id, current_turn, status, channel from conversations where id = $1", [id]);
  }

  async ensureConversation(id: string, channel: string) {
    await this.db.query("insert into conversations (id, channel) values ($1, $2) on conflict (id) do nothing", [id, channel]);
  }

  async setVerifiedCustomer(conversationId: string, customerId: string) {
    await this.db.query("update conversations set customer_id = $2, verified_at = now() where id = $1", [conversationId, customerId]);
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

  async staffRecipients() {
    const { rows } = await this.db.query<{ email: string; full_name: string | null }>(
      "select email, full_name from profiles where role in ('support_agent', 'admin')",
    );
    return rows.map((r) => ({ email: r.email, name: r.full_name }));
  }

  async logNotification(r: NotificationRow) {
    await this.db.query(
      `insert into notifications (kind, ticket_id, escalation_id, conversation_id, subject, recipients, status, detail)
       values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [r.kind, r.ticket_id, r.escalation_id, r.conversation_id, r.subject, r.recipients, r.status, r.detail],
    );
  }
}
