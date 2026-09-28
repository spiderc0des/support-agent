/**
 * Retrieval quality gate. Runs the gold question set against the real
 * match_kb function over the real chunks, in PGlite. No network, no cost.
 *
 * Recall@3 must stay at or above 90%, and off-topic questions must not match.
 * If this fails after a knowledge-base change, fix data/kb-keywords.json
 * before reaching for embeddings.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { createTestDb } from "../scripts/lib/test-db.ts";
import { ROOT } from "../scripts/lib/seed-data.ts";
import { KB_MATCH_THRESHOLD } from "../apps/mcp-server/src/lib/retrieval.ts";

type Gold = { q: string; expect: string[] | "none" };
const gold: Gold[] = JSON.parse(fs.readFileSync(path.join(ROOT, "data/retrieval-gold.json"), "utf8")).queries;

let db: PGlite;
before(async () => {
  db = await createTestDb();
});
after(async () => {
  await db.close();
});

async function top3(q: string) {
  const { rows } = await db.query<{ id: string; score: number }>("select id, score from match_kb($1, 3)", [q]);
  return rows;
}

test("recall@3 on answerable questions is at least 90%", async () => {
  const answerable = gold.filter((g) => g.expect !== "none");
  const misses: string[] = [];
  for (const g of answerable) {
    const hits = (await top3(g.q)).filter((r) => r.score >= KB_MATCH_THRESHOLD).map((r) => r.id);
    if (!(g.expect as string[]).some((id) => hits.includes(id))) {
      misses.push(`"${g.q}" -> [${hits.join(", ")}], expected one of [${(g.expect as string[]).join(", ")}]`);
    }
  }
  const recall = 1 - misses.length / answerable.length;
  if (misses.length) console.log(`misses:\n  ${misses.join("\n  ")}`);
  console.log(`recall@3 = ${(recall * 100).toFixed(1)}% (${answerable.length - misses.length}/${answerable.length})`);
  assert.ok(recall >= 0.9, `recall@3 ${(recall * 100).toFixed(1)}% is below 90%`);
});

test("off-topic questions retrieve nothing above the threshold", async () => {
  for (const g of gold.filter((x) => x.expect === "none")) {
    const above = (await top3(g.q)).filter((r) => r.score >= KB_MATCH_THRESHOLD);
    assert.deepEqual(above, [], `"${g.q}" matched ${JSON.stringify(above)}`);
  }
});

test("the scenario 1 fee question ranks the fee policy first", async () => {
  const [first] = await top3("What fees does RelayPay charge for international payments?");
  assert.equal(first?.id, "faq-how-does-relaypay-charge-fees");
});
