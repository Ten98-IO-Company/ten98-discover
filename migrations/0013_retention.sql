ALTER TABLE workspace ADD COLUMN raw_analytics_days integer NOT NULL DEFAULT 90 CHECK (raw_analytics_days BETWEEN 1 AND 3650);
ALTER TABLE workspace ADD COLUMN replay_days integer NOT NULL DEFAULT 7 CHECK (replay_days BETWEEN 1 AND 3650);
ALTER TABLE workspace ADD COLUMN raw_provider_evidence_days integer NOT NULL DEFAULT 90 CHECK (raw_provider_evidence_days BETWEEN 1 AND 3650);
ALTER TABLE workspace ADD COLUMN derived_history_days integer NOT NULL DEFAULT 365 CHECK (derived_history_days BETWEEN 1 AND 3650);
ALTER TABLE workspace ADD COLUMN retention_revision integer NOT NULL DEFAULT 1 CHECK (retention_revision > 0);
ALTER TABLE workspace ADD COLUMN retention_updated_at timestamptz NOT NULL DEFAULT clock_timestamp();

ALTER TABLE project ADD COLUMN retention_policy_revision integer CHECK (retention_policy_revision > 0);
ALTER TABLE project ADD COLUMN retention_cutoff timestamptz;
ALTER TABLE project ADD COLUMN retention_next_run_at timestamptz NOT NULL DEFAULT clock_timestamp();
ALTER TABLE project ADD COLUMN retention_last_completed_at timestamptz;
ALTER TABLE project ADD COLUMN retention_error text CHECK (retention_error IN ('cleanup_failed'));
-- This never moves backward: extending a policy cannot restore deleted history.
ALTER TABLE project ADD COLUMN analytics_retained_from timestamptz;
CREATE INDEX project_retention_due_idx ON project(retention_next_run_at,id);
CREATE INDEX event_project_visitor_time_idx ON event(project_id,visitor_id,received_at) WHERE visitor_id IS NOT NULL;
CREATE INDEX analytics_visitor_retention_idx ON analytics_visitor(project_id,last_seen_at,id);
