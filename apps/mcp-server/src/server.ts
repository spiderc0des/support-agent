/**
 * The RelayPay support MCP server: eight tools, one conversation per
 * connection context.
 *
 * Descriptions say when to use each tool, because that is what the model
 * reads when choosing. The judgement behind them (precedence, categories,
 * what may be said) lives in the agent's skills; the descriptions only point
 * the right way and never contradict them.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { runTool, sanitizeError, truncateForLog, type ToolContext } from "./lib/tooling.ts";
import { searchKnowledgeBase, searchKnowledgeBaseShape } from "./tools/knowledge.ts";
import {
  lookupCustomer,
  lookupCustomerShape,
  lookupPayout,
  lookupPayoutShape,
  lookupTransaction,
  lookupTransactionShape,
} from "./tools/lookups.ts";
import {
  createEscalation,
  createEscalationShape,
  createSupportTicket,
  createSupportTicketShape,
  logConversationEvent,
  logConversationEventShape,
} from "./tools/actions.ts";
import { bookCallback, bookCallbackShape } from "./tools/callbacks.ts";

export const SERVER_NAME = "relaypay";

export const TOOL_NAMES = [
  "search_knowledge_base",
  "lookup_customer",
  "lookup_transaction",
  "lookup_payout",
  "create_support_ticket",
  "create_escalation",
  "book_callback",
  "log_conversation_event",
] as const;

/**
 * The SDK rejects arguments that fail a tool's schema before our handler
 * runs, so without this a malformed call would leave no tool_calls row. The
 * tool rules require failed calls to be logged, so the validator is wrapped
 * to record the rejection and then fail exactly as before.
 *
 * `validateToolInput` is private in the SDK's types but an ordinary method at
 * runtime. tests/mcp-tools.test.ts ("an invalid category is rejected...")
 * fails if an SDK upgrade stops this from working.
 */
function logSchemaRejections(server: McpServer, ctx: ToolContext) {
  const target = server as unknown as {
    validateToolInput: (tool: unknown, args: unknown, name: string) => Promise<unknown>;
  };
  const original = target.validateToolInput.bind(server);
  target.validateToolInput = async (tool, args, name) => {
    try {
      return await original(tool, args, name);
    } catch (err) {
      const conversation = ctx.conversationId ? await ctx.store.getConversation(ctx.conversationId).catch(() => null) : null;
      await ctx.store.logToolCall({
        conversation_id: conversation?.id ?? null,
        turn_index: conversation?.current_turn ?? null,
        tool_name: name,
        purpose: "rejected by input schema",
        input_summary: truncateForLog(args),
        result_summary: null,
        status: "invalid_input",
        error_message: sanitizeError(err instanceof Error ? err.message : String(err)),
        duration_ms: 0,
      });
      throw err;
    }
  };
}

export function buildServer(ctx: ToolContext): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: "1.0.0" });
  logSchemaRejections(server, ctx);

  server.registerTool(
    "search_knowledge_base",
    {
      description:
        "Search RelayPay's approved support knowledge. Use before answering ANY product, fee, timeline, policy or compliance question, even if you think you know the answer. Returns matched=false when nothing approved covers it.",
      inputSchema: searchKnowledgeBaseShape,
    },
    (args) => runTool(ctx, "search_knowledge_base", "Retrieve approved knowledge before answering", args, searchKnowledgeBase),
  );

  server.registerTool(
    "lookup_customer",
    {
      description:
        "Find and verify the caller's RelayPay account from a company name plus their name, an account email, or an account ID. Use when the caller asks about their own account. Returns verified=false if the caller could not be verified.",
      inputSchema: lookupCustomerShape,
    },
    (args) => runTool(ctx, "lookup_customer", "Identify and verify the caller's account", args, lookupCustomer),
  );

  server.registerTool(
    "lookup_transaction",
    {
      description:
        "Get the status of one transaction from a reference the caller gives (e.g. TXN-9001). Pass the reference as heard. Never guess or invent a reference.",
      inputSchema: lookupTransactionShape,
    },
    (args) => runTool(ctx, "lookup_transaction", "Check a transaction the caller referenced", args, lookupTransaction),
  );

  server.registerTool(
    "lookup_payout",
    {
      description:
        "Get the status of a contractor or vendor payout from a payout reference (e.g. PAY-7002) or its transaction reference. Pass the reference as heard.",
      inputSchema: lookupPayoutShape,
    },
    (args) => runTool(ctx, "lookup_payout", "Check a payout the caller referenced", args, lookupPayout),
  );

  server.registerTool(
    "create_support_ticket",
    {
      description:
        "Open a support ticket so the RelayPay team follows up on an issue that needs work but not an urgent human conversation (for example a failed invoice payment). Escalations create their own ticket; do not open a separate one for them.",
      inputSchema: createSupportTicketShape,
    },
    (args) => runTool(ctx, "create_support_ticket", "Log an issue for support follow-up", args, createSupportTicket),
  );

  server.registerTool(
    "create_escalation",
    {
      description:
        "Hand the case to a human specialist: account restrictions, compliance or verification concerns, disputes, refunds, cancellations, frustrated callers, or anything a record says needs a person. Needs the caller's name and email unless the call context says the server already has them; a preferred callback time is optional.",
      inputSchema: createEscalationShape,
    },
    (args) => runTool(ctx, "create_escalation", "Escalate to human support", args, createEscalation),
  );

  server.registerTool(
    "book_callback",
    {
      description:
        "Book a callback with a RelayPay specialist for this call's escalation, at the time the caller asked for. Books the first specialist free then and assigns them the case; if nobody is, returns alternatives and books nothing. Call only after create_escalation.",
      inputSchema: bookCallbackShape,
    },
    (args) => runTool(ctx, "book_callback", "Book a specialist callback", args, bookCallback),
  );

  server.registerTool(
    "log_conversation_event",
    {
      description:
        "Record a decision a reviewer should see that no other tool records: refusing an unsafe request, being unable to verify a caller, withholding data, or hitting the clarification limit. Tickets, escalations, lookups and searches are already logged; do not log those.",
      inputSchema: logConversationEventShape,
    },
    (args) => runTool(ctx, "log_conversation_event", "Log an agent decision for review", args, logConversationEvent),
  );

  return server;
}
