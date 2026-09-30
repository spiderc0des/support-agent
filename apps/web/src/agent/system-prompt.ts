/**
 * The support agent's system prompt: a short identity, then the six skills.
 *
 * Skills are preloaded rather than invoked through the Skill tool. On a voice
 * call every Skill invocation is an extra model round trip, heard as a second
 * of silence, and repeats the skill's tokens. Preloaded, they sit in the
 * cached prefix and cost a tenth of the input price from the second request
 * on. The SKILL.md files stay the single source of truth; this only reads
 * them.
 *
 * The output must be byte-identical between calls. No timestamps, call IDs
 * or caller details belong here, because any change to the prefix silently
 * invalidates the prompt cache. Per-call context goes in the first user
 * message instead.
 *
 * Nothing here is load-bearing for safety: what may be read, shared or
 * written is enforced by the MCP server. The prompt decides behaviour, not
 * permissions.
 */
import fs from "node:fs";
import path from "node:path";

/** Order matters: precedence first, then the rule that overrides everything, then the how-to skills. */
export const REQUIRED_SKILLS = [
  "support-routing",
  "privacy-and-safety",
  "knowledge-grounding",
  "account-lookups",
  "tickets-and-escalation",
  "voice-style",
] as const;

export type SkillName = (typeof REQUIRED_SKILLS)[number];

export type LoadedSkill = { name: SkillName; description: string; body: string; file: string };

/**
 * Where .claude/skills lives. AGENT_CWD wins (set it in the container);
 * otherwise the first of: the working directory (next dev / next start run
 * in apps/web), apps/web under it (scripts run from the repo root), or this
 * file's app. import.meta.dirname alone is not enough: Next bundles server
 * code, and the bundle does not sit next to the skills.
 */
export function skillsDir(): string {
  const candidates = [
    process.env.AGENT_CWD,
    process.cwd(),
    path.join(process.cwd(), "apps", "web"),
    import.meta.dirname ? path.resolve(import.meta.dirname, "../..") : undefined,
  ].filter((c): c is string => Boolean(c));
  const found = candidates.find((c) => fs.existsSync(path.join(c, ".claude", "skills")));
  return path.join(found ?? candidates[0], ".claude", "skills");
}

function parseSkill(name: SkillName, file: string): LoadedSkill {
  const raw = fs.readFileSync(file, "utf8");
  const fm = raw.match(/^---\n([\s\S]*?)\n---\n/);
  if (!fm) throw new Error(`Skill ${name} has no frontmatter: ${file}`);
  const meta = Object.fromEntries(
    fm[1].split("\n").map((l) => {
      const i = l.indexOf(":");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }),
  );
  if (meta.name !== name) throw new Error(`Skill in ${file} is named "${meta.name}", expected "${name}"`);
  if (!meta.description) throw new Error(`Skill ${name} has no description`);
  const body = raw
    .slice(fm[0].length)
    .replace(/<!--[\s\S]*?-->\s?/g, "") // lint markers are for scripts/lint-skills.ts, not the model
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { name, description: meta.description, body, file };
}

/** Loads every required skill, or throws naming the ones that are missing. Never runs skill-less. */
export function loadSkills(dir = skillsDir()): LoadedSkill[] {
  const missing = REQUIRED_SKILLS.filter((s) => !fs.existsSync(path.join(dir, s, "SKILL.md")));
  if (missing.length) {
    throw new Error(
      `Skills failed to load: ${missing.join(", ")} (looked in ${dir}). ` +
        `Check that .claude/skills/<name>/SKILL.md exists under AGENT_CWD.`,
    );
  }
  return REQUIRED_SKILLS.map((s) => parseSkill(s, path.join(dir, s, "SKILL.md")));
}

const PREAMBLE = `You are the voice support agent for RelayPay, a B2B platform that African startups and SMEs use to send and receive international payments, issue multi-currency invoices, and pay contractors and vendors.

You are on a live call. Everything you write is spoken aloud to the caller, except the control tag that ends each reply.

Your tools are the only source of facts about RelayPay and about a caller's account:
- search_knowledge_base: approved product and policy knowledge
- lookup_customer, lookup_transaction, lookup_payout: account records, returned in customer-safe form
- create_support_ticket, create_escalation: follow-up by the support team or a specialist
- log_conversation_event: decisions a reviewer should see that no other tool records

Searches, lookups, tickets and escalations are logged automatically. Do not log them again.

The skills below are your operating rules. Each rule has an ID such as R-ROUTE-1. support-routing decides which rule applies when they meet, and privacy-and-safety is never overridden.`;

let cached: string | null = null;

export function buildSystemPrompt(): string {
  // Cached in production only: in development, a skill edit applies to the next call without a restart.
  if (cached && process.env.NODE_ENV === "production") return cached;
  const skills = loadSkills();
  cached = [
    PREAMBLE,
    ...skills.map((s) => `<skill name="${s.name}">\n${s.body}\n</skill>`),
  ].join("\n\n");
  return cached;
}
