/**
 * The speech filter: the control tag never reaches the caller, however the
 * stream splits it, and redaction catches what the MCP server's safe
 * summaries should already have kept out.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { SpeechFilter, emailsSpokenBy, parseControlTag } from "../apps/web/src/agent/speech-filter.ts";

function run(chunks: string[], emails: string[] = []) {
  const f = new SpeechFilter(emails);
  let out = "";
  for (const c of chunks) out += f.push(c);
  out += f.flush();
  return { out, f };
}

test("the tag is stripped and parsed", () => {
  const { out, f } = run(["Fees vary by corridor. ", "[[path=answer|conf=high|note=fee policy]]"]);
  assert.equal(out.trim(), "Fees vary by corridor.");
  assert.deepEqual(f.tag, { path: "answer", confidence: "high", note: "fee policy" });
});

test("a tag split across every possible chunk boundary never leaks", () => {
  const text = "Your ticket is open. [[path=answer|conf=medium|note=ticket opened]]";
  for (let i = 1; i < text.length; i++) {
    const { out, f } = run([text.slice(0, i), text.slice(i)]);
    assert.ok(!out.includes("[") && !out.includes("path="), `split at ${i} leaked: ${out}`);
    assert.equal(f.tag?.path, "answer");
  }
  const { out } = run([...text]);
  assert.equal(out.trim(), "Your ticket is open.");
});

test("text is released a sentence at a time, before the turn ends", () => {
  const f = new SpeechFilter();
  assert.equal(f.push("Let me check that"), "");
  assert.equal(f.push(" for you. Then"), "Let me check that for you.");
  assert.equal(f.boundary(), " Then ");
});

test("an unterminated tag is dropped, not spoken", () => {
  const { out, f } = run(["All set. [[path=clarify|conf=lo"]);
  assert.equal(out.trim(), "All set.");
  assert.equal(f.tag?.path, "clarify");
});

test("a malformed tag is recorded as malformed", () => {
  const { f } = run(["Okay. [[whatever]]"]);
  assert.equal(f.tag, null);
  assert.equal(f.malformedTag, true);
});

test("an invalid path is rejected; a missing confidence defaults to medium", () => {
  assert.equal(parseControlTag("path=maybe|conf=high"), null);
  assert.equal(parseControlTag("path=decline")?.confidence, "medium");
});

test("emails the caller did not say are redacted; their own is kept", () => {
  const { out, f } = run(["I'll email amara@lagosledger.example and efua@accrastack.example. "], ["amara@lagosledger.example"]);
  assert.match(out, /amara@lagosledger\.example/);
  assert.doesNotMatch(out, /efua@/);
  assert.deepEqual(f.redactions, ["email"]);
});

test("an email split across chunks is still redacted", () => {
  const { out } = run(["Contact efua@accra", "stack.example today. "]);
  assert.doesNotMatch(out, /efua@/);
});

test("customer IDs and markdown are removed", () => {
  const { out } = run(["**Account** CUS-1003 is noted.\n- item one\n"]);
  assert.doesNotMatch(out, /CUS-1003|\*\*|^- /m);
});

test("spoken emails in transcripts are recognised as the caller's", () => {
  assert.deepEqual(emailsSpokenBy(["it's efua at accrastack dot example thanks"]), ["efua@accrastack.example"]);
  assert.deepEqual(emailsSpokenBy(["amara@lagosledger.example"]), ["amara@lagosledger.example"]);
});
