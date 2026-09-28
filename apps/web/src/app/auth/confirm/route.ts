import { type NextRequest, NextResponse } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";
import { supabaseServer } from "@/lib/supabase/server";
import { publicUrl } from "@/lib/public-origin";

/**
 * Magic-link and invite landing (week 5). Supabase arrives in one of three
 * shapes depending on a dashboard setting, and all three are handled:
 * ?code= (PKCE), ?token_hash=&type= (the templates in supabase/email-templates),
 * or ?error= when Supabase rejected the link before redirecting.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const next = searchParams.get("next") ?? "/review";
  // App-relative only: "//evil.com" would make this an open redirect.
  const safeNext = next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\") ? next : "/review";
  const fail = (msg: string) => NextResponse.redirect(publicUrl(`/login?error=${encodeURIComponent(msg)}`, request));

  const supabaseError = searchParams.get("error_description") ?? searchParams.get("error");
  if (supabaseError) return fail(supabaseError);

  const supabase = await supabaseServer();

  const code = searchParams.get("code");
  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    return error ? fail(error.message) : NextResponse.redirect(publicUrl(safeNext, request));
  }

  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type") as EmailOtpType | null;
  if (tokenHash && type) {
    const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });
    return error ? fail(error.message) : NextResponse.redirect(publicUrl(safeNext, request));
  }

  return fail("link_missing_token");
}
