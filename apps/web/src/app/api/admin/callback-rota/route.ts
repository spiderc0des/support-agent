import { z } from "zod";
import { supabaseAdmin } from "@relaypay/shared/supabase";
import { isValidTimeZone } from "@relaypay/shared/slots";
import { errorResponse, requireAdmin } from "@/lib/auth";

export const runtime = "nodejs";

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Times are HH:MM");
const Agent = z
  .object({
    profile_id: z.string().uuid(),
    takes_callbacks: z.boolean(),
    timezone: z.string().refine(isValidTimeZone, "Unknown time zone"),
    work_days: z.array(z.number().int().min(1).max(7)).min(1, "Pick at least one working day").max(7),
    work_start: time,
    work_end: time,
  })
  .refine((a) => a.work_end > a.work_start, "Working hours must end after they start");
const Body = z.object({ agents: z.array(Agent).max(200) });

/** Save the callback rota: who takes callbacks, their hours, and the order they're checked in. Admins only. */
export async function PUT(req: Request) {
  try {
    await requireAdmin();
    const parsed = Body.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message ?? "Invalid rota" }, { status: 400 });
    const db = supabaseAdmin();
    const ids = parsed.data.agents.map((a) => a.profile_id);
    if (new Set(ids).size !== ids.length) return Response.json({ error: "Someone is listed twice" }, { status: 400 });
    const { data: staff } = await db.from("profiles").select("id").in("id", ids).in("role", ["admin", "support_agent"]);
    if ((staff ?? []).length !== ids.length) return Response.json({ error: "Only support agents and admins can take callbacks" }, { status: 400 });

    const rows = parsed.data.agents.map((a, i) => ({ ...a, rank: i + 1, work_days: [...new Set(a.work_days)].sort(), updated_at: new Date().toISOString() }));
    const { error } = await db.from("callback_agents").upsert(rows, { onConflict: "profile_id" });
    if (error) throw new Error(error.message);
    return Response.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
