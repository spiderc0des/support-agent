import Link from "next/link";
import { redirect } from "next/navigation";
import { supabaseAdmin } from "@relaypay/shared/supabase";
import { DeleteControl } from "@/components/DeleteControl";
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
    db.from("support_tickets").select("assigned_to").neq("status", "closed").not("assigned_to", "is", null).is("deleted_at", null),
    db.from("eval_runs").select("id, model, started_at, passed, total, cost_usd").is("deleted_at", null).order("started_at", { ascending: false }).limit(1).maybeSingle(),
    mcpHealthy(),
  ]);

  // Recently deleted, across every kind that can be deleted.
  const [{ data: delTickets }, { data: delConvs }, { data: delRuns }, { data: delEscs }] = await Promise.all([
    db.from("support_tickets").select("ticket_id, summary, deleted_at, deleted_by, delete_reason").not("deleted_at", "is", null).order("deleted_at", { ascending: false }).limit(30),
    db.from("conversations").select("id, channel, started_at, deleted_at, deleted_by, delete_reason").not("deleted_at", "is", null).order("deleted_at", { ascending: false }).limit(30),
    db.from("eval_runs").select("id, model, started_at, passed, total, deleted_at, deleted_by, delete_reason").not("deleted_at", "is", null).order("deleted_at", { ascending: false }).limit(30),
    db.from("escalations").select("escalation_id, ticket_id").not("deleted_at", "is", null),
  ]);
  const escOf = new Map((delEscs ?? []).map((e) => [e.ticket_id, e.escalation_id]));
  const who = (id: string | null) => (profiles ?? []).find((p) => p.id === id)?.full_name ?? (profiles ?? []).find((p) => p.id === id)?.email ?? "someone";
  type Deleted = { key: string; kind: "case" | "conversation" | "eval_run"; id: string; title: string; href: string; at: string; by: string; reason: string | null };
  const deleted: Deleted[] = [
    ...(delTickets ?? []).map((t) => ({
      key: `t-${t.ticket_id}`, kind: "case" as const, id: t.ticket_id,
      title: `${t.ticket_id}${escOf.get(t.ticket_id) ? ` + ${escOf.get(t.ticket_id)}` : ""} · ${t.summary}`,
      href: `/review/tickets/${t.ticket_id}`, at: t.deleted_at, by: who(t.deleted_by), reason: t.delete_reason,
    })),
    ...(delConvs ?? []).map((c) => ({
      key: `c-${c.id}`, kind: "conversation" as const, id: c.id,
      title: `${c.channel.replace("_", " ")} conversation from ${new Date(c.started_at).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}`,
      href: `/review/conversations/${c.id}`, at: c.deleted_at, by: who(c.deleted_by), reason: c.delete_reason,
    })),
    ...(delRuns ?? []).map((r) => ({
      key: `r-${r.id}`, kind: "eval_run" as const, id: r.id,
      title: `Eval run ${r.model} · ${r.passed ?? "?"}/${r.total ?? "?"}`,
      href: `/review/evals?run=${r.id}`, at: r.deleted_at, by: who(r.deleted_by), reason: r.delete_reason,
    })),
  ].sort((a, b) => b.at.localeCompare(a.at));

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

      <section className="panel">
        <div className="panel-head">
          <h2>Recently deleted</h2>
          <span className="muted">hidden from queues and counts, never erased</span>
        </div>
        {deleted.length ? (
          <ul className="list">
            {deleted.map((d) => (
              <li key={d.key}>
                <span className="list-main">
                  <Link href={d.href}>{d.title}</Link>
                  <span className="muted"> · deleted by {d.by}, <When iso={d.at} mode="relative" />{d.reason ? `: ${d.reason}` : ""}</span>
                </span>
                <DeleteControl kind={d.kind} id={d.id} label={d.title.split(" · ")[0]} detail="" deleted />
              </li>
            ))}
          </ul>
        ) : (
          <p className="empty">Nothing deleted.</p>
        )}
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
