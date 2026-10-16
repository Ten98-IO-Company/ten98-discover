-- Recurring authorization is disabled until a current owner explicitly approves it.
-- Financial work remains in the existing quote/comparison/provider-request tables.
CREATE TABLE prompt_tracker (
 id uuid PRIMARY KEY,
 workspace_id text NOT NULL,
 project_id text NOT NULL,
 created_request_id uuid NOT NULL,
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 120),
 revision integer NOT NULL DEFAULT 1 CHECK(revision BETWEEN 1 AND 2147483646),
 input jsonb NOT NULL CHECK(jsonb_typeof(input)='object' AND input->>'reuseCached'='false' AND octet_length(input::text)<=32768),
 definition_hash text NOT NULL CHECK(definition_hash ~ '^[a-f0-9]{64}$'),
 calendar jsonb NOT NULL CHECK(jsonb_typeof(calendar)='object' AND calendar->>'interval' IN('daily','weekly','monthly') AND octet_length(calendar::text)<=1024),
 maximum_micros bigint NOT NULL CHECK(maximum_micros BETWEEN 1 AND 1000000000000),
 enabled boolean NOT NULL DEFAULT false,
 next_due_at timestamptz,
 approval_id uuid,
 approval_user_id text REFERENCES "user"(id),
 approval_connection_revision integer CHECK(approval_connection_revision>0),
 approval_key_fingerprint text CHECK(approval_key_fingerprint ~ '^[a-f0-9]{64}$'),
 approval_models_hash text CHECK(approval_models_hash ~ '^[a-f0-9]{64}$'),
 approved_at timestamptz,
 last_status text CHECK(length(last_status)<=500),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(project_id,workspace_id) REFERENCES project(id,workspace_id),
 UNIQUE(id,workspace_id,project_id),
 UNIQUE(project_id,created_request_id),
 CHECK((approval_id IS NULL AND approval_user_id IS NULL AND approval_connection_revision IS NULL AND approval_key_fingerprint IS NULL AND approval_models_hash IS NULL AND approved_at IS NULL) OR (approval_id IS NOT NULL AND approval_user_id IS NOT NULL AND approval_connection_revision IS NOT NULL AND approval_key_fingerprint IS NOT NULL AND approval_models_hash IS NOT NULL AND approved_at IS NOT NULL)),
 CHECK(NOT enabled OR approval_id IS NOT NULL),
 CHECK((enabled AND next_due_at IS NOT NULL AND isfinite(next_due_at)) OR (NOT enabled AND next_due_at IS NULL))
);
CREATE INDEX prompt_tracker_due_idx ON prompt_tracker(next_due_at,id) WHERE enabled;
CREATE TABLE prompt_occurrence (
 id uuid PRIMARY KEY,
 tracker_id uuid NOT NULL,
 workspace_id text NOT NULL,
 project_id text NOT NULL,
 user_id text NOT NULL REFERENCES "user"(id),
 requested_by text NOT NULL REFERENCES "user"(id),
 approval_id uuid NOT NULL,
 definition_hash text NOT NULL CHECK(definition_hash ~ '^[a-f0-9]{64}$'),
 scheduled_for timestamptz NOT NULL CHECK(isfinite(scheduled_for)),
 trigger text NOT NULL CHECK(trigger IN('calendar','now')),
 request_key uuid NOT NULL,
 quote_id uuid,
 comparison_id uuid,
 status text NOT NULL CHECK(status IN('quoted','started','skipped')),
 reason text CHECK(length(reason)<=500),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(tracker_id,workspace_id,project_id) REFERENCES prompt_tracker(id,workspace_id,project_id),
 FOREIGN KEY(quote_id,workspace_id,project_id,user_id) REFERENCES prompt_execution_quote(id,workspace_id,project_id,user_id),
 FOREIGN KEY(comparison_id,workspace_id,project_id) REFERENCES prompt_comparison(id,workspace_id,project_id),
 UNIQUE(id,workspace_id,project_id),
 UNIQUE(tracker_id,scheduled_for),
 UNIQUE(workspace_id,request_key),
 UNIQUE(quote_id),
 UNIQUE(comparison_id),
 CHECK((status='quoted' AND quote_id IS NOT NULL AND comparison_id IS NULL) OR (status='started' AND quote_id IS NOT NULL AND comparison_id IS NOT NULL) OR (status='skipped' AND comparison_id IS NULL))
);
CREATE INDEX prompt_occurrence_pending_idx ON prompt_occurrence(created_at,id) WHERE status='quoted';
ALTER TABLE prompt_execution_quote ADD COLUMN recurring_occurrence_id uuid;
ALTER TABLE prompt_execution_quote ADD COLUMN recurring_models_hash text CHECK(recurring_models_hash IS NULL OR recurring_models_hash ~ '^[a-f0-9]{64}$');
ALTER TABLE prompt_execution_quote ADD CONSTRAINT prompt_quote_recurring_scope FOREIGN KEY(recurring_occurrence_id,workspace_id,project_id) REFERENCES prompt_occurrence(id,workspace_id,project_id);
CREATE UNIQUE INDEX prompt_quote_recurring_unique ON prompt_execution_quote(recurring_occurrence_id) WHERE recurring_occurrence_id IS NOT NULL;
