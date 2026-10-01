import "server-only";
import { z } from "zod";
import { supabaseAdmin } from "@relaypay/shared/supabase";

/**
 * Soft delete and restore, admins only (the routes check the role).
 *
 *   case          a ticket and the escalation on it, together (they are one case)
 *   conversation  the call; its cases go with it, stamped with the same
 *                 deleted_at so restoring the call brings back exactly those
 *   eval_run      an eval run; its evaluations are hidden with it
 *
 * Nothing is removed from the database. Every delete and restore is recorded:
 * cases in case_events, conversations in conversation_events.
 */
export const DeletionRequest = z.object({
  action: z.enum(["delete", "restore"]),
  kind: z.enum(["case", "conversation", "eval_run"]),
  id: z.string().min(1).max(80),
  reason: z.string().trim().max(500).optional(),
});
export type DeletionRequest = z.infer<typeof DeletionRequest>;

export class DeletionError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409) {
    super(message);
  }
}

type Db = ReturnType<typeof supabaseAdmin>;

function check(error: { message: string } | null) {
  if (error) throw new Error(error.message);
}

async function caseRows(db: Db, ticketId: string) {
  const { data: ticket } = await db.from("support_tickets").select("ticket_id, deleted_at").eq("ticket_id", ticketId).maybeSingle();
  if (!ticket) throw new DeletionError(`Ticket ${ticketId} not found`, 404);
  const { data: esc } = await db.from("escalations").select("escalation_id").eq("ticket_id", ticketId).maybeSingle();
  return { ticket, escalationId: (esc?.escalation_id as string | undefined) ?? null };
}

async function stampCase(db: Db, ticketId: string, escalationId: string | null, stamp: Record<string, unknown>) {
  check((await db.from("support_tickets").update(stamp).eq("ticket_id", ticketId)).error);
  if (escalationId) check((await db.from("escalations").update(stamp).eq("escalation_id", escalationId)).error);
}

export async function applyDeletion(req: DeletionRequest, actorId: string): Promise<{ note: string }> {
  const db = supabaseAdmin();
  const now = new Date().toISOString();
  const deleting = req.action === "delete";
  if (deleting && (!req.reason || req.reason.length < 3)) throw new DeletionError("Give a reason for deleting this", 400);
  const stamp = deleting ? { deleted_at: now, deleted_by: actorId, delete_reason: req.reason } : { deleted_at: null, deleted_by: null, delete_reason: null };

  if (req.kind === "case") {
    const { ticket, escalationId } = await caseRows(db, req.id);
    if (deleting === Boolean(ticket.deleted_at)) throw new DeletionError(deleting ? "Already deleted" : "Not deleted", 409);
    await stampCase(db, req.id, escalationId, stamp);
    check(
      (await db.from("case_events").insert({
        ticket_id: req.id,
        escalation_id: escalationId,
        actor_id: actorId,
        action: deleting ? "deleted" : "restored",
        note: deleting ? req.reason : null,
      })).error,
    );
    return { note: `${req.id}${escalationId ? ` and ${escalationId}` : ""} ${deleting ? "deleted" : "restored"}.` };
  }

  if (req.kind === "conversation") {
    const { data: conv } = await db.from("conversations").select("id, deleted_at").eq("id", req.id).maybeSingle();
    if (!conv) throw new DeletionError("Conversation not found", 404);
    if (deleting === Boolean(conv.deleted_at)) throw new DeletionError(deleting ? "Already deleted" : "Not deleted", 409);

    // Cases go with the call. On restore, only the cases deleted with it come back.
    let tq = db.from("support_tickets").select("ticket_id").eq("conversation_id", req.id);
    tq = deleting ? tq.is("deleted_at", null) : tq.eq("deleted_at", conv.deleted_at);
    const { data: tickets } = await tq;
    const ticketIds = (tickets ?? []).map((t) => t.ticket_id as string);
    for (const id of ticketIds) {
      const { escalationId } = await caseRows(db, id);
      await stampCase(db, id, escalationId, stamp);
      check(
        (await db.from("case_events").insert({
          ticket_id: id,
          escalation_id: escalationId,
          actor_id: actorId,
          action: deleting ? "deleted" : "restored",
          note: deleting ? `With its conversation: ${req.reason}` : "With its conversation",
        })).error,
      );
    }
    check((await db.from("conversations").update(stamp).eq("id", req.id)).error);
    check(
      (await db.from("conversation_events").insert({
        conversation_id: req.id,
        event_type: deleting ? "record_deleted" : "record_restored",
        summary: deleting ? `Conversation deleted: ${req.reason}` : "Conversation restored",
        metadata: { actor_id: actorId, cases: ticketIds },
        source: "system",
      })).error,
    );
    const cases = ticketIds.length ? ` with ${ticketIds.length} case${ticketIds.length === 1 ? "" : "s"}` : "";
    return { note: `Conversation ${deleting ? "deleted" : "restored"}${cases}.` };
  }

  // eval_run
  const { data: run } = await db.from("eval_runs").select("id, deleted_at").eq("id", req.id).maybeSingle();
  if (!run) throw new DeletionError("Eval run not found", 404);
  if (deleting === Boolean(run.deleted_at)) throw new DeletionError(deleting ? "Already deleted" : "Not deleted", 409);
  check((await db.from("eval_runs").update(stamp).eq("id", req.id)).error);
  return { note: `Eval run ${deleting ? "deleted" : "restored"}.` };
}
