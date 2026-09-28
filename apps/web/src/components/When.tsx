"use client";
import { useEffect, useState } from "react";

/**
 * A timestamp in the reader's own time zone. The server runs in UTC on
 * Railway, so formatting there would show every agent the wrong hour. Renders
 * the ISO date first, then swaps in the local form after hydration.
 */
export function When({ iso, mode = "datetime" }: { iso: string | null | undefined; mode?: "datetime" | "time" | "relative" }) {
  const [text, setText] = useState(() => (iso ? iso.slice(0, 16).replace("T", " ") : ""));
  useEffect(() => {
    if (!iso) return;
    const d = new Date(iso);
    if (mode === "time") setText(d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }));
    else if (mode === "relative") setText(relative(d));
    else setText(d.toLocaleString([], { dateStyle: "medium", timeStyle: "short" }));
  }, [iso, mode]);
  if (!iso) return null;
  return (
    <time dateTime={iso} title={iso}>
      {text}
    </time>
  );
}

function relative(d: Date): string {
  const s = Math.round((Date.now() - d.getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)} d ago`;
  return d.toLocaleDateString([], { dateStyle: "medium" });
}
