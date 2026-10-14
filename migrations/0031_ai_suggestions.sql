CREATE TABLE ai_suggestion_quote (
 id uuid PRIMARY KEY,
 workspace_id text NOT NULL,
 project_id text NOT NULL,
 user_id text NOT NULL REFERENCES "user"(id),
 request_id uuid NOT NULL,
 connection_id uuid NOT NULL,
 connection_revision integer NOT NULL CHECK(connection_revision>0),
 request_actor text NOT NULL CHECK(length(request_actor)=64),
 key_fingerprint text NOT NULL CHECK(length(key_fingerprint)=64),
 input_hash text NOT NULL CHECK(length(input_hash)=64),
 snapshot_hash text NOT NULL CHECK(length(snapshot_hash)=64),
 input jsonb,
 snapshot jsonb,
 messages jsonb,
 route jsonb NOT NULL CHECK(jsonb_typeof(route)='object'),
 input_purged_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz NOT NULL,
 UNIQUE(project_id,request_id),
 UNIQUE(id,workspace_id,project_id,user_id),
 FOREIGN KEY(project_id,workspace_id) REFERENCES project(id,workspace_id) ON DELETE CASCADE,
 FOREIGN KEY(connection_id,workspace_id) REFERENCES provider_connection(id,workspace_id),
 CHECK(expires_at>created_at),
 CHECK((jsonb_typeof(input)='object' AND jsonb_typeof(snapshot)='object' AND jsonb_typeof(messages)='array' AND input IS NOT NULL AND snapshot IS NOT NULL AND messages IS NOT NULL AND input_purged_at IS NULL)
  OR (input IS NULL AND snapshot IS NULL AND messages IS NULL AND input_purged_at IS NOT NULL))
);
CREATE TABLE ai_suggestion_run (
 id uuid PRIMARY KEY,
 quote_id uuid NOT NULL UNIQUE,
 workspace_id text NOT NULL,
 project_id text NOT NULL,
 user_id text NOT NULL,
 request_id uuid NOT NULL,
 status text NOT NULL CHECK(status IN('queued','running','completed','failed','uncertain','cancelled')),
 lease_owner uuid,
 lease_expires_at timestamptz,
 generation_id text CHECK(generation_id ~ '^gen-[0-9A-Za-z-]{1,124}$'),
 dispatched_at timestamptz,
 completed_at timestamptz,
 raw_result text CHECK(octet_length(raw_result)<=1000000),
 proposal jsonb CHECK(proposal IS NULL OR jsonb_typeof(proposal)='object'),
 proposal_revision integer NOT NULL DEFAULT 1 CHECK(proposal_revision BETWEEN 1 AND 2147483646),
 accepted_candidate_ids jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(accepted_candidate_ids)='array' AND jsonb_array_length(accepted_candidate_ids)<=5),
 evidence jsonb CHECK(evidence IS NULL OR jsonb_typeof(evidence)='object'),
 diagnostic text,
 result_purged_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(project_id,request_id),
 FOREIGN KEY(quote_id,workspace_id,project_id,user_id) REFERENCES ai_suggestion_quote(id,workspace_id,project_id,user_id),
 FOREIGN KEY(id,workspace_id) REFERENCES provider_request(id,workspace_id)
);
CREATE UNIQUE INDEX ai_suggestion_active_project_idx ON ai_suggestion_run(project_id) WHERE status IN('queued','running','uncertain');
CREATE INDEX ai_suggestion_history_idx ON ai_suggestion_run(project_id,created_at DESC,id DESC);
CREATE INDEX ai_suggestion_pending_idx ON ai_suggestion_run(status,lease_expires_at);
CREATE INDEX ai_suggestion_retention_idx ON ai_suggestion_run(project_id,completed_at,id) WHERE raw_result IS NOT NULL OR proposal IS NOT NULL;
