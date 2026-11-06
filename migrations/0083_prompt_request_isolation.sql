-- Separate authored-selection identity; existing request/payload/receipt hashes remain unchanged.
ALTER TABLE ai_suggestion_quote ADD COLUMN business_input_hash text
 CHECK(business_input_hash IS NULL OR business_input_hash ~ '^[a-f0-9]{64}$');

WITH shaped AS MATERIALIZED (
 SELECT q.id,q.input,
  CASE WHEN jsonb_typeof(input->'sectionKeys')='array' THEN input->'sectionKeys' ELSE '[]'::jsonb END AS sections,
  CASE WHEN jsonb_typeof(input->'competitorIds')='array' THEN input->'competitorIds' ELSE '[]'::jsonb END AS competitors,
  CASE WHEN jsonb_typeof(input->'excludedPrompts')='array' THEN input->'excludedPrompts' ELSE '[]'::jsonb END AS excluded
 FROM ai_suggestion_quote q
 WHERE purpose='prompt' AND input_purged_at IS NULL
), eligible AS MATERIALIZED (
 SELECT id,input FROM shaped
 WHERE jsonb_typeof(input)='object'
  AND jsonb_typeof(input->'sectionKeys')='array'
  AND jsonb_typeof(input->'competitorIds')='array'
  AND jsonb_typeof(input->'excludedPrompts')='array'
  AND jsonb_array_length(sections)<=4
  AND jsonb_array_length(competitors)<=10
  AND jsonb_array_length(excluded)<=20
  AND NOT EXISTS (
   SELECT 1 FROM (VALUES('topic',100),('country',80),('language',80)) AS f(name,maximum)
   WHERE jsonb_typeof(input->f.name) IS DISTINCT FROM 'string'
    OR NOT COALESCE(char_length(input->>f.name)+char_length(regexp_replace(input->>f.name,U&'[^\+010000-\+10FFFF]','','g')) BETWEEN 1 AND f.maximum
     AND input->>f.name=btrim(input->>f.name,U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'),false)
  )
  AND NOT EXISTS (
   SELECT 1 FROM jsonb_array_elements(sections) v
   WHERE jsonb_typeof(v) IS DISTINCT FROM 'string'
    OR (v#>>'{}') NOT IN('business_overview','current_goal','positioning','writing_preferences')
  )
  AND NOT EXISTS (
   SELECT 1 FROM jsonb_array_elements(competitors) v
   WHERE jsonb_typeof(v) IS DISTINCT FROM 'string'
    OR NOT COALESCE((v#>>'{}') ~ '^([0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[1-8][0-9A-Fa-f]{3}-[89ABab][0-9A-Fa-f]{3}-[0-9A-Fa-f]{12}|00000000-0000-0000-0000-000000000000|[Ff]{8}-[Ff]{4}-[Ff]{4}-[Ff]{4}-[Ff]{12})$',false)
  )
  AND NOT EXISTS (
   SELECT 1 FROM jsonb_array_elements(excluded) v
   WHERE jsonb_typeof(v) IS DISTINCT FROM 'string'
    OR NOT COALESCE(char_length(v#>>'{}')+char_length(regexp_replace(v#>>'{}',U&'[^\+010000-\+10FFFF]','','g')) BETWEEN 1 AND 2000
     AND (v#>>'{}')=btrim(v#>>'{}',U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'),false)
  )
), identities AS (
 SELECT id,jsonb_build_array('prompt-suggestion-business-v1','prompt',input->'topic',input->'country',input->'language',COALESCE((SELECT jsonb_agg(v ORDER BY v COLLATE "C") FROM (SELECT DISTINCT value#>>'{}' AS v FROM jsonb_array_elements(input->'sectionKeys')) s),'[]'::jsonb),COALESCE((SELECT jsonb_agg(v ORDER BY v COLLATE "C") FROM (SELECT DISTINCT lower(value#>>'{}') AS v FROM jsonb_array_elements(input->'competitorIds')) s),'[]'::jsonb),COALESCE((SELECT jsonb_agg(v ORDER BY v COLLATE "C") FROM (SELECT DISTINCT value#>>'{}' AS v FROM jsonb_array_elements(input->'excludedPrompts')) s),'[]'::jsonb)) AS identity FROM eligible
)
UPDATE ai_suggestion_quote q
 SET business_input_hash=encode(sha256(convert_to(i.identity::text,'UTF8')),'hex')
 FROM identities i WHERE i.id=q.id;

-- Missing/malformed historical prompt selectors remain NULL. An unknown prompt
-- with NULL identity conservatively blocks new prompt work in that project.
-- Site-analysis retains its existing independent uncertain/active restriction.
DROP INDEX ai_suggestion_active_project_idx;
CREATE UNIQUE INDEX ai_suggestion_active_project_idx ON ai_suggestion_run(project_id,purpose)
 WHERE status IN('queued','running') OR (purpose='site-analysis' AND status='uncertain');
CREATE INDEX ai_suggestion_uncertain_prompt_idx ON ai_suggestion_run(project_id,quote_id)
 WHERE purpose='prompt' AND status='uncertain';
