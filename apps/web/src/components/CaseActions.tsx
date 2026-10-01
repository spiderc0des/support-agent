"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { ConfirmButton } from "@/components/ConfirmButton";

/**
 * Working a ticket or escalation: take it, move it along, close it with a
 * resolution note, schedule a callback, or leave a note. Every button that
 * changes the case asks first and says what will happen; every change lands
 * in the case's activity log.
 */
export function CaseActions({
  kind,
  id,
  status,
  assignedToMe,
  assigneeName,
  meId,
  caseLabel,
}: {
  /** How the case is named in confirmations, e.g. "TCK-1002 and ESC-101". Defaults to the id. */
  caseLabel?: string;
  kind: "ticket" | "escalation";
  id: string;
  status: string;
  assignedToMe: boolean;
  assigneeName: string | null;
  meId: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [resolution, setResolution] = useState("");
  const [note, setNote] = useState("");
  const [callback, setCallback] = useState("");
  // A ticket with an escalation on it is one case; actions apply to both.
  const noun = caseLabel ? "case" : kind === "ticket" ? "ticket" : "escalation";
  const label = caseLabel ?? id;

  async function send(body: Record<string, unknown>, success: string) {
    setBusy(true);
    setMessage(null);
    const res = await fetch(`/api/cases/${kind === "ticket" ? "tickets" : "escalations"}/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    setMessage({ ok: res.ok, text: res.ok ? success : (data.error ?? `Failed (${res.status})`) });
    if (res.ok) router.refresh();
    return res.ok;
  }

  return (
    <div className="case-actions">
      <div className="action-row">
        {assignedToMe ? (
          <ConfirmButton
            label="Release"
            confirmLabel="Release it"
            question={`Release ${label}?`}
            detail="It goes back to the unassigned queue for anyone to pick up."
            busy={busy}
            onConfirm={() => send({ assign: "none" }, "Released.").then(() => undefined)}
          />
        ) : (
          <ConfirmButton
            label={assigneeName ? `Take over from ${assigneeName}` : "Assign to me"}
            confirmLabel="Assign to me"
            question={`Take ${label}?`}
            detail={assigneeName ? `${assigneeName} is working on it now. They'll no longer be the owner.` : `You'll be the owner of this ${noun}.`}
            variant="primary"
            busy={busy}
            onConfirm={() => send({ assign: meId }, "Assigned to you.").then(() => undefined)}
          />
        )}

        {status === "open" ? (
          <ConfirmButton
            label="Start work"
            confirmLabel="Mark in progress"
            question={`Mark ${label} as in progress?`}
            detail={assignedToMe ? undefined : "It will also be assigned to you."}
            busy={busy}
            onConfirm={() =>
              send({ status: "in_progress", ...(assignedToMe ? {} : { assign: meId }) }, "Marked in progress.").then(() => undefined)
            }
          />
        ) : null}

        {status !== "closed" ? (
          <ConfirmButton
            label={`Close ${noun}`}
            confirmLabel={`Close ${noun}`}
            question={`Close ${label}?`}
            detail="Say what was done. The note is kept on the record."
            tone="danger"
            busy={busy}
            onConfirm={async () => {
              if (resolution.trim().length < 2) {
                setMessage({ ok: false, text: "Add a resolution note first." });
                return false;
              }
              const ok = await send({ status: "closed", note: resolution.trim() }, `${label} closed.`);
              if (ok) setResolution("");
              return ok;
            }}
          >
            <textarea
              className="field"
              rows={3}
              placeholder="Resolution, for example: called the customer, beneficiary details corrected, payout re-sent."
              value={resolution}
              onChange={(e) => setResolution(e.target.value)}
              aria-label="Resolution note"
            />
          </ConfirmButton>
        ) : (
          <ConfirmButton
            label="Reopen"
            confirmLabel="Reopen"
            question={`Reopen ${label}?`}
            detail="It goes back to open."
            busy={busy}
            onConfirm={() => send({ status: "open" }, "Reopened.").then(() => undefined)}
          />
        )}
      </div>

      {kind === "escalation" && status !== "closed" ? (
        <form
          className="inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!callback) return;
            void send({ callback_at: new Date(callback).toISOString() }, "Callback time saved.").then((ok) => ok && setCallback(""));
          }}
        >
          <label className="label" htmlFor={`cb-${id}`}>
            Confirmed callback time
          </label>
          <div className="inline-row">
            <input id={`cb-${id}`} type="datetime-local" className="field" value={callback} onChange={(e) => setCallback(e.target.value)} />
            <button type="submit" className="btn secondary" disabled={busy || !callback}>
              Save time
            </button>
          </div>
        </form>
      ) : null}

      <form
        className="inline-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (note.trim().length < 2) return;
          void send({ note: note.trim() }, "Note added.").then((ok) => ok && setNote(""));
        }}
      >
        <label className="label" htmlFor={`note-${id}`}>
          Add a note
        </label>
        <div className="inline-row">
          <input id={`note-${id}`} className="field" value={note} maxLength={2000} placeholder="Visible to the support team only" onChange={(e) => setNote(e.target.value)} />
          <button type="submit" className="btn secondary" disabled={busy || note.trim().length < 2}>
            Add note
          </button>
        </div>
      </form>

      {message ? <p className={`notice ${message.ok ? "ok" : "bad"}`}>{message.text}</p> : null}
    </div>
  );
}
