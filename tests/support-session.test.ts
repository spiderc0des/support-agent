/**
 * SupportSession against a fake Agent SDK: the turn lifecycle a live call
 * depends on, without a model or a key.
 *
 * Covers what is hard to see on a real call: speech released before tools
 * finish, per-turn cost from the SDK's cumulative total, the tool-call cap,
 * and barge-in, whether or not the SDK ever reports the interrupted turn.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { SupportSession } from "../apps/web/src/agent/support-session.ts";

type Step = { kind: "text"; text: string } | { kind: "tool"; name: string } | { kind: "stop" } | { kind: "wait"; ms: number };
type Script = { steps: Step[]; cumulativeCost: number; hang?: boolean; resultOnInterrupt?: boolean; lateResultMs?: number };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A stand-in for the SDK's query(): one script per user message. */
function fakeQuery(scripts: Script[]) {
  return ((params: { prompt: AsyncIterable<unknown> }) => {
    const out: unknown[] = [];
    let wake: (() => void) | null = null;
    let interrupted: (() => void) | null = null;
    const emit = (m: unknown) => {
      out.push(m);
      wake?.();
    };
    const result = (cost: number, subtype = "success") =>
      emit({ type: "result", subtype, total_cost_usd: cost, usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 5000, cache_creation_input_tokens: 0 } });

    void (async () => {
      let i = 0;
      for await (const _msg of params.prompt) {
        // Like the real SDK: init comes only after the first user message.
        if (i === 0) emit({ type: "system", subtype: "init" });
        const s = scripts[i++];
        for (const step of s.steps) {
          if (step.kind === "text") emit({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", delta: { type: "text_delta", text: step.text } } });
          if (step.kind === "stop") emit({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_stop" } });
          if (step.kind === "tool") emit({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "tool_use", name: `mcp__relaypay__${step.name}` }] } });
          if (step.kind === "wait") await sleep(step.ms);
        }
        if (s.hang) {
          await new Promise<void>((r) => (interrupted = r));
          if (s.resultOnInterrupt) result(s.cumulativeCost, "error_during_execution");
          else if (s.lateResultMs) setTimeout(() => result(s.cumulativeCost, "error_during_execution"), s.lateResultMs);
          continue;
        }
        result(s.cumulativeCost);
      }
    })();

    return {
      async *[Symbol.asyncIterator]() {
        while (true) {
          if (out.length) {
            yield out.shift();
            continue;
          }
          await new Promise<void>((r) => (wake = r));
          wake = null;
        }
      },
      interrupt: async () => {
        interrupted?.();
      },
      close: () => {},
    };
  }) as never;
}

function session(scripts: Script[], extra: Record<string, unknown> = {}) {
  return new SupportSession({
    conversationId: "00000000-0000-0000-0000-000000000001",
    channel: "eval",
    mcpUrl: "http://unused",
    mcpToken: "unused",
    systemPrompt: "test",
    queryFn: fakeQuery(scripts),
    interruptGraceMs: 100,
    ...extra,
  });
}

test("a turn streams speech, parses the tag, and records its own cost", async () => {
  const s = session([
    { cumulativeCost: 0.01, steps: [{ kind: "text", text: "Let me check that for you." }, { kind: "stop" }, { kind: "tool", name: "lookup_transaction" }, { kind: "text", text: " It is processing. [[path=answer|conf=high|note=txn]]" }] },
    { cumulativeCost: 0.025, steps: [{ kind: "text", text: "Anything else? [[path=clarify|conf=medium]]" }] },
  ]);
  const chunks: string[] = [];
  const r1 = await s.sendTurn("check TXN-9001", (t) => chunks.push(t));
  assert.equal(chunks[0].trim(), "Let me check that for you.", "the filler is released before the tool result");
  assert.equal(r1.text, "Let me check that for you. It is processing.");
  assert.equal(r1.tag?.path, "answer");
  assert.deepEqual(r1.toolsUsed, ["lookup_transaction"]);
  assert.equal(r1.costUsd, 0.01);
  assert.equal(r1.usage.cacheRead, 5000);

  const r2 = await s.sendTurn("no", () => {});
  assert.equal(r2.costUsd, 0.015, "cost is the difference from the cumulative total");
  assert.equal(r2.tag?.path, "clarify");
  s.close();
});

test("barge-in: the interrupted turn settles, and the next turn runs", async () => {
  const s = session([
    { cumulativeCost: 0.01, hang: true, resultOnInterrupt: true, steps: [{ kind: "text", text: "RelayPay supports many corridors. " }] },
    { cumulativeCost: 0.02, steps: [{ kind: "text", text: "Sure. [[path=answer|conf=high]]" }] },
  ]);
  const first = s.sendTurn("tell me everything", () => {});
  await sleep(20);
  await s.interrupt();
  const r1 = await first;
  assert.equal(r1.status, "interrupted");
  const r2 = await s.sendTurn("actually, just fees", () => {});
  assert.equal(r2.status, "ok");
  assert.equal(r2.text, "Sure.");
  s.close();
});

test("barge-in when the SDK never reports the interrupted turn: settled by force, late result discarded", async () => {
  const s = session([
    { cumulativeCost: 0.01, hang: true, lateResultMs: 150, steps: [{ kind: "text", text: "Working on it. " }] },
    { cumulativeCost: 0.03, steps: [{ kind: "wait", ms: 300 }, { kind: "text", text: "Here you go. [[path=answer|conf=high]]" }] },
  ]);
  const first = s.sendTurn("first", () => {});
  await sleep(20);
  const t0 = Date.now();
  await s.interrupt();
  assert.ok(Date.now() - t0 < 1000, "interrupt returns after the grace period, not the turn timeout");
  const r1 = await first;
  assert.equal(r1.status, "interrupted");

  // The first turn's late result (at ~150ms) must not settle this one.
  const r2 = await s.sendTurn("second", () => {});
  assert.equal(r2.text, "Here you go.");
  assert.equal(r2.status, "ok");
  assert.equal(r2.costUsd, 0.02, "cost baseline moved past the discarded result");
  s.close();
});

test("a turn that calls too many tools is cut off", async () => {
  const tools: Step[] = Array.from({ length: 4 }, () => ({ kind: "tool", name: "search_knowledge_base" }) as Step);
  const s = session([{ cumulativeCost: 0.01, hang: true, resultOnInterrupt: true, steps: tools }], { maxToolCallsPerTurn: 3 });
  const r = await s.sendTurn("loop forever", () => {});
  assert.equal(r.status, "error");
  assert.match(r.errorMessage ?? "", /More than 3 tool calls/);
  s.close();
});

test("a turn that runs past its timeout is settled as a timeout", async () => {
  const s = session([{ cumulativeCost: 0.01, hang: true, steps: [] }]);
  const r = await s.sendTurn("slow", () => {}, { timeoutMs: 50 });
  assert.equal(r.status, "timeout");
  s.close();
});
