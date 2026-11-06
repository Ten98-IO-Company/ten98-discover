-- Preserve business-input identity after raw input retention expires. Historical
-- requests whose input is already purged retain a NULL identity for conservative
-- duplicate checks against their immutable prompt text.
ALTER TABLE ai_search_quote ADD COLUMN business_input_hash text
 CHECK (business_input_hash IS NULL OR business_input_hash ~ '^[a-f0-9]{64}$');

UPDATE ai_search_quote
 SET business_input_hash=encode(sha256(convert_to((input->'request')::text,'UTF8')),'hex')
 WHERE jsonb_typeof(input->'request')='object';

-- Unknown outcomes remain fenced by their input under the existing project lock.
-- Only queued/running work holds the project's active execution slot.
DROP INDEX ai_search_active_project_idx;
CREATE UNIQUE INDEX ai_search_active_project_idx ON ai_search_run(project_id)
 WHERE status IN ('queued','running');
CREATE INDEX ai_search_uncertain_project_idx ON ai_search_run(project_id,quote_id)
 WHERE status='uncertain';
