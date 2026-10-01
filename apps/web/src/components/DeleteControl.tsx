"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { ConfirmButton } from "@/components/ConfirmButton";

type Kind = "case" | "conversation" | "eval_run";

/**
 * Admin-only soft delete with a required reason, and restore. Nothing is
 * removed: the record is hidden from the queues and counts, and can be
 * brought back from the same place or from Admin → Recently deleted.
 */
export function DeleteControl({ kind, id, label, detail, deleted, afterDelete }: {
  kind: Kind;
  id: string;
  /** e.g. "TCK-1002 and ESC-101" */
  label: string;
  detail: string;
  deleted: boolean;
  /** Where to go after deleting (the record vanishes from lists). */
  afterDelete?: string;
}) {
  const router = useRouter();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function send(action: "delete" | "restore") {
    setBusy(true);
    setMsg(null);
    const res = await fetch("/api/admin/records", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, kind, id, reason: reason.trim() || undefined }),
    });
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    setMsg({ ok: res.ok, text: res.ok ? data.note : (data.error ?? `Failed (${res.status})`) });
    if (res.ok) {
      setReason("");
      if (action === "delete" && afterDelete) router.push(afterDelete);
      else router.refresh();
    }
    return res.ok;
  }

  return (
    <div className="delete-control">
      {deleted ? (
        <ConfirmButton
          label="Restore"
          confirmLabel="Restore"
          question={`Restore ${label}?`}
          detail="It goes back into the queues and counts as it was."
          busy={busy}
          onConfirm={() => send("restore")}
        />
      ) : (
        <ConfirmButton
          label="Delete"
          confirmLabel={`Delete ${kind === "eval_run" ? "run" : kind}`}
          question={`Delete ${label}?`}
          detail={detail}
          tone="danger"
          busy={busy}
          onConfirm={async () => {
            if (reason.trim().length < 3) {
              setMsg({ ok: false, text: "Give a reason for deleting this." });
              return false;
            }
            return send("delete");
          }}
        >
          <textarea
            className="field"
            rows={2}
            placeholder="Reason, for example: test call, duplicate, created by mistake"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            aria-label="Reason for deleting"
          />
        </ConfirmButton>
      )}
      {msg ? <p className={`notice ${msg.ok ? "ok" : "bad"}`}>{msg.text}</p> : null}
    </div>
  );
}

/** Shown on a deleted record's page (admins only ever reach one). */
export function DeletedBanner({ when, by, reason }: { when: string; by: string | null; reason: string | null }) {
  return (
    <p className="notice bad deleted-banner">
      <strong>Deleted</strong> {new Date(when).toLocaleString()}
      {by ? ` by ${by}` : ""}
      {reason ? `: ${reason}` : ""}. Hidden from every queue and count; restore it below.
    </p>
  );
}
