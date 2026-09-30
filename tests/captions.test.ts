/**
 * Voice-page captions: what the caller said stays up through their pauses,
 * and each side's line is replaced only when that side starts a new turn.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { captionsReducer, fromVapiMessage, initialCaptions, type TranscriptEvent } from "../apps/web/src/lib/captions.ts";

const run = (events: TranscriptEvent[]) => events.reduce(captionsReducer, initialCaptions);
const u = (text: string, final = true): TranscriptEvent => ({ role: "user", final, text });
const a = (text: string, final = true): TranscriptEvent => ({ role: "agent", final, text });

test("a pause mid-sentence keeps the start of what the caller said", () => {
  const c = run([u("Hi.", false), u("Hi."), u("Are exchange rates", false), u("Are exchange rates fixed?")]);
  assert.equal(c.user.finals, "Hi. Are exchange rates fixed?");
  assert.equal(c.user.partial, "");
});

test("the partial is shown after the finished segments", () => {
  const c = run([u("Can you check"), u("transaction nine", false)]);
  assert.deepEqual(c.user, { finals: "Can you check", partial: "transaction nine" });
});

test("the caller's words stay visible while the agent answers", () => {
  const c = run([u("Are exchange rates fixed?"), a("Exchange rates aren't fixed.", false)]);
  assert.equal(c.user.finals, "Are exchange rates fixed?");
  assert.equal(c.agent.partial, "Exchange rates aren't fixed.");
});

test("the agent's whole reply accumulates, and stays up until its next reply", () => {
  let c = run([u("Fees?"), a("Fees vary by corridor."), a("They're shown before you confirm.")]);
  assert.equal(c.agent.finals, "Fees vary by corridor. They're shown before you confirm.");
  c = captionsReducer(c, u("Thanks", false));
  assert.equal(c.agent.finals, "Fees vary by corridor. They're shown before you confirm.", "agent line survives the caller's next turn");
  assert.deepEqual(c.user, { finals: "", partial: "Thanks" }, "caller's new turn replaces their old line");
  c = captionsReducer(captionsReducer(c, u("Thanks.")), a("You're welcome."));
  assert.equal(c.agent.finals, "You're welcome.", "agent's new turn replaces its old reply");
});

test("the greeting shows before the caller has said anything", () => {
  const c = run([a("Hi, you've reached RelayPay support.")]);
  assert.equal(c.agent.finals, "Hi, you've reached RelayPay support.");
  assert.equal(c.user.finals, "");
});

test("only Vapi transcript messages become caption events", () => {
  assert.deepEqual(fromVapiMessage({ type: "transcript", role: "assistant", transcriptType: "final", transcript: "Hi" }), { role: "agent", final: true, text: "Hi" });
  assert.equal(fromVapiMessage({ type: "speech-update", role: "user" }), null);
  assert.equal(fromVapiMessage({ type: "transcript", role: "system", transcript: "x" }), null);
});
