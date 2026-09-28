/**
 * Load the provided seed data (data/seed/*.csv) into Supabase.
 *
 *   npm run db:seed
 *
 * Idempotent: rows are upserted by their IDs, so re-running after editing a
 * CSV updates in place. Order matters because of the foreign keys:
 * customers, then transactions, then payouts.
 */
import { loadEnv, requireEnv } from "../packages/shared/src/env.ts";
import { supabaseAdmin } from "../packages/shared/src/supabase.ts";
import { loadCustomers, loadPayouts, loadTransactions } from "./lib/seed-data.ts";

loadEnv();
requireEnv("SUPABASE_SERVICE_ROLE_KEY");
const db = supabaseAdmin();

async function upsert(table: string, key: string, rows: Record<string, unknown>[]) {
  const { error } = await db.from(table).upsert(rows, { onConflict: key });
  if (error) throw new Error(`${table}: ${error.message}`);
  const { count } = await db.from(table).select(key, { count: "exact", head: true });
  console.log(`${table.padEnd(13)} upserted ${rows.length}, table now has ${count}`);
}

await upsert("customers", "customer_id", loadCustomers());
await upsert("transactions", "transaction_id", loadTransactions());
await upsert("payouts", "payout_id", loadPayouts());
