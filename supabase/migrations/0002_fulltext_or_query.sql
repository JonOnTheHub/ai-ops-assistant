-- 0002: replace AND-based full-text candidate function with OR-across-terms.
-- Supersedes the match_kb_documents_fulltext_ids defined in 0001.
-- This is a verbatim capture of the version deployed in Supabase.

CREATE OR REPLACE FUNCTION public.match_kb_documents_fulltext_ids(query_text text, match_count integer)
 RETURNS TABLE(id uuid, rank double precision)
 LANGUAGE plpgsql
AS $function$
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
$function$;