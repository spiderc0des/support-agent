/**
 * Everything between the model's text and the caller's ears.
 *
 * 1. Control tag. Each reply ends with [[path=...|conf=...|note=...]] (skill
 *    rule R-ROUTE-5). It is held back from speech as soon as its opening
 *    "[[" appears, even when split across stream chunks, and parsed for the
 *    turn log.
 * 2. Sentences. Text is released one complete sentence at a time, so the
 *    redaction below always sees a whole email address, and TTS gets natural
 *    units.
 * 3. Redaction, the last line of defence behind the MCP server's safe
 *    summaries. It removes email addresses the caller did not say, customer
 *    IDs, and markdown that would be read aloud as symbols.
 */
import { ANSWER_PATHS, CONFIDENCE_LEVELS, type AnswerPath, type Confidence } from "@relaypay/shared/enums";

export type ControlTag = { path: AnswerPath; confidence: Confidence; note: string | null; end: boolean };

const TAG_RE = /\[\[\s*([^\]]*?)\s*\]\]/g;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const CUSTOMER_ID_RE = /\bCUS[\s-]?\d{3,}\b/gi;

export function parseControlTag(inner: string): ControlTag | null {
  const fields: Record<string, string> = {};
  for (const part of inner.split("|")) {
    const i = part.indexOf("=");
    if (i > 0) fields[part.slice(0, i).trim().toLowerCase()] = part.slice(i + 1).trim();
  }
  const path = fields.path as AnswerPath;
  const confidence = (fields.conf ?? fields.confidence) as Confidence;
  if (!(ANSWER_PATHS as readonly string[]).includes(path)) return null;
  return {
    path,
    confidence: (CONFIDENCE_LEVELS as readonly string[]).includes(confidence) ? confidence : "medium",
    note: fields.note ? fields.note.slice(0, 160) : null,
    end: /^(yes|true|1)$/i.test(fields.end ?? ""),
  };
}

export function redact(text: string, callerEmails: ReadonlySet<string>): { text: string; redactions: string[] } {
  const redactions: string[] = [];
  let out = text.replace(EMAIL_RE, (m) => {
    if (callerEmails.has(m.toLowerCase())) return m;
    redactions.push("email");
    return "the email on file";
  });
  out = out.replace(CUSTOMER_ID_RE, () => {
    redactions.push("customer_id");
    return "your account";
  });
  // Markdown and list syntax would be spoken as symbols.
  out = out
    .replace(/\*\*|__|`/g, "")
    .replace(/^\s*[-*•]\s+/gm, "")
    .replace(/^\s*#+\s+/gm, "");
  return { text: out, redactions };
}

/** Index just past the last sentence end in `s`, or 0 if there is none yet. */
function lastSentenceEnd(s: string): number {
  let end = 0;
  const re = /[.!?](?=\s)|\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) end = m.index + 1;
  return end;
}

export class SpeechFilter {
  private pending = "";
  private held = "";
  private holding = false;
  private readonly callerEmails: Set<string>;

  /** Everything released for speech, after redaction. */
  spoken = "";
  /** The last well-formed control tag seen in this turn. */
  tag: ControlTag | null = null;
  /** True if a tag-shaped block appeared but could not be parsed. */
  malformedTag = false;
  redactions: string[] = [];

  /**
   * When set, sentences carrying this phrase are dropped from speech. Used
   * for the end-call phrase when the caller has not said they are leaving:
   * Vapi hangs up the instant it hears the phrase, so a premature goodbye
   * (after an escalation, say) must never reach it.
   */
  private readonly blockedPhrase: RegExp | null;
  blockedPhraseRemoved = false;

  constructor(callerEmails: Iterable<string> = [], opts: { blockPhrase?: string } = {}) {
    this.callerEmails = new Set([...callerEmails].map((e) => e.toLowerCase()));
    const phrase = opts.blockPhrase?.replace(/\.$/, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    this.blockedPhrase = phrase ? new RegExp(`[^.!?]*\\b${phrase}\\b[^.!?]*[.!?]?\\s*`, "gi") : null;
  }

  /** Feed a text delta; returns text ready to speak now (possibly ""). */
  push(delta: string): string {
    for (const ch of delta) {
      if (this.holding) {
        this.held += ch;
        if (this.held.endsWith("]]")) this.closeTag();
        continue;
      }
      this.pending += ch;
      if (this.pending.endsWith("[[")) {
        this.pending = this.pending.slice(0, -2);
        this.holding = true;
        this.held = "[[";
      }
    }
    return this.release(false);
  }

  /** A text block ended (for example, just before a tool call): release what is complete. */
  boundary(): string {
    if (this.pending && !/\s$/.test(this.pending)) this.pending += " ";
    return this.release(true);
  }

  /** The turn is over: release everything, and settle any unterminated tag. */
  flush(): string {
    if (this.holding) {
      // A tag that never closed is dropped from speech, not read out.
      const inner = this.held.replace(/^\[\[/, "");
      const parsed = parseControlTag(inner);
      if (parsed) this.tag = parsed;
      else this.malformedTag = true;
      this.holding = false;
      this.held = "";
    }
    return this.release(true);
  }

  private closeTag() {
    const inner = this.held.slice(2, -2);
    const parsed = parseControlTag(inner);
    if (parsed) this.tag = parsed;
    else this.malformedTag = true;
    this.holding = false;
    this.held = "";
  }

  private release(all: boolean): string {
    // A lone "[" at the end may be the first half of "[[": keep it back.
    const keep = !all && this.pending.endsWith("[") ? 1 : 0;
    const body = this.pending.slice(0, this.pending.length - keep);
    const cut = all ? body.length : lastSentenceEnd(body);
    if (cut === 0) return "";
    const ready = body.slice(0, cut);
    this.pending = this.pending.slice(cut);
    let speakable = ready.replace(TAG_RE, "");
    if (this.blockedPhrase && this.blockedPhrase.test(speakable)) {
      this.blockedPhrase.lastIndex = 0;
      speakable = speakable.replace(this.blockedPhrase, "");
      this.blockedPhraseRemoved = true;
    }
    const { text: redacted, redactions } = redact(speakable, this.callerEmails);
    // Where the pre-tool sentence meets the post-tool text, don't double the space.
    const text = /\s$/.test(this.spoken) ? redacted.replace(/^\s+/, "") : redacted;
    this.redactions.push(...redactions);
    this.spoken += text;
    return text;
  }
}

/** Emails the caller has said in the conversation so far: the only ones that may be read back. */
export function emailsSpokenBy(transcripts: string[]): string[] {
  const out = new Set<string>();
  for (const t of transcripts) {
    for (const m of t.matchAll(EMAIL_RE)) out.add(m[0].toLowerCase());
    // Spoken form: "amara at lagosledger dot example"
    const spoken = t.toLowerCase().match(/([a-z0-9._-]+)\s+at\s+([a-z0-9-]+(?:\s+dot\s+[a-z0-9-]+)+)/g) ?? [];
    for (const s of spoken) out.add(s.replace(/\s+at\s+/, "@").replace(/\s+dot\s+/g, "."));
  }
  return [...out];
}
