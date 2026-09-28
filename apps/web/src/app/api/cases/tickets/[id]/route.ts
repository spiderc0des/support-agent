import { requireStaff, errorResponse } from "@/lib/auth";
import { applyCaseChange, CaseChange, CaseError } from "@/lib/cases";

export const runtime = "nodejs";

/** Change a ticket's status, assignee, or add a note. Any support agent or admin. */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireStaff();
    const parsed = CaseChange.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message ?? "Invalid change" }, { status: 400 });
    const { id } = await ctx.params;
    return Response.json(await applyCaseChange("ticket", id, parsed.data, actor));
  } catch (err) {
    if (err instanceof CaseError) return Response.json({ error: err.message }, { status: err.status });
    return errorResponse(err);
  }
}
