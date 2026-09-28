/**
 * An in-process Postgres (PGlite) with the real migrations applied and the
 * seed data loaded. Lets the SQL — constraints, match_kb, the ticket and
 * escalation functions, RLS setup — be tested with no Supabase project.
 *
 * The shim creates only what Supabase provides and the migrations assume:
 * the extensions and auth schemas, auth.users, auth.uid(), and the three API
 * roles.
 */
import fs from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { loadCustomers, loadKbChunks, loadPayouts, loadTransactions, migrationFiles } from "./seed-data.ts";

const SUPABASE_SHIM = `
  create schema if not exists extensions;
  create schema if not exists auth;
  create table if not exists auth.users (
    id uuid primary key default gen_random_uuid(),
    email text,
    raw_user_meta_data jsonb default '{}'::jsonb
  );
  create or replace function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
  do $$ begin
    if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
    if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
    if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin; end if;
  end $$;
`;

type Row = Record<string, unknown>;

async function insertRows(db: PGlite, table: string, rows: Row[]) {
  for (const row of rows) {
    const cols = Object.keys(row);
    const params = cols.map((_, i) => `$${i + 1}`).join(", ");
    await db.query(`insert into public.${table} (${cols.join(", ")}) values (${params})`, cols.map((c) => row[c]));
  }
}

export async function createTestDb(): Promise<PGlite> {
  const db = await PGlite.create({ extensions: { pg_trgm } });
  await db.exec(SUPABASE_SHIM);
  for (const file of migrationFiles()) {
    try {
      await db.exec(fs.readFileSync(file, "utf8"));
    } catch (err) {
      throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
    }
  }
  await insertRows(db, "customers", loadCustomers());
  await insertRows(db, "transactions", loadTransactions());
  await insertRows(db, "payouts", loadPayouts());
  await insertRows(
    db,
    "kb_chunks",
    loadKbChunks().map(({ id, section, title, source_title, summary, content, keywords, ordinal }) => ({
      id, section, title, source_title, summary, content, keywords, ordinal,
    })),
  );
  return db;
}
