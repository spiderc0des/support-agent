import Link from "next/link";
import { ROLE_LABEL } from "@relaypay/shared/enums";
import { supabaseAdmin } from "@relaypay/shared/supabase";
import { ConfirmSignOut } from "@/components/ConfirmSignOut";
import { ProfileForm } from "@/components/ProfileForm";
import { When } from "@/components/When";
import { currentProfile, displayName, initials } from "@/lib/auth";
import { supabaseServer } from "@/lib/supabase/server";
import { calendarConfigured } from "@relaypay/shared/google-calendar";
import { spokenSlot } from "@relaypay/shared/slots";
import { CalendarConnect } from "@/components/CalendarConnect";
import { calendarStatus } from "@/lib/calendar-connections";

const CALENDAR_NOTICE: Record<string, { ok: boolean; text: string }> = {
  connected: { ok: true, text: "Your Google Calendar is connected. Callers can now book callbacks with you during your hours." },
  declined: { ok: false, text: "Calendar access wasn't granted, so nothing was connected." },
  expired: { ok: false, text: "That connection attempt expired. Try again." },
  no_offline_access: { ok: false, text: "Google didn't grant offline access. Try again and allow every permission." },
  missing_permission: { ok: false, text: "Calendar access was only partly granted. Try again and tick both calendar permissions." },
  failed: { ok: false, text: "Connecting the calendar failed. Try again in a moment." },
  not_configured: { ok: false, text: "Calendar booking isn't set up on this deployment yet." },
};
const DAY = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export const dynamic = "force-dynamic";

export default async function ProfilePage({ searchParams }: { searchParams: Promise<{ calendar?: string }> }) {
  const notice = CALENDAR_NOTICE[(await searchParams).calendar ?? ""];
  const me = (await currentProfile())!;
  const supabase = await supabaseServer();
  const [{ data: authUser }, openTickets, closedByMe, escalations, calendar, { data: rota }, { data: upcoming }] = await Promise.all([
    supabaseAdmin().auth.admin.getUserById(me.id),
    supabase.from("support_tickets").select("ticket_id", { count: "exact", head: true }).eq("assigned_to", me.id).neq("status", "closed").is("deleted_at", null),
    supabase.from("case_events").select("id", { count: "exact", head: true }).eq("actor_id", me.id).eq("action", "status_changed").eq("to_value", "closed"),
    supabase.from("escalations").select("escalation_id", { count: "exact", head: true }).eq("assigned_to", me.id).neq("status", "closed").is("deleted_at", null),
    calendarStatus(me.id),
    supabase.from("callback_agents").select("takes_callbacks, timezone, work_days, work_start, work_end").eq("profile_id", me.id).maybeSingle(),
    supabase
      .from("callback_bookings")
      .select("id, slot_start, escalation_id, ticket_id, google_event_link")
      .eq("profile_id", me.id)
      .eq("status", "booked")
      .gte("slot_start", new Date().toISOString())
      .order("slot_start")
      .limit(5),
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

      <section className="panel">
        <div className="panel-head">
          <h2>Callbacks and calendar</h2>
          {calendar.connected ? <span className="pill done">connected</span> : <span className="pill attention">not connected</span>}
        </div>
        {notice ? <p className={`notice ${notice.ok ? "ok" : "bad"}`}>{notice.text}</p> : null}
        <p className="muted">
          When a caller asks for a callback, the assistant books it with the first person in the admin&apos;s order who is working then and free on
          their Google Calendar. The case is assigned to them and the call goes on their calendar with a video link.
        </p>
        <dl className="facts">
          <dt>Google Calendar</dt>
          <dd>
            {calendar.connected ? (
              <>
                {calendar.google_email ?? "connected"} <span className="muted">· since <When iso={calendar.connected_at} mode="relative" /></span>
                {calendar.last_error ? (
                  <span className="pill attention" title={calendar.last_error}>
                    last check failed
                  </span>
                ) : null}
              </>
            ) : (
              "not connected"
            )}
          </dd>
          <dt>Your callback hours</dt>
          <dd>
            {rota
              ? rota.takes_callbacks
                ? `${(rota.work_days as number[]).map((d) => DAY[d]).join(", ")} · ${String(rota.work_start).slice(0, 5)}–${String(rota.work_end).slice(0, 5)} (${rota.timezone})`
                : "Not taking callbacks (an admin turned this off)"
              : "Not on the callback rota yet: connect your calendar to join it"}
          </dd>
          <dt>Upcoming callbacks</dt>
          <dd>
            {upcoming?.length ? (
              <ul className="plain-list">
                {upcoming.map((b) => (
                  <li key={b.id}>
                    <Link href={`/review/tickets/${b.ticket_id}`}>{b.escalation_id}</Link> · {spokenSlot(new Date(b.slot_start), (rota?.timezone as string) ?? "Africa/Lagos")}
                  </li>
                ))}
              </ul>
            ) : (
              <span className="muted">none</span>
            )}
          </dd>
        </dl>
        <p className="hint">An admin sets your hours and your place in the order on the Admin page.</p>
        <CalendarConnect connected={calendar.connected} configured={calendarConfigured()} />
      </section>
    </>
  );
}
