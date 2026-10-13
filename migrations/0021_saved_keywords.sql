ALTER TABLE project ADD COLUMN saved_keywords_revision integer NOT NULL DEFAULT 1 CHECK(saved_keywords_revision>0);
ALTER TABLE project ADD COLUMN saved_keyword_metrics_revision bigint NOT NULL DEFAULT 1 CHECK(saved_keyword_metrics_revision>0);
CREATE SEQUENCE saved_keyword_version_seq AS bigint;

ALTER TABLE keyword_research_run ADD CONSTRAINT keyword_run_project_identity UNIQUE(id,project_id);
CREATE TABLE saved_keyword (
  id uuid PRIMARY KEY,
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  keyword text NOT NULL CHECK(length(keyword) BETWEEN 1 AND 500),
  location_code integer NOT NULL CHECK(location_code>0),
  language_code text NOT NULL CHECK(language_code ~ '^[a-z]{2,3}(-[A-Z]{2})?$'),
  created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  metric_data jsonb CHECK(metric_data IS NULL OR jsonb_typeof(metric_data)='object'),
  metric_source_run_id uuid,
  metric_source_row integer CHECK(metric_source_row BETWEEN 0 AND 99),
  metric_source text,
  metric_fetched_at timestamptz,
  metric_observed_at timestamptz,
  metric_expired_at timestamptz,
  metric_version bigint NOT NULL DEFAULT 0 CHECK(metric_version>=0),
  last_attempt_version bigint NOT NULL DEFAULT 0 CHECK(last_attempt_version>=0),
  last_attempt_status text CHECK(last_attempt_status IN('queued','running','completed','missing','failed','uncertain','cancelled','reconciled','skipped')),
  last_attempt_at timestamptz,
  UNIQUE(project_id,id),
  UNIQUE(project_id,keyword,location_code,language_code),
  FOREIGN KEY(metric_source_run_id,project_id) REFERENCES keyword_research_run(id,project_id),
  CHECK(metric_data IS NULL OR (metric_source_run_id IS NOT NULL AND metric_source_row IS NOT NULL AND metric_source IS NOT NULL AND metric_fetched_at IS NOT NULL AND metric_observed_at IS NOT NULL AND metric_expired_at IS NULL)),
  CHECK((last_attempt_status IS NULL)=(last_attempt_at IS NULL))
);
CREATE INDEX saved_keyword_page_idx ON saved_keyword(project_id,created_at,id);
CREATE INDEX saved_keyword_retention_idx ON saved_keyword(project_id,metric_observed_at,id) WHERE metric_data IS NOT NULL;
CREATE TABLE saved_keyword_tag (
  id uuid PRIMARY KEY,
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  name text NOT NULL CHECK(length(name) BETWEEN 1 AND 64),
  normalized_name text NOT NULL CHECK(length(normalized_name) BETWEEN 1 AND 64),
  color text CHECK(color IN('slate','rose','amber','lime','emerald','sky','violet','fuchsia')),
  UNIQUE(project_id,id),
  UNIQUE(project_id,normalized_name)
);
CREATE TABLE saved_keyword_tag_assignment (
  project_id text NOT NULL,
  keyword_id uuid NOT NULL,
  tag_id uuid NOT NULL,
  PRIMARY KEY(project_id,keyword_id,tag_id),
  FOREIGN KEY(project_id,keyword_id) REFERENCES saved_keyword(project_id,id) ON DELETE CASCADE,
  FOREIGN KEY(project_id,tag_id) REFERENCES saved_keyword_tag(project_id,id) ON DELETE RESTRICT
);
CREATE INDEX saved_keyword_tag_members_idx ON saved_keyword_tag_assignment(project_id,tag_id,keyword_id);

CREATE TABLE saved_keyword_refresh_plan (
  id uuid PRIMARY KEY,
  workspace_id text NOT NULL,
  project_id text NOT NULL,
  user_id text NOT NULL REFERENCES "user"(id),
  connection_id uuid NOT NULL,
  connection_revision integer NOT NULL CHECK(connection_revision>0),
  account_fingerprint text NOT NULL CHECK(length(account_fingerprint)=64),
  connection_name text NOT NULL,
  estimate_micros bigint NOT NULL CHECK(estimate_micros BETWEEN 1 AND 20000000000000),
  target_count integer NOT NULL CHECK(target_count BETWEEN 1 AND 2000),
  version bigint NOT NULL DEFAULT nextval('saved_keyword_version_seq') CHECK(version>0),
  price_as_of timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  started_at timestamptz,
  request_key uuid,
  UNIQUE(id,workspace_id,project_id,user_id),
  UNIQUE(workspace_id,request_key),
  FOREIGN KEY(project_id,workspace_id) REFERENCES project(id,workspace_id) ON DELETE CASCADE,
  FOREIGN KEY(connection_id,workspace_id) REFERENCES provider_connection(id,workspace_id),
  CHECK(expires_at>created_at),
  CHECK((started_at IS NULL)=(request_key IS NULL))
);
CREATE INDEX saved_keyword_refresh_page_idx ON saved_keyword_refresh_plan(project_id,created_at DESC,id DESC);
ALTER TABLE keyword_quote ADD COLUMN saved_refresh_plan_id uuid;
ALTER TABLE keyword_quote ADD COLUMN saved_target_ids uuid[];
ALTER TABLE keyword_quote ADD CONSTRAINT keyword_quote_saved_plan FOREIGN KEY(saved_refresh_plan_id,workspace_id,project_id,user_id) REFERENCES saved_keyword_refresh_plan(id,workspace_id,project_id,user_id);
ALTER TABLE keyword_quote ADD CONSTRAINT keyword_quote_saved_targets CHECK(
  (saved_refresh_plan_id IS NULL AND saved_target_ids IS NULL)
  OR (saved_refresh_plan_id IS NOT NULL AND saved_target_ids IS NOT NULL AND cardinality(saved_target_ids) BETWEEN 1 AND 100 AND array_position(saved_target_ids,NULL) IS NULL)
);
CREATE INDEX keyword_quote_saved_plan_idx ON keyword_quote(saved_refresh_plan_id) WHERE saved_refresh_plan_id IS NOT NULL;
