/**
 * Loads the seed CSVs and the knowledge base from data/, typed for insertion.
 * Shared by `npm run db:seed` / `kb:ingest` (Supabase) and the offline test
 * database (PGlite), so both load exactly the same rows.
 */
import fs from "node:fs";
import path from "node:path";
import { parseCsv } from "../../packages/shared/src/csv.ts";
import { chunkKnowledgeBase, type KbChunk } from "../../packages/shared/src/kb.ts";

export const ROOT = path.resolve(import.meta.dirname, "../..");
const DATA = path.join(ROOT, "data");

const read = (f: string) => fs.readFileSync(path.join(DATA, f), "utf8");
const num = (v: string | null) => (v === null ? null : Number(v));

export function loadCustomers() {
  return parseCsv(read("seed/customers.csv")).map((r) => ({
    customer_id: r.customer_id!,
    company_name: r.company_name!,
    contact_name: r.contact_name,
    contact_email: r.contact_email,
    plan: r.plan!,
    account_status: r.account_status!,
    region: r.region,
    kyc_status: r.kyc_status!,
    support_notes: r.support_notes,
  }));
}

export function loadTransactions() {
  return parseCsv(read("seed/transactions.csv")).map((r) => ({
    transaction_id: r.transaction_id!,
    customer_id: r.customer_id!,
    transaction_type: r.transaction_type!,
    amount: num(r.amount),
    currency: r.currency!,
    destination_country: r.destination_country,
    status: r.status!,
    created_at: r.created_at!,
    estimated_arrival: r.estimated_arrival,
    support_summary: r.support_summary,
  }));
}

export function loadPayouts() {
  return parseCsv(read("seed/payouts.csv")).map((r) => ({
    payout_id: r.payout_id!,
    transaction_id: r.transaction_id,
    customer_id: r.customer_id!,
    recipient_name: r.recipient_name,
    amount: num(r.amount),
    currency: r.currency!,
    status: r.status!,
    scheduled_for: r.scheduled_for,
    failure_reason: r.failure_reason,
  }));
}

export function loadKbChunks(): KbChunk[] {
  const keywords = JSON.parse(read("kb-keywords.json")) as Record<string, string>;
  const chunks = chunkKnowledgeBase(read("relaypay-knowledge-base.md"), keywords);
  const ids = new Set(chunks.map((c) => c.id));
  const orphans = Object.keys(keywords).filter((k) => k !== "//" && !ids.has(k));
  if (orphans.length) throw new Error(`kb-keywords.json names chunks that do not exist: ${orphans.join(", ")}`);
  return chunks;
}

export function migrationFiles(): string[] {
  const dir = path.join(ROOT, "supabase/migrations");
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => path.join(dir, f));
}
