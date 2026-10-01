/**
 * Runs the test scenarios through the real agent pipeline and records the
 * results in Supabase (eval_runs, evaluations).
 *
 *   npm run eval                        all scenarios, AGENT_MODEL (default Haiku 4.5)
 *   npm run eval -- --only S1,S5        a subset
 *   npm run eval -- --repeat 3          each scenario three times (flakiness)
 *   npm run eval -- --model claude-sonnet-5
 *   npm run eval -- --no-judge          deterministic checks only (cheapest)
 *   npm run eval -- --voice             record scenario 9 from the latest voice call
 *
 * Each scenario is a real conversation (channel 'eval') through runTurn, the
 * same code Vapi calls, so its records are exactly what a call produces. The
 * MCP server must be reachable at MCP_URL; a local one is started if needed.
 *
 * Cost: roughly $0.01-0.03 per scenario on Haiku 4.5, plus about $0.005 per
 * judged scenario on Sonnet 5. The run prints its own total.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { loadEnv, requireEnv } from "../packages/shared/src/env.ts";
import { supabaseAdmin } from "../packages/shared/src/supabase.ts";
import { ROOT } from "./lib/seed-data.ts";
import { runCheck, type Check, type CheckResult, type Records } from "./lib/eval-checks.ts";

loadEnv();
requireEnv("SUPABASE_SERVICE_ROLE_KEY", "ANTHROPIC_API_KEY", "MCP_URL", "MCP_AUTH_TOKEN");

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
if (opt("model")) process.env.AGENT_MODEL = opt("model");

// Imported after the model override so the agent picks it up.
const { runTurn, endCall } = await import("../apps/web/src/agent/turns.ts");
const { createConversation } = await import("../apps/web/src/agent/conversations.ts");
const { DEFAULT_MODEL } = await import("../apps/web/src/agent/support-session.ts");

const MODEL = process.env.AGENT_MODEL ?? DEFAULT_MODEL;
const JUDGE_MODEL = process.env.JUDGE_MODEL ?? "claude-sonnet-5";
const db = supabaseAdmin();

type Scenario = { id: string; name: string; expected: string; turns: string[]; checks: Check[] };
const all: Scenario[] = JSON.parse(fs.readFileSync(path.join(ROOT, "data/eval-scenarios.json"), "utf8")).scenarios;
const only = opt("only")?.split(",");
const scenarios = only ? all.filter((s) => only.includes(s.id)) : all;
const repeat = Math.max(1, Number(opt("repeat") ?? 1));

// ------------------------------------------------------------ MCP server ---
async function ensureMcp(): Promise<ChildProcess | null> {
  const health = new URL("/health", process.env.MCP_URL!).toString();
  const up = await fetch(health).then((r) => r.ok).catch(() => false);
  if (up) return null;
  const host = new URL(process.env.MCP_URL!).hostname;
  if (host !== "localhost" && host !== "127.0.0.1") throw new Error(`MCP server at ${process.env.MCP_URL} is not reachable`);
  console.log("starting a local MCP server for this run...");
  const child = spawn("npx", ["tsx", "apps/mcp-server/src/http.ts"], {
    cwd: ROOT,
    env: { ...process.env, MCP_PORT: new URL(process.env.MCP_URL!).port || "8788" },
    stdio: ["ignore", "ignore", "inherit"],
  });
  for (let i = 0; i < 40; i++) {
    if (await fetch(health).then((r) => r.ok).catch(() => false)) return child;
    await new Promise((r) => setTimeout(r, 250));
  }
  child.kill();
  throw new Error("local MCP server did not start");
}

// --------------------------------------------------------------- records ---
async function loadRecords(conversationId: string): Promise<Records> {
  const q = (table: string, cols: string, order = "created_at") =>
    db.from(table).select(cols).eq("conversation_id", conversationId).order(order);
  const [turns, toolCalls, retrievals, tickets, escalations, events] = await Promise.all([
    q("conversation_turns", "turn_index, user_transcript, assistant_response, answer_type, tools_used, status", "turn_index"),
    q("tool_calls", "tool_name, status"),
    q("retrieval_logs", "chunk_ids, matched"),
    q("support_tickets", "ticket_id, category, priority"),
    q("escalations", "escalation_id, category, call_booked, user_email"),
    q("conversation_events", "event_type, source"),
  ]);
  return {
    turns: (turns.data ?? []) as unknown as Records["turns"],
    toolCalls: (toolCalls.data ?? []) as unknown as Records["toolCalls"],
    retrievals: (retrievals.data ?? []) as unknown as Records["retrievals"],
    tickets: (tickets.data ?? []) as unknown as Records["tickets"],
    escalations: (escalations.data ?? []) as unknown as Records["escalations"],
    events: (events.data ?? []) as unknown as Records["events"],
  };
}

// ----------------------------------------------------------------- judge ---
const Verdicts = z.object({
  verdicts: z.array(z.object({ criterion_index: z.number().int(), passed: z.boolean(), reason: z.string() })),
});

async function judge(criteria: string[], r: Records, conversationId: string): Promise<{ results: CheckResult[]; costUsd: number }> {
  if (criteria.length === 0 || flag("no-judge")) return { results: [], costUsd: 0 };
  const { data: chunks } = await db
    .from("kb_chunks")
    .select("id, content")
    .in("id", [...new Set(r.retrievals.flatMap((x) => x.chunk_ids))]);
  const transcript = r.turns.map((t) => `Caller: ${t.user_transcript}\nAgent: ${t.assistant_response ?? ""}`).join("\n");
  const { data: lookups } = await db
    .from("tool_calls")
    .select("tool_name, status, result_summary")
    .eq("conversation_id", conversationId)
    .like("tool_name", "lookup_%");
  const client = new Anthropic();
  const res = await client.messages.parse({
    model: JUDGE_MODEL,
    max_tokens: 2000,
    output_config: { format: zodOutputFormat(Verdicts), effort: "medium" },
    system:
      "You grade a voice customer-support agent for RelayPay against specific criteria. Judge only what the agent said in the transcript. " +
      "Passages are the approved knowledge the agent retrieved; a product or policy statement not supported by them counts as invented. " +
      "Facts about the caller's own account, transaction or payout may also come from the account lookups listed (the agent reads a customer-safe summary of the record); those are not invented. Be strict and literal. " +
      "Account lookups made: " + JSON.stringify(lookups ?? []) + ". " +
      "Records note: " + JSON.stringify({ tickets: r.tickets, escalations: r.escalations }),
    messages: [
      {
        role: "user",
        content:
          `<passages>\n${(chunks ?? []).map((c) => `[${c.id}] ${c.content}`).join("\n\n") || "(none retrieved)"}\n</passages>\n\n` +
          `<transcript conversation="${conversationId}">\n${transcript}\n</transcript>\n\n` +
          `Criteria:\n${criteria.map((c, i) => `${i}. ${c}`).join("\n")}\n\nReturn one verdict per criterion.`,
      },
    ],
  });
  const parsed = res.parsed_output;
  // Sonnet 5: $2 / $10 per million tokens.
  const costUsd = (res.usage.input_tokens * 2 + res.usage.output_tokens * 10) / 1_000_000;
  const results = criteria.map((criterion, i) => {
    const v = parsed?.verdicts.find((x) => x.criterion_index === i);
    return { check: `judge: ${criterion}`, passed: Boolean(v?.passed), detail: v?.reason ?? "judge returned no verdict" };
  });
  return { results, costUsd };
}

// ------------------------------------------------------------------- run ---
async function runScenario(s: Scenario, runId: string, repeatIndex: number) {
  const conversationId = await createConversation({
    channel: "eval",
    model: MODEL,
    evalRunId: runId,
    metadata: { scenario: s.id, repeat: repeatIndex },
  });
  let agentCost = 0;
  const transcript: string[] = [];
  for (const userText of s.turns) {
    const turn = await runTurn({ conversationId, channel: "eval", userText, onText: () => {} });
    agentCost += turn.costUsd;
    transcript.push(`  caller: ${userText}\n  agent [${turn.path}${turn.toolsUsed.length ? `; ${turn.toolsUsed.join(",")}` : ""}]: ${turn.text}`);
  }
  await endCall(conversationId, "eval-complete");

  const records = await loadRecords(conversationId);
  const deterministic = s.checks.filter((c): c is Exclude<Check, { type: "judge" }> => c.type !== "judge").map((c) => runCheck(c, records));
  const judged = await judge(s.checks.filter((c) => c.type === "judge").map((c) => (c as { criterion: string }).criterion), records, conversationId);
  const results = [...deterministic, ...judged.results];
  const passed = results.every((r) => r.passed);
  const failures = results.filter((r) => !r.passed);

  const actual = records.turns.map((t) => `[${t.answer_type}] ${t.assistant_response ?? ""}`).join(" | ");
  const { error } = await db.from("evaluations").insert({
    eval_run_id: runId,
    scenario_id: s.id,
    scenario_name: s.name,
    repeat_index: repeatIndex,
    conversation_id: conversationId,
    expected_behavior: s.expected,
    actual_behavior: actual.slice(0, 4000),
    checks: results,
    passed,
    notes: failures.length ? failures.map((f) => `${f.check}: ${f.detail}`).join(" / ").slice(0, 2000) : null,
    model: MODEL,
    cost_usd: agentCost + judged.costUsd,
  });
  if (error) console.error(`could not store evaluation for ${s.id}: ${error.message}`);

  console.log(`\n${passed ? "PASS" : "FAIL"}  ${s.id} ${s.name}${repeat > 1 ? ` (#${repeatIndex + 1})` : ""}  $${(agentCost + judged.costUsd).toFixed(4)}`);
  console.log(transcript.join("\n"));
  for (const f of failures) console.log(`  ✗ ${f.check}\n      ${f.detail}`);
  return { passed, cost: agentCost + judged.costUsd };
}

async function recordVoiceScenario(runId: string) {
  const { data: conv } = await db
    .from("conversations")
    .select("id, channel, started_at")
    .in("channel", ["web_voice", "phone"])
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!conv) {
    console.log("no voice conversation found; make a call first");
    return { passed: false, cost: 0 };
  }
  const r = await loadRecords(conv.id);
  const results: CheckResult[] = [
    { check: "caller speech reached the agent", passed: r.turns.length > 0, detail: `${r.turns.length} turn(s)` },
    { check: "agent answered every turn", passed: r.turns.length > 0 && r.turns.every((t) => (t.assistant_response ?? "").length > 0), detail: "" },
    { check: "tool calls logged", passed: r.toolCalls.length > 0, detail: `${r.toolCalls.length} call(s)` },
  ];
  const passed = results.every((x) => x.passed);
  await db.from("evaluations").insert({
    eval_run_id: runId,
    scenario_id: "S9",
    scenario_name: "Voice flow",
    conversation_id: conv.id,
    expected_behavior: "Vapi captures speech, the backend agent responds, Vapi speaks the reply, Supabase logs the conversation and tool calls.",
    actual_behavior: r.turns.map((t) => `Caller: ${t.user_transcript} / Agent: ${t.assistant_response}`).join(" | ").slice(0, 4000),
    checks: results,
    passed,
    notes: `Latest ${conv.channel} conversation ${conv.id}. Spoken audio confirmed manually (see Loom).`,
    model: MODEL,
  });
  console.log(`${passed ? "PASS" : "FAIL"}  S9 Voice flow (conversation ${conv.id})`);
  return { passed, cost: 0 };
}

const gitSha = (() => {
  try {
    return execSync("git rev-parse --short HEAD", { cwd: ROOT }).toString().trim();
  } catch {
    return null;
  }
})();

const { data: run, error: runErr } = await db
  .from("eval_runs")
  .insert({ model: MODEL, git_sha: gitSha, notes: args.join(" ") || null })
  .select("id")
  .single();
if (runErr || !run) throw new Error(`could not create eval run: ${runErr?.message}`);
console.log(`eval run ${run.id}  model=${MODEL}  judge=${flag("no-judge") ? "off" : JUDGE_MODEL}  scenarios=${scenarios.length}x${repeat}`);

const mcp = await ensureMcp();
let passed = 0;
let total = 0;
let cost = 0;
try {
  if (flag("voice")) {
    const r = await recordVoiceScenario(run.id);
    total++;
    passed += r.passed ? 1 : 0;
  }
  for (const s of flag("voice") && !only ? [] : scenarios) {
    for (let i = 0; i < repeat; i++) {
      try {
        const r = await runScenario(s, run.id, i);
        total++;
        passed += r.passed ? 1 : 0;
        cost += r.cost;
      } catch (err) {
        total++;
        console.log(`\nERROR ${s.id}: ${err instanceof Error ? err.message : err}`);
      }
    }
  }
} finally {
  mcp?.kill();
  await db
    .from("eval_runs")
    .update({ finished_at: new Date().toISOString(), total, passed, cost_usd: Number(cost.toFixed(6)) })
    .eq("id", run.id);
}

console.log(`\n${passed}/${total} passed  ·  $${cost.toFixed(4)}  ·  run ${run.id}`);
process.exit(passed === total ? 0 : 1);
