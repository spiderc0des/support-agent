import { z } from "zod";
import { STAFF_ROLES } from "@relaypay/shared/enums";
import { supabaseAdmin } from "@relaypay/shared/supabase";
import { requireAdmin, errorResponse } from "@/lib/auth";

export const runtime = "nodejs";

const Body = z
  .object({
    role: z.enum(STAFF_ROLES).optional(),
    full_name: z.string().trim().min(1, "A name can't be empty").max(120).optional(),
  })
  .refine((b) => b.role || b.full_name, { message: "Nothing to change" });

/**
 * Change someone's role or name. An admin can't demote or remove themselves:
 * if they were the last admin, nobody would be left to undo it.
 */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const admin = await requireAdmin();
    const { id } = await ctx.params;
    const parsed = Body.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message ?? "Invalid change" }, { status: 400 });
    if (id === admin.id && parsed.data.role && parsed.data.role !== "admin") {
      return Response.json({ error: "You can't remove your own admin role. Ask another admin." }, { status: 400 });
    }
    const { data, error } = await supabaseAdmin()
      .from("profiles")
      .update({ ...parsed.data, updated_at: new Date().toISOString() })
      .eq("id", id)
      .select("email, full_name, role")
      .maybeSingle();
    if (error) return Response.json({ error: error.message }, { status: 500 });
    if (!data) return Response.json({ error: "No such user" }, { status: 404 });
    return Response.json({ note: `Updated ${data.full_name ?? data.email}.` });
  } catch (err) {
    return errorResponse(err);
  }
}

/** Remove someone's access entirely. Their past case activity stays, unattributed. */
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const admin = await requireAdmin();
    const { id } = await ctx.params;
    if (id === admin.id) return Response.json({ error: "You can't remove your own account." }, { status: 400 });
    const db = supabaseAdmin();
    const { data: person } = await db.from("profiles").select("email").eq("id", id).maybeSingle();
    const { error } = await db.auth.admin.deleteUser(id);
    if (error) return Response.json({ error: error.message }, { status: 500 });
    if (person?.email) await db.from("allowed_emails").delete().eq("email", person.email);
    return Response.json({ note: `Removed ${person?.email ?? "the user"}.` });
  } catch (err) {
    return errorResponse(err);
  }
}
