ALTER TABLE project_domain ADD COLUMN redirect_revision bigint NOT NULL DEFAULT 1 CHECK(redirect_revision>0);
CREATE TABLE domain_redirect_check (
 id uuid PRIMARY KEY,
 workspace_id text NOT NULL,
 project_id text NOT NULL,
 domain_id uuid NOT NULL,
 user_id text NOT NULL REFERENCES "user"(id),
 request_id uuid NOT NULL,
 domain_revision bigint NOT NULL CHECK(domain_revision>0),
 hostname text NOT NULL,
 expected_target_host text NOT NULL,
 verified_at timestamptz NOT NULL,
 status text NOT NULL CHECK(status IN('queued','running','completed','stale','failed')),
 diagnostic text,
 observation jsonb CHECK(observation IS NULL OR jsonb_typeof(observation)='object'),
 observation_expired_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 started_at timestamptz,
 completed_at timestamptz,
 FOREIGN KEY(project_id,workspace_id) REFERENCES project(id,workspace_id) ON DELETE CASCADE,
 UNIQUE(project_id,user_id,request_id),
 CHECK((status IN('queued','running'))=(completed_at IS NULL)),
 CHECK(observation IS NULL OR (status='completed' AND observation_expired_at IS NULL))
);
-- History intentionally retains the domain ID/snapshot after a registry entry is removed.
-- Every insertion validates that ID in its project under the workspace/project mutation gate.
CREATE UNIQUE INDEX domain_redirect_active_idx ON domain_redirect_check(domain_id) WHERE status IN('queued','running');
CREATE INDEX domain_redirect_history_idx ON domain_redirect_check(project_id,domain_id,created_at DESC,id DESC);
CREATE INDEX domain_redirect_retention_idx ON domain_redirect_check(project_id,completed_at,id) WHERE observation IS NOT NULL;
