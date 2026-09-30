/**
 * The eval scenarios are data, so they can rot: a renamed tool, a re-slugged
 * knowledge-base chunk, or a category the enums no longer have would make a
 * check fail for the wrong reason. This keeps them honest, offline.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ANSWER_PATHS, ESCALATION_CATEGORIES, TICKET_CATEGORIES, AGENT_EVENT_TYPES, SYSTEM_EVENT_TYPES } from "../packages/shared/src/enums.ts";
import { TOOL_NAMES } from "../apps/mcp-server/src/server.ts";
import { loadKbChunks, ROOT } from "../scripts/lib/seed-data.ts";
import { runCheck, type Check, type Records } from "../scripts/lib/eval-checks.ts";

type Scenario = { id: string; name: string; expected: string; turns: string[]; checks: Check[] };
const scenarios: Scenario[] = JSON.parse(fs.readFileSync(path.join(ROOT, "data/eval-scenarios.json"), "utf8")).scenarios;
const chunkIds = new Set(loadKbChunks().map((c) => c.id));

test("covers the eight PRD text scenarios", () => {
  for (const id of ["S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8"]) {
    assert.ok(scenarios.some((s) => s.id === id), `missing ${id}`);
  }
  assert.equal(new Set(scenarios.map((s) => s.id)).size, scenarios.length, "duplicate scenario ids");
});

test("every check refers to things that exist", () => {
  for (const s of scenarios) {
    assert.ok(s.turns.length > 0 && s.expected, `${s.id} needs turns and an expected behaviour`);
    for (const c of s.checks) {
      const where = `${s.id} ${c.type}`;
      if (c.type === "tool_called" || c.type === "tool_not_called") assert.ok((TOOL_NAMES as readonly string[]).includes(c.tool), `${where}: unknown tool ${c.tool}`);
      if (c.type === "retrieval_hit") for (const id of [c.chunk].flat()) assert.ok(chunkIds.has(id), `${where}: unknown chunk ${id}`);
      if (c.type === "path") for (const p of c.in) assert.ok((ANSWER_PATHS as readonly string[]).includes(p), `${where}: unknown path ${p}`);
      if (c.type === "path" || c.type === "reply_matches") assert.ok(c.turn >= 1 && c.turn <= s.turns.length, `${where}: turn ${c.turn} out of range`);
      if (c.type === "ticket_created") for (const k of c.category ?? []) assert.ok((TICKET_CATEGORIES as readonly string[]).includes(k), `${where}: ${k}`);
      if (c.type === "escalation_created") for (const k of c.category ?? []) assert.ok((ESCALATION_CATEGORIES as readonly string[]).includes(k), `${where}: ${k}`);
      if (c.type === "event_logged") assert.ok([...AGENT_EVENT_TYPES, ...SYSTEM_EVENT_TYPES].includes(c.event_type as never), `${where}: ${c.event_type}`);
      if (c.type === "reply_matches" || c.type === "reply_not_matches") assert.doesNotThrow(() => new RegExp(c.pattern, "i"), where);
    }
  }
});

const good: Records = {
  turns: [{ turn_index: 1, user_transcript: "fees?", assistant_response: "Fees vary by corridor and are shown before you confirm.", answer_type: "answer", tools_used: ["search_knowledge_base"], status: "ok" }],
  toolCalls: [{ tool_name: "search_knowledge_base", status: "success" }],
  retrievals: [{ chunk_ids: ["faq-how-does-relaypay-charge-fees"], matched: true }],
  tickets: [],
  escalations: [],
  events: [],
};

test("S1's deterministic checks pass on a good conversation", () => {
  const s1 = scenarios.find((s) => s.id === "S1")!;
  for (const c of s1.checks) {
    if (c.type === "judge") continue;
    const r = runCheck(c, good);
    assert.ok(r.passed, `${r.check}: ${r.detail}`);
  }
});

test("S1's fee check catches an invented fee", () => {
  const s1 = scenarios.find((s) => s.id === "S1")!;
  const bad = { ...good, turns: [{ ...good.turns[0], assistant_response: "It's a flat 1.5% fee, shown before you confirm." }] };
  const feeCheck = s1.checks.find((c) => c.type === "reply_not_matches")!;
  assert.equal(runCheck(feeCheck as Exclude<Check, { type: "judge" }>, bad).passed, false);
});

test("S8's decline check accepts the common ways of saying it", () => {
  const s8 = scenarios.find((s) => s.id === "S8")!;
  const check = s8.checks.find((c) => c.type === "reply_matches") as Exclude<Check, { type: "judge" }>;
  for (const reply of ["I can't guarantee that time.", "Arrival times aren't something we can guarantee; they're not guaranteed.", "We're unable to guarantee a specific time."]) {
    const r = runCheck(check, { ...good, turns: [{ ...good.turns[0], assistant_response: reply }] });
    assert.ok(r.passed, `should accept: ${reply}`);
  }
});

test("the Vapi end-call phrase is the one the voice-style skill tells the agent to say", () => {
  const assistant = JSON.parse(fs.readFileSync(path.join(ROOT, "vapi/assistant.template.json"), "utf8"));
  const skill = fs.readFileSync(path.join(ROOT, "apps/web/.claude/skills/voice-style/SKILL.md"), "utf8").toLowerCase();
  assert.ok(assistant.endCallPhrases?.length, "assistant has endCallPhrases");
  for (const phrase of assistant.endCallPhrases as string[]) assert.ok(skill.includes(phrase.toLowerCase()), `skill never says "${phrase}"`);
});
