-- Hybrid search: full-text column/index + lean id-only retrieval functions.
--
-- Run this directly in the Supabase SQL editor. This is the first tracked
-- migration file in this project — schema changes so far have only ever
-- lived in the SQL editor itself, which is exactly what caused the earlier
-- local/production drift on the vector-dimension fix. Keeping this file in
-- git going forward doesn't replace running it manually, but at least
-- gives a reviewable, diffable record of what changed and why.

-- 1. Full-text search column + index -----------------------------------
-- Generated column, so it stays in sync with `content` automatically —
-- no application code has to remember to update it on insert/edit.
alter table kb_documents
  add column if not exists content_tsv tsvector
  generated always as (to_tsvector('english', content)) stored;

create index if not exists kb_documents_content_tsv_idx
  on kb_documents using gin (content_tsv);

-- 2. Lean vector search — ids + similarity only, no content -------------
-- Strictly LIMIT-bounded, no similarity threshold: this is a CANDIDATE
-- fetch for fusion, not a final-answer fetch. Threshold filtering belongs
-- after fusion decides what actually wins, not before.
create or replace function match_kb_documents_ids(
  query_embedding vector(512),
  match_count int
)
returns table (id uuid, similarity float)
language plpgsql
as $$
begin
  return query
  select
    kb_documents.id,
    1 - (kb_documents.embedding <=> query_embedding) as similarity
  from kb_documents
  order by kb_documents.embedding <=> query_embedding
  limit match_count;
end;
$$;

-- 3. Lean full-text search — ids + rank only, no content -----------------
create or replace function match_kb_documents_fulltext_ids(
  query_text text,
  match_count int
)
returns table (id uuid, rank double precision)
language plpgsql
as $$
declare
  or_query tsquery;
  word text;
begin
  -- OR-across-terms instead of plainto_tsquery's implicit AND: a 4-word
  -- query where even one word doesn't literally appear in a chunk would
  -- otherwise match nothing, even when 3 of 4 words do — defeating the
  -- point of full-text as a generous candidate generator for fusion.
  -- Each word is still safely stemmed via plainto_tsquery individually,
  -- then OR'd together as tsquery values, not raw string concatenation —
  -- no injection risk from hand-building tsquery syntax.
  or_query := null;
  for word in select unnest(string_to_array(trim(query_text), ' ')) loop
    if length(word) > 0 then
      if or_query is null then
        or_query := plainto_tsquery('english', word);
      else
        or_query := or_query || plainto_tsquery('english', word);
      end if;
    end if;
  end loop;

  if or_query is null then
    return;
  end if;

  return query
  select
    kb_documents.id,
    ts_rank(kb_documents.content_tsv, or_query)::float8 as rank
  from kb_documents
  where kb_documents.content_tsv @@ or_query
  order by rank desc
  limit match_count;
end;
$$;