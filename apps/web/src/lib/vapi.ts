/**
 * The parts of Vapi's requests the backend relies on.
 *
 * Shapes follow Vapi's Custom LLM and Server URL docs; Phase 0's spike
 * (spikes/vapi-echo.ts) records the real payloads, and docs/spikes.md notes
 * any difference. Everything here reads defensively: a missing field means
 * "unknown", never a crash mid-call.
 */
import { timingSafeEqual } from "node:crypto";
import type { Channel } from "@relaypay/shared/enums";

export type VapiMessage = { role: "system" | "user" | "assistant" | "tool" | "function"; content?: string | null };

export type VapiCall = {
  id?: string;
  type?: string; // "webCall" | "inboundPhoneCall" | "outboundPhoneCall"
  customer?: { number?: string | null } | null;
  metadata?: Record<string, unknown> | null;
  assistantOverrides?: { metadata?: Record<string, unknown> | null } | null;
};

/** The "Know me" session the voice page passed when it started the call, if Vapi forwards it. */
export function callerSessionIdOf(call: VapiCall | undefined): string | null {
  const v = call?.assistantOverrides?.metadata?.callerSessionId ?? call?.metadata?.callerSessionId;
  return typeof v === "string" ? v : null;
}

export type VapiChatRequest = {
  model?: string;
  messages?: VapiMessage[];
  stream?: boolean;
  call?: VapiCall;
  metadata?: Record<string, unknown>;
};

export type VapiServerMessage = {
  message?: {
    type?: string;
    status?: string;
    endedReason?: string;
    call?: VapiCall;
    artifact?: { transcript?: string };
  };
};

/**
 * Vapi authenticates to us with a shared secret, sent either as a bearer
 * token (Custom LLM credential) or as X-Vapi-Secret (Server URL secret).
 * Both are accepted and compared in constant time.
 */
export function vapiAuthorised(headers: Headers): boolean {
  // Tolerate the usual copy-paste damage in a hosting dashboard: surrounding
  // whitespace or quotes around the value.
  const secret = process.env.VAPI_WEBHOOK_SECRET?.trim().replace(/^["']|["']$/g, "");
  const candidates = [headers.get("x-vapi-secret"), headers.get("authorization")?.replace(/^Bearer\s+/i, "")].map((c) => c?.trim() ?? "");
  if (!secret) {
    warnOnce("VAPI_WEBHOOK_SECRET is not set, so every Vapi request is refused (Vapi reports pipeline-error-custom-llm-401-unauthorized).");
    return false;
  }
  const expected = Buffer.from(secret);
  const ok = candidates.some((c) => {
    if (!c) return false;
    const given = Buffer.from(c);
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
  if (!ok) {
    // Lengths only: enough to spot a wrong or truncated value, nothing that reveals it.
    warnOnce(
      `Vapi secret mismatch: request carried ${candidates.filter(Boolean).map((c) => `${c.length} chars`).join(" / ") || "no secret"}, ` +
        `VAPI_WEBHOOK_SECRET is ${secret.length} chars. It must equal the key of Vapi's custom-llm credential.`,
    );
  }
  return ok;
}

let warned = 0;
function warnOnce(message: string) {
  // At most a few lines, so a misconfigured deploy doesn't flood the logs.
  if (warned++ < 3) console.warn(`[vapi] ${message}`);
}

export function channelOf(call: VapiCall | undefined): Channel {
  return call?.type && /phone/i.test(call.type) ? "phone" : "web_voice";
}

/**
 * What the caller said since the agent last spoke. Vapi sends the whole
 * history every time; the new utterance is every user message after the
 * last assistant message (usually one, occasionally two if speech was split).
 */
export function newUserText(messages: VapiMessage[]): string {
  const out: string[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "assistant") break;
    if (m.role === "user" && m.content?.trim()) out.unshift(m.content.trim());
  }
  return out.join(" ");
}

/** Earlier turns as plain text, for rebuilding a session that was lost mid-call. */
export function historyPrimer(messages: VapiMessage[]): string | null {
  let lastAssistant = -1;
  messages.forEach((m, i) => {
    if (m.role === "assistant") lastAssistant = i;
  });
  const earlier = messages
    .slice(0, lastAssistant + 1)
    .filter((m) => (m.role === "user" || m.role === "assistant") && m.content?.trim())
    .map((m) => `${m.role === "user" ? "Caller" : "Agent"}: ${m.content!.trim()}`);
  // The greeting alone is not history worth replaying.
  return earlier.length > 1 ? earlier.join("\n") : null;
}

/** One OpenAI-style streaming chunk, as Vapi's Custom LLM integration expects. */
export function sseChunk(id: string, delta: Record<string, unknown>, finishReason: string | null = null): string {
  return `data: ${JSON.stringify({
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "relaypay-support-agent",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;
}
