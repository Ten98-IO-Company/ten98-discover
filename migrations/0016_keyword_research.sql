-- Original keyword research persistence; prior migration identities are unchanged.
ALTER TABLE provider_request ADD CONSTRAINT provider_request_id_workspace_unique UNIQUE(id,workspace_id);
CREATE TABLE keyword_market_catalog (
 workspace_id text PRIMARY KEY REFERENCES workspace(id) ON DELETE CASCADE,
 markets jsonb NOT NULL CHECK(jsonb_typeof(markets)='array'),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE keyword_quote (
 id uuid PRIMARY KEY,
 workspace_id text NOT NULL,
 project_id text NOT NULL,
 user_id text NOT NULL REFERENCES "user"(id),
 connection_id uuid NOT NULL,
 connection_revision integer NOT NULL CHECK(connection_revision>0),
 request jsonb NOT NULL CHECK(jsonb_typeof(request)='object'),
 account_fingerprint text NOT NULL CHECK(length(account_fingerprint)=64),
 per_task_micros bigint NOT NULL CHECK(per_task_micros BETWEEN 0 AND 1000000000000),
 per_item_micros bigint NOT NULL CHECK(per_item_micros BETWEEN 0 AND 1000000000000),
 estimate_micros bigint NOT NULL CHECK(estimate_micros BETWEEN 1 AND 1000000000000),
 price_as_of timestamptz NOT NULL,
 expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(project_id,workspace_id) REFERENCES project(id,workspace_id) ON DELETE CASCADE,
 FOREIGN KEY(connection_id,workspace_id) REFERENCES provider_connection(id,workspace_id),
 UNIQUE(id,workspace_id,project_id,user_id),
 CHECK(expires_at>created_at)
);
CREATE INDEX keyword_quote_expiry_idx ON keyword_quote(expires_at);
CREATE TABLE keyword_research_run (
 id uuid PRIMARY KEY,
 workspace_id text NOT NULL,
 project_id text NOT NULL,
 user_id text NOT NULL REFERENCES "user"(id),
 quote_id uuid NOT NULL UNIQUE,
 status text NOT NULL CHECK(status IN('queued','running','completed','failed','uncertain','cancelled','reconciled')),
 diagnostic text,
 result jsonb,
 reconciliation_evidence jsonb,
 dispatched_at timestamptz,
 completed_at timestamptz,
 result_purged_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(project_id,workspace_id) REFERENCES project(id,workspace_id) ON DELETE CASCADE,
 FOREIGN KEY(id,workspace_id) REFERENCES provider_request(id,workspace_id),
 FOREIGN KEY(quote_id,workspace_id,project_id,user_id) REFERENCES keyword_quote(id,workspace_id,project_id,user_id),
 CHECK(result IS NULL OR jsonb_typeof(result)='object')
);
CREATE INDEX keyword_research_project_idx ON keyword_research_run(project_id,created_at DESC,id DESC);
CREATE INDEX keyword_research_pending_idx ON keyword_research_run(status,dispatched_at);
CREATE INDEX keyword_research_retention_idx ON keyword_research_run(workspace_id,completed_at,id) WHERE result IS NOT NULL;
CREATE INDEX keyword_quote_workspace_expiry_idx ON keyword_quote(workspace_id,expires_at,id);
