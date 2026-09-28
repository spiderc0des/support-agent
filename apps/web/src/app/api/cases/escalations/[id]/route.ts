import { requireStaff, errorResponse } from "@/lib/auth";
import { applyCaseChange, CaseChange, CaseError } from "@/lib/cases";

export const runtime = "nodejs";

/** Change an escalation's status, assignee or callback time, or add a note. Any support agent or admin. */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireStaff();
    const parsed = CaseChange.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message ?? "Invalid change" }, { status: 400 });
    const { id } = await ctx.params;
    return Response.json(await applyCaseChange("escalation", id, parsed.data, actor));
  } catch (err) {
    if (err instanceof CaseError) return Response.json({ error: err.message }, { status: err.status });
    return errorResponse(err);
  }
}
