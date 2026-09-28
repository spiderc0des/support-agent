"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

/** Invite a support agent or admin (week 5). Signup is closed; this is the only way in. */
export function InviteForm() {
  const router = useRouter();
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"support_agent" | "admin">("support_agent");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setResult(null);
    const res = await fetch("/api/admin/invite", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, full_name: fullName, role }),
    });
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    setResult({ ok: res.ok, text: res.ok ? data.note : (data.error ?? `Failed (${res.status})`) });
    if (res.ok) {
      setFullName("");
      setEmail("");
      setRole("support_agent");
      router.refresh();
    }
  }

  return (
    <form onSubmit={submit} className="invite-form">
      <label>
        <span className="label">Full name</span>
        <input className="field" required maxLength={120} value={fullName} onChange={(e) => setFullName(e.target.value)} disabled={busy} />
      </label>
      <label>
        <span className="label">Email</span>
        <input className="field" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} disabled={busy} />
      </label>
      <label>
        <span className="label">Role</span>
        <select className="field" value={role} onChange={(e) => setRole(e.target.value as typeof role)} disabled={busy}>
          <option value="support_agent">Support agent</option>
          <option value="admin">Admin</option>
        </select>
      </label>
      <button type="submit" className="btn" disabled={busy || !fullName.trim() || !email.includes("@")}>
        {busy ? "Sending…" : "Send invite"}
      </button>
      <p className="hint span-all">
        {role === "admin"
          ? "Admins can do everything agents can, and also invite people, change roles and see system settings."
          : "Support agents can read every conversation and work tickets and escalations."}
      </p>
      {result ? <p className={`notice span-all ${result.ok ? "ok" : "bad"}`}>{result.text}</p> : null}
    </form>
  );
}
