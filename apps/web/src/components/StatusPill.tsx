/**
 * One small label for every status in the console. Tone comes from what the
 * status means for the reader (needs attention, in hand, done), never from
 * its position in a list. Always text, so colour is never the only signal.
 */
const TONE: Record<string, "attention" | "progress" | "done" | "neutral"> = {
  // tickets and escalations
  open: "attention",
  in_progress: "progress",
  closed: "done",
  // conversations
  active: "progress",
  escalated: "attention",
  ticketed: "progress",
  resolved: "done",
  abandoned: "neutral",
  error: "attention",
  // priorities
  high: "attention",
  medium: "progress",
  low: "neutral",
  // answer paths
  answer: "done",
  clarify: "progress",
  escalate: "attention",
  decline: "neutral",
  // tool calls
  success: "done",
  not_found: "neutral",
  denied: "attention",
  invalid_input: "attention",
  // evals
  pass: "done",
  fail: "attention",
};

export function StatusPill({ value, label }: { value: string | null | undefined; label?: string }) {
  if (!value) return null;
  return <span className={`pill ${TONE[value] ?? "neutral"}`}>{label ?? value.replace(/_/g, " ")}</span>;
}
