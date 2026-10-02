/**
 * Create or update the Vapi assistant from vapi/assistant.template.json.
 *
 *   npm run vapi:sync                 create, or update VAPI_ASSISTANT_ID if set
 *   npm run vapi:sync -- --dry-run    print the rendered config, send nothing
 *
 * The assistant uses the Custom LLM provider, so Vapi runs no model of its
 * own: every turn goes to APP_URL/api/vapi/chat/completions. Vapi
 * authenticates to that endpoint with a "custom-llm" credential whose API key
 * is VAPI_WEBHOOK_SECRET; this script creates that credential if it does not
 * exist. Server events carry the same secret in the x-vapi-secret header.
 *
 * Needs VAPI_PRIVATE_KEY (Vapi dashboard → API Keys → private key), APP_URL
 * (public https origin; an ngrok URL locally) and VAPI_WEBHOOK_SECRET.
 */
import fs from "node:fs";
import path from "node:path";
import { loadEnv, requireEnv } from "../packages/shared/src/env.ts";
import { ROOT } from "./lib/seed-data.ts";

loadEnv();
const dryRun = process.argv.includes("--dry-run");
requireEnv("APP_URL", "VAPI_WEBHOOK_SECRET", ...(dryRun ? [] : ["VAPI_PRIVATE_KEY"]));

const API = "https://api.vapi.ai";
const appUrl = process.env.APP_URL!.replace(/\/$/, "");
if (!/^https:\/\//.test(appUrl)) throw new Error(`APP_URL must be a public https origin Vapi can reach; got ${appUrl}`);
// There is one assistant, shared by local testing and production. Pointing it
// at a tunnel takes every real call there, so that needs saying on purpose.
if (/ngrok|localhost|127\.0\.0\.1|\.local\b/i.test(appUrl) && !process.argv.includes("--dev") && !dryRun) {
  throw new Error(
    `APP_URL is a development address (${appUrl}). Syncing would send every live call there. ` +
      `For production run: APP_URL=https://<your-app>.up.railway.app npm run vapi:sync. ` +
      `To point the assistant at your tunnel on purpose, add --dev.`,
  );
}

const template = fs.readFileSync(path.join(ROOT, "vapi/assistant.template.json"), "utf8");
const rendered = template.replace(/\$\{(APP_URL|VAPI_WEBHOOK_SECRET)\}/g, (_m, name: string) =>
  name === "APP_URL" ? appUrl : process.env.VAPI_WEBHOOK_SECRET!,
);
const assistant = JSON.parse(rendered);

if (dryRun) {
  const shown = JSON.parse(rendered);
  if (shown.server?.headers) shown.server.headers["x-vapi-secret"] = "<VAPI_WEBHOOK_SECRET>";
  console.log(JSON.stringify(shown, null, 2));
  process.exit(0);
}

async function vapi(method: string, route: string, body?: unknown) {
  const res = await fetch(`${API}${route}`, {
    method,
    headers: { authorization: `Bearer ${process.env.VAPI_PRIVATE_KEY}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${route} -> ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

// Custom LLM credential: Vapi sends its apiKey as "Authorization: Bearer ..."
// to our endpoint. It is named and attached to the assistant explicitly: in a
// shared Vapi organisation other people's custom-llm credentials exist too,
// and an unattached assistant would send one of theirs (our endpoint then
// refuses it: pipeline-error-custom-llm-401-unauthorized after the greeting).
// The secret can't be read back from Vapi, so ours is recreated on each sync.
const CREDENTIAL_NAME = "relaypay-support-webhook";
const credentials = (await vapi("GET", "/credential")) as { id: string; provider: string; name?: string | null }[];
for (const old of credentials.filter((c) => c.provider === "custom-llm" && c.name === CREDENTIAL_NAME)) {
  await vapi("DELETE", `/credential/${old.id}`).catch(() => {});
}
const credential = (await vapi("POST", "/credential", {
  provider: "custom-llm",
  name: CREDENTIAL_NAME,
  apiKey: process.env.VAPI_WEBHOOK_SECRET,
})) as { id: string };
assistant.credentialIds = [credential.id];
console.log(`custom-llm credential ${CREDENTIAL_NAME} (${credential.id.slice(0, 8)}…) attached to the assistant`);

const existingId = process.env.VAPI_ASSISTANT_ID;
const saved = existingId
  ? await vapi("PATCH", `/assistant/${existingId}`, assistant)
  : await vapi("POST", "/assistant", assistant);

console.log(`${existingId ? "updated" : "created"} assistant ${saved.id}`);
console.log(`  model    -> ${assistant.model.url}/chat/completions`);
console.log(`  events   -> ${assistant.server.url}`);
if (!existingId) {
  console.log(`\nSet these, then rebuild the web app (NEXT_PUBLIC_* are inlined at build time):`);
  console.log(`  VAPI_ASSISTANT_ID=${saved.id}`);
  console.log(`  NEXT_PUBLIC_VAPI_ASSISTANT_ID=${saved.id}`);
}
