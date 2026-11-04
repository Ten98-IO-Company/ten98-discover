ALTER TABLE ai_suggestion_quote ADD COLUMN purpose text NOT NULL DEFAULT 'prompt' CHECK(purpose IN('prompt','site-analysis'));
ALTER TABLE ai_suggestion_run ADD COLUMN purpose text NOT NULL DEFAULT 'prompt' CHECK(purpose IN('prompt','site-analysis'));
ALTER TABLE ai_suggestion_quote ADD UNIQUE(id,purpose);
ALTER TABLE ai_suggestion_run ADD FOREIGN KEY(quote_id,purpose) REFERENCES ai_suggestion_quote(id,purpose);
DROP INDEX ai_suggestion_active_project_idx;
CREATE UNIQUE INDEX ai_suggestion_active_project_idx ON ai_suggestion_run(project_id,purpose) WHERE status IN('queued','running','uncertain');

CREATE TABLE site_analysis_run (
 id uuid PRIMARY KEY,
 workspace_id text NOT NULL,
 project_id text NOT NULL,
 user_id text NOT NULL REFERENCES "user"(id),
 request_id uuid NOT NULL,
 request_hash text NOT NULL CHECK(length(request_hash)=64),
 connection_id uuid NOT NULL,
 connection_revision integer NOT NULL CHECK(connection_revision>0),
 key_fingerprint text NOT NULL CHECK(length(key_fingerprint)=64),
 model text NOT NULL CHECK(length(model) BETWEEN 1 AND 200),
 origin text NOT NULL,
 context_revision integer NOT NULL CHECK(context_revision BETWEEN 1 AND 2147483646),
 audit_id uuid,
 child_request_id uuid NOT NULL UNIQUE,
 ai_run_id uuid UNIQUE REFERENCES ai_suggestion_run(id) ON DELETE SET NULL,
 status text NOT NULL DEFAULT 'crawling' CHECK(status IN('crawling','analysing','failed','cancelled')),
 diagnostic text,
 proposal_revision integer NOT NULL DEFAULT 1 CHECK(proposal_revision BETWEEN 1 AND 2147483646),
 accepted_candidate_ids jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(accepted_candidate_ids)='array' AND jsonb_array_length(accepted_candidate_ids)<=21),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 completed_at timestamptz,
 UNIQUE(project_id,request_id),
 FOREIGN KEY(project_id,workspace_id) REFERENCES project(id,workspace_id) ON DELETE CASCADE,
 FOREIGN KEY(connection_id,workspace_id) REFERENCES provider_connection(id,workspace_id),
 FOREIGN KEY(audit_id,project_id) REFERENCES site_audit_run(id,project_id) ON DELETE SET NULL (audit_id)
);
CREATE INDEX site_analysis_history_idx ON site_analysis_run(project_id,created_at DESC,id DESC);
CREATE INDEX site_analysis_pending_idx ON site_analysis_run(created_at,id) WHERE status='crawling';
