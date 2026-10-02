import "server-only";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { supabaseAdmin } from "@relaypay/shared/supabase";
import { KB_MATCH_THRESHOLD, KB_MIN_RECALL, prepareKnowledgeBase, type GoldQuery } from "@relaypay/shared/kb";

/**
 * The knowledge base an admin edits on /review/admin/knowledge.
 *
 * The current text is the latest kb_versions row. Before anything has been
 * published from the console, it is the repository's
 * data/relaypay-knowledge-base.md, the same file `npm run kb:ingest` loads.
 * The gold retrieval set always comes from the repository: it is the test
 * a change has to pass, so it isn't editable from the page being tested.
 */

function dataDir(): string {
  const candidates = [
    process.env.DATA_DIR,
    path.join(process.cwd(), "data"),
    path.join(process.cwd(), "..", "..", "data"),
  ].filter((c): c is string => Boolean(c));
  const found = candidates.find((c) => fs.existsSync(path.join(c, "relaypay-knowledge-base.md")));
  if (!found) throw new Error(`Knowledge-base files not found (looked in ${candidates.join(", ")}). Set DATA_DIR.`);
  return found;
}

const readData = (f: string) => fs.readFileSync(path.join(dataDir(), f), "utf8");

export function goldSet(): GoldQuery[] {
  return (JSON.parse(readData("retrieval-gold.json")) as { queries: GoldQuery[] }).queries;
}

export type KbVersion = {
  version: number;
  markdown: string;
  keywords: Record<string, string>;
  chunk_count: number;
  recall: number | null;
  forced: boolean;
  note: string | null;
  published_by: string | null;
  published_at: string;
};

export type CurrentKb = { source: "published"; version: KbVersion } | { source: "repository"; markdown: string; keywords: Record<string, string> };

export async function currentKnowledgeBase(): Promise<CurrentKb> {
  const { data, error } = await supabaseAdmin().from("kb_versions").select("*").order("version", { ascending: false }).limit(1).maybeSingle();
  if (error) throw new Error(`kb_versions: ${error.message}`);
  if (data) return { source: "published", version: data as KbVersion };
  return { source: "repository", markdown: readData("relaypay-knowledge-base.md"), keywords: JSON.parse(readData("kb-keywords.json")) };
}

export const PublishRequest = z.object({
  mode: z.enum(["check", "publish"]),
  markdown: z.string(),
  keywords: z.record(z.string(), z.string()),
  note: z.string().trim().max(500).optional(),
  force: z.boolean().optional(),
});
export type PublishRequest = z.infer<typeof PublishRequest>;

export type PublishResult = {
  published: boolean;
  version: number | null;
  passed: boolean;
  chunks: number;
  added: string[];
  removed: string[];
  changed: string[];
  recall: number | null;
  recall_before: number | null;
  answerable: number;
  hits: number;
  misses: { q: string; expect: string[]; got: string[] }[];
  leaks: { q: string; got: string[] }[];
  /** Gold questions that find their answer today and wouldn't after this change. */
  regressed: { q: string; expect: string[]; got: string[] }[];
  new_leaks: { q: string; got: string[] }[];
  orphanKeywords: string[];
  orphanGold: string[];
  minRecall: number;
};

export class KnowledgeError extends Error {}

/**
 * Check or publish. Both run the new chunks through the real match_kb inside
 * one transaction (kb_publish, 0011); a check always rolls back, a publish
 * keeps the change only if retrieval holds up or the admin forces it.
 */
export async function publishKnowledgeBase(req: PublishRequest, actorId: string): Promise<PublishResult> {
  const gold = goldSet();
  let prepared;
  try {
    prepared = prepareKnowledgeBase(req.markdown, req.keywords, gold);
  } catch (err) {
    throw new KnowledgeError(err instanceof Error ? err.message : String(err));
  }
  const { data, error } = await supabaseAdmin().rpc("kb_publish", {
    p_markdown: req.markdown,
    p_keywords: prepared.keywords,
    p_chunks: prepared.chunks,
    p_gold: gold,
    p_threshold: KB_MATCH_THRESHOLD,
    p_min_recall: KB_MIN_RECALL,
    p_dry_run: req.mode === "check",
    p_force: Boolean(req.force),
    p_note: req.note ?? null,
    p_actor: actorId,
  });
  if (error) throw new KnowledgeError(error.message);
  return { ...(data as Omit<PublishResult, "orphanKeywords" | "orphanGold" | "minRecall">), orphanKeywords: prepared.orphanKeywords, orphanGold: prepared.orphanGold, minRecall: KB_MIN_RECALL };
}
