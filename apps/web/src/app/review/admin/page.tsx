import Link from "next/link";
import { redirect } from "next/navigation";
import { supabaseAdmin } from "@relaypay/shared/supabase";
import { InviteForm } from "@/components/InviteForm";
import { TeamTable, type TeamMember } from "@/components/TeamTable";
import { When } from "@/components/When";
import { activeSessionCount } from "@/agent/turns";
import { DEFAULT_MODEL } from "@/agent/support-session";
import { currentProfile } from "@/lib/auth";

export const dynamic = "force-dynamic";

async function mcpHealthy(): Promise<boolean> {
  const url = process.env.MCP_URL;
  if (!url) return false;
  try {
    const res = await fetch(new URL("/health", url), { signal: AbortSignal.timeout(2000), cache: "no-store" });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Admin only: the team (invite, roles, removal) and whether the system is
 * wired up. Settings are shown, never editable here: they live in the
 * deployment's environment, and a page that could change them would be a
 * second source of truth.
 */
export default async function AdminPage() {
  const me = await currentProfile();
  if (me?.role !== "admin") redirect("/review");

  const db = supabaseAdmin();
  const [{ data: profiles }, { data: authList }, { data: open }, { data: lastEval }, mcpOk] = await Promise.all([
    db.from("profiles").select("id, email, full_name, role, created_at").order("created_at"),
    db.auth.admin.listUsers({ perPage: 1000 }),
    db.from("support_tickets").select("assigned_to").neq("status", "closed").not("assigned_to", "is", null),
    db.from("eval_runs").select("id, model, started_at, passed, total, cost_usd").order("started_at", { ascending: false }).limit(1).maybeSingle(),
    mcpHealthy(),
  ]);

  const lastSignIn = new Map((authList?.users ?? []).map((u) => [u.id, u.last_sign_in_at ?? null]));
  const openBy = new Map<string, number>();
  for (const t of open ?? []) openBy.set(t.assigned_to as string, (openBy.get(t.assigned_to as string) ?? 0) + 1);
  const members: TeamMember[] = (profiles ?? []).map((p) => ({
    id: p.id,
    email: p.email,
    full_name: p.full_name,
    role: p.role === "admin" ? "admin" : "support_agent",
    last_sign_in_at: lastSignIn.get(p.id) ?? null,
    open_cases: openBy.get(p.id) ?? 0,
  }));

  const set = (v: string | undefined) => (v ? <span className="pill done">set</span> : <span className="pill attention">missing</span>);

  return (
    <>
      <div className="page-head">
        <h1>Admin</h1>
      </div>

      <section className="panel">
        <h2>Invite someone</h2>
        <p className="muted">Signup is closed. They get an email and can sign in once they use it.</p>
        <InviteForm />
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>Team</h2>
          <span className="muted">
            {members.filter((m) => m.role === "admin").length} admin, {members.filter((m) => m.role === "support_agent").length} support agent
          </span>
        </div>
        <TeamTable members={members} meId={me.id} />
      </section>

      <div className="grid-2">
        <section className="panel">
          <h2>System</h2>
          <dl className="facts">
            <dt>Agent model</dt>
            <dd>{process.env.AGENT_MODEL ?? DEFAULT_MODEL}</dd>
            <dt>Live call sessions</dt>
            <dd>{activeSessionCount()}</dd>
            <dt>MCP server</dt>
            <dd>{mcpOk ? <span className="pill done">reachable</span> : <span className="pill attention">not reachable</span>}</dd>
            <dt>Per-call budget</dt>
            <dd>${Number(process.env.CALL_BUDGET_USD ?? 0.5).toFixed(2)}</dd>
            <dt>Public URL</dt>
            <dd>{process.env.NEXT_PUBLIC_APP_URL ?? <span className="pill attention">missing</span>}</dd>
            <dt>Support phone</dt>
            <dd>{process.env.NEXT_PUBLIC_SUPPORT_PHONE || <span className="muted">none</span>}</dd>
          </dl>
        </section>

        <section className="panel">
          <h2>Configuration</h2>
          <dl className="facts">
            <dt>Anthropic key</dt>
            <dd>{set(process.env.ANTHROPIC_API_KEY)}</dd>
            <dt>MCP token</dt>
            <dd>{set(process.env.MCP_AUTH_TOKEN)}</dd>
            <dt>Vapi assistant</dt>
            <dd>{set(process.env.NEXT_PUBLIC_VAPI_ASSISTANT_ID)}</dd>
            <dt>Vapi secret</dt>
            <dd>{set(process.env.VAPI_WEBHOOK_SECRET)}</dd>
            <dt>Text test endpoint</dt>
            <dd>{process.env.DEV_API_TOKEN ? <span className="pill progress">enabled</span> : <span className="muted">off</span>}</dd>
            <dt>Last eval</dt>
            <dd>
              {lastEval ? (
                <Link href={`/review/evals?run=${lastEval.id}`}>
                  {lastEval.passed}/{lastEval.total} passed on {lastEval.model}, <When iso={lastEval.started_at} mode="relative" />
                </Link>
              ) : (
                <span className="muted">never run</span>
              )}
            </dd>
          </dl>
          <p className="hint">Values come from the deployment&apos;s environment. Change them there and redeploy.</p>
        </section>
      </div>
    </>
  );
}
