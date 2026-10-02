import { type NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { publicUrl } from "@/lib/public-origin";

/**
 * Gates the review dashboard behind sign-in and keeps its session fresh.
 * (Next 16 names this convention `proxy`; it was `middleware`.)
 *
 * Only /review is protected. The voice page must be public, and the Vapi
 * endpoints authenticate with Vapi's own secret, not a browser session, so
 * the matcher leaves both alone entirely.
 */
export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) response.cookies.set(name, value, options);
      },
    },
  });

  // getClaims() verifies the access token's signature locally against the
  // project's published signing key (ES256, cached), refreshing the session
  // first if it has expired. getUser() made a network round trip to Supabase
  // Auth on every click, which was most of the delay between pages.
  const { data } = await supabase.auth.getClaims();

  if (!data?.claims?.sub) {
    const url = publicUrl("/login", request);
    url.searchParams.set("next", request.nextUrl.pathname);
    return NextResponse.redirect(url);
  }
  return response;
}

export const config = {
  matcher: ["/review/:path*"],
};
