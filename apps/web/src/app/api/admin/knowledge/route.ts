import { requireAdmin, errorResponse } from "@/lib/auth";
import { KnowledgeError, PublishRequest, publishKnowledgeBase } from "@/lib/knowledge";

export const runtime = "nodejs";

/**
 * Check or publish a knowledge-base edit. Admins only.
 *   mode "check"    measure the change on the real search, then roll it back
 *   mode "publish"  re-ingest it; refused if retrieval regresses, unless force
 */
export async function POST(req: Request) {
  try {
    const admin = await requireAdmin();
    const parsed = PublishRequest.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message ?? "Invalid request" }, { status: 400 });
    return Response.json(await publishKnowledgeBase(parsed.data, admin.id));
  } catch (err) {
    if (err instanceof KnowledgeError) return Response.json({ error: err.message }, { status: 400 });
    return errorResponse(err);
  }
}
