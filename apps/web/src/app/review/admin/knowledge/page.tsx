import Link from "next/link";
import { redirect } from "next/navigation";
import { supabaseAdmin } from "@relaypay/shared/supabase";
import { KnowledgeEditor, type HistoryEntry } from "@/components/KnowledgeEditor";
import { When } from "@/components/When";
import { currentProfile } from "@/lib/auth";
import { currentKnowledgeBase, goldSet, type KbVersion } from "@/lib/knowledge";

export const dynamic = "force-dynamic";

/** Admin only: edit the approved knowledge base and re-ingest it into the agent's search. */
export default async function KnowledgePage() {
  const me = await currentProfile();
  if (me?.role !== "admin") redirect("/review");

  const db = supabaseAdmin();
  const [current, { data: versions }, { data: profiles }, { count: liveChunks }] = await Promise.all([
    currentKnowledgeBase(),
    db.from("kb_versions").select("*").order("version", { ascending: false }).limit(10),
    db.from("profiles").select("id, full_name, email"),
    db.from("kb_chunks").select("id", { count: "exact", head: true }),
  ]);
  const who = (id: string | null) => {
    const p = (profiles ?? []).find((x) => x.id === id);
    return p?.full_name || p?.email || "someone";
  };
  const history: HistoryEntry[] = ((versions ?? []) as KbVersion[]).map((v) => ({
    version: v.version,
    markdown: v.markdown,
    keywords: v.keywords,
    chunk_count: v.chunk_count,
    recall: v.recall,
    forced: v.forced,
    note: v.note,
    by: who(v.published_by),
    published_at: v.published_at,
  }));
  const markdown = current.source === "published" ? current.version.markdown : current.markdown;
  const keywords = current.source === "published" ? current.version.keywords : current.keywords;
  const gold = goldSet();

  return (
    <>
      <p className="crumbs">
        <Link href="/review/admin">Admin</Link> / Knowledge base
      </p>
      <div className="page-head">
        <div>
          <h1>Knowledge base</h1>
          <p className="muted">
            {current.source === "published" ? (
              <>
                Live: version {current.version.version}, published by {who(current.version.published_by)}{" "}
                <When iso={current.version.published_at} mode="relative" />.
              </>
            ) : (
              <>Live: the repository&apos;s data/relaypay-knowledge-base.md. Nothing published from here yet.</>
            )}{" "}
            {liveChunks ?? 0} chunks in search. Every change is checked against {gold.filter((g) => g.expect !== "none").length} gold questions
            before it goes live.
          </p>
        </div>
      </div>
      <KnowledgeEditor initialMarkdown={markdown} initialKeywords={keywords} history={history} />
    </>
  );
}
