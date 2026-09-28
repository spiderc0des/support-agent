"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

export function ProfileForm({ fullName }: { fullName: string }) {
  const router = useRouter();
  const [name, setName] = useState(fullName);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const dirty = name.trim() !== fullName.trim();

  return (
    <form
      className="inline-form"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        const res = await fetch("/api/profile", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ full_name: name }) });
        const data = await res.json().catch(() => ({}));
        setBusy(false);
        setMsg({ ok: res.ok, text: res.ok ? "Saved." : (data.error ?? "Could not save") });
        if (res.ok) router.refresh();
      }}
    >
      <label className="label" htmlFor="full_name">
        Display name
      </label>
      <div className="inline-row">
        <input id="full_name" className="field" maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />
        <button type="submit" className="btn" disabled={busy || !dirty || !name.trim()}>
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
      <p className="hint">Shown to teammates on the cases you work.</p>
      {msg ? <p className={`notice ${msg.ok ? "ok" : "bad"}`}>{msg.text}</p> : null}
    </form>
  );
}
