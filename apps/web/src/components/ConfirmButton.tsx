"use client";
import { useEffect, useRef, useState } from "react";

/**
 * A button that asks before it acts (week 5).
 *
 * Reveal-in-place rather than window.confirm(): the native dialog can't name
 * the thing being acted on, can't be styled, and reads as a browser warning.
 * The confirm button says what will happen ("Close ticket"), never "OK".
 * Escape or a click outside backs out.
 */
export function ConfirmButton({
  label,
  confirmLabel,
  question,
  detail,
  tone = "default",
  variant = "secondary",
  disabled,
  busy,
  busyLabel,
  onConfirm,
  children,
}: {
  label: string;
  confirmLabel: string;
  question: string;
  detail?: string;
  tone?: "default" | "danger";
  variant?: "primary" | "secondary";
  disabled?: boolean;
  busy?: boolean;
  busyLabel?: string;
  /** Return false to keep the confirmation open (for example, a required note is missing). */
  onConfirm: () => void | boolean | Promise<void | boolean>;
  /** Extra fields shown inside the confirmation, such as a note box. */
  children?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const showing = open && !disabled;

  useEffect(() => {
    if (!showing) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [showing]);

  if (!showing) {
    return (
      <button
        type="button"
        className={`btn ${variant === "primary" ? "" : "secondary"} ${tone === "danger" ? "danger-text" : ""}`}
        disabled={disabled || busy}
        onClick={() => setOpen(true)}
      >
        {busy ? (busyLabel ?? "Working…") : label}
      </button>
    );
  }

  return (
    <div ref={ref} className={`confirm ${tone === "danger" ? "danger" : ""}`} role="alertdialog" aria-label={question}>
      <div className="confirm-text">
        <p className="confirm-q">{question}</p>
        {detail ? <p className="confirm-d">{detail}</p> : null}
        {children}
      </div>
      <div className="confirm-actions">
        <button type="button" className="btn secondary" onClick={() => setOpen(false)}>
          Cancel
        </button>
        <button
          type="button"
          className={`btn ${tone === "danger" ? "danger" : ""}`}
          disabled={busy}
          onClick={async () => {
            if ((await onConfirm()) !== false) setOpen(false);
          }}
        >
          {confirmLabel}
        </button>
      </div>
    </div>
  );
}
