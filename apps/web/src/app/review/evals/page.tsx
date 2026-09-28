import Link from "next/link";
import { StatusPill } from "@/components/StatusPill";
import { supabaseServer } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type CheckResult = { check: string; passed: boolean; detail: string };

/** The testing-evidence table the PRD asks for, straight from the evaluations table. */
export default async function Evals({ searchParams }: { searchParams: Promise<{ run?: string }> }) {
  const { run: runParam } = await searchParams;
  const supabase = await supabaseServer();
  const { data: runs } = await supabase
    .from("eval_runs")
    .select("id, model, git_sha, started_at, total, passed, cost_usd")
    .order("started_at", { ascending: false })
    .limit(20);
  const runId = runParam ?? runs?.[0]?.id;
  const { data: rows } = runId
    ? await supabase
        .from("evaluations")
        .select("id, scenario_id, scenario_name, repeat_index, conversation_id, expected_behavior, actual_behavior, passed, checks, notes, cost_usd")
        .eq("eval_run_id", runId)
        .order("scenario_id")
        .order("repeat_index")
    : { data: [] };

  return (
    <>
      <div className="page-head">
        <h1>Evaluations</h1>
      </div>
      <div>
        <div className="filters" aria-label="Eval runs">
          {(runs ?? []).map((r) => (
            <Link key={r.id} href={`/review/evals?run=${r.id}`} className={r.id === runId ? "active" : ""}>
              {new Date(r.started_at).toLocaleString("en-GB", { dateStyle: "short", timeStyle: "short" })} · {r.model} · {r.passed ?? "?"}/
              {r.total ?? "?"}
            </Link>
          ))}
        </div>
      </div>
      <table className="table responsive">
        <thead>
          <tr>
            <th>Scenario</th>
            <th>Expected behaviour</th>
            <th>Actual behaviour</th>
            <th>Result</th>
            <th>Checks</th>
          </tr>
        </thead>
        <tbody>
          {(rows ?? []).map((r) => (
            <tr key={r.id}>
              <td data-label="Scenario">
                <strong>{r.scenario_id}</strong> {r.scenario_name}
                {r.repeat_index ? ` #${r.repeat_index + 1}` : ""}
                {r.conversation_id ? (
                  <div>
                    <Link href={`/review/conversations/${r.conversation_id}`}>View conversation</Link>
                  </div>
                ) : null}
              </td>
              <td data-label="Expected">{r.expected_behavior}</td>
              <td data-label="Actual" className="summary">{r.actual_behavior}</td>
              <td data-label="Result">
                <StatusPill value={r.passed ? "pass" : "fail"} />
              </td>
              <td data-label="Checks">
                {((r.checks as CheckResult[]) ?? []).map((c, i) => (
                  <div key={i} className={c.passed ? "check ok" : "check bad"} title={c.detail}>
                    {c.passed ? "✓" : "✗"} {c.check}
                  </div>
                ))}
              </td>
            </tr>
          ))}
          {!rows?.length ? (
            <tr>
              <td colSpan={5} className="empty">No evaluations yet. Run npm run eval.</td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </>
  );
}
