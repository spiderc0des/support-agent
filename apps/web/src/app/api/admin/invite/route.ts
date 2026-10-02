import { z } from "zod";
import { STAFF_ROLES } from "@relaypay/shared/enums";
import { supabaseAdmin } from "@relaypay/shared/supabase";
import { buildInviteEmail, emailConfigured, sendViaBrevo } from "@relaypay/shared/notify";
import { requireAdmin, errorResponse } from "@/lib/auth";
import { INVITE_DAYS, newInviteToken } from "@/lib/invites";
import { publicOrigin } from "@/lib/public-origin";

export const runtime = "nodejs";

const Body = z.object({
  email: z.string().trim().toLowerCase().email("A valid email address is required"),
  full_name: z.string().trim().min(1, "Their name is required").max(120),
  role: z.enum(STAFF_ROLES).default("support_agent"),
});

/**
 * Invite a support agent or admin. Signup is otherwise closed.
 *
 * The name, role and a three-day invite token go on the allowlist; the auth
 * user is created straight away (the signup trigger builds the profile from
 * the allowlist row). The email links to /invite/<token>, not to a Supabase
 * link: Supabase's links expire within a day, and a mail scanner opening one
 * uses it up. Inviting again sends a new link and ends the old one.
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

    const invite = newInviteToken();
    const { error: allowErr } = await db.from("allowed_emails").upsert(
      {
        email,
        full_name,
        role,
        invited_by: admin.id,
        invited_at: new Date().toISOString(),
        invite_token_hash: invite.hash,
        invite_expires_at: invite.expiresAt.toISOString(),
      },
      { onConflict: "email" },
    );
    if (allowErr) return Response.json({ error: `Could not record the invite: ${allowErr.message}` }, { status: 500 });

    if (existing) {
      await db.from("profiles").update({ full_name, role }).eq("id", existing.id);
    } else {
      const { data, error } = await db.auth.admin.createUser({ email, email_confirm: true, user_metadata: { full_name } });
      if (error && !/already (been )?registered|exists/i.test(error.message)) {
        return Response.json({ error: `Could not create the account: ${error.message}` }, { status: 502 });
      }
      if (data?.user) await db.from("profiles").update({ full_name, role }).eq("id", data.user.id);
    }

    const link = `${publicOrigin(req)}/invite/${invite.token}`;
    const resent = Boolean(existing);
    if (!emailConfigured()) {
      return Response.json({
        note: `Email isn't set up (BREVO_API_KEY, MAIL_FROM), so send ${full_name} this link yourself. It works for ${INVITE_DAYS} days.`,
        link,
      });
    }
    const sent = await sendViaBrevo(
      { email, name: full_name },
      buildInviteEmail({ name: full_name, role, link, invitedBy: admin.full_name?.trim() || admin.email, expiresDays: INVITE_DAYS }),
    );
    if (!sent.ok) {
      return Response.json({ note: `The email couldn't be sent (${sent.reason}). Send ${full_name} this link yourself; it works for ${INVITE_DAYS} days.`, link });
    }
    return Response.json({
      note: `${resent ? "A new invite was sent" : "Invite sent"} to ${full_name} (${email}) as ${role === "admin" ? "an admin" : "a support agent"}. The link works for ${INVITE_DAYS} days.`,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
