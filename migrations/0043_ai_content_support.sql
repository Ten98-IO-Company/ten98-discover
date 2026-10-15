-- Dedicated closed-corpus evaluation storage. The application lifecycle is added
-- separately; source deletion must never cascade away an incurred charge.
CREATE TABLE ai_content_support_quote (
 id uuid PRIMARY KEY,
 workspace_id text NOT NULL,
 project_id text NOT NULL,
 user_id text NOT NULL REFERENCES "user"(id),
 request_id uuid NOT NULL,
 connection_id uuid NOT NULL,
 connection_revision integer NOT NULL CHECK(connection_revision>0),
 request_actor text NOT NULL CHECK(length(request_actor)=64 AND request_actor ~ '^[a-f0-9]+$'),
 key_fingerprint text NOT NULL CHECK(length(key_fingerprint)=64 AND key_fingerprint ~ '^[a-f0-9]+$'),
 purpose text NOT NULL CHECK(purpose='website-content-support'),
 prompt_version text NOT NULL CHECK(prompt_version='closed-corpus-support-v1'),
 schema_version integer NOT NULL CHECK(schema_version=1),
 method text NOT NULL CHECK(method='closed-corpus-model-judgment-v1'),
 derivation_version text NOT NULL CHECK(derivation_version='immutable-prompt-trim-lower-v1'),
 source_kind text NOT NULL CHECK(source_kind IN('capture','project')),
 audit_run_id uuid NOT NULL,
 input_hash text NOT NULL CHECK(length(input_hash)=64 AND input_hash ~ '^[a-f0-9]+$'),
 payload_hash text NOT NULL CHECK(length(payload_hash)=64 AND payload_hash ~ '^[a-f0-9]+$'),
 schema_hash text NOT NULL CHECK(length(schema_hash)=64 AND schema_hash ~ '^[a-f0-9]+$'),
 query_receipt_hash text NOT NULL CHECK(length(query_receipt_hash)=64 AND query_receipt_hash ~ '^[a-f0-9]+$'),
 corpus_receipt_hash text NOT NULL CHECK(length(corpus_receipt_hash)=64 AND corpus_receipt_hash ~ '^[a-f0-9]+$'),
 source_context_revision integer CHECK(source_context_revision>0),
 source_profile_hash text CHECK(source_profile_hash IS NULL OR (length(source_profile_hash)=64 AND source_profile_hash ~ '^[a-f0-9]+$')),
 retention_revision integer NOT NULL CHECK(retention_revision>0),
 raw_days_at_quote integer NOT NULL CHECK(raw_days_at_quote BETWEEN 1 AND 3650),
 derived_days_at_quote integer NOT NULL CHECK(derived_days_at_quote BETWEEN 1 AND 3650),
 raw_anchor_at timestamptz NOT NULL,
 derived_anchor_at timestamptz NOT NULL,
 -- Only bounded IDs, exact original clocks and hashes; never source text/URLs/keys.
 -- Strict application schema validates entries; SQL additionally bounds storage/count.
 dependencies jsonb NOT NULL CHECK(jsonb_typeof(dependencies)='array' AND jsonb_array_length(dependencies) BETWEEN 2 AND 1020 AND octet_length(dependencies::text)<=1048576),
 -- Closed public selectors and selected IDs; source-derived bodies cannot be submitted.
 source_input jsonb CHECK(source_input IS NULL OR (jsonb_typeof(source_input)='object' AND octet_length(source_input::text)<=32768)),
 snapshot jsonb CHECK(snapshot IS NULL OR (jsonb_typeof(snapshot)='object' AND octet_length(snapshot::text)<=262144)),
 messages jsonb CHECK(messages IS NULL OR (jsonb_typeof(messages)='array' AND jsonb_array_length(messages)=2 AND octet_length(messages::text)<=262144)),
 route jsonb NOT NULL CHECK(jsonb_typeof(route)='object' AND octet_length(route::text)<=8192),
 estimate_micros bigint NOT NULL CHECK(estimate_micros BETWEEN 1 AND 1000000000000),
 max_spend_micros bigint NOT NULL CHECK(max_spend_micros BETWEEN 1 AND 1000000000000),
 raw_expired_at timestamptz,
 input_purged_at timestamptz,
 unavailable_reason text CHECK(unavailable_reason IN('source_expired','source_changed','source_deleted','authority_changed','input_expired')),
 created_at timestamptz NOT NULL,
 expires_at timestamptz NOT NULL,
 UNIQUE(project_id,request_id),
 UNIQUE(id,workspace_id,project_id,user_id),
 FOREIGN KEY(project_id,workspace_id) REFERENCES project(id,workspace_id) ON DELETE CASCADE,
 FOREIGN KEY(connection_id,workspace_id) REFERENCES provider_connection(id,workspace_id),
 CHECK(estimate_micros<=max_spend_micros),
 CHECK(expires_at=created_at+interval '5 minutes'),
 CHECK(raw_anchor_at<=created_at AND derived_anchor_at<=created_at),
 CHECK((source_kind='capture' AND source_context_revision IS NULL AND source_profile_hash IS NULL)
    OR (source_kind='project' AND source_context_revision IS NOT NULL AND source_profile_hash IS NOT NULL)),
 CHECK((source_input IS NOT NULL AND snapshot IS NOT NULL AND messages IS NOT NULL AND input_purged_at IS NULL)
    OR (source_input IS NULL AND snapshot IS NULL AND messages IS NULL AND input_purged_at IS NOT NULL)),
 CHECK(input_purged_at IS NULL OR raw_expired_at IS NOT NULL),
 CHECK((raw_expired_at IS NULL)=(unavailable_reason IS NULL))
);
CREATE INDEX ai_content_support_quote_retention_idx ON ai_content_support_quote(project_id,created_at,id)
 WHERE input_purged_at IS NULL;

CREATE TABLE ai_content_support_run (
 id uuid PRIMARY KEY,
 quote_id uuid NOT NULL UNIQUE,
 workspace_id text NOT NULL,
 project_id text NOT NULL,
 user_id text NOT NULL,
 request_id uuid NOT NULL,
 status text NOT NULL CHECK(status IN('queued','running','completed','failed','uncertain','cancelled')),
 lease_owner uuid,
 lease_expires_at timestamptz,
 generation_id text CHECK(generation_id IS NULL OR (length(generation_id)<=128 AND generation_id ~ '^gen-[0-9A-Za-z-]{1,124}$')),
 dispatched_at timestamptz,
 completed_at timestamptz,
 raw_result text CHECK(raw_result IS NULL OR octet_length(raw_result)<=65536),
 proposal jsonb CHECK(proposal IS NULL OR (jsonb_typeof(proposal)='object' AND octet_length(proposal::text)<=131072)),
 financial_evidence jsonb CHECK(financial_evidence IS NULL OR (jsonb_typeof(financial_evidence)='object' AND octet_length(financial_evidence::text)<=16384)),
 diagnostic text CHECK(diagnostic IS NULL OR length(diagnostic)<=1000),
 result_purged_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(project_id,request_id),
 FOREIGN KEY(project_id,workspace_id) REFERENCES project(id,workspace_id) ON DELETE CASCADE,
 FOREIGN KEY(quote_id,workspace_id,project_id,user_id) REFERENCES ai_content_support_quote(id,workspace_id,project_id,user_id),
 FOREIGN KEY(id,workspace_id) REFERENCES provider_request(id,workspace_id),
 CHECK((lease_owner IS NULL)=(lease_expires_at IS NULL)),
 CHECK(status<>'queued' OR dispatched_at IS NULL),
 CHECK(status<>'running' OR (dispatched_at IS NOT NULL AND lease_owner IS NOT NULL)),
 CHECK(status<>'cancelled' OR dispatched_at IS NULL),
 CHECK(status NOT IN('completed','failed','uncertain') OR dispatched_at IS NOT NULL),
 CHECK((status IN('queued','running'))=(completed_at IS NULL)),
 CHECK(status<>'completed' OR proposal IS NOT NULL OR result_purged_at IS NOT NULL),
 CHECK(result_purged_at IS NULL OR (raw_result IS NULL AND proposal IS NULL))
);
CREATE UNIQUE INDEX ai_content_support_active_project_idx ON ai_content_support_run(project_id)
 WHERE status IN('queued','running','uncertain');
CREATE INDEX ai_content_support_history_idx ON ai_content_support_run(project_id,created_at DESC,id DESC);
CREATE INDEX ai_content_support_pending_idx ON ai_content_support_run(status,lease_expires_at);
-- No FK from audit/query/body dependencies: source deletion must invalidate/purge
-- content, never delete an incurred charge or make original-key recovery impossible.
-- Insertion uses ONE CTE clock for created_at and expires_at, not two evaluations.
-- The larger jsonb storage bounds accommodate PostgreSQL's ::text spacing. They
-- never replace the accepted64KiB bodies/128KiB messages+schema/160KiB request caps.
