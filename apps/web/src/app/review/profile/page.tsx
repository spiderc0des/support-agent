import Link from "next/link";
import { ROLE_LABEL } from "@relaypay/shared/enums";
import { supabaseAdmin } from "@relaypay/shared/supabase";
import { ConfirmSignOut } from "@/components/ConfirmSignOut";
import { ProfileForm } from "@/components/ProfileForm";
import { When } from "@/components/When";
import { currentProfile, displayName, initials } from "@/lib/auth";
import { supabaseServer } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function ProfilePage() {
  const me = (await currentProfile())!;
  const supabase = await supabaseServer();
  const [{ data: authUser }, openTickets, closedByMe, escalations] = await Promise.all([
    supabaseAdmin().auth.admin.getUserById(me.id),
    supabase.from("support_tickets").select("ticket_id", { count: "exact", head: true }).eq("assigned_to", me.id).neq("status", "closed"),
    supabase.from("case_events").select("id", { count: "exact", head: true }).eq("actor_id", me.id).eq("action", "status_changed").eq("to_value", "closed"),
    supabase.from("escalations").select("escalation_id", { count: "exact", head: true }).eq("assigned_to", me.id).neq("status", "closed"),
  ]);

  return (
    <>
      <div className="page-head">
        <h1>Your profile</h1>
      </div>
      <div className="grid-2">
        <section className="panel">
          <div className="profile-id">
            <span className="avatar large">{initials(me)}</span>
            <div>
              <p className="lead-text">{displayName(me)}</p>
              <p className="muted">{me.email}</p>
            </div>
          </div>
          <dl className="facts">
            <dt>Role</dt>
            <dd>
              {me.role ? ROLE_LABEL[me.role] : "none"}
              <span className="muted"> · {me.role === "admin" ? "works cases, manages the team and settings" : "works tickets and escalations"}</span>
            </dd>
            <dt>Last sign-in</dt>
            <dd>
              <When iso={authUser?.user?.last_sign_in_at ?? null} />
            </dd>
            <dt>Member since</dt>
            <dd>
              <When iso={authUser?.user?.created_at ?? null} mode="relative" />
            </dd>
          </dl>
          <ProfileForm fullName={me.full_name ?? ""} />
          <p className="hint">Only an admin can change your role.</p>
        </section>

        <section className="panel">
          <h2>Your work</h2>
          <div className="tiles small">
            <Link href="/review/tickets?view=mine" className="tile">
              <p className="tile-label">Open tickets</p>
              <p className="tile-value">{openTickets.count ?? 0}</p>
            </Link>
            <Link href="/review/escalations?view=mine" className="tile">
              <p className="tile-label">Open escalations</p>
              <p className="tile-value">{escalations.count ?? 0}</p>
            </Link>
            <div className="tile">
              <p className="tile-label">Cases you closed</p>
              <p className="tile-value">{closedByMe.count ?? 0}</p>
            </div>
          </div>
          <ConfirmSignOut />
        </section>
      </div>
    </>
  );
}
