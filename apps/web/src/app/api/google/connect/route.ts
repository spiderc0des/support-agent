import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { authorizationUrl, calendarConfigured } from "@relaypay/shared/google-calendar";
import { AuthError, requireStaff } from "@/lib/auth";
import { publicOrigin, publicUrl } from "@/lib/public-origin";

export const runtime = "nodejs";

/** Start connecting the signed-in staff member's Google Calendar. */
export async function GET(req: Request) {
  try {
    const me = await requireStaff();
    if (!calendarConfigured()) return Response.redirect(publicUrl("/review/profile?calendar=not_configured", req), 303);
    const state = randomBytes(24).toString("base64url");
    (await cookies()).set("rp_gstate", `${state}.${me.id}`, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/api/google", maxAge: 600 });
    return Response.redirect(authorizationUrl({ origin: publicOrigin(req), state, loginHint: me.email }), 303);
  } catch (err) {
    if (err instanceof AuthError) return Response.redirect(publicUrl("/login?next=/review/profile", req), 303);
    throw err;
  }
}
