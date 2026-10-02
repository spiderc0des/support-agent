/**
 * Publishing an edited knowledge base (kb_publish, 0011), on the real SQL in
 * PGlite: the same function the admin editor and `npm run kb:ingest` call.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { createTestDb } from "../scripts/lib/test-db.ts";
import { ROOT } from "../scripts/lib/seed-data.ts";
import { KB_MATCH_THRESHOLD, KB_MIN_RECALL, prepareKnowledgeBase, type GoldQuery } from "../packages/shared/src/kb.ts";

const read = (f: string) => fs.readFileSync(path.join(ROOT, "data", f), "utf8");
const MARKDOWN = read("relaypay-knowledge-base.md");
const KEYWORDS = JSON.parse(read("kb-keywords.json")) as Record<string, string>;
const GOLD = (JSON.parse(read("retrieval-gold.json")) as { queries: GoldQuery[] }).queries;

type Result = { published: boolean; version: number | null; passed: boolean; chunks: number; added: string[]; removed: string[]; changed: string[]; recall: number; misses: unknown[]; leaks: unknown[] };

let db: PGlite;
before(async () => {
  db = await createTestDb();
});
after(async () => {
  await db.close();
});

async function publish(markdown: string, opts: { dryRun?: boolean; force?: boolean; keywords?: Record<string, string> } = {}): Promise<Result> {
  const p = prepareKnowledgeBase(markdown, opts.keywords ?? KEYWORDS, GOLD);
  const { rows } = await db.query<{ r: Result }>("select public.kb_publish($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) as r", [
    markdown, JSON.stringify(p.keywords), JSON.stringify(p.chunks), JSON.stringify(GOLD), KB_MATCH_THRESHOLD, KB_MIN_RECALL,
    opts.dryRun ?? false, opts.force ?? false, "test", null,
  ]);
  return rows[0].r;
}

const chunkContent = async (id: string) => (await db.query<{ content: string }>("select content from kb_chunks where id = $1", [id])).rows[0]?.content;
const versions = async () => (await db.query<{ n: number }>("select count(*)::int as n from kb_versions")).rows[0].n;

// The fee answer the scenario 1 gold questions depend on.
const FEES = "faq-how-does-relaypay-charge-fees";
const withoutFees = () => {
  const start = MARKDOWN.indexOf("### How Does RelayPay Charge Fees?");
  assert.ok(start > 0, "fixture: fee heading present");
  const end = MARKDOWN.indexOf("\n###", start + 4);
  return MARKDOWN.slice(0, start) + MARKDOWN.slice(end + 1);
};

test("republishing the repository text passes and records version 1", async () => {
  const r = await publish(MARKDOWN);
  assert.equal(r.passed, true);
  assert.equal(r.published, true);
  assert.equal(r.version, 1);
  assert.deepEqual([r.added, r.removed, r.changed], [[], [], []]);
  assert.ok(r.recall >= KB_MIN_RECALL);
  assert.equal(await versions(), 1);
});

test("a check measures an edit and changes nothing", async () => {
  const edited = MARKDOWN.replace("## Policies And Compliance", "## Policies And Compliance\n\n### Weekend support hours\n\nPhone support is available on Saturdays from 9am to 1pm WAT.\n");
  const r = await publish(edited, { dryRun: true });
  assert.equal(r.published, false);
  assert.deepEqual(r.added, ["policy-weekend-support-hours"]);
  assert.equal(await chunkContent("policy-weekend-support-hours"), undefined, "rolled back");
  assert.equal(await versions(), 1);
});

test("an edit that loses an answer is refused, and the live chunks are untouched", async () => {
  const r = await publish(withoutFees());
  assert.equal(r.passed, false);
  assert.equal(r.published, false);
  assert.deepEqual(r.removed, [FEES]);
  assert.ok(r.misses.length > 0);
  assert.ok(await chunkContent(FEES), "fee chunk still live");
  assert.equal(await versions(), 1);
});

test("publish anyway keeps a failing edit and marks the version forced", async () => {
  const r = await publish(withoutFees(), { force: true });
  assert.equal(r.published, true);
  assert.equal(await chunkContent(FEES), undefined);
  const { rows } = await db.query<{ forced: boolean }>("select forced from kb_versions where version = $1", [r.version]);
  assert.equal(rows[0].forced, true);
  // Restore for any later test.
  assert.equal((await publish(MARKDOWN)).published, true);
  assert.ok(await chunkContent(FEES));
});

test("a changed answer is re-ingested and searchable at once", async () => {
  const edited = MARKDOWN.replace("### How Does RelayPay Charge Fees?\n", "### How Does RelayPay Charge Fees?\n\nZanzibar corridor transfers carry a flat fee.\n");
  assert.notEqual(edited, MARKDOWN, "fixture: fee heading present");
  const r = await publish(edited);
  assert.equal(r.published, true);
  assert.deepEqual(r.changed, [FEES]);
  const { rows } = await db.query<{ id: string }>("select id from match_kb('zanzibar', 3)");
  assert.equal(rows[0]?.id, FEES);
});

test("prepareKnowledgeBase refuses documents that can't be published", () => {
  assert.throws(() => prepareKnowledgeBase("   ", {}), /empty/);
  assert.throws(() => prepareKnowledgeBase("# Title only\n\nIntro.", {}), /No chunks/);
  assert.throws(() => prepareKnowledgeBase("## A\n\n### Same\n\nx\n\n### Same\n\ny", {}), /Duplicate/);
  const p = prepareKnowledgeBase("## FAQ\n\n### Renamed\n\nText.", { "faq-old": "words" }, [{ q: "x", expect: ["faq-old"] }]);
  assert.deepEqual(p.orphanKeywords, ["faq-old"]);
  assert.deepEqual(p.orphanGold, ["faq-old"]);
});
