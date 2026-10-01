import { AppHeader } from "@/components/AppHeader";
import { currentProfile, displayName } from "@/lib/auth";
import { supabaseServer } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/** The support console shell: header, nav with open-work counts, and the role gate. */
export default async function ConsoleLayout({ children }: { children: React.ReactNode }) {
  const profile = await currentProfile();

  if (!profile?.role) {
    return (
      <div className="page">
        <main className="main">
          <section className="card">
            <h1>No access yet</h1>
            <p className="lede">
              {profile ? `${displayName(profile)} (${profile.email}) is signed in` : "You are signed in"}, but the account has no support role. Ask an
              admin to invite you from the Admin page.
            </p>
            <form action="/auth/signout" method="post">
              <button className="btn secondary" type="submit">
                Sign out
              </button>
            </form>
          </section>
        </main>
      </div>
    );
  }

  const supabase = await supabaseServer();
  // A ticket with an escalation is counted once, as an escalation.
  const { data: escalated } = await supabase.from("escalations").select("ticket_id").is("deleted_at", null);
  const escalatedIds = (escalated ?? []).map((e) => `"${e.ticket_id}"`).join(",");
  let ticketQuery = supabase.from("support_tickets").select("ticket_id", { count: "exact", head: true }).neq("status", "closed").is("deleted_at", null);
  if (escalatedIds) ticketQuery = ticketQuery.not("ticket_id", "in", `(${escalatedIds})`);
  const [tickets, escalations] = await Promise.all([
    ticketQuery,
    supabase.from("escalations").select("escalation_id", { count: "exact", head: true }).neq("status", "closed").is("deleted_at", null),
  ]);

  return (
    <div className="page console">
      <AppHeader profile={{ ...profile, role: profile.role }} openTickets={tickets.count ?? 0} openEscalations={escalations.count ?? 0} />
      <main className="wide">{children}</main>
    </div>
  );
}
