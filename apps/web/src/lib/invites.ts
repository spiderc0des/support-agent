import "server-only";
import { createHash, randomBytes } from "node:crypto";

/** How long an invite link works. Supabase's own links can't last longer than a day. */
export const INVITE_DAYS = 3;

export const hashInviteToken = (token: string) => createHash("sha256").update(token).digest("hex");

export function newInviteToken() {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: hashInviteToken(token), expiresAt: new Date(Date.now() + INVITE_DAYS * 86_400_000) };
}
