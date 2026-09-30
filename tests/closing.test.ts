/**
 * The call must hang up after the agent's goodbye, however it words it.
 * Cases are from real calls where it did not.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { END_CALL_PHRASE, endCallSuffix } from "../apps/web/src/agent/closing.ts";
import { parseControlTag } from "../apps/web/src/agent/speech-filter.ts";
import { ROOT } from "../scripts/lib/seed-data.ts";

test("paraphrased goodbyes from real calls get the end-call phrase", () => {
  for (const [userText, replyText] of [
    ["Hi. Bye.", "Goodbye, and thanks for calling RelayPay."],
    ["Sure. I want to end the call. Thanks. Bye bye.", "You're welcome. Goodbye."],
    ["No. That's all for now.", "Great. Thanks for calling RelayPay. Have a great day."],
  ]) {
    assert.equal(endCallSuffix({ tagEnd: false, userText, replyText }), ` ${END_CALL_PHRASE}`, `${userText} -> ${replyText}`);
  }
});

test("a tagged closing always ends the call", () => {
  assert.equal(endCallSuffix({ tagEnd: true, userText: "thanks", replyText: "Thanks for calling." }), ` ${END_CALL_PHRASE}`);
});

test("nothing is added when the phrase is already there", () => {
  assert.equal(endCallSuffix({ tagEnd: true, userText: "bye", replyText: "Thank you for calling. Goodbye from RelayPay." }), "");
});

test("an ordinary turn is never ended", () => {
  assert.equal(endCallSuffix({ tagEnd: false, userText: "Are exchange rates fixed?", replyText: "No, they fluctuate." }), "");
  // The caller wraps up, but the agent asks to finish an escalation first: keep the call open.
  assert.equal(endCallSuffix({ tagEnd: false, userText: "That's all, bye", replyText: "Before you go, can I take your email so a specialist can follow up?" }), "");
});

test("the control tag carries end=yes", () => {
  assert.equal(parseControlTag("path=answer|conf=high|note=done|end=yes")?.end, true);
  assert.equal(parseControlTag("path=answer|conf=high")?.end, false);
});

test("the phrase appended is one Vapi hangs up on", () => {
  const assistant = JSON.parse(fs.readFileSync(path.join(ROOT, "vapi/assistant.template.json"), "utf8"));
  const phrases = (assistant.endCallPhrases as string[]).map((p) => p.toLowerCase());
  assert.ok(phrases.some((p) => END_CALL_PHRASE.toLowerCase().includes(p)));
});
