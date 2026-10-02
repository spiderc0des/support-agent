/**
 * Split the approved knowledge base into retrieval chunks, one per heading.
 *
 * `##` headings are sections; each `###` beneath one is a chunk. Text that
 * sits under a `##` before its first `###` (a section intro) becomes a chunk
 * titled with the section itself. The document title and its preamble are
 * not knowledge and are skipped.
 *
 * Chunk ids are stable slugs, so retrieval logs and the gold retrieval set
 * keep meaning the same thing across re-ingests.
 */
/**
 * The score (0..1, from match_kb) a chunk needs to count as approved context.
 *
 * Tuned by tests/retrieval.test.ts: every gold question's answer scores well
 * above it, and off-topic questions score nothing. Change it only with that
 * test green. Lives here because the MCP server, the ingest script and the
 * admin knowledge editor all measure against it.
 */
export const KB_MATCH_THRESHOLD = 0.35;

/** Recall@3 on the gold set a knowledge-base change must keep. */
export const KB_MIN_RECALL = 0.9;

/** Generous for ~40 short sections; refuses a pasted novel. */
export const KB_MAX_BYTES = 200_000;

export type KbChunk = {
  id: string;
  section: string;
  title: string;
  source_title: string;
  summary: string;
  content: string;
  keywords: string;
  ordinal: number;
};

const SECTION_PREFIX: Record<string, string> = {
  "Product Features Overview": "product",
  "Frequently Asked Questions": "faq",
  "Policies And Compliance": "policy",
  "Release Notes And Known Limitations": "release",
};

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * A one-line summary for retrieval logs: the opening sentences, enough of them
 * to say something. FAQ answers that start "No." or "Yes." need the next
 * sentence to mean anything on their own.
 */
function summarise(text: string): string {
  const flat = text.replace(/^[-*]\s+/gm, "").replace(/\s+/g, " ").trim();
  const sentences = flat.match(/[^.!?]+[.!?]+(\s|$)|[^.!?]+$/g) ?? [flat];
  let out = "";
  for (const s of sentences) {
    out = `${out} ${s.trim()}`.trim();
    if (out.length >= 40) break;
  }
  return out.length > 180 ? `${out.slice(0, 177)}...` : out;
}

export function chunkKnowledgeBase(markdown: string, keywords: Record<string, string> = {}): KbChunk[] {
  const chunks: KbChunk[] = [];
  let section: string | null = null;
  let title: string | null = null;
  let buffer: string[] = [];

  const flush = () => {
    const content = buffer.join("\n").trim();
    buffer = [];
    if (!section || !content) return;
    const chunkTitle = title ?? section;
    const prefix = SECTION_PREFIX[section] ?? slugify(section);
    const id = title ? `${prefix}-${slugify(title)}` : `${prefix}-overview`;
    chunks.push({
      id,
      section,
      title: chunkTitle,
      source_title: title ? `${section} › ${title}` : section,
      summary: summarise(content),
      content,
      keywords: keywords[id] ?? "",
      ordinal: chunks.length + 1,
    });
  };

  for (const line of markdown.split("\n")) {
    const h2 = line.match(/^##\s+(.+?)\s*$/);
    const h3 = line.match(/^###\s+(.+?)\s*$/);
    if (h2 && !line.startsWith("###")) {
      flush();
      section = h2[1];
      title = null;
    } else if (h3) {
      flush();
      title = h3[1];
    } else if (/^#\s/.test(line)) {
      flush();
      section = null;
      title = null;
    } else if (section) {
      buffer.push(line);
    }
  }
  flush();

  const seen = new Set<string>();
  for (const c of chunks) {
    if (seen.has(c.id)) throw new Error(`Duplicate knowledge-base chunk id: ${c.id}`);
    seen.add(c.id);
  }
  return chunks;
}

export type GoldQuery = { q: string; expect: string[] | "none" };

export type PreparedKb = {
  chunks: KbChunk[];
  /** Keyword entries kept: only those naming a chunk that exists. */
  keywords: Record<string, string>;
  /** Keyword entries dropped because their chunk no longer exists (a renamed or removed heading). */
  orphanKeywords: string[];
  /** Gold questions whose expected chunk no longer exists: they will miss. */
  orphanGold: string[];
};

/**
 * Validate and chunk a knowledge-base document for publishing. Throws with a
 * message fit to show an admin when the document can't be published at all.
 */
export function prepareKnowledgeBase(markdown: string, keywords: Record<string, string>, gold: GoldQuery[] = []): PreparedKb {
  if (!markdown.trim()) throw new Error("The knowledge base is empty.");
  if (new TextEncoder().encode(markdown).length > KB_MAX_BYTES) throw new Error(`The knowledge base is over ${KB_MAX_BYTES / 1000} KB.`);
  for (const [k, v] of Object.entries(keywords)) {
    if (typeof v !== "string") throw new Error(`Keywords for "${k}" must be a string of words.`);
  }
  const chunks = chunkKnowledgeBase(markdown, keywords);
  if (!chunks.length) throw new Error("No chunks found. Put each topic under a ## section heading, with ### headings for its parts.");
  const ids = new Set(chunks.map((c) => c.id));
  const orphanKeywords = Object.keys(keywords).filter((k) => k !== "//" && !ids.has(k));
  const kept = Object.fromEntries(Object.entries(keywords).filter(([k]) => k === "//" || ids.has(k)));
  const orphanGold = [...new Set(gold.flatMap((g) => (g.expect === "none" ? [] : g.expect.filter((id) => !ids.has(id)))))];
  return { chunks, keywords: kept, orphanKeywords, orphanGold };
}
