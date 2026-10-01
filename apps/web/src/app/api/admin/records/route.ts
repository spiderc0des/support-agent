import { requireAdmin, errorResponse } from "@/lib/auth";
import { applyDeletion, DeletionError, DeletionRequest } from "@/lib/deletions";

export const runtime = "nodejs";

/** Soft delete or restore a case, conversation or eval run. Admins only. */
export async function POST(req: Request) {
  try {
    const admin = await requireAdmin();
    const parsed = DeletionRequest.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message ?? "Invalid request" }, { status: 400 });
    return Response.json(await applyDeletion(parsed.data, admin.id));
  } catch (err) {
    if (err instanceof DeletionError) return Response.json({ error: err.message }, { status: err.status });
    return errorResponse(err);
  }
}
