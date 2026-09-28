import path from "node:path";
import { config as loadDotenv } from "dotenv";
import type { NextConfig } from "next";

// One .env.local at the repository root serves the scripts, the MCP server
// and this app. Next.js only reads env files from apps/web by itself; this
// fills in the rest without overriding anything already set (Railway sets
// real environment variables and has no env files).
loadDotenv({ path: [path.resolve(process.cwd(), "../../.env.local"), path.resolve(process.cwd(), "../../.env")], quiet: true });

const nextConfig: NextConfig = {
  /**
   * The Agent SDK spawns the Claude Code CLI as a subprocess and resolves its
   * native binary at runtime; bundling breaks that resolution (week 5 lesson).
   * For the same reason this is not a `standalone` build.
   */
  serverExternalPackages: ["@anthropic-ai/claude-agent-sdk"],
  /** The shared workspace package ships TypeScript source. */
  transpilePackages: ["@relaypay/shared"],
};

export default nextConfig;
