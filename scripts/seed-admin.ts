/**
 * Give someone access to the review dashboard (/review), inviting them first
 * if they have no account. There is no self-service signup; this is the only
 * way in. (Carried over from week 5.)
 *
 *   npm run seed:admin -- you@company.com
 */
import { loadEnv, requireEnv } from "../packages/shared/src/env.ts";
import { supabaseAdmin } from "../packages/shared/src/supabase.ts";

loadEnv();
requireEnv("SUPABASE_SERVICE_ROLE_KEY");

const email = process.argv[2]?.trim().toLowerCase();
if (!email) {
  console.error("Usage: npm run seed:admin -- you@company.com");
  process.exit(1);
}

const db = supabaseAdmin();
await db.from("allowed_emails").upsert({ email, role: "admin" }, { onConflict: "email" });

const { data: list, error: listErr } = await db.auth.admin.listUsers({ page: 1, perPage: 1000 });
if (listErr) throw new Error(`listing users: ${listErr.message}`);
let user = list.users.find((u) => u.email?.toLowerCase() === email);

if (!user) {
  const redirectTo = `${process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"}/auth/confirm?next=/review`;
  const { data, error } = await db.auth.admin.inviteUserByEmail(email, { redirectTo });
  if (error) throw new Error(`invite failed: ${error.message}`);
  user = data.user;
  console.log(`Invited ${email}.`);
}

// The signup trigger normally creates the profile; this covers an existing account.
const { error } = await db.from("profiles").upsert({ id: user.id, email, role: "admin" }, { onConflict: "id" });
if (error) throw new Error(`setting the admin role: ${error.message}`);
console.log(`${email} is an admin. Sign in at /login; the invite email also works as a sign-in link.`);
