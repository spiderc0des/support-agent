-- ============================================================================
-- 0002_knowledge_base.sql — approved RelayPay knowledge, chunked by heading
--
-- Loaded from assets/relaypay-knowledge-base.md by `npm run kb:ingest`.
--
-- Retrieval is Postgres full-text search, not embeddings: the knowledge base is
-- about forty short sections, so ranked keyword search with a curated keyword
-- list per chunk is free, deterministic, and easy to debug from a log row.
-- `npm run test:retrieval` holds it to a recall target; if it ever misses,
-- vectors are the upgrade, not a rewrite.
-- ============================================================================

create table public.kb_chunks (
  id          text primary key,                  -- stable slug, e.g. 'faq-how-does-relaypay-charge-fees'
  section     text not null,                     -- top-level heading, e.g. 'Frequently Asked Questions'
  title       text not null,                     -- the chunk's own heading
  source_title text not null,                    -- 'Section › Title', what retrieval logs and the agent cite
  summary     text not null,                     -- one line, for retrieval logs
  content     text not null,
  keywords    text not null default '',          -- curated synonyms the caller might say instead
  ordinal     integer not null,                  -- position in the source document
  tsv         tsvector generated always as (
                setweight(to_tsvector('english', title), 'A') ||
                setweight(to_tsvector('english', keywords), 'A') ||
                setweight(to_tsvector('english', content), 'B')
              ) stored,
  updated_at  timestamptz not null default now()
);

create index kb_chunks_tsv_idx on public.kb_chunks using gin (tsv);

-- ---------------------------------------------------------------- match_kb -
-- OR-semantics: every meaningful word in the query can contribute, and the
-- ranking decides. AND-semantics (websearch_to_tsquery) fails on spoken
-- questions, which are long and full of words no chunk contains.
--
-- The brand name is dropped from the query: it appears in almost every chunk,
-- so it only adds noise to the ranking — unless it is the whole question.
--
-- Scores are normalised to 0..1 (ts_rank_cd flag 32). `matched` is decided by
-- the caller against a threshold tuned in test:retrieval.
create or replace function public.match_kb(p_query text, p_k integer default 3)
returns table (id text, source_title text, summary text, content text, score real)
language plpgsql
stable
set search_path = public
as $$
declare
  v_query tsquery;
begin
  select string_agg(quote_literal(lexeme), ' | ')::text::tsquery
    into v_query
    from unnest(to_tsvector('english', coalesce(p_query, '')))
   where lexeme <> 'relaypay';

  -- "What is RelayPay?" is nothing but the brand name once stopwords go.
  if v_query is null then
    select string_agg(quote_literal(lexeme), ' | ')::text::tsquery
      into v_query
      from unnest(to_tsvector('english', coalesce(p_query, '')));
  end if;

  if v_query is null then
    return;
  end if;

  return query
    select c.id, c.source_title, c.summary, c.content,
           ts_rank_cd('{0.1, 0.2, 0.4, 1.0}', c.tsv, v_query, 32)::real as score
      from public.kb_chunks c
     where c.tsv @@ v_query
     order by score desc, c.ordinal
     limit greatest(1, least(coalesce(p_k, 3), 5));
end;
$$;
