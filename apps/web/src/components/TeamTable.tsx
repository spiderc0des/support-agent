"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { ConfirmButton } from "@/components/ConfirmButton";
import { When } from "@/components/When";

export type TeamMember = {
  id: string;
  email: string;
  full_name: string | null;
  role: "support_agent" | "admin";
  last_sign_in_at: string | null;
  open_cases: number;
};

/**
 * The support team. An admin can change anyone's role or remove them, except
 * themselves: the server refuses that, since the last admin doing it would
 * lock everyone out.
 */
export function TeamTable({ members, meId }: { members: TeamMember[]; meId: string }) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  async function call(id: string, method: "PATCH" | "DELETE", body?: Record<string, string>) {
    setBusyId(id);
    setNote(null);
    const res = await fetch(`/api/admin/users/${id}`, {
      method,
      headers: { "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    setBusyId(null);
    setNote({ ok: res.ok, text: res.ok ? data.note : (data.error ?? `Failed (${res.status})`) });
    if (res.ok) router.refresh();
  }

  return (
    <div>
      <table className="table responsive">
        <thead>
          <tr>
            <th>Name</th>
            <th>Email</th>
            <th>Role</th>
            <th>Open cases</th>
            <th>Last sign-in</th>
            <th aria-label="Actions" />
          </tr>
        </thead>
        <tbody>
          {members.map((m) => {
            const me = m.id === meId;
            const name = m.full_name || m.email;
            const busy = busyId === m.id;
            return (
              <tr key={m.id}>
                <td data-label="Name">
                  {m.full_name ?? <span className="muted">no name yet</span>}
                  {me ? <span className="muted"> (you)</span> : null}
                </td>
                <td data-label="Email">{m.email}</td>
                <td data-label="Role">
                  <span className={`pill ${m.role === "admin" ? "progress" : "neutral"}`}>{m.role === "admin" ? "Admin" : "Support agent"}</span>
                </td>
                <td data-label="Open cases">{m.open_cases}</td>
                <td data-label="Last sign-in">{m.last_sign_in_at ? <When iso={m.last_sign_in_at} mode="relative" /> : <span className="muted">invited, not signed in</span>}</td>
                <td className="row-actions">
                  {me ? (
                    <span className="muted">your account</span>
                  ) : (
                    <>
                      {m.role === "admin" ? (
                        <ConfirmButton
                          label="Make agent"
                          confirmLabel="Change role"
                          question={`Make ${name} a support agent?`}
                          detail="They keep working cases but lose the admin page: invites, roles and system settings."
                          busy={busy}
                          onConfirm={() => call(m.id, "PATCH", { role: "support_agent" })}
                        />
                      ) : (
                        <ConfirmButton
                          label="Make admin"
                          confirmLabel="Make admin"
                          question={`Make ${name} an admin?`}
                          detail="Admins can invite and remove people, change roles, and see system settings."
                          busy={busy}
                          onConfirm={() => call(m.id, "PATCH", { role: "admin" })}
                        />
                      )}
                      <ConfirmButton
                        label="Remove"
                        confirmLabel="Remove access"
                        question={`Remove ${name}?`}
                        detail={`They can no longer sign in.${m.open_cases ? ` Their ${m.open_cases} open case(s) become unassigned.` : ""} Their past activity stays on record.`}
                        tone="danger"
                        busy={busy}
                        onConfirm={() => call(m.id, "DELETE")}
                      />
                    </>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {note ? <p className={`notice ${note.ok ? "ok" : "bad"}`}>{note.text}</p> : null}
    </div>
  );
}
