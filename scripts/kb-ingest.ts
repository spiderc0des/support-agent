/**
 * Publish data/relaypay-knowledge-base.md into kb_chunks.
 *
 *   npm run kb:ingest              check retrieval, publish if it holds up
 *   npm run kb:ingest -- --check   measure only; nothing changes
 *   npm run kb:ingest -- --force   publish even if the check fails
 *
 * Goes through kb_publish (0011), the same path as the admin knowledge
 * editor: chunks are replaced in one transaction, the gold retrieval set runs
 * against the new chunks with the real match_kb, and the change is kept only
 * if recall@3 holds. Each publish is recorded as a version in kb_versions,
 * so the console's history includes ingests from here.
 *
 * Admins can also edit the knowledge base on /review/admin/knowledge. Running
 * this publishes the repository's text over any such edit (which stays in the
 * history and can be loaded back from the page).
 */
import fs from "node:fs";
import path from "node:path";
import { loadEnv, requireEnv } from "../packages/shared/src/env.ts";
import { supabaseAdmin } from "../packages/shared/src/supabase.ts";
import { KB_MATCH_THRESHOLD, KB_MIN_RECALL, prepareKnowledgeBase, type GoldQuery } from "../packages/shared/src/kb.ts";
import { ROOT } from "./lib/seed-data.ts";

loadEnv();
requireEnv("SUPABASE_SERVICE_ROLE_KEY");
const db = supabaseAdmin();
const check = process.argv.includes("--check");
const force = process.argv.includes("--force");

const read = (f: string) => fs.readFileSync(path.join(ROOT, "data", f), "utf8");
const markdown = read("relaypay-knowledge-base.md");
const keywords = JSON.parse(read("kb-keywords.json")) as Record<string, string>;
const gold = (JSON.parse(read("retrieval-gold.json")) as { queries: GoldQuery[] }).queries;
const prepared = prepareKnowledgeBase(markdown, keywords, gold);
if (prepared.orphanKeywords.length) throw new Error(`kb-keywords.json names chunks that do not exist: ${prepared.orphanKeywords.join(", ")}`);

const { data: latest } = await db.from("kb_versions").select("version, markdown").order("version", { ascending: false }).limit(1).maybeSingle();
if (latest && latest.markdown !== markdown && !check) {
  console.log(`note: the live text is version ${latest.version} (edited in the console). Publishing the repository's text over it; v${latest.version} stays in the history.`);
}

const { data, error } = await db.rpc("kb_publish", {
  p_markdown: markdown,
  p_keywords: prepared.keywords,
  p_chunks: prepared.chunks,
  p_gold: gold,
  p_threshold: KB_MATCH_THRESHOLD,
  p_min_recall: KB_MIN_RECALL,
  p_dry_run: check,
  p_force: force,
  p_note: "npm run kb:ingest (repository file)",
  p_actor: null,
});
if (error) throw new Error(`kb_publish: ${error.message}`);

const r = data as {
  published: boolean; version: number | null; passed: boolean; chunks: number; added: string[]; removed: string[]; changed: string[];
  recall: number | null; hits: number; answerable: number; misses: { q: string; expect: string[]; got: string[] }[]; regressed: { q: string }[]; leaks: { q: string; got: string[] }[]; new_leaks: { q: string }[];
};
console.log(`chunks ${r.chunks}: ${r.added.length} added, ${r.changed.length} changed, ${r.removed.length} removed`);
console.log(`recall@3 ${r.recall === null ? "n/a" : (r.recall * 100).toFixed(1) + "%"} (${r.hits}/${r.answerable}), off-topic matches ${r.leaks.length}`);
const regressed = new Set(r.regressed.map((m) => m.q));
for (const m of r.misses) console.log(`  ${regressed.has(m.q) ? "REGRESSION" : "miss"}: "${m.q}" -> [${m.got.join(", ")}], expected one of [${m.expect.join(", ")}]`);
for (const l of r.leaks) console.log(`  off-topic match: "${l.q}" -> [${l.got.join(", ")}]`);
if (r.published) console.log(`published as version ${r.version}${r.passed ? "" : " (forced past a failed check)"}`);
else if (check) console.log("check only: nothing changed");
else {
  console.error("not published: the retrieval check failed. Fix the text or data/kb-keywords.json, or re-run with --force.");
  process.exit(1);
}
