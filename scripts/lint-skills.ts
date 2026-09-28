/**
 * Keeps the six skills consistent with each other and with the code.
 *
 *   npm run lint:skills
 *
 * Checks, each of which has caught a real class of drift:
 *   1. Frontmatter: every required skill exists, is named after its folder,
 *      and has a description.
 *   2. Rule ownership: each rule ID (R-ROUTE-1, R-ESC-3, ...) is defined once,
 *      as a heading, in the skill that owns its prefix. Every rule ID that is
 *      referenced anywhere is defined somewhere.
 *   3. Enum lists: a line marked <!-- enum:NAME --> lists exactly the values
 *      of that enum in packages/shared/src/enums.ts, no more and no fewer.
 *   4. Event types: every `log_conversation_event` with `x` names an event
 *      type the agent is allowed to log.
 *   5. Tool names: every backticked tool name is a tool the MCP server has.
 *   6. Identifiers: every backticked snake_case or dotted identifier appears
 *      in the MCP server, shared, or agent source — a skill cannot tell the
 *      model to read a field no tool returns.
 *   7. Skill cross-references: a skill named in prose exists.
 */
import fs from "node:fs";
import path from "node:path";
import * as enums from "../packages/shared/src/enums.ts";
import { REQUIRED_SKILLS, loadSkills, skillsDir } from "../apps/web/src/agent/system-prompt.ts";
import { TOOL_NAMES } from "../apps/mcp-server/src/server.ts";
import { ROOT } from "./lib/seed-data.ts";

const RULE_OWNER: Record<string, string> = {
  ROUTE: "support-routing",
  SAFE: "privacy-and-safety",
  KB: "knowledge-grounding",
  LOOK: "account-lookups",
  ESC: "tickets-and-escalation",
  VOICE: "voice-style",
};

const errors: string[] = [];
const fail = (msg: string) => errors.push(msg);

// 1. Frontmatter (loadSkills throws on any problem)
let skills: ReturnType<typeof loadSkills> = [];
try {
  skills = loadSkills();
} catch (err) {
  fail((err as Error).message);
}
const raw = new Map(skills.map((s) => [s.name, fs.readFileSync(s.file, "utf8")]));

// 2. Rule ownership
const defined = new Map<string, string>();
const referenced = new Map<string, Set<string>>();
for (const [name, text] of raw) {
  for (const m of text.matchAll(/^###\s+(R-([A-Z]+)-\d+)\b/gm)) {
    const [, id, prefix] = m;
    if (defined.has(id)) fail(`${id} is defined in both ${defined.get(id)} and ${name}`);
    defined.set(id, name);
    if (RULE_OWNER[prefix] !== name) fail(`${id} is defined in ${name}, but ${prefix} rules belong to ${RULE_OWNER[prefix] ?? "no skill"}`);
  }
  for (const m of text.matchAll(/\bR-[A-Z]+-\d+\b/g)) {
    if (!referenced.has(m[0])) referenced.set(m[0], new Set());
    referenced.get(m[0])!.add(name);
  }
}
for (const [id, where] of referenced) {
  if (!defined.has(id)) fail(`${id} is referenced in ${[...where].join(", ")} but defined nowhere`);
}

// 3. Enum lists
for (const [name, text] of raw) {
  for (const line of text.split("\n")) {
    const m = line.match(/<!--\s*enum:([A-Z_]+)\s*-->(.*)$/);
    if (!m) continue;
    const [, enumName, rest] = m;
    const expected = (enums as Record<string, unknown>)[enumName];
    if (!Array.isArray(expected)) {
      fail(`${name}: enum marker names ${enumName}, which is not exported by enums.ts`);
      continue;
    }
    const listed = [...rest.matchAll(/`([^`]+)`/g)].map((x) => x[1]);
    const missing = expected.filter((v) => !listed.includes(v));
    const extra = listed.filter((v) => !expected.includes(v));
    if (missing.length || extra.length) {
      fail(`${name}: ${enumName} list is out of sync. missing [${missing.join(", ")}] extra [${extra.join(", ")}]`);
    }
  }
}

// 4. Event types
for (const [name, text] of raw) {
  for (const m of text.matchAll(/log_conversation_event`\s+with\s+`([a-z_]+)`/g)) {
    if (!(enums.AGENT_EVENT_TYPES as readonly string[]).includes(m[1])) {
      fail(`${name}: tells the agent to log "${m[1]}", which is not in AGENT_EVENT_TYPES`);
    }
  }
}

// 5 & 6. Tool names and identifiers
const sourceText = ["apps/mcp-server/src", "packages/shared/src", "apps/web/src/agent"]
  .flatMap((d) => walk(path.join(ROOT, d)))
  .map((f) => fs.readFileSync(f, "utf8"))
  .join("\n");
for (const [name, text] of raw) {
  const body = text.replace(/^---[\s\S]*?---/, "");
  for (const m of body.matchAll(/`([a-z][a-z0-9_.]*)`/g)) {
    const id = m[1];
    if (/^(search|lookup|create|log)_/.test(id) && !id.includes(".")) {
      if (!(TOOL_NAMES as readonly string[]).includes(id)) fail(`${name}: names tool \`${id}\`, which the MCP server does not have`);
      continue;
    }
    if (!/[_.]/.test(id)) continue; // plain words such as `high` are covered by the enum checks
    const leaf = id.split(".").pop()!;
    if (!sourceText.includes(leaf)) fail(`${name}: refers to \`${id}\`, which appears nowhere in the tool or agent source`);
  }
}

// 7. Skill cross-references
for (const [name, text] of raw) {
  for (const m of text.matchAll(/\b([a-z]+(?:-[a-z]+)+)\b/g)) {
    const candidate = m[1];
    const looksLikeSkill = /(routing|safety|grounding|lookups|escalation|style)$/.test(candidate);
    if (looksLikeSkill && !(REQUIRED_SKILLS as readonly string[]).includes(candidate)) {
      fail(`${name}: mentions skill "${candidate}", which does not exist`);
    }
  }
}

function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : /\.(ts|tsx|sql)$/.test(e.name) ? [p] : [];
  });
}

if (errors.length) {
  console.error(`lint:skills found ${errors.length} problem(s) in ${skillsDir()}:\n  - ${errors.join("\n  - ")}`);
  process.exit(1);
}
console.log(
  `lint:skills ok: ${skills.length} skills, ${defined.size} rules, every enum list, tool name and field reference matches the code`,
);
