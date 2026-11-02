-- Historical financial fields and their value checks remain intact. New requests omit them.
CREATE TABLE workspace_provider_control (
  workspace_id text PRIMARY KEY REFERENCES workspace(id) ON DELETE CASCADE,
  paused boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO workspace_provider_control(workspace_id,paused)
SELECT workspace_id,paused FROM workspace_budget;

-- Version zero preserves the identity of historical preparations; new writers use version one.
ALTER TABLE keyword_quote ADD COLUMN request_version smallint NOT NULL DEFAULT 0 CHECK(request_version IN(0,1));
ALTER TABLE prompt_execution_quote ADD COLUMN request_version smallint NOT NULL DEFAULT 0 CHECK(request_version IN(0,1));
ALTER TABLE rank_run ADD COLUMN request_version smallint NOT NULL DEFAULT 0 CHECK(request_version IN(0,1));
ALTER TABLE ai_suggestion_quote ADD COLUMN request_version smallint NOT NULL DEFAULT 0 CHECK(request_version IN(0,1));
ALTER TABLE ai_search_quote ADD COLUMN request_version smallint NOT NULL DEFAULT 0 CHECK(request_version IN(0,1));
ALTER TABLE ai_content_support_quote ADD COLUMN request_version smallint NOT NULL DEFAULT 0 CHECK(request_version IN(0,1));
ALTER TABLE domain_research_quote ADD COLUMN request_version smallint NOT NULL DEFAULT 0 CHECK(request_version IN(0,1));
ALTER TABLE saved_keyword_refresh_plan ADD COLUMN request_version smallint NOT NULL DEFAULT 0 CHECK(request_version IN(0,1));

-- Ordinary value checks accept NULL, so only the listed obsolete input requirements change.
ALTER TABLE provider_request ALTER COLUMN estimate_micros DROP NOT NULL, ALTER COLUMN budget_month DROP NOT NULL;
ALTER TABLE keyword_quote ALTER COLUMN per_task_micros DROP NOT NULL, ALTER COLUMN per_item_micros DROP NOT NULL,
  ALTER COLUMN estimate_micros DROP NOT NULL, ALTER COLUMN price_as_of DROP NOT NULL;
ALTER TABLE saved_keyword_refresh_plan ALTER COLUMN estimate_micros DROP NOT NULL, ALTER COLUMN price_as_of DROP NOT NULL;
ALTER TABLE rank_run ALTER COLUMN estimate_micros DROP NOT NULL, ALTER COLUMN price_as_of DROP NOT NULL;
ALTER TABLE ai_search_quote ALTER COLUMN price_version DROP NOT NULL, ALTER COLUMN price_mode DROP NOT NULL,
  ALTER COLUMN price_source DROP NOT NULL, ALTER COLUMN price_checked_on DROP NOT NULL, ALTER COLUMN estimate_micros DROP NOT NULL;
ALTER TABLE ai_content_support_quote ALTER COLUMN estimate_micros DROP NOT NULL, ALTER COLUMN max_spend_micros DROP NOT NULL;
ALTER TABLE domain_research_quote ALTER COLUMN per_task_micros DROP NOT NULL, ALTER COLUMN per_item_micros DROP NOT NULL,
  ALTER COLUMN estimate_micros DROP NOT NULL, ALTER COLUMN price_as_of DROP NOT NULL;
ALTER TABLE prompt_tracker ALTER COLUMN maximum_micros DROP NOT NULL;

-- Replace only the mixed schedule check that explicitly requires a financial amount.
-- All existing actor, credential, revision and schedule authorization conditions are retained.
DO $$
DECLARE
  existing_constraint name;
BEGIN
  SELECT conname INTO STRICT existing_constraint FROM pg_constraint
  WHERE conrelid='rank_config'::regclass AND contype='c'
    AND pg_get_constraintdef(oid) LIKE '%approval_max_micros IS NOT NULL%';
  EXECUTE format('ALTER TABLE rank_config DROP CONSTRAINT %I',existing_constraint);
END $$;
ALTER TABLE rank_config ADD CONSTRAINT rank_config_enabled_request_approval CHECK(NOT schedule_enabled OR (
  archived_at IS NULL AND schedule_interval<>'manual' AND next_due_at IS NOT NULL
  AND approval_id IS NOT NULL AND approval_user_id IS NOT NULL
  AND approval_config_revision IS NOT NULL AND approval_config_revision=revision
  AND approval_keywords_revision IS NOT NULL AND approval_keywords_revision=keywords_revision
  AND approval_request_hash IS NOT NULL AND approval_connection_id IS NOT NULL AND approval_connection_revision IS NOT NULL
  AND approval_account_fingerprint IS NOT NULL AND approval_account_fingerprint_version IS NOT NULL
  AND approval_account_fingerprint_version=2 AND approved_at IS NOT NULL
));

-- Request completion and result collection are independent of historical billing evidence.
ALTER TABLE rank_task ADD COLUMN request_evidence jsonb
  CHECK(request_evidence IS NULL OR (jsonb_typeof(request_evidence)='object' AND octet_length(request_evidence::text)<=16384));
ALTER TABLE rank_dispatch ADD COLUMN request_evidence jsonb
  CHECK(request_evidence IS NULL OR (jsonb_typeof(request_evidence)='object' AND octet_length(request_evidence::text)<=16384));

ALTER TABLE ai_content_support_run ADD COLUMN request_evidence jsonb
  CHECK(request_evidence IS NULL OR (jsonb_typeof(request_evidence)='object' AND octet_length(request_evidence::text)<=16384));

-- Preserve only the approved connection binding used to collect an existing request.
-- Malformed historical bindings stay invalid rather than falling back to a different key.
UPDATE rank_dispatch SET request_evidence=jsonb_build_object('recovery',
 CASE WHEN jsonb_typeof(charge_evidence->'recovery')='object' AND octet_length((charge_evidence->'recovery')::text)<=8192
 THEN charge_evidence->'recovery' ELSE 'null'::jsonb END)
WHERE charge_evidence?'recovery';
