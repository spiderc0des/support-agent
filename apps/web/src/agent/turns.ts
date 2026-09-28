/**
 * Running one caller turn, the same way for every channel.
 *
 * Vapi (web and phone), the text endpoint and the eval runner all come
 * through `runTurn`, so a scenario that passes in the eval behaves the same
 * on a call. This file owns the session-per-conversation map, barge-in, the
 * per-turn log row, and the fallback when the agent cannot finish.
 */
import type { AnswerPath, Channel } from "@relaypay/shared/enums";
import { emailsSpokenBy } from "./speech-filter.ts";
import { SupportSession, type TurnResult } from "./support-session.ts";
import {
  beginTurn,
  callerTranscripts,
  endConversation,
  openFallbackTicket,
  recordDeniedTool,
  recordSystemEvent,
  recordTurn,
} from "./conversations.ts";
import { summariseConversation } from "./summary.ts";

const IDLE_MS = 10 * 60_000;

export const FALLBACK_REPLY =
  "I'm sorry, I'm having trouble with that right now. I've noted it so our support team can follow up with you.";

// Survives Next.js dev reloads, which would otherwise orphan live sessions.
const g = globalThis as unknown as { __relaypaySessions?: Map<string, SupportSession>; __relaypaySweep?: NodeJS.Timeout };
const sessions = (g.__relaypaySessions ??= new Map<string, SupportSession>());
g.__relaypaySweep ??= setInterval(() => {
  for (const [id, s] of sessions) {
    if (Date.now() - s.lastActivity > IDLE_MS && !s.isBusy) void endCall(id, "idle-timeout");
  }
}, 60_000).unref();

function mcpConfig() {
  const url = process.env.MCP_URL;
  const token = process.env.MCP_AUTH_TOKEN;
  if (!url || !token) throw new Error("MCP_URL and MCP_AUTH_TOKEN must be set");
  return { mcpUrl: url, mcpToken: token };
}

export function activeSessionCount() {
  return sessions.size;
}

/** Get or start the conversation's session. Starting early (on call start) hides the spawn behind the greeting. */
export function sessionFor(conversationId: string, channel: Channel): SupportSession {
  let s = sessions.get(conversationId);
  if (s && s.isClosed) {
    sessions.delete(conversationId);
    s = undefined;
  }
  if (!s) {
    s = new SupportSession({
      conversationId,
      channel,
      ...mcpConfig(),
      onDeniedTool: (tool) => void recordDeniedTool(conversationId, tool),
    });
    sessions.set(conversationId, s);
    const started = s;
    void started
      .start()
      .then(() =>
        recordSystemEvent(conversationId, "session_started", `Agent session ready in ${started.spawnMs}ms`, {
          model: started.model,
          spawn_ms: started.spawnMs,
        }),
      )
      .catch((err) => console.error(`[turns] session for ${conversationId} failed to start:`, err));
  }
  return s;
}

/**
 * Per-call context the agent needs but the cached system prompt must not
 * contain (it would break the cache): today's date, for "tomorrow", and the
 * channel. Sent with the first user message only.
 */
function callContext(channel: Channel, primer: string | null): string {
  const today = new Date().toISOString().slice(0, 10);
  const lines = [`<call_context>channel: ${channel}; today: ${today}</call_context>`];
  if (primer) {
    lines.push(
      `<earlier_in_this_call>\n${primer}\n</earlier_in_this_call>\n` +
        "The call was reconnected. Continue from where it left off; do not greet the caller again.",
    );
  }
  return lines.join("\n");
}

/** When the tag is missing, infer the path from what happened, and say so in the log. */
function inferPath(r: TurnResult): AnswerPath {
  if (r.toolsUsed.includes("create_escalation")) return "escalate";
  if (r.text.trim().endsWith("?")) return "clarify";
  return "answer";
}

export type RunTurnInput = {
  conversationId: string;
  channel: Channel;
  userText: string;
  onText: (text: string) => void;
  /** Earlier transcript, when a session has to be rebuilt mid-call. */
  primer?: string | null;
};

export async function runTurn(input: RunTurnInput): Promise<TurnResult & { turnIndex: number; path: AnswerPath }> {
  const { conversationId, channel, userText, onText } = input;
  const session = sessionFor(conversationId, channel);

  // Barge-in: the caller spoke again while the last reply was still being
  // produced. Stop it; the new utterance is what matters now.
  if (session.isBusy) {
    await session.interrupt();
    for (let i = 0; i < 40 && session.isBusy; i++) await new Promise((r) => setTimeout(r, 50));
  }

  const turnIndex = await beginTurn(conversationId);
  const earlier = await callerTranscripts(conversationId);
  // A session rebuilt mid-call (server restart) is new too, so the check is
  // on the session, not the turn number.
  const content = session.turnsSent === 0 ? `${callContext(channel, input.primer ?? null)}\n\n${userText}` : userText;

  let result: TurnResult;
  try {
    result = await session.sendTurn(content, onText, { callerEmails: emailsSpokenBy([...earlier, userText]) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    result = {
      text: "", tag: null, malformedTag: false, toolsUsed: [], redactions: [], status: "error", errorMessage: message,
      firstTokenMs: null, latencyMs: 0, costUsd: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
  }

  // The agent failed without saying anything useful: the caller still gets
  // an answer, and the team gets a ticket to follow up.
  if ((result.status === "error" || result.status === "timeout") && result.text.length < 5) {
    onText(FALLBACK_REPLY);
    result = { ...result, text: FALLBACK_REPLY };
    const ticket = await openFallbackTicket(conversationId, turnIndex, result.errorMessage ?? result.status);
    await recordSystemEvent(conversationId, "turn_error", `Turn ${turnIndex} failed: ${result.errorMessage ?? result.status}`, {
      fallback_ticket: ticket,
    }, turnIndex);
  }

  const path = result.tag?.path ?? inferPath(result);
  const notes = [
    result.tag?.note,
    !result.tag ? (result.malformedTag ? "control tag malformed; path inferred" : "control tag missing; path inferred") : null,
    result.redactions.length ? `redacted: ${[...new Set(result.redactions)].join(", ")}` : null,
  ].filter(Boolean);

  await recordTurn({
    conversationId,
    turnIndex,
    userTranscript: userText,
    assistantResponse: result.text,
    answerType: path,
    confidence: result.tag?.confidence ?? (result.status === "ok" ? "medium" : "low"),
    uncertaintyNote: notes.length ? notes.join("; ") : null,
    toolsUsed: result.toolsUsed,
    status: result.status,
    errorMessage: result.errorMessage,
    firstTokenMs: result.firstTokenMs,
    latencyMs: result.latencyMs,
    costUsd: result.costUsd,
    usage: result.usage,
  });

  return { ...result, turnIndex, path };
}

/** Close the session and the conversation record. Idempotent. */
export async function endCall(conversationId: string, endedReason: string, opts: { error?: boolean } = {}) {
  const s = sessions.get(conversationId);
  sessions.delete(conversationId);
  s?.close();
  const summary = await summariseConversation(conversationId).catch(() => null);
  const closed = await endConversation(conversationId, { endedReason, summary, error: opts.error });
  if (closed) await recordSystemEvent(conversationId, "call_ended", `Call ended: ${endedReason}`);
}
