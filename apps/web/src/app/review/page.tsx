import Link from "next/link";
import { supabaseServer } from "@/lib/supabase/server";
import { CHANNELS } from "@relaypay/shared/enums";

export const dynamic = "force-dynamic";

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }) : "");

export default async function Conversations({ searchParams }: { searchParams: Promise<{ channel?: string }> }) {
  const { channel } = await searchParams;
  const supabase = await supabaseServer();
  let q = supabase
    .from("conversations")
    .select("id, channel, status, started_at, ended_at, num_turns, total_cost_usd, summary, caller_identifier, customer_id")
    .order("started_at", { ascending: false })
    .limit(100);
  if (channel && (CHANNELS as readonly string[]).includes(channel)) q = q.eq("channel", channel);
  const { data: rows, error } = await q;

  return (
    <>
      <div className="toolbar">
        <h1>Conversations</h1>
        <div className="filters">
          <Link href="/review" className={!channel ? "active" : ""}>
            All
          </Link>
          {CHANNELS.map((c) => (
            <Link key={c} href={`/review?channel=${c}`} className={channel === c ? "active" : ""}>
              {c.replace("_", " ")}
            </Link>
          ))}
        </div>
      </div>
      {error ? <p className="error">{error.message}</p> : null}
      <table className="table">
        <thead>
          <tr>
            <th>Started</th>
            <th>Channel</th>
            <th>Status</th>
            <th>Turns</th>
            <th>Cost</th>
            <th>Summary</th>
          </tr>
        </thead>
        <tbody>
          {(rows ?? []).map((r) => (
            <tr key={r.id}>
              <td>
                <Link href={`/review/${r.id}`}>{fmt(r.started_at)}</Link>
              </td>
              <td>{r.channel.replace("_", " ")}</td>
              <td>
                <span className={`pill ${r.status}`}>{r.status}</span>
              </td>
              <td>{r.num_turns}</td>
              <td>${Number(r.total_cost_usd).toFixed(4)}</td>
              <td className="summary">{r.summary ?? (r.ended_at ? "" : "in progress")}</td>
            </tr>
          ))}
          {rows?.length === 0 ? (
            <tr>
              <td colSpan={6}>No conversations yet.</td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </>
  );
}
