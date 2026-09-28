/**
 * Chunk data/relaypay-knowledge-base.md and load it into kb_chunks.
 *
 *   npm run kb:ingest
 *
 * Upserts every chunk by its stable id and deletes chunks that no longer
 * exist in the document, so the table always mirrors the approved text.
 * Run `npm run test:retrieval` first after any change to the document or to
 * data/kb-keywords.json.
 */
import { loadEnv, requireEnv } from "../packages/shared/src/env.ts";
import { supabaseAdmin } from "../packages/shared/src/supabase.ts";
import { loadKbChunks } from "./lib/seed-data.ts";

loadEnv();
requireEnv("SUPABASE_SERVICE_ROLE_KEY");
const db = supabaseAdmin();

const chunks = loadKbChunks().map((c) => ({ ...c, updated_at: new Date().toISOString() }));
const { error } = await db.from("kb_chunks").upsert(chunks, { onConflict: "id" });
if (error) throw new Error(`kb_chunks: ${error.message}`);

const ids = chunks.map((c) => c.id);
const { data: stale, error: staleErr } = await db
  .from("kb_chunks")
  .delete()
  .not("id", "in", `(${ids.map((i) => `"${i}"`).join(",")})`)
  .select("id");
if (staleErr) throw new Error(`removing stale chunks: ${staleErr.message}`);

console.log(`kb_chunks: ${chunks.length} upserted, ${stale?.length ?? 0} stale removed`);

const { data: probe, error: probeErr } = await db.rpc("match_kb", { p_query: "international payment fees", p_k: 1 });
if (probeErr) throw new Error(`match_kb probe: ${probeErr.message}`);
console.log(`probe "international payment fees" -> ${probe?.[0]?.id ?? "no match"}`);
