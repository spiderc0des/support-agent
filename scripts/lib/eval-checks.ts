/**
 * Deterministic eval checks over one conversation's Supabase records.
 *
 * Pure functions: given the records, a check passes or fails with a reason.
 * The runner (scripts/eval.ts) loads the records; tests can feed fixtures.
 * Judge checks are graded separately and merged in by the runner.
 */

export type Records = {
  turns: { turn_index: number; user_transcript: string; assistant_response: string | null; answer_type: string | null; tools_used: string[]; status: string }[];
  toolCalls: { tool_name: string; status: string }[];
  retrievals: { chunk_ids: string[]; matched: boolean }[];
  tickets: { ticket_id: string; category: string; priority: string }[];
  escalations: { escalation_id: string; category: string; call_booked: boolean; user_email: string }[];
  events: { event_type: string; source: string }[];
};

export type Check =
  | { type: "tool_called"; tool: string; status?: string }
  | { type: "tool_not_called"; tool: string }
  | { type: "retrieval_hit"; chunk: string | string[] }
  | { type: "path"; turn: number; in: string[] }
  | { type: "reply_matches"; turn: number; pattern: string; why?: string }
  | { type: "reply_not_matches"; pattern: string; why?: string }
  | { type: "ticket_created"; category?: string[] }
  | { type: "no_ticket" }
  | { type: "escalation_created"; category?: string[]; call_booked?: boolean; email?: string }
  | { type: "no_escalation" }
  | { type: "event_logged"; event_type: string }
  | { type: "judge"; criterion: string };

export type CheckResult = { check: string; passed: boolean; detail: string };

const list = (xs: string[]) => (xs.length ? xs.join(", ") : "none");

export function describe(c: Check): string {
  switch (c.type) {
    case "tool_called": return `called ${c.tool}${c.status ? ` (${c.status})` : ""}`;
    case "tool_not_called": return `did not call ${c.tool}`;
    case "retrieval_hit": return `retrieved ${[c.chunk].flat().join(" or ")}`;
    case "path": return `turn ${c.turn} path in [${c.in.join(", ")}]`;
    case "reply_matches": return `turn ${c.turn} reply ${c.why ?? `matches /${c.pattern}/`}`;
    case "reply_not_matches": return `no reply ${c.why ? `breaks "${c.why}"` : `matches /${c.pattern}/`}`;
    case "ticket_created": return `ticket created${c.category ? ` (${c.category.join(" or ")})` : ""}`;
    case "no_ticket": return "no ticket created";
    case "escalation_created": return `escalation created${c.category ? ` (${c.category.join(" or ")})` : ""}`;
    case "no_escalation": return "no escalation created";
    case "event_logged": return `event ${c.event_type} logged`;
    case "judge": return `judge: ${c.criterion}`;
  }
}

export function runCheck(c: Exclude<Check, { type: "judge" }>, r: Records): CheckResult {
  const name = describe(c);
  const ok = (passed: boolean, detail: string): CheckResult => ({ check: name, passed, detail });

  switch (c.type) {
    case "tool_called": {
      const calls = r.toolCalls.filter((t) => t.tool_name === c.tool);
      const hit = calls.some((t) => !c.status || t.status === c.status);
      return ok(hit, `calls: ${list(r.toolCalls.map((t) => `${t.tool_name}:${t.status}`))}`);
    }
    case "tool_not_called": {
      const calls = r.toolCalls.filter((t) => t.tool_name === c.tool);
      return ok(calls.length === 0, `${c.tool} called ${calls.length} time(s)`);
    }
    case "retrieval_hit": {
      const want = [c.chunk].flat();
      const got = r.retrievals.flatMap((x) => x.chunk_ids);
      return ok(want.some((w) => got.includes(w)), `retrieved: ${list([...new Set(got)])}`);
    }
    case "path": {
      const turn = r.turns.find((t) => t.turn_index === c.turn);
      return ok(Boolean(turn?.answer_type && c.in.includes(turn.answer_type)), `turn ${c.turn} path: ${turn?.answer_type ?? "missing"}`);
    }
    case "reply_matches": {
      const turn = r.turns.find((t) => t.turn_index === c.turn);
      const re = new RegExp(c.pattern, "i");
      return ok(re.test(turn?.assistant_response ?? ""), `reply: "${(turn?.assistant_response ?? "").slice(0, 160)}"`);
    }
    case "reply_not_matches": {
      const re = new RegExp(c.pattern, "i");
      const bad = r.turns.find((t) => re.test(t.assistant_response ?? ""));
      return ok(!bad, bad ? `turn ${bad.turn_index}: "${(bad.assistant_response ?? "").slice(0, 160)}"` : "clean");
    }
    case "ticket_created": {
      const hit = r.tickets.some((t) => !c.category || c.category.includes(t.category));
      return ok(hit, `tickets: ${list(r.tickets.map((t) => `${t.ticket_id}:${t.category}`))}`);
    }
    case "no_ticket":
      return ok(r.tickets.length === 0, `tickets: ${list(r.tickets.map((t) => t.ticket_id))}`);
    case "escalation_created": {
      const hit = r.escalations.some(
        (e) =>
          (!c.category || c.category.includes(e.category)) &&
          (c.call_booked === undefined || e.call_booked === c.call_booked) &&
          (!c.email || e.user_email === c.email),
      );
      return ok(hit, `escalations: ${list(r.escalations.map((e) => `${e.escalation_id}:${e.category}:${e.user_email}:booked=${e.call_booked}`))}`);
    }
    case "no_escalation":
      return ok(r.escalations.length === 0, `escalations: ${list(r.escalations.map((e) => e.escalation_id))}`);
    case "event_logged":
      return ok(r.events.some((e) => e.event_type === c.event_type), `events: ${list(r.events.map((e) => e.event_type))}`);
  }
}
