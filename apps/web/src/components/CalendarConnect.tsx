"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { ConfirmButton } from "@/components/ConfirmButton";

/** Connect or disconnect the signed-in staff member's Google Calendar. */
export function CalendarConnect({ connected, configured }: { connected: boolean; configured: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  if (!configured) return <p className="hint">Calendar booking isn&apos;t set up on this deployment yet (GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET).</p>;
  if (!connected) {
    return (
      <a className="btn" href="/api/google/connect">
        Connect Google Calendar
      </a>
    );
  }
  return (
    <div className="kb-actions">
      <a className="btn secondary" href="/api/google/connect">
        Reconnect
      </a>
      <ConfirmButton
        label="Disconnect"
        confirmLabel="Disconnect"
        tone="danger"
        question="Disconnect your calendar?"
        detail="You'll stop receiving callback bookings. Callbacks already booked stay on your calendar."
        busy={busy}
        onConfirm={async () => {
          setBusy(true);
          await fetch("/api/google/disconnect", { method: "POST" }).catch(() => {});
          setBusy(false);
          router.refresh();
        }}
      />
    </div>
  );
}
