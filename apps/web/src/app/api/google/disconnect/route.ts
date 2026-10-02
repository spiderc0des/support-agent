import { supabaseAdmin } from "@relaypay/shared/supabase";
import { revoke } from "@relaypay/shared/google-calendar";
import { errorResponse, requireStaff } from "@/lib/auth";

export const runtime = "nodejs";

/** Disconnect the signed-in staff member's calendar. Callbacks already booked stay on it. */
export async function POST() {
  try {
    const me = await requireStaff();
    const db = supabaseAdmin();
    const { data } = await db.from("staff_calendars").select("refresh_token").eq("profile_id", me.id).maybeSingle();
    if (data?.refresh_token) await revoke(data.refresh_token as string);
    await db.from("staff_calendars").delete().eq("profile_id", me.id);
    return Response.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
