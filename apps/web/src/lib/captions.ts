/**
 * Live captions for the voice page, one line per speaker.
 *
 * Speech-to-text arrives in segments: a stream of "partial" guesses, then a
 * "final" for each stretch of speech. A caller who pauses mid-sentence
 * produces several finals in one turn, and showing only the latest one made
 * the start of what they said vanish. So:
 *
 *   - within a turn, finals accumulate and the current partial follows them;
 *   - a speaker's line is replaced only when that speaker starts a NEW turn,
 *     that is, when they speak again after the other side has spoken.
 *
 * The caller's words stay up while the agent answers, and the agent's answer
 * stays up until its next answer begins.
 */
export type CaptionLine = { finals: string; partial: string };
export type Captions = { user: CaptionLine; agent: CaptionLine; lastSpeaker: "user" | "agent" | null };
export type TranscriptEvent = { role: "user" | "agent"; final: boolean; text: string };

const EMPTY: CaptionLine = { finals: "", partial: "" };
export const initialCaptions: Captions = { user: EMPTY, agent: EMPTY, lastSpeaker: null };

function join(a: string, b: string): string {
  const x = a.trim();
  const y = b.trim();
  return x && y ? `${x} ${y}` : x || y;
}

export function captionsReducer(state: Captions, ev: TranscriptEvent): Captions {
  const text = ev.text.trim();
  if (!text) return state;
  const key = ev.role;
  // Speaking again after the other side did starts a new turn: clear this line.
  const current = state.lastSpeaker === key || state.lastSpeaker === null ? state[key] : EMPTY;
  const line: CaptionLine = ev.final ? { finals: join(current.finals, text), partial: "" } : { finals: current.finals, partial: text };
  return { ...state, [key]: line, lastSpeaker: key };
}

/** Vapi's transcript message, normalised. Anything else returns null. */
export function fromVapiMessage(m: { type?: string; role?: string; transcriptType?: string; transcript?: string }): TranscriptEvent | null {
  if (m.type !== "transcript" || !m.transcript) return null;
  if (m.role !== "user" && m.role !== "assistant") return null;
  return { role: m.role === "user" ? "user" : "agent", final: m.transcriptType === "final", text: m.transcript };
}
