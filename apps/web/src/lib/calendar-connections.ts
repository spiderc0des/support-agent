import "server-only";
import { supabaseAdmin } from "@relaypay/shared/supabase";

/** Put a staff member on the callback rota (last in the order) unless they already are. */
export async function ensureOnCallbackRota(profileId: string) {
  const db = supabaseAdmin();
  const { data: existing } = await db.from("callback_agents").select("profile_id").eq("profile_id", profileId).maybeSingle();
  if (existing) return;
  const { data: last } = await db.from("callback_agents").select("rank").order("rank", { ascending: false }).limit(1).maybeSingle();
  await db.from("callback_agents").insert({ profile_id: profileId, rank: ((last?.rank as number | undefined) ?? 0) + 1 });
}

export type CalendarStatus = { connected: false } | { connected: true; google_email: string | null; connected_at: string; last_error: string | null; last_error_at: string | null };

export async function calendarStatus(profileId: string): Promise<CalendarStatus> {
  const { data } = await supabaseAdmin()
    .from("staff_calendars")
    .select("google_email, connected_at, last_error, last_error_at")
    .eq("profile_id", profileId)
    .maybeSingle();
  return data ? { connected: true, ...(data as Omit<Extract<CalendarStatus, { connected: true }>, "connected">) } : { connected: false };
}
