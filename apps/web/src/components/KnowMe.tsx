"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * "Know me": sign in before a call, so the agent greets the caller by name
 * and never asks them to spell a name or an email over the phone.
 *   Customer  account email + customer ID; the call starts verified.
 *   Guest     a name to be called by + an email for follow-up.
 */
export function KnowMe() {
  const router = useRouter();
  const [kind, setKind] = useState<"customer" | "guest">("customer");
  const [email, setEmail] = useState("");
  const [customerId, setCustomerId] = useState("");
  const [name, setName] = useState("");
  const [company, setCompany] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    let timezone: string | undefined;
    try {
      timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {
      timezone = undefined;
    }
    const body = kind === "customer" ? { kind, email, customer_id: customerId, timezone } : { kind, name, email, company_name: company.trim() || undefined, timezone };
    const res = await fetch("/api/caller", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      setError(data.error ?? "We couldn't sign you in. Please try again.");
      return;
    }
    router.refresh();
  }

  const ready = kind === "customer" ? email.includes("@") && customerId.trim().length >= 3 : name.trim() && email.includes("@");

  return (
    <div className="know-me">
      <h2>Before you call</h2>
      <p className="muted">Tell us who you are, so the assistant can greet you by name and you won&apos;t need to spell anything out.</p>
      <div className="segmented" role="tablist" aria-label="Who is calling">
        <button type="button" role="tab" aria-selected={kind === "customer"} className={kind === "customer" ? "on" : ""} onClick={() => setKind("customer")}>
          I&apos;m a customer
        </button>
        <button type="button" role="tab" aria-selected={kind === "guest"} className={kind === "guest" ? "on" : ""} onClick={() => setKind("guest")}>
          I&apos;m a guest
        </button>
      </div>
      <form onSubmit={submit} className="stack-form know-me-form">
        {kind === "customer" ? (
          <>
            <label htmlFor="km-email" className="label">
              Account email
            </label>
            <input id="km-email" className="field" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} disabled={busy} />
            <label htmlFor="km-id" className="label">
              Customer ID
            </label>
            <input
              id="km-id"
              className="field"
              placeholder="e.g. CUS-1234"
              autoComplete="off"
              autoCapitalize="characters"
              required
              value={customerId}
              onChange={(e) => setCustomerId(e.target.value)}
              disabled={busy}
            />
            <p className="hint">Your customer ID is on your RelayPay dashboard under Account settings.</p>
          </>
        ) : (
          <>
            <label htmlFor="km-name" className="label">
              What should we call you?
            </label>
            <input id="km-name" className="field" autoComplete="name" required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} disabled={busy} />
            <label htmlFor="km-gemail" className="label">
              Email
            </label>
            <input id="km-gemail" className="field" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} disabled={busy} />
            <label htmlFor="km-company" className="label">
              Company <span className="muted">(optional)</span>
            </label>
            <input id="km-company" className="field" autoComplete="organization" maxLength={200} value={company} onChange={(e) => setCompany(e.target.value)} disabled={busy} />
            <p className="hint">Your email is used only if a specialist needs to follow up. Add your company if you want to discuss its account.</p>
          </>
        )}
        {error ? <p className="notice bad">{error}</p> : null}
        <button type="submit" className="btn" disabled={busy || !ready}>
          {busy ? "Checking…" : "Continue"}
        </button>
      </form>
    </div>
  );
}

/** Who is about to call, with a way out if it's the wrong person. */
export function CallerBadge({ name, detail }: { name: string; detail: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <div className="caller-badge">
      <span>
        Calling as <strong>{name}</strong>
        <span className="muted"> · {detail}</span>
      </span>
      <button
        type="button"
        className="linklike"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          await fetch("/api/caller", { method: "DELETE" }).catch(() => {});
          router.refresh();
        }}
      >
        Not you?
      </button>
    </div>
  );
}
