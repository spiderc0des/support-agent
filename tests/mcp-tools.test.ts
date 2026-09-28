/**
 * The MCP server end to end, through a real MCP client, over the real SQL
 * (PGlite). No network, no model, no cost.
 *
 * Organised by the guarantees the plan makes, not by tool: every call is
 * logged, lookups never leak contact data, verified accounts cannot be used
 * to read other accounts, creates are idempotent, and escalations always sit
 * on a ticket.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createTestDb } from "../scripts/lib/test-db.ts";
import { PgliteStore } from "./lib/pglite-store.ts";
import { buildServer, TOOL_NAMES } from "../apps/mcp-server/src/server.ts";

let db: PGlite;
let store: PgliteStore;

before(async () => {
  db = await createTestDb();
  store = new PgliteStore(db);
});
after(async () => {
  await db.close();
});

/** A fresh conversation and an MCP client bound to it, as the orchestrator would set up a call. */
async function session(conversationId: string | null = randomUUID()) {
  if (conversationId) await store.ensureConversation(conversationId, "eval");
  const server = buildServer({ store, conversationId });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);

  const call = async (name: string, args: Record<string, unknown>) => {
    const res = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    return { isError: Boolean(res.isError), body: JSON.parse(res.content[0].text) as Record<string, any> };
  };
  const rows = async (sql: string) => (await db.query<Record<string, any>>(sql, [conversationId])).rows;
  return { conversationId: conversationId!, client, call, rows };
}

const SENSITIVE = [
  "amara@lagosledger.example", "Okafor", "efua@accrastack.example", "Mensah", "Bright Studio", "Kente Labs", "Mwiza Design",
];
function assertNoContactData(body: unknown) {
  const text = JSON.stringify(body);
  for (const s of SENSITIVE) assert.ok(!text.includes(s), `tool output leaked "${s}": ${text}`);
}

// ------------------------------------------------------------ surface -----

test("exposes exactly the seven tools", async () => {
  const { client } = await session();
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), [...TOOL_NAMES].sort());
});

test("a connection without a conversation is denied, and the denial is logged", async () => {
  const s = await session(null);
  const res = await s.call("lookup_transaction", { transaction_id: "TXN-9001" });
  assert.match(res.body.error, /live support conversation/);
  const { rows } = await db.query<{ status: string }>(
    "select status from tool_calls where conversation_id is null and tool_name = 'lookup_transaction' order by created_at desc limit 1",
  );
  assert.equal(rows[0]?.status, "denied");
});

// -------------------------------------------------- scenario 1: knowledge -----

test("scenario 1: fee question retrieves the fee policy and logs the retrieval", async () => {
  const s = await session();
  const res = await s.call("search_knowledge_base", { query: "international payment fees" });
  assert.equal(res.body.matched, true);
  assert.equal(res.body.chunks[0].id, "faq-how-does-relaypay-charge-fees");
  assert.match(res.body.chunks[0].text, /displays applicable fees before a transaction is confirmed/);

  const [log] = await s.rows("select * from retrieval_logs where conversation_id = $1");
  assert.equal(log.matched, true);
  assert.ok(log.chunk_ids.includes("faq-how-does-relaypay-charge-fees"));
  assert.ok(log.source_titles[0].includes("How Does RelayPay Charge Fees?"));
  const [call] = await s.rows("select * from tool_calls where conversation_id = $1");
  assert.equal(call.status, "success");
});

test("off-topic search returns matched=false and still logs it", async () => {
  const s = await session();
  const res = await s.call("search_knowledge_base", { query: "weather in Lagos today" });
  assert.equal(res.body.matched, false);
  assert.match(res.body.guidance, /Do not answer from general knowledge/);
  const [log] = await s.rows("select matched from retrieval_logs where conversation_id = $1");
  assert.equal(log.matched, false);
});

// ------------------------------------------------- scenario 3: customer -----

test("scenario 3: Amara from LagosLedger is verified and gets only a safe summary", async () => {
  const s = await session();
  const res = await s.call("lookup_customer", { company_name: "Lagos Ledger", contact_name: "Amara" });
  assert.equal(res.body.found, true);
  assert.equal(res.body.verified, true);
  assert.equal(res.body.customer_id, "CUS-1001");
  assert.match(res.body.safe_summary, /active on the Growth plan/);
  assertNoContactData(res.body);

  const [conv] = await s.rows("select customer_id from conversations where id = $1");
  assert.equal(conv.customer_id, "CUS-1001");
  const events = await s.rows("select event_type from conversation_events where conversation_id = $1");
  assert.ok(events.some((e) => e.event_type === "customer_verified"));
});

test("company name alone does not verify, and reveals nothing about the account", async () => {
  const s = await session();
  const res = await s.call("lookup_customer", { company_name: "LagosLedger" });
  assert.equal(res.body.verified, false);
  assert.equal(res.body.plan, undefined);
  assert.equal(res.body.account_status, undefined);
  const [conv] = await s.rows("select customer_id from conversations where id = $1");
  assert.equal(conv.customer_id, null);
});

test("a wrong name for the company does not verify", async () => {
  const s = await session();
  const res = await s.call("lookup_customer", { company_name: "LagosLedger", contact_name: "Efua" });
  assert.equal(res.body.verified, false);
});

test("spoken email verifies", async () => {
  const s = await session();
  const res = await s.call("lookup_customer", { email: "amina at capecloud dot example" });
  assert.equal(res.body.verified, true);
  assert.equal(res.body.customer_id, "CUS-1004");
});

test("restricted account routes to a human without explaining why", async () => {
  const s = await session();
  const res = await s.call("lookup_customer", { company_name: "AccraStack", contact_name: "Efua Mensah" });
  assert.equal(res.body.routing.requires_human, true);
  assert.equal(res.body.routing.suggested_category, "account");
  assert.doesNotMatch(res.body.safe_summary, /compliance|review|restrict/i);
  assertNoContactData(res.body);
});

test("unknown customer is a structured not-found, not a crash", async () => {
  const s = await session();
  const res = await s.call("lookup_customer", { company_name: "Nonexistent Holdings" });
  assert.equal(res.isError, false);
  assert.equal(res.body.found, false);
  const [call] = await s.rows("select status from tool_calls where conversation_id = $1");
  assert.equal(call.status, "not_found");
});

test("no identifying field is invalid input", async () => {
  const s = await session();
  const res = await s.call("lookup_customer", { contact_name: "Amara" });
  assert.equal(res.isError, true);
  const [call] = await s.rows("select status from tool_calls where conversation_id = $1");
  assert.equal(call.status, "invalid_input");
});

// ---------------------------------------------- scenario 4: transaction -----

test("scenario 4: TXN-9001 gives the record's estimate, framed as an estimate", async () => {
  const s = await session();
  const res = await s.call("lookup_transaction", { transaction_id: "TXN-9001" });
  assert.equal(res.body.status, "processing");
  assert.match(res.body.safe_summary, /August 19, 2026/);
  assert.match(res.body.safe_summary, /estimate, not a guarantee/);
  assert.equal(res.body.related_payout_id, "PAY-7001");
  assertNoContactData(res.body);
});

for (const heard of ["t x n nine zero zero one", "transaction 9001", "txn 9001", "TXN9001", "tee ex en nine thousand one"]) {
  test(`speech-to-text reference "${heard}" resolves to TXN-9001`, async () => {
    const s = await session();
    const res = await s.call("lookup_transaction", { transaction_id: heard });
    assert.equal(res.body.transaction_id, "TXN-9001");
  });
}

test("an unreadable reference asks for a repeat instead of guessing", async () => {
  const s = await session();
  const res = await s.call("lookup_transaction", { transaction_id: "the one from last week" });
  assert.equal(res.isError, true);
  assert.match(res.body.error, /repeat it/);
});

test("a verified caller cannot read another customer's transaction, and the attempt is logged", async () => {
  const s = await session();
  await s.call("lookup_customer", { company_name: "LagosLedger", contact_name: "Amara" });
  const res = await s.call("lookup_transaction", { transaction_id: "TXN-9003" });
  assert.equal(res.body.found, false);
  assert.equal(res.body.status, undefined);
  const events = await s.rows("select event_type from conversation_events where conversation_id = $1");
  assert.ok(events.some((e) => e.event_type === "ownership_blocked"));
  const calls = await s.rows("select status from tool_calls where conversation_id = $1 and tool_name = 'lookup_transaction'");
  assert.equal(calls[0].status, "denied");
});

test("failed transaction suggests a ticket; review-required suggests a human", async () => {
  const s = await session();
  const failed = await s.call("lookup_transaction", { transaction_id: "TXN-9004" });
  assert.equal(failed.body.routing.suggest_ticket, true);
  const review = await s.call("lookup_transaction", { transaction_id: "TXN-9003" });
  assert.equal(review.body.routing.requires_human, true);
  assert.equal(review.body.routing.suggested_category, "compliance");
});

// --------------------------------------------------- scenario 5: payout -----

test("scenario 5: PAY-7002 is under review and routes to compliance escalation", async () => {
  const s = await session();
  const res = await s.call("lookup_payout", { payout_id: "PAY-7002" });
  assert.equal(res.body.status, "review required");
  assert.equal(res.body.routing.requires_human, true);
  assert.equal(res.body.routing.suggested_category, "compliance");
  assert.doesNotMatch(res.body.safe_summary, /compliance/i);
  assertNoContactData(res.body);
});

test("payout can be found by its transaction", async () => {
  const s = await session();
  const res = await s.call("lookup_payout", { transaction_id: "TXN-9004" });
  assert.equal(res.body.payout_id, "PAY-7003");
  assert.match(res.body.safe_summary, /beneficiary details need review/);
});

// --------------------------------------------------- scenario 6: ticket -----

test("scenario 6: failed invoice payment opens one ticket, stored and deduplicated", async () => {
  const s = await session();
  const first = await s.call("create_support_ticket", {
    category: "invoice",
    priority: "medium",
    summary: "Customer reports an invoice payment failed and wants the team to look at it.",
  });
  assert.match(first.body.ticket_id, /^TCK-\d+$/);
  assert.equal(first.body.status, "open");
  assert.equal(first.body.deduplicated, false);

  const again = await s.call("create_support_ticket", {
    category: "invoice",
    priority: "medium",
    summary: "Same issue, asked again after an interruption.",
  });
  assert.equal(again.body.ticket_id, first.body.ticket_id);
  assert.equal(again.body.deduplicated, true);

  const tickets = await s.rows("select * from support_tickets where conversation_id = $1");
  assert.equal(tickets.length, 1);
  const [conv] = await s.rows("select status from conversations where id = $1");
  assert.equal(conv.status, "ticketed");
});

test("ticket links the transaction and its owner even without a verified caller", async () => {
  const s = await session();
  const res = await s.call("create_support_ticket", {
    category: "payout",
    priority: "medium",
    summary: "Payout failed; beneficiary details need review.",
    transaction_id: "txn 9004",
  });
  const [t] = await s.rows("select * from support_tickets where conversation_id = $1");
  assert.equal(t.ticket_id, res.body.ticket_id);
  assert.equal(t.transaction_id, "TXN-9004");
  assert.equal(t.customer_id, "CUS-1004");
});

test("a model-supplied conversation_id cannot redirect a ticket", async () => {
  const s = await session();
  const other = await session();
  await s.call("create_support_ticket", {
    category: "other",
    priority: "low",
    summary: "Trying to write into someone else's conversation.",
    conversation_id: other.conversationId,
  });
  assert.equal((await other.rows("select * from support_tickets where conversation_id = $1")).length, 0);
  assert.equal((await s.rows("select * from support_tickets where conversation_id = $1")).length, 1);
});

test("an invalid category is rejected by the schema, not stored", async () => {
  const s = await session();
  const res = (await s.client.callTool({
    name: "create_support_ticket",
    arguments: { category: "refunds", priority: "medium", summary: "Not a real category at all." },
  })) as { isError?: boolean };
  assert.equal(res.isError, true);
  assert.equal((await s.rows("select * from support_tickets where conversation_id = $1")).length, 0);
  const [call] = await s.rows("select status, purpose from tool_calls where conversation_id = $1");
  assert.equal(call?.status, "invalid_input", "schema rejections must still leave a tool_calls row");
});

// ----------------------------------------------- scenario 7: escalation -----

test("scenario 7: restricted account escalation stores details, auto-ticket, and marks the call", async () => {
  const s = await session();
  await s.call("lookup_customer", { company_name: "AccraStack", contact_name: "Efua" });
  const res = await s.call("create_escalation", {
    user_name: "Efua Mensah",
    user_email: "efua at accrastack dot example",
    category: "account",
    reason: "Account is restricted and the customer says nobody has helped them.",
    preferred_time: "tomorrow at 3pm",
  });
  assert.match(res.body.escalation_id, /^ESC-\d+$/);
  assert.match(res.body.ticket_id, /^TCK-\d+$/);
  assert.equal(res.body.call_booked, true);
  assert.match(res.body.follow_up_summary, /specialist will follow up/);
  assert.doesNotMatch(res.body.follow_up_summary, /guarantee|confirmed for/i);

  const [e] = await s.rows("select * from escalations where conversation_id = $1");
  assert.equal(e.user_email, "efua@accrastack.example");
  assert.equal(e.customer_id, "CUS-1003");
  assert.equal(e.contact_matches_record, true);
  assert.equal(e.preferred_time_text, "tomorrow at 3pm");
  assert.equal(e.status, "open");

  const [t] = await s.rows("select * from support_tickets where conversation_id = $1");
  assert.equal(t.ticket_id, e.ticket_id);
  assert.equal(t.priority, "high");
  const [conv] = await s.rows("select status from conversations where id = $1");
  assert.equal(conv.status, "escalated");
});

test("escalation reuses an existing ticket, and a retry does not duplicate it", async () => {
  const s = await session();
  const ticket = await s.call("create_support_ticket", {
    category: "payment", priority: "medium", summary: "Delayed incoming transfer for KigaliWorks.",
  });
  const args = {
    user_name: "Patrick", user_email: "patrick@kigaliworks.example", category: "payment",
    reason: "Customer is frustrated about a delayed transfer.", ticket_id: ticket.body.ticket_id,
  };
  const first = await s.call("create_escalation", args);
  const second = await s.call("create_escalation", args);
  assert.equal(first.body.ticket_id, ticket.body.ticket_id);
  assert.equal(second.body.escalation_id, first.body.escalation_id);
  assert.equal(second.body.deduplicated, true);
  assert.equal((await s.rows("select * from escalations where conversation_id = $1")).length, 1);
  assert.equal((await s.rows("select * from support_tickets where conversation_id = $1")).length, 1);
});

test("an incomplete email is sent back to be spelled again, and nothing is stored", async () => {
  const s = await session();
  const res = await s.call("create_escalation", {
    user_name: "Daniel", user_email: "daniel at nairobi ops", category: "compliance",
    reason: "Wants to understand why verification is pending.",
  });
  assert.equal(res.isError, true);
  assert.match(res.body.error, /spell it again/);
  assert.equal((await s.rows("select * from escalations where conversation_id = $1")).length, 0);
});

test("an unverified caller's escalation records a mismatch against the account on file", async () => {
  const s = await session();
  await s.call("create_escalation", {
    user_name: "Someone", user_email: "someone@elsewhere.example", category: "compliance",
    reason: "Asking about payout PAY-7002 under review.", payout_id: "PAY-7002",
  });
  const [e] = await s.rows("select * from escalations where conversation_id = $1");
  assert.equal(e.customer_id, "CUS-1003");
  assert.equal(e.contact_matches_record, false);
});

// ---------------------------------------------------- event logging -----

test("the agent can log decision events but not system events", async () => {
  const s = await session();
  const ok = await s.call("log_conversation_event", {
    event_type: "policy_refusal", summary: "Caller asked for another customer's email; refused.",
  });
  assert.equal(ok.body.logged, true);
  const bad = (await s.client.callTool({
    name: "log_conversation_event", arguments: { event_type: "escalation_created", summary: "Forged event." },
  })) as { isError?: boolean };
  assert.equal(bad.isError, true);
  const events = await s.rows("select event_type, source from conversation_events where conversation_id = $1");
  assert.deepEqual(events, [{ event_type: "policy_refusal", source: "agent" }]);
});

test("every tool call produced exactly one tool_calls row", async () => {
  const s = await session();
  await s.call("search_knowledge_base", { query: "exchange rates" });
  await s.call("lookup_transaction", { transaction_id: "TXN-0000" });
  await s.call("lookup_payout", { payout_id: "PAY-7001" });
  const calls = await s.rows("select tool_name, status from tool_calls where conversation_id = $1 order by created_at");
  assert.deepEqual(
    calls.map((c) => `${c.tool_name}:${c.status}`),
    ["search_knowledge_base:success", "lookup_transaction:not_found", "lookup_payout:success"],
  );
});
