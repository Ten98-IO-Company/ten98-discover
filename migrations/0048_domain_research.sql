-- Scoped ranked-keyword research; serving domains are a separate configuration.
CREATE TABLE domain_research_quote (
 id uuid PRIMARY KEY,workspace_id text NOT NULL,project_id text NOT NULL,user_id text NOT NULL REFERENCES "user"(id),
 connection_id uuid NOT NULL,connection_revision integer NOT NULL CHECK(connection_revision>0),
 request jsonb NOT NULL CHECK(jsonb_typeof(request)='object'),
 account_fingerprint text NOT NULL CHECK(account_fingerprint ~ '^[a-f0-9]{64}$'),account_fingerprint_version integer NOT NULL DEFAULT 2 CHECK(account_fingerprint_version=2),
 per_task_micros bigint NOT NULL CHECK(per_task_micros BETWEEN 0 AND 1000000000000),per_item_micros bigint NOT NULL CHECK(per_item_micros BETWEEN 0 AND 1000000000000),
 estimate_micros bigint NOT NULL CHECK(estimate_micros BETWEEN 1 AND 1000000000000),
 price_as_of timestamptz NOT NULL,expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL,
 FOREIGN KEY(project_id,workspace_id) REFERENCES project(id,workspace_id) ON DELETE CASCADE,
 FOREIGN KEY(connection_id,workspace_id) REFERENCES provider_connection(id,workspace_id),
 UNIQUE(id,workspace_id,project_id,user_id),CHECK(expires_at=created_at+interval '5 minutes'),CHECK(price_as_of=created_at)
);
CREATE TABLE domain_research_run (
 id uuid PRIMARY KEY,workspace_id text NOT NULL,project_id text NOT NULL,user_id text NOT NULL REFERENCES "user"(id),quote_id uuid NOT NULL UNIQUE,
 status text NOT NULL CHECK(status IN('queued','running','completed','failed','uncertain','cancelled','reconciled')),
 diagnostic text,result jsonb,reconciliation_evidence jsonb,dispatched_at timestamptz,completed_at timestamptz,result_purged_at timestamptz,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(project_id,workspace_id) REFERENCES project(id,workspace_id) ON DELETE CASCADE,
 FOREIGN KEY(id,workspace_id) REFERENCES provider_request(id,workspace_id),
 FOREIGN KEY(quote_id,workspace_id,project_id,user_id) REFERENCES domain_research_quote(id,workspace_id,project_id,user_id),
 CHECK(result IS NULL OR jsonb_typeof(result)='object'),CHECK(result_purged_at IS NULL OR result IS NULL)
);
CREATE INDEX domain_research_project_idx ON domain_research_run(project_id,created_at DESC,id DESC);
CREATE INDEX domain_research_pending_idx ON domain_research_run(status,dispatched_at);
CREATE INDEX domain_research_retention_idx ON domain_research_run(project_id,completed_at,id) WHERE result IS NOT NULL;
CREATE INDEX domain_research_quote_expiry_idx ON domain_research_quote(project_id,expires_at,id);
