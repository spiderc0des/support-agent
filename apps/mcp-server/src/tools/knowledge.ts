import { z } from "zod";
import type { ToolHandler } from "../lib/tooling.ts";
import { KB_DEFAULT_K, KB_MATCH_THRESHOLD } from "../lib/retrieval.ts";

export const searchKnowledgeBaseShape = {
  query: z
    .string()
    .min(2)
    .max(300)
    .describe("Keywords for what the caller is asking, e.g. 'international payment fees'. Rewrite speech into search terms."),
  k: z.number().int().min(1).max(5).optional().describe("How many passages to return (default 3)."),
};
type Args = { query: string; k?: number };

export const searchKnowledgeBase: ToolHandler<Args> = async ({ query, k }, conversation, { store }) => {
  const hits = await store.matchKb(query, k ?? KB_DEFAULT_K);
  const approved = hits.filter((h) => h.score >= KB_MATCH_THRESHOLD);
  const matched = approved.length > 0;

  // Every search is logged, including the ones that found nothing: an empty
  // retrieval is the evidence behind a "decline" answer.
  await store.logRetrieval({
    conversation_id: conversation.id,
    turn_index: conversation.current_turn,
    query,
    chunk_ids: approved.map((h) => h.id),
    source_titles: approved.map((h) => h.source_title),
    source_summaries: approved.map((h) => h.summary),
    scores: hits.map((h) => Number(h.score.toFixed(3))),
    top_score: hits[0] ? Number(hits[0].score.toFixed(3)) : null,
    matched,
  });

  return {
    status: "success",
    result: matched
      ? {
          matched: true,
          chunks: approved.map((h) => ({ id: h.id, source: h.source_title, text: h.content })),
          guidance: "Answer only from these passages. If they do not answer the question, treat it as not covered.",
        }
      : {
          matched: false,
          chunks: [],
          guidance:
            "No approved knowledge covers this. Do not answer from general knowledge: say you can't confirm that, and offer a follow-up from the support team if it concerns their account.",
        },
    summary: { matched, chunk_ids: approved.map((h) => h.id), top_score: hits[0]?.score ?? null },
  };
};
