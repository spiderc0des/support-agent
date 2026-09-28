import "server-only";
import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";

/**
 * Anon-key client carrying the signed-in reviewer's session. RLS applies:
 * only admins can read anything (0004_auth_rls.sql), and nobody can write.
 * The review dashboard reads through this, never the service role, so the
 * policies are what actually protect the logs.
 */
export async function supabaseServer() {
  const cookieStore = await cookies();
  return createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) cookieStore.set(name, value, options);
        } catch {
          // Server Components cannot set cookies; proxy.ts refreshes the session.
        }
      },
    },
  });
}
