import { cookies } from "next/headers";
import { supabaseAdmin } from "@relaypay/shared/supabase";
import { exchangeCode } from "@relaypay/shared/google-calendar";
import { AuthError, requireStaff } from "@/lib/auth";
import { ensureOnCallbackRota } from "@/lib/calendar-connections";
import { publicOrigin, publicUrl } from "@/lib/public-origin";

export const runtime = "nodejs";

/** Google sends the staff member back here after they allow calendar access. */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const back = (status: string) => Response.redirect(publicUrl(`/review/profile?calendar=${status}`, req), 303);
  const jar = await cookies();
  const saved = jar.get("rp_gstate")?.value ?? "";
  jar.delete({ name: "rp_gstate", path: "/api/google" });

  if (url.searchParams.get("error")) return back("declined");
  const [state, profileId] = saved.split(".");
  if (!state || state !== url.searchParams.get("state")) return back("expired");

  let me;
  try {
    me = await requireStaff();
  } catch (err) {
    if (err instanceof AuthError) return Response.redirect(publicUrl("/login?next=/review/profile", req), 303);
    throw err;
  }
  if (me.id !== profileId) return back("expired");

  const code = url.searchParams.get("code");
  if (!code) return back("expired");
  try {
    const t = await exchangeCode(code, publicOrigin(req));
    if (!t.refreshToken) return back("no_offline_access");
    if (!t.scope.includes("calendar.events") || !t.scope.includes("calendar.freebusy")) return back("missing_permission");
    const { error } = await supabaseAdmin()
      .from("staff_calendars")
      .upsert({ profile_id: me.id, google_email: t.email, refresh_token: t.refreshToken, connected_at: new Date().toISOString(), last_error: null, last_error_at: null });
    if (error) throw new Error(error.message);
    await ensureOnCallbackRota(me.id);
    return back("connected");
  } catch (err) {
    console.error("[google] connect failed:", err instanceof Error ? err.message : err);
    return back("failed");
  }
}
