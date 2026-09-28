"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabase/client";
import { Logo } from "@/components/Logo";

function LoginForm() {
  const params = useSearchParams();
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const linkError = params.get("error");

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const next = params.get("next") ?? "/review";
    // shouldCreateUser:false closes signup: an address never invited gets no link.
    await supabaseBrowser().auth.signInWithOtp({
      email: email.trim(),
      options: { shouldCreateUser: false, emailRedirectTo: `${window.location.origin}/auth/confirm?next=${encodeURIComponent(next)}` },
    });
    // Same response whether or not the address exists: the form must not reveal who has access.
    setBusy(false);
    setSent(true);
  }

  return (
    <div className="page">
      <header className="header">
        <Logo />
      </header>
      <main className="main">
        <section className="card">
          <h1>Support review</h1>
          <p className="lede">Conversation logs, tool calls, tickets, escalations and evaluations. Access is invite-only.</p>
          {linkError ? (
            <p className="error">That sign-in link did not work ({linkError}). Links are single-use and expire; request a new one.</p>
          ) : null}
          {sent ? (
            <p>
              If <strong>{email}</strong> has access, a sign-in link is on its way.{" "}
              <button className="linklike" onClick={() => setSent(false)}>
                Use a different address
              </button>
            </p>
          ) : (
            <form onSubmit={onSubmit}>
              <label htmlFor="email" className="label">
                Email address
              </label>
              <input
                id="email"
                className="field"
                type="email"
                required
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
              <button className="btn" type="submit" disabled={busy}>
                {busy ? "Sending…" : "Send sign-in link"}
              </button>
            </form>
          )}
        </section>
      </main>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
