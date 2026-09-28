import type { NextConfig } from "next";

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
