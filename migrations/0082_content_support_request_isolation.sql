-- Identity is canonicalHash([purpose,promptVersion,schemaVersion,method,
-- derivationVersion,sortedQueryIds,sortedPageIdBodyHashPairs]). All strings are
-- fixed ASCII contract literals, lowercase UUIDs or SHA-256 hex. Consequently
-- removing JSONB's comma spaces produces the existing canonicalHash JSON bytes;
-- this is not a general-purpose JSON canonicalization function.
ALTER TABLE ai_content_support_quote ADD COLUMN business_input_hash text
 CHECK (business_input_hash IS NULL OR business_input_hash ~ '^[a-f0-9]{64}$');

WITH candidates AS MATERIALIZED (
 SELECT q.*,
  CASE WHEN jsonb_typeof(q.snapshot#>'{selection,queries}')='array'
   THEN q.snapshot#>'{selection,queries}' ELSE '[]'::jsonb END AS selected_queries,
  CASE WHEN jsonb_typeof(q.snapshot#>'{selection,pages}')='array'
   THEN q.snapshot#>'{selection,pages}' ELSE '[]'::jsonb END AS selected_pages,
  CASE WHEN jsonb_typeof(q.source_input->'selectedQueryIds')='array'
   THEN q.source_input->'selectedQueryIds' ELSE '[]'::jsonb END AS input_queries,
  CASE WHEN jsonb_typeof(q.source_input->'selectedPageIds')='array'
   THEN q.source_input->'selectedPageIds' ELSE '[]'::jsonb END AS input_pages
 FROM ai_content_support_quote q
 WHERE q.input_purged_at IS NULL
), identities AS (
 SELECT q.id,jsonb_build_array(q.purpose,q.prompt_version,q.schema_version,
  q.method,q.derivation_version,queries.ids,pages.pairs) AS identity
 FROM candidates q
 CROSS JOIN LATERAL (
  SELECT count(*) AS n,count(DISTINCT v->>'id') AS unique_n,
   bool_and(COALESCE(jsonb_typeof(v)='object' AND jsonb_typeof(v->'id')='string'
    AND v->>'id' ~ '^[a-f0-9]{64}$',false)) AS valid,
   jsonb_agg(v->'id' ORDER BY (v->>'id') COLLATE "C") AS ids
  FROM jsonb_array_elements(q.selected_queries) v
 ) queries
 CROSS JOIN LATERAL (
  SELECT count(*) AS n,count(DISTINCT v->>'id') AS unique_n,
   bool_and(COALESCE(jsonb_typeof(v)='object' AND jsonb_typeof(v->'id')='string'
    AND v->>'id' ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
    AND jsonb_typeof(v->'bodySha256')='string'
    AND v->>'bodySha256' ~ '^[a-f0-9]{64}$',false)) AS valid,
   jsonb_agg(v->'id' ORDER BY (v->>'id') COLLATE "C") AS ids,
   jsonb_agg(jsonb_build_array(v->'id',v->'bodySha256')
    ORDER BY (v->>'id') COLLATE "C",(v->>'bodySha256') COLLATE "C") AS pairs
  FROM jsonb_array_elements(q.selected_pages) v
 ) pages
 WHERE queries.n BETWEEN 1 AND 5 AND queries.n=queries.unique_n AND queries.valid
  AND pages.n BETWEEN 1 AND 20 AND pages.n=pages.unique_n AND pages.valid
  AND queries.ids=(SELECT jsonb_agg(v ORDER BY (v#>>'{}') COLLATE "C")
   FROM jsonb_array_elements(q.input_queries) v)
  AND pages.ids=(SELECT jsonb_agg(v ORDER BY (v#>>'{}') COLLATE "C")
   FROM jsonb_array_elements(q.input_pages) v)
  AND pages.pairs=(SELECT jsonb_agg(jsonb_build_array(v->'pageId',v->'bodySha256')
    ORDER BY (v->>'pageId') COLLATE "C",(v->>'bodySha256') COLLATE "C")
   FROM jsonb_array_elements(q.dependencies) v WHERE v->>'kind'='body')
)
UPDATE ai_content_support_quote q
 SET business_input_hash=encode(sha256(convert_to(replace(i.identity::text,', ',','),'UTF8')),'hex')
 FROM identities i WHERE i.id=q.id;

-- Already-purged or structurally inconsistent input stays NULL. Application
-- fallback must validate retained dependencies before comparing page/body pairs;
-- malformed dependencies block the new start rather than establish independence.
-- Existing source/input/payload/receipt fields and retention clocks are untouched.
DROP INDEX ai_content_support_active_project_idx;
CREATE UNIQUE INDEX ai_content_support_active_project_idx
 ON ai_content_support_run(project_id) WHERE status IN('queued','running');
CREATE INDEX ai_content_support_uncertain_project_idx
 ON ai_content_support_run(project_id,quote_id) WHERE status='uncertain';
