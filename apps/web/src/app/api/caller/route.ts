import { cookies } from "next/headers";
import { CALLER_COOKIE, KnowMeError, KnowMeRequest, cookieOptions, createCallerSession } from "@/lib/caller";

export const runtime = "nodejs";

// A handful of attempts per address per minute: enough for typos, too few
// to guess customer IDs against an email.
const attempts = new Map<string, number[]>();
function limited(key: string): boolean {
  const now = Date.now();
  const recent = (attempts.get(key) ?? []).filter((t) => now - t < 60_000);
  recent.push(now);
  attempts.set(key, recent);
  return recent.length > 6;
}

/** "Know me": sign in as a customer or a guest before a call. */
export async function POST(req: Request) {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  if (limited(ip)) return Response.json({ error: "Too many attempts. Wait a minute and try again." }, { status: 429 });
  const parsed = KnowMeRequest.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message ?? "Check the form." }, { status: 400 });
  try {
    const session = await createCallerSession(parsed.data);
    (await cookies()).set(CALLER_COOKIE, session.id, cookieOptions());
    return Response.json({ name: session.name, kind: session.kind, company_name: session.company_name });
  } catch (err) {
    if (err instanceof KnowMeError) return Response.json({ error: err.message }, { status: 401 });
    console.error("[caller]", err);
    return Response.json({ error: "We couldn't sign you in just now. Please try again." }, { status: 500 });
  }
}

/** "Not you?": forget the caller on this browser. */
export async function DELETE() {
  (await cookies()).delete(CALLER_COOKIE);
  return Response.json({ ok: true });
}
