"use client";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ConfirmButton } from "@/components/ConfirmButton";

export type RotaRow = {
  profile_id: string;
  name: string;
  email: string;
  calendar: "connected" | "error" | "none";
  takes_callbacks: boolean;
  timezone: string;
  work_days: number[];
  work_start: string;
  work_end: string;
};

const DAYS = [
  [1, "Mon"],
  [2, "Tue"],
  [3, "Wed"],
  [4, "Thu"],
  [5, "Fri"],
  [6, "Sat"],
  [7, "Sun"],
] as const;
const ZONES = ["Africa/Lagos", "Africa/Accra", "Africa/Nairobi", "Africa/Johannesburg", "Africa/Kigali", "Africa/Cairo", "Europe/London", "UTC"];

/**
 * The callback rota: who takes callbacks, their hours, and the order the
 * booking tries them in. The first person in the list who is working and free
 * at the requested time gets the callback and the case.
 */
export function CallbackRota({ initial }: { initial: RotaRow[] }) {
  const router = useRouter();
  const [rows, setRows] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const dirty = useMemo(() => JSON.stringify(rows) !== JSON.stringify(initial), [rows, initial]);

  const update = (i: number, patch: Partial<RotaRow>) => setRows((r) => r.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const move = (i: number, by: -1 | 1) =>
    setRows((r) => {
      const j = i + by;
      if (j < 0 || j >= r.length) return r;
      const next = [...r];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });

  async function save() {
    setBusy(true);
    setResult(null);
    const res = await fetch("/api/admin/callback-rota", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agents: rows.map(({ profile_id, takes_callbacks, timezone, work_days, work_start, work_end }) => ({
          profile_id, takes_callbacks, timezone, work_days, work_start: work_start.slice(0, 5), work_end: work_end.slice(0, 5),
        })),
      }),
    });
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    setResult({ ok: res.ok, text: res.ok ? "Saved. New callbacks follow this order." : (data.error ?? `Failed (${res.status})`) });
    if (res.ok) router.refresh();
  }

  if (!rows.length) return <p className="empty">No support agents or admins yet.</p>;
  const active = rows.filter((r) => r.takes_callbacks && r.calendar !== "none").length;

  return (
    <>
      <div className="table-wrap">
        <table className="table rota">
          <thead>
            <tr>
              <th>Order</th>
              <th>Person</th>
              <th>Takes callbacks</th>
              <th>Working days</th>
              <th>Hours</th>
              <th>Time zone</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.profile_id} className={r.takes_callbacks ? "" : "off"}>
                <td className="rota-order">
                  <span className="num">{i + 1}</span>
                  <span className="rota-move">
                    <button type="button" className="btn small secondary" aria-label={`Move ${r.name} up`} disabled={i === 0 || busy} onClick={() => move(i, -1)}>
                      ↑
                    </button>
                    <button type="button" className="btn small secondary" aria-label={`Move ${r.name} down`} disabled={i === rows.length - 1 || busy} onClick={() => move(i, 1)}>
                      ↓
                    </button>
                  </span>
                </td>
                <td>
                  <strong>{r.name}</strong>
                  <div className="muted">{r.email}</div>
                  {r.calendar === "connected" ? (
                    <span className="pill done">calendar connected</span>
                  ) : r.calendar === "error" ? (
                    <span className="pill attention">calendar check failing</span>
                  ) : (
                    <span className="pill attention">no calendar: can&apos;t be booked</span>
                  )}
                </td>
                <td>
                  <label className="check">
                    <input type="checkbox" checked={r.takes_callbacks} onChange={(e) => update(i, { takes_callbacks: e.target.checked })} disabled={busy} />
                    {r.takes_callbacks ? "Yes" : "No"}
                  </label>
                </td>
                <td>
                  <div className="day-picks">
                    {DAYS.map(([d, label]) => (
                      <label key={d} className={`day ${r.work_days.includes(d) ? "on" : ""}`}>
                        <input
                          type="checkbox"
                          checked={r.work_days.includes(d)}
                          disabled={busy}
                          onChange={(e) => update(i, { work_days: e.target.checked ? [...r.work_days, d].sort() : r.work_days.filter((x) => x !== d) })}
                        />
                        {label}
                      </label>
                    ))}
                  </div>
                </td>
                <td>
                  <div className="hours">
                    <input type="time" className="field select-inline" step={1800} value={r.work_start.slice(0, 5)} onChange={(e) => update(i, { work_start: e.target.value })} disabled={busy} aria-label={`${r.name} starts`} />
                    <span>–</span>
                    <input type="time" className="field select-inline" step={1800} value={r.work_end.slice(0, 5)} onChange={(e) => update(i, { work_end: e.target.value })} disabled={busy} aria-label={`${r.name} ends`} />
                  </div>
                </td>
                <td>
                  <input
                    className="field select-inline"
                    list="rota-zones"
                    value={r.timezone}
                    onChange={(e) => update(i, { timezone: e.target.value })}
                    disabled={busy}
                    aria-label={`${r.name} time zone`}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <datalist id="rota-zones">
          {ZONES.map((z) => (
            <option key={z} value={z} />
          ))}
        </datalist>
      </div>
      <div className="kb-actions">
        <ConfirmButton
          label="Save callback order"
          confirmLabel="Save"
          variant="primary"
          question="Save the callback order and hours?"
          detail="Bookings already made stay with the person they were booked with."
          disabled={!dirty}
          busy={busy}
          busyLabel="Saving…"
          onConfirm={save}
        />
        {dirty ? (
          <button type="button" className="btn secondary" onClick={() => setRows(initial)} disabled={busy}>
            Undo changes
          </button>
        ) : null}
      </div>
      <p className="hint">
        {active} of {rows.length} can be booked now. People need a connected Google Calendar (from their Profile page) to receive callbacks.
      </p>
      {result ? <p className={`notice ${result.ok ? "ok" : "bad"}`}>{result.text}</p> : null}
    </>
  );
}
