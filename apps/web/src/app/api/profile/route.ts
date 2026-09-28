import { z } from "zod";
import { supabaseAdmin } from "@relaypay/shared/supabase";
import { requireStaff, errorResponse } from "@/lib/auth";

export const runtime = "nodejs";

const Body = z.object({ full_name: z.string().trim().min(1, "Your name can't be empty").max(120) });

/** Change your own display name. Roles are changed by an admin, not here. */
export async function PATCH(req: Request) {
  try {
    const me = await requireStaff();
    const parsed = Body.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message ?? "Invalid name" }, { status: 400 });
    const { error } = await supabaseAdmin()
      .from("profiles")
      .update({ full_name: parsed.data.full_name, updated_at: new Date().toISOString() })
      .eq("id", me.id);
    if (error) return Response.json({ error: error.message }, { status: 500 });
    return Response.json({ note: "Saved." });
  } catch (err) {
    return errorResponse(err);
  }
}
