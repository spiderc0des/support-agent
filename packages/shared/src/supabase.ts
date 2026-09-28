import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Service-role client. Bypasses RLS, so it must only ever run server-side:
 * in the MCP server, the orchestrator's API routes, and the scripts.
 *
 * The URL guard is carried over from week 5. supabase-js appends /rest/v1
 * itself, and a URL that already carries a path fails with errors that never
 * mention the cause.
 */
let cached: SupabaseClient | null = null;

export function supabaseAdmin(): SupabaseClient {
  if (cached) return cached;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL) or SUPABASE_SERVICE_ROLE_KEY. Copy .env.example to .env and fill it in.",
    );
  }

  const parsed = new URL(url);
  if (parsed.pathname.replace(/\/$/, "") !== "") {
    throw new Error(`The Supabase URL must be the bare project URL with no path. Got ${url}; use ${parsed.origin}.`);
  }

  cached = createClient(parsed.origin, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return cached;
}
