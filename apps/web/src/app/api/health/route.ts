import { activeSessionCount } from "@/agent/turns";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Liveness for Railway. No database call, no secrets. */
export function GET() {
  return Response.json({ ok: true, activeSessions: activeSessionCount() });
}
