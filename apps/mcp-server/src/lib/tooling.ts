/**
 * Shared plumbing for every tool: context, logging, result shaping.
 *
 * `runTool` guarantees what the PRD and the MCP tool rules ask for:
 *   - exactly one tool_calls row per call, whatever the outcome
 *   - failures reach the model as a short structured message, never a stack
 *   - errors carry enough detail in the log row to debug, and no secrets
 *   - every call is tied to a conversation and to the turn it served
 */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ToolCallStatus } from "@relaypay/shared/enums";
import type { ConversationState, Store } from "../store.ts";

export type ToolContext = {
  store: Store;
  /** From the X-Conversation-Id header (HTTP) or the environment (stdio). Never from the model. */
  conversationId: string | null;
};

export type ToolOutcome = {
  status: ToolCallStatus;
  /** What the model receives, as JSON. */
  result: Record<string, unknown>;
  /** What tool_calls.result_summary records. Defaults to `result`. */
  summary?: unknown;
  /** Recorded in tool_calls.error_message for anything but success. */
  error?: string;
};

export type ToolHandler<A> = (args: A, conversation: ConversationState, ctx: ToolContext) => Promise<ToolOutcome>;

export function truncateForLog(value: unknown, maxChars = 400): unknown {
  if (typeof value === "string") {
    return value.length > maxChars ? `${value.slice(0, maxChars)}… [+${value.length - maxChars} chars]` : value;
  }
  if (Array.isArray(value)) {
    const head = value.slice(0, 8).map((v) => truncateForLog(v, 200));
    return value.length > 8 ? [...head, `… +${value.length - 8} more`] : head;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = truncateForLog(v, 200);
    return out;
  }
  return value;
}

/** Strip anything credential-shaped from an error before it is stored or shown. */
export function sanitizeError(message: string): string {
  return message
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "[redacted-jwt]")
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, "[redacted-key]")
    .replace(/(apikey|api_key|authorization|password)=?[^\s&]*/gi, "$1=[redacted]")
    .slice(0, 500);
}

function toCallResult(outcome: ToolOutcome): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(outcome.result) }],
    isError: outcome.status === "error" || outcome.status === "invalid_input",
  };
}

export async function runTool<A>(
  ctx: ToolContext,
  toolName: string,
  purpose: string,
  args: A,
  handler: ToolHandler<A>,
): Promise<CallToolResult> {
  const startedAt = Date.now();
  let conversation: ConversationState | null = null;
  let outcome: ToolOutcome;

  try {
    conversation = ctx.conversationId ? await ctx.store.getConversation(ctx.conversationId) : null;
    if (!conversation) {
      outcome = {
        status: "denied",
        result: { error: "This tool can only be used inside a live support conversation." },
        error: ctx.conversationId ? `Unknown conversation ${ctx.conversationId}` : "No conversation id on the connection",
      };
    } else {
      outcome = await handler(args, conversation, ctx);
    }
  } catch (err) {
    const message = sanitizeError(err instanceof Error ? err.message : String(err));
    outcome = {
      status: "error",
      result: {
        error: `${toolName} is unavailable right now.`,
        guidance:
          "Apologise briefly, do not retry this tool, and do not guess the answer. Offer to have the support team follow up.",
      },
      error: message,
    };
  }

  await ctx.store.logToolCall({
    conversation_id: conversation?.id ?? null,
    turn_index: conversation?.current_turn ?? null,
    tool_name: toolName,
    purpose,
    input_summary: truncateForLog(args),
    result_summary: truncateForLog(outcome.summary ?? outcome.result),
    status: outcome.status,
    error_message: outcome.status === "success" ? null : (outcome.error ?? null),
    duration_ms: Date.now() - startedAt,
  });

  return toCallResult(outcome);
}

/** "TCK-1001" -> "T C K 1 0 0 1": how a reference should be read aloud. */
export function spokenReference(ref: string): string {
  return ref.replace(/[^A-Za-z0-9]/g, "").split("").join(" ");
}
