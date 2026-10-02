import { cookies } from "next/headers";
import { CALLER_COOKIE, attachSessionToCall, callerSessionById } from "@/lib/caller";

export const runtime = "nodejs";

/** The voice page reports the Vapi call it just started, so the call knows who is on it. */
export async function POST(req: Request) {
  const session = await callerSessionById((await cookies()).get(CALLER_COOKIE)?.value);
  if (!session) return Response.json({ error: "Not signed in" }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { callId?: unknown };
  const callId = typeof body.callId === "string" && /^[\w-]{8,80}$/.test(body.callId) ? body.callId : null;
  if (!callId) return Response.json({ error: "callId required" }, { status: 400 });
  await attachSessionToCall(session.id, callId);
  return Response.json({ ok: true });
}
