CREATE TABLE prompt_execution_quote (
 id uuid PRIMARY KEY,
 workspace_id text NOT NULL,
 project_id text NOT NULL,
 user_id text NOT NULL REFERENCES "user"(id),
 prompt_id uuid NOT NULL,
 version_id uuid NOT NULL,
 connection_id uuid NOT NULL,
 connection_revision integer NOT NULL CHECK(connection_revision>0),
 request_actor text NOT NULL CHECK(length(request_actor)=64),
 key_fingerprint text NOT NULL CHECK(length(key_fingerprint)=64),
 input jsonb CHECK(jsonb_typeof(input)='object'),
 messages jsonb CHECK(jsonb_typeof(messages)='array'),
 input_purged_at timestamptz,
 routes jsonb NOT NULL CHECK(jsonb_typeof(routes)='array'),
 input_hash text NOT NULL CHECK(length(input_hash)=64),
 expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(project_id,workspace_id) REFERENCES project(id,workspace_id) ON DELETE CASCADE,
 FOREIGN KEY(project_id,prompt_id,version_id) REFERENCES prompt_text_version(project_id,prompt_id,id),
 FOREIGN KEY(connection_id,workspace_id) REFERENCES provider_connection(id,workspace_id),
 UNIQUE(id,workspace_id,project_id,user_id),
 CHECK(expires_at>created_at),
 CHECK((input IS NOT NULL AND messages IS NOT NULL AND input_purged_at IS NULL) OR (input IS NULL AND messages IS NULL AND input_purged_at IS NOT NULL))
);
CREATE TABLE prompt_comparison (
 id uuid PRIMARY KEY,
 quote_id uuid NOT NULL UNIQUE,
 workspace_id text NOT NULL,
 project_id text NOT NULL,
 user_id text NOT NULL,
 request_key uuid NOT NULL,
 cancel_requested boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(workspace_id,request_key),
 UNIQUE(id,workspace_id,project_id),
 FOREIGN KEY(quote_id,workspace_id,project_id,user_id) REFERENCES prompt_execution_quote(id,workspace_id,project_id,user_id)
);
CREATE TABLE prompt_execution (
 id uuid PRIMARY KEY,
 comparison_id uuid NOT NULL,
 workspace_id text NOT NULL,
 project_id text NOT NULL,
 position integer NOT NULL CHECK(position IN(0,1)),
 route jsonb NOT NULL CHECK(jsonb_typeof(route)='object'),
 status text NOT NULL CHECK(status IN('queued','running','completed','failed','uncertain','cancelled','reconciled')),
 diagnostic text,
 result jsonb,
 evidence jsonb,
 generation_id text CHECK(generation_id ~ '^gen-[0-9A-Za-z-]{1,124}$'),
 dispatched_at timestamptz,
 completed_at timestamptz,
 result_purged_at timestamptz,
 UNIQUE(comparison_id,position),
 FOREIGN KEY(comparison_id,workspace_id,project_id) REFERENCES prompt_comparison(id,workspace_id,project_id),
 FOREIGN KEY(id,workspace_id) REFERENCES provider_request(id,workspace_id),
 CHECK(result IS NULL OR jsonb_typeof(result)='object')
);
CREATE INDEX prompt_comparison_project_idx ON prompt_comparison(project_id,created_at DESC,id DESC);
CREATE INDEX prompt_execution_pending_idx ON prompt_execution(status,dispatched_at);
CREATE INDEX prompt_execution_retention_idx ON prompt_execution(project_id,completed_at,id) WHERE result IS NOT NULL;
CREATE INDEX prompt_execution_quote_expiry_idx ON prompt_execution_quote(project_id,expires_at,id);
