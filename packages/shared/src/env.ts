/**
 * Environment loading for everything that is not Next.js (scripts, the MCP
 * server). Carried over from week 5: plain `dotenv/config` only reads `.env`,
 * so values put in `.env.local` were silently missing.
 *
 * Reads the repository root's `.env.local` then `.env` (Next.js precedence),
 * wherever the process was started from. On Railway neither file exists and
 * the service variables are already in process.env, which this never
 * overrides.
 */
import fs from "node:fs";
import path from "node:path";
import { config } from "dotenv";

function repoRoot(from: string): string {
  let dir = from;
  for (let i = 0; i < 6; i++) {
    const pkg = path.join(dir, "package.json");
    if (fs.existsSync(pkg) && JSON.parse(fs.readFileSync(pkg, "utf8")).workspaces) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return from;
}

let loaded = false;

export function loadEnv(): void {
  if (loaded) return;
  loaded = true;
  const root = repoRoot(process.cwd());
  config({ path: [path.join(root, ".env.local"), path.join(root, ".env")], quiet: true });
}

/** Throws one clear error naming every missing variable. */
export function requireEnv(...names: string[]): void {
  const missing = names.filter((n) => !process.env[n]);
  if (missing.length) {
    throw new Error(`Missing ${missing.join(", ")}. Copy .env.example to .env.local and fill it in.`);
  }
}
