-- ============================================================================
-- 0011_kb_versions.sql — admins edit the knowledge base and re-ingest it
--
-- Until now the knowledge base lived only in data/relaypay-knowledge-base.md
-- and reached kb_chunks through `npm run kb:ingest`. An admin can now edit it
-- on /review/admin/knowledge. The deployed app's filesystem is rebuilt on
-- every deploy, so the edited document is kept here, one row per published
-- version, and that row is what the editor opens next time.
--
-- Publishing goes through kb_publish(), which:
--   1. replaces kb_chunks with the new chunks in one transaction, so the
--      agent never searches a half-written knowledge base;
--   2. runs the retrieval gold set (data/retrieval-gold.json) against the
--      new chunks with the real match_kb, before anything is committed;
--   3. keeps the change only if no gold question that finds its answer
--      today stops finding it, recall@3 stays at the bar, and no off-topic
--      question starts matching (or the admin explicitly publishes anyway).
--      The regression rule matters: deleting one answer outright costs only
--      a few points of recall, which a percentage bar alone would let through;
--   4. records the version: text, keywords, chunk count, recall, who, why.
--
-- A "check" is the same run with step 3 always rolling back, so the admin
-- sees exactly what publishing would do, measured on the real search.
-- ============================================================================

create table if not exists public.kb_versions (
  version       integer primary key,
  markdown      text not null,
  keywords      jsonb not null default '{}'::jsonb,
  chunk_count   integer not null,
  recall        real,                        -- recall@3 on the gold set when published
  forced        boolean not null default false, -- published despite a failed check
  note          text,                        -- what changed, in the admin's words
  published_by  uuid references public.profiles(id) on delete set null,
  published_at  timestamptz not null default now()
);

alter table public.kb_versions enable row level security;
drop policy if exists kb_versions_select_admin on public.kb_versions;
create policy kb_versions_select_admin on public.kb_versions
  for select to authenticated using ((select public.is_admin()));

-- ---------------------------------------------------------- kb_gold_eval -
-- The gold set against whatever kb_chunks holds right now.
create or replace function public.kb_gold_eval(p_gold jsonb, p_threshold real)
returns jsonb
language plpgsql
stable
set search_path = public
as $$
declare
  g          jsonb;
  v_top      text[];
  v_answerable integer := 0;
  v_hits     integer := 0;
  v_misses   jsonb := '[]'::jsonb;
  v_leaks    jsonb := '[]'::jsonb;
begin
  for g in select * from jsonb_array_elements(coalesce(p_gold, '[]'::jsonb)) loop
    select coalesce(array_agg(m.id order by m.score desc), '{}') into v_top
      from match_kb(g->>'q', 3) m where m.score >= p_threshold;
    if jsonb_typeof(g->'expect') = 'array' then
      v_answerable := v_answerable + 1;
      if exists (select 1 from jsonb_array_elements_text(g->'expect') e where e = any (v_top)) then
        v_hits := v_hits + 1;
      else
        v_misses := v_misses || jsonb_build_object('q', g->>'q', 'expect', g->'expect', 'got', to_jsonb(v_top));
      end if;
    elsif cardinality(v_top) > 0 then
      v_leaks := v_leaks || jsonb_build_object('q', g->>'q', 'got', to_jsonb(v_top));
    end if;
  end loop;
  return jsonb_build_object('answerable', v_answerable, 'hits', v_hits, 'misses', v_misses, 'leaks', v_leaks);
end;
$$;

-- --------------------------------------------------------------- kb_publish -
-- p_chunks: [{id, section, title, source_title, summary, content, keywords, ordinal}]
--           chunked by the app with the same chunker as `npm run kb:ingest`.
-- p_gold:   [{q, expect: [chunk ids] | "none"}]
create or replace function public.kb_publish(
  p_markdown   text,
  p_keywords   jsonb,
  p_chunks     jsonb,
  p_gold       jsonb,
  p_threshold  real,
  p_min_recall real,
  p_dry_run    boolean,
  p_force      boolean,
  p_note       text,
  p_actor      uuid
)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_added     text[];
  v_removed   text[];
  v_changed   text[];
  v_count     integer;
  v_before    jsonb;
  v_after     jsonb;
  v_regressed jsonb := '[]'::jsonb;
  v_new_leaks jsonb := '[]'::jsonb;
  v_recall    real;
  v_passed    boolean;
  v_kept      boolean := false;
  v_version   integer;
begin
  if jsonb_typeof(p_chunks) <> 'array' or jsonb_array_length(p_chunks) = 0 then
    raise exception 'The knowledge base has no chunks: add at least one ## section with text under it';
  end if;

  -- One publish at a time; a second admin waits rather than interleaving.
  perform pg_advisory_xact_lock(hashtext('kb_publish'));

  -- Today's results, to compare against.
  v_before := kb_gold_eval(p_gold, p_threshold);

  begin
    create temp table if not exists kb_incoming (
      id text, section text, title text, source_title text, summary text,
      content text, keywords text, ordinal integer
    ) on commit drop;
    truncate kb_incoming;
    insert into kb_incoming
      select * from jsonb_to_recordset(p_chunks) as x(
        id text, section text, title text, source_title text, summary text,
        content text, keywords text, ordinal integer);
    select count(*) into v_count from kb_incoming;

    select coalesce(array_agg(i.id order by i.ordinal), '{}') into v_added
      from kb_incoming i where not exists (select 1 from kb_chunks c where c.id = i.id);
    select coalesce(array_agg(c.id order by c.ordinal), '{}') into v_removed
      from kb_chunks c where not exists (select 1 from kb_incoming i where i.id = c.id);
    select coalesce(array_agg(i.id order by i.ordinal), '{}') into v_changed
      from kb_incoming i join kb_chunks c on c.id = i.id
     where (c.content, c.title, c.section, c.keywords, c.ordinal) is distinct from (i.content, i.title, i.section, i.keywords, i.ordinal);

    delete from kb_chunks c where not exists (select 1 from kb_incoming i where i.id = c.id);
    insert into kb_chunks (id, section, title, source_title, summary, content, keywords, ordinal, updated_at)
      select id, section, title, source_title, summary, content, coalesce(keywords, ''), ordinal, now() from kb_incoming
    on conflict (id) do update set
      section = excluded.section, title = excluded.title, source_title = excluded.source_title,
      summary = excluded.summary, content = excluded.content, keywords = excluded.keywords,
      ordinal = excluded.ordinal,
      updated_at = case when (kb_chunks.content, kb_chunks.title, kb_chunks.keywords)
                             is distinct from (excluded.content, excluded.title, excluded.keywords)
                        then now() else kb_chunks.updated_at end;

    -- The gold set, on the new chunks, with the real search.
    v_after := kb_gold_eval(p_gold, p_threshold);
    select coalesce(jsonb_agg(m), '[]'::jsonb) into v_regressed
      from jsonb_array_elements(v_after->'misses') m
     where not exists (select 1 from jsonb_array_elements(v_before->'misses') b where b->>'q' = m->>'q');
    select coalesce(jsonb_agg(l), '[]'::jsonb) into v_new_leaks
      from jsonb_array_elements(v_after->'leaks') l
     where not exists (select 1 from jsonb_array_elements(v_before->'leaks') b where b->>'q' = l->>'q');

    v_recall := case when (v_after->>'answerable')::int = 0 then null
                     else (v_after->>'hits')::real / (v_after->>'answerable')::int end;
    v_passed := coalesce(v_recall, 1) >= p_min_recall
                and jsonb_array_length(v_regressed) = 0
                and jsonb_array_length(v_new_leaks) = 0;

    if p_dry_run or (not v_passed and not p_force) then
      raise exception using errcode = 'P0001', message = 'kb_publish:rollback';
    end if;
    v_kept := true;
  exception when sqlstate 'P0001' then
    if sqlerrm <> 'kb_publish:rollback' then raise; end if;
    -- Everything in the block is undone; the measurements above survive.
  end;

  if v_kept then
    select coalesce(max(version), 0) + 1 into v_version from kb_versions;
    insert into kb_versions (version, markdown, keywords, chunk_count, recall, forced, note, published_by)
    values (v_version, p_markdown, coalesce(p_keywords, '{}'::jsonb), v_count, v_recall, not v_passed,
            nullif(btrim(coalesce(p_note, '')), ''), p_actor);
  end if;

  return jsonb_build_object(
    'published', v_kept,
    'version', v_version,
    'passed', v_passed,
    'chunks', v_count,
    'added', to_jsonb(v_added),
    'removed', to_jsonb(v_removed),
    'changed', to_jsonb(v_changed),
    'recall', v_recall,
    'recall_before', case when (v_before->>'answerable')::int = 0 then null
                          else (v_before->>'hits')::real / (v_before->>'answerable')::int end,
    'answerable', (v_after->>'answerable')::int,
    'hits', (v_after->>'hits')::int,
    'misses', v_after->'misses',
    'regressed', v_regressed,
    'leaks', v_after->'leaks',
    'new_leaks', v_new_leaks
  );
end;
$$;

revoke all on function public.kb_gold_eval(jsonb, real) from public, anon, authenticated;
grant execute on function public.kb_gold_eval(jsonb, real) to service_role;
revoke all on function public.kb_publish(text, jsonb, jsonb, jsonb, real, real, boolean, boolean, text, uuid) from public, anon, authenticated;
grant execute on function public.kb_publish(text, jsonb, jsonb, jsonb, real, real, boolean, boolean, text, uuid) to service_role;
