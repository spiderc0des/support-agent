import { NextResponse } from "next/server";
import { supabaseAdmin } from "@relaypay/shared/supabase";
import { hashInviteToken } from "@/lib/invites";
import { publicOrigin, publicUrl } from "@/lib/public-origin";

export const runtime = "nodejs";

/**
 * An invite link (valid three days). Each visit asks Supabase for a fresh
 * one-time sign-in and passes it to /auth/confirm, so the link survives mail
 * scanners and a second click. It stops working when it expires, when a new
 * invite replaces it, or when the person's access is removed.
 */
export async function GET(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const fail = (msg: string) => NextResponse.redirect(publicUrl(`/login?error=${encodeURIComponent(msg)}`, req));
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return fail("invite_link_invalid");

  const db = supabaseAdmin();
  const { data: invite } = await db
    .from("allowed_emails")
    .select("email, invite_expires_at")
    .eq("invite_token_hash", hashInviteToken(token))
    .maybeSingle();
  if (!invite) return fail("This invite link isn't valid any more. Ask an admin to send a new one.");
  if (!invite.invite_expires_at || new Date(invite.invite_expires_at as string) < new Date()) {
    return fail("This invite link has expired (they last 3 days). Ask an admin to send a new one, or sign in below if you've joined before.");
  }

  const { data, error } = await db.auth.admin.generateLink({
    type: "magiclink",
    email: invite.email as string,
    options: { redirectTo: `${publicOrigin(req)}/auth/confirm?next=/review` },
  });
  const hashed = data?.properties?.hashed_token;
  if (error || !hashed) return fail(error?.message ?? "invite_sign_in_failed");
  return NextResponse.redirect(publicUrl(`/auth/confirm?token_hash=${encodeURIComponent(hashed)}&type=magiclink&next=/review`, req));
}
