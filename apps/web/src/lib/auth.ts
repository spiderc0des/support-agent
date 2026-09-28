import "server-only";
import { supabaseAdmin } from "@relaypay/shared/supabase";
import type { StaffRole } from "@relaypay/shared/enums";
import { supabaseServer } from "@/lib/supabase/server";

/**
 * Who is signed in, and what they may do. Carried over from week 5 with two
 * staff roles:
 *   support_agent  works tickets and escalations, reads every support record
 *   admin          also manages people and sees system settings
 *
 * Pages use these to decide what to render; API routes use them to refuse.
 * RLS (0005) enforces the same split for reads underneath.
 */
export type Profile = { id: string; email: string; full_name: string | null; role: StaffRole | null };

export class AuthError extends Error {
  constructor(message: string, readonly status: 401 | 403) {
    super(message);
  }
}

export async function currentProfile(): Promise<Profile | null> {
  const supabase = await supabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  // Service role: a brand-new user may race the signup trigger, and a missing
  // profile should read as "no role", not as an error page.
  const { data } = await supabaseAdmin().from("profiles").select("id, email, full_name, role").eq("id", user.id).maybeSingle();
  if (!data) return { id: user.id, email: user.email ?? "", full_name: null, role: null };
  const role = data.role === "admin" || data.role === "support_agent" ? data.role : null;
  return { id: data.id, email: data.email, full_name: data.full_name, role };
}

export async function requireStaff(): Promise<Profile & { role: StaffRole }> {
  const p = await currentProfile();
  if (!p) throw new AuthError("Not signed in", 401);
  if (!p.role) throw new AuthError("Your account has no support role", 403);
  return p as Profile & { role: StaffRole };
}

export async function requireAdmin(): Promise<Profile & { role: "admin" }> {
  const p = await requireStaff();
  if (p.role !== "admin") throw new AuthError("Admins only", 403);
  return p as Profile & { role: "admin" };
}

/** Turn an AuthError (or anything else) into a JSON response. */
export function errorResponse(err: unknown): Response {
  if (err instanceof AuthError) return Response.json({ error: err.message }, { status: err.status });
  console.error("[api]", err);
  return Response.json({ error: err instanceof Error ? err.message : "Unexpected error" }, { status: 500 });
}

export function displayName(p: { full_name?: string | null; email?: string | null }): string {
  return p.full_name?.trim() || p.email?.split("@")[0] || "Unknown";
}

export function initials(p: { full_name?: string | null; email?: string | null }): string {
  const parts = displayName(p).split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase() || "?";
}
