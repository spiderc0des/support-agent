/**
 * Ending the call when the caller is done.
 *
 * Vapi hangs up when the assistant speaks one of its endCallPhrases
 * (vapi/assistant.template.json). The skill (R-VOICE-8) tells the agent to
 * end its closing line with that exact phrase, but a model paraphrases:
 * "Goodbye, and thanks for calling RelayPay." left a real caller on an open
 * line until the silence timeout. So the phrase is guaranteed here, in code:
 * when a reply closes the call and the phrase is missing, it is appended.
 *
 * A reply closes the call when the agent tags it end=yes, or, as a backstop
 * for a missing tag, when the caller said goodbye and the agent said goodbye
 * back.
 */
export const END_CALL_PHRASE = "Goodbye from RelayPay.";

const CALLER_BYE = /\b(bye|bye[- ]bye|goodbye|good night|that'?s (all|everything)|i'?m (done|good|all set)|end (the|this) call|hang up)\b/i;
const AGENT_BYE = /\b(goodbye|bye|take care|have a (good|great|nice) (day|one|evening))\b/i;

export function callerIsLeaving(userText: string): boolean {
  return CALLER_BYE.test(userText);
}

export function isClosingReply(opts: { tagEnd: boolean | undefined; userText: string; replyText: string }): boolean {
  if (opts.tagEnd) return true;
  return callerIsLeaving(opts.userText) && AGENT_BYE.test(opts.replyText);
}

/** The text to add so Vapi hangs up after this reply, or "" if none is needed. */
export function endCallSuffix(opts: { tagEnd: boolean | undefined; userText: string; replyText: string }): string {
  if (!isClosingReply(opts)) return "";
  if (opts.replyText.toLowerCase().includes(END_CALL_PHRASE.toLowerCase().replace(/\.$/, ""))) return "";
  return `${/\s$/.test(opts.replyText) || !opts.replyText ? "" : " "}${END_CALL_PHRASE}`;
}
