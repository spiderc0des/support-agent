/**
 * Apply supabase/migrations/*.sql to the Supabase database, in order, once.
 *
 *   npm run db:migrate            apply anything not yet applied
 *   npm run db:migrate -- --status list what is applied
 *
 * Needs SUPABASE_DB_URL: Supabase → Project Settings → Database → Connection
 * string (URI). Use the session pooler string if your network has no IPv6.
 * Uses the local `psql`, one transaction per file, stopping on the first error.
 *
 * No psql? Paste the files into the SQL editor in order instead; this script
 * is a convenience, not a requirement.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { loadEnv, requireEnv } from "../packages/shared/src/env.ts";
import { migrationFiles } from "./lib/seed-data.ts";

loadEnv();
requireEnv("SUPABASE_DB_URL");
const DB = process.env.SUPABASE_DB_URL!;

function psql(args: string[]): string {
  return execFileSync("psql", [DB, "-v", "ON_ERROR_STOP=1", "-X", "-q", "-t", "-A", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

psql(["-c", "create table if not exists public.schema_migrations (name text primary key, applied_at timestamptz not null default now())"]);
const applied = new Set(psql(["-c", "select name from public.schema_migrations"]).split("\n").filter(Boolean));

if (process.argv.includes("--status")) {
  for (const f of migrationFiles()) console.log(`${applied.has(path.basename(f)) ? "applied " : "pending "} ${path.basename(f)}`);
  process.exit(0);
}

let count = 0;
for (const file of migrationFiles()) {
  const name = path.basename(file);
  if (applied.has(name)) continue;
  process.stdout.write(`applying ${name} ... `);
  try {
    psql(["-1", "-f", file, "-c", `insert into public.schema_migrations (name) values ('${name}')`]);
    console.log("ok");
    count++;
  } catch (err) {
    console.log("FAILED");
    const e = err as { stderr?: string; message: string };
    console.error(e.stderr || e.message);
    process.exit(1);
  }
}
console.log(count ? `applied ${count} migration(s)` : "database is up to date");
