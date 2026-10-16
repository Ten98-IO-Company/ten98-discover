-- Archive configuration without deleting financial, occurrence or retry identity.
ALTER TABLE prompt_tracker ADD COLUMN archived_at timestamptz CHECK(archived_at IS NULL OR isfinite(archived_at));
ALTER TABLE prompt_tracker ADD CONSTRAINT prompt_tracker_archived_disabled CHECK(archived_at IS NULL OR (
 NOT enabled AND next_due_at IS NULL AND approval_id IS NULL AND approval_user_id IS NULL
 AND approval_connection_revision IS NULL AND approval_key_fingerprint IS NULL
 AND approval_models_hash IS NULL AND approved_at IS NULL));
CREATE INDEX prompt_tracker_library_idx ON prompt_tracker(project_id,created_at DESC,id DESC);