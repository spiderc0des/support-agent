/**
 * The score (0..1, from match_kb) a chunk needs to count as approved context.
 *
 * Tuned by tests/retrieval.test.ts: every gold question's answer scores well
 * above it, and off-topic questions score nothing. Change it only with that
 * test green.
 */
export const KB_MATCH_THRESHOLD = 0.35;

/** Chunks handed to the model per search. Three keeps the turn short and cheap. */
export const KB_DEFAULT_K = 3;
