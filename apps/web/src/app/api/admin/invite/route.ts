import { z } from "zod";
import { STAFF_ROLES } from "@relaypay/shared/enums";
import { supabaseAdmin } from "@relaypay/shared/supabase";
import { requireAdmin, errorResponse } from "@/lib/auth";

export const runtime = "nodejs";

const Body = z.object({
  email: z.string().trim().toLowerCase().email("A valid email address is required"),
  full_name: z.string().trim().min(1, "Their name is required").max(120),
  role: z.enum(STAFF_ROLES).default("support_agent"),
});

/**
 * Invite a support agent or admin (week 5 flow). Signup is otherwise closed.
 * The name and role go on the allowlist first: inviting creates the auth
 * user, and the signup trigger builds the profile from that row.
 */
export async function POST(req: Request) {
  try {
    const admin = await requireAdmin();
    const parsed = Body.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message ?? "Invalid invite" }, { status: 400 });
    const { email, full_name, role } = parsed.data;
    const db = supabaseAdmin();

    const { data: existing } = await db.from("profiles").select("id").eq("email", email).maybeSingle();
    if (existing) {
      const { data: authUser } = await db.auth.admin.getUserById(existing.id);
      if (authUser?.user?.last_sign_in_at) {
        return Response.json({ error: `${email} already has an account. Change their role in the team list.` }, { status: 409 });
      }
    }

    const { error: allowErr } = await db
      .from("allowed_emails")
      .upsert({ email, full_name, role, invited_by: admin.id, invited_at: new Date().toISOString() }, { onConflict: "email" });
    if (allowErr) return Response.json({ error: `Could not record the invite: ${allowErr.message}` }, { status: 500 });

    const redirectTo = `${(process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/$/, "")}/auth/confirm?next=/review`;
    const { data, error } = await db.auth.admin.inviteUserByEmail(email, { data: { full_name }, redirectTo });

    if (error && /already (been )?registered|exists/i.test(error.message)) {
      // Invited before but never signed in: send a fresh sign-in link instead.
      const { error: otpErr } = await db.auth.signInWithOtp({ email, options: { shouldCreateUser: false, emailRedirectTo: redirectTo } });
      if (otpErr) return Response.json({ error: `Could not resend: ${otpErr.message}` }, { status: 502 });
      if (existing) await db.from("profiles").update({ full_name, role }).eq("id", existing.id);
      return Response.json({ note: `${full_name} was already invited, so they've been sent a fresh sign-in link.` });
    }
    if (error) return Response.json({ error: `Supabase could not send the invite: ${error.message}` }, { status: 502 });
    if (data?.user) await db.from("profiles").update({ full_name, role }).eq("id", data.user.id);

    return Response.json({ note: `Invite sent to ${full_name} (${email}) as ${role === "admin" ? "an admin" : "a support agent"}.` });
  } catch (err) {
    return errorResponse(err);
  }
}
