CREATE TABLE site_audit_run (
 id uuid PRIMARY KEY,
 workspace_id text NOT NULL,
 project_id text NOT NULL,
 user_id text NOT NULL REFERENCES "user"(id),
 request_id uuid NOT NULL,
 request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
 domain_id uuid,
 origin text CHECK(origin IS NULL OR octet_length(origin)<=2048),
 domain_hostname text,
 domain_verified_at timestamptz,
 domain_revision bigint CHECK(domain_revision IS NULL OR domain_revision>0),
 config jsonb CHECK(config IS NULL OR (jsonb_typeof(config)='object' AND octet_length(config::text)<=8192)),
 rule_version text NOT NULL DEFAULT 'static-html-v1' CHECK(rule_version='static-html-v1'),
 status text NOT NULL DEFAULT 'queued' CHECK(status IN('queued','running','cancelling','completed','partial','failed','cancelled')),
 phase text CHECK(phase IN('robots','discovery','pages','finalizing')),
 stop_reason text CHECK(stop_reason IS NULL OR (length(stop_reason)<=80 AND stop_reason ~ '^[a-z][a-z0-9_]*$')),
 created_at timestamptz NOT NULL,
 started_at timestamptz,
 completed_at timestamptz,
 deadline_at timestamptz NOT NULL,
 queue_job_id uuid NOT NULL,
 generation bigint NOT NULL DEFAULT 1 CHECK(generation>0),
 lease_owner uuid,
 lease_expires_at timestamptz,
 heartbeat_at timestamptz,
 cancel_requested_at timestamptz,
 next_request_at timestamptz,
 request_count integer NOT NULL DEFAULT 0 CHECK(request_count BETWEEN 0 AND 3100),
 html_pages_started integer NOT NULL DEFAULT 0 CHECK(html_pages_started BETWEEN 0 AND 1000),
 sitemap_documents_started integer NOT NULL DEFAULT 0 CHECK(sitemap_documents_started BETWEEN 0 AND 20),
 frontier_count integer NOT NULL DEFAULT 0 CHECK(frontier_count BETWEEN 0 AND 10000),
 edge_count integer NOT NULL DEFAULT 0 CHECK(edge_count BETWEEN 0 AND 100000),
 budget_charged_bytes bigint NOT NULL DEFAULT 0 CHECK(budget_charged_bytes BETWEEN 0 AND 524288000),
 wire_bytes bigint NOT NULL DEFAULT 0 CHECK(wire_bytes>=0),
 http_decoded_bytes bigint NOT NULL DEFAULT 0 CHECK(http_decoded_bytes>=0),
 decoded_bytes bigint NOT NULL DEFAULT 0 CHECK(decoded_bytes>=0),
 coverage jsonb NOT NULL DEFAULT '{"reasons":[],"discoveryComplete":false,"linksComplete":false,"scopeExclusions":0,"rawEvidenceRecorded":false}'::jsonb
   CHECK(jsonb_typeof(coverage)='object' AND octet_length(coverage::text)<=16384),
 summary jsonb CHECK(summary IS NULL OR (jsonb_typeof(summary)='object' AND octet_length(summary::text)<=16384)),
 robots_state text NOT NULL DEFAULT 'pending' CHECK(robots_state IN('pending','present','absent','unavailable')),
 robots_body bytea CHECK(robots_body IS NULL OR octet_length(robots_body)<=524288),
 robots_digest text CHECK(robots_digest IS NULL OR robots_digest ~ '^[a-f0-9]{64}$'),
 robots_fetched_at timestamptz,
 raw_expired_at timestamptz,
 raw_cleanup_completed_at timestamptz,
 data_expired_at timestamptz,
 data_cleanup_completed_at timestamptz,
 deleted_at timestamptz,
 FOREIGN KEY(project_id,workspace_id) REFERENCES project(id,workspace_id) ON DELETE CASCADE,
 UNIQUE(id,project_id),
 UNIQUE(project_id,user_id,request_id),
 CHECK((status IN('queued','running','cancelling'))=(completed_at IS NULL)),
 CHECK((lease_owner IS NULL)=(lease_expires_at IS NULL)),
 CHECK((status IN('running','cancelling'))=(lease_owner IS NOT NULL)),
 CHECK(status IN('running','cancelling') OR phase IS NULL),
 CHECK(deadline_at=created_at+interval '30 minutes'),
 CHECK(started_at IS NULL OR started_at>=created_at),
 CHECK(completed_at IS NULL OR completed_at>=created_at),
 CHECK(deleted_at IS NOT NULL OR (origin IS NOT NULL AND config IS NOT NULL)),
 CHECK(domain_id IS NULL OR deleted_at IS NOT NULL OR
   (domain_hostname IS NOT NULL AND domain_verified_at IS NOT NULL AND domain_revision IS NOT NULL)),
 CHECK(domain_id IS NOT NULL OR (domain_hostname IS NULL AND domain_verified_at IS NULL AND domain_revision IS NULL)),
 CHECK(robots_body IS NULL OR (robots_state='present' AND robots_digest IS NOT NULL)),
 CHECK(robots_state<>'present' OR robots_digest IS NOT NULL),
 CHECK(raw_expired_at IS NULL OR completed_at IS NOT NULL),
 CHECK(data_expired_at IS NULL OR completed_at IS NOT NULL),
 CHECK(deleted_at IS NULL OR completed_at IS NOT NULL),
 CHECK(raw_cleanup_completed_at IS NULL OR raw_expired_at IS NOT NULL),
 CHECK(data_cleanup_completed_at IS NULL OR data_expired_at IS NOT NULL)
);
CREATE UNIQUE INDEX site_audit_workspace_active_idx ON site_audit_run(workspace_id)
 WHERE status IN('queued','running','cancelling');
-- ponytail: one logically active run per installation; replace only after measured capacity work.
CREATE UNIQUE INDEX site_audit_installation_active_idx ON site_audit_run((true))
 WHERE status IN('running','cancelling');
CREATE INDEX site_audit_history_idx ON site_audit_run(project_id,created_at DESC,id DESC);
CREATE INDEX site_audit_queue_idx ON site_audit_run(created_at,id) WHERE status='queued';
CREATE INDEX site_audit_retention_idx ON site_audit_run(project_id,completed_at,id)
 WHERE completed_at IS NOT NULL AND
   (raw_cleanup_completed_at IS NULL OR data_cleanup_completed_at IS NULL);

CREATE TABLE site_audit_page (
 id uuid PRIMARY KEY,
 run_id uuid NOT NULL,
 project_id text NOT NULL,
 resource_kind text NOT NULL CHECK(resource_kind IN('html','robots','sitemap')),
 url text NOT NULL CHECK(octet_length(url) BETWEEN 1 AND 2048),
 discovered_start boolean NOT NULL DEFAULT false,
 discovered_link boolean NOT NULL DEFAULT false,
 discovered_sitemap boolean NOT NULL DEFAULT false,
 link_depth integer CHECK(link_depth BETWEEN 0 AND 10000),
 sitemap_depth integer NOT NULL DEFAULT 0 CHECK(sitemap_depth BETWEEN 0 AND 3),
 redirect_hops integer NOT NULL DEFAULT 0 CHECK(redirect_hops BETWEEN 0 AND 8),
 state text NOT NULL DEFAULT 'pending' CHECK(state IN('pending','leased','done','excluded','unavailable')),
 attempts_started integer NOT NULL DEFAULT 0 CHECK(attempts_started BETWEEN 0 AND 2),
 attempt_id uuid,
 attempt_generation bigint CHECK(attempt_generation IS NULL OR attempt_generation>0),
 dispatched_at timestamptz,
 reserved_bytes integer CHECK(reserved_bytes BETWEEN 0 AND 5242880),
 attempt_settled_at timestamptz,
 last_attempt_outcome text CHECK(last_attempt_outcome IS NULL OR
   last_attempt_outcome IN('complete','failed','unknown','cancelled')),
 retry_after_at timestamptz,
 observed_at timestamptz,
 http_status integer CHECK(http_status BETWEEN 200 AND 599),
 fetch_state text NOT NULL DEFAULT 'not_fetched' CHECK(fetch_state IN('ok','blocked','rate_limited','error','robots_disallowed','not_fetched')),
 analysis_coverage text NOT NULL DEFAULT 'not_fetched' CHECK(analysis_coverage IN(
   'unavailable','blocked','rate_limited','robots_disallowed','not_fetched','http_error','redirect','non_html','partial','shell','analyzed')),
 reasons jsonb NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(reasons)='array' AND octet_length(reasons::text)<=4096),
 response_time_ms integer CHECK(response_time_ms>=0),
 facts jsonb CHECK(facts IS NULL OR (jsonb_typeof(facts)='object' AND octet_length(facts::text)<=8192)),
 evidence jsonb CHECK(evidence IS NULL OR (jsonb_typeof(evidence)='object' AND octet_length(evidence::text)<=65536)),
 evidence_recorded boolean NOT NULL DEFAULT false,
 evidence_truncated boolean NOT NULL DEFAULT false,
 FOREIGN KEY(run_id,project_id) REFERENCES site_audit_run(id,project_id) ON DELETE CASCADE,
 UNIQUE(run_id,id),
 UNIQUE(run_id,resource_kind,url),
 CHECK((state='leased')=(attempt_id IS NOT NULL AND attempt_settled_at IS NULL)),
 CHECK(attempt_id IS NULL OR (attempt_generation IS NOT NULL AND dispatched_at IS NOT NULL AND reserved_bytes IS NOT NULL)),
 CHECK(evidence IS NULL OR evidence_recorded),
 CHECK(NOT evidence_truncated OR evidence_recorded),
 CHECK(facts IS NULL OR analysis_coverage IN('analyzed','shell'))
);
CREATE UNIQUE INDEX site_audit_start_page_idx ON site_audit_page(run_id) WHERE discovered_start;
CREATE INDEX site_audit_frontier_idx ON site_audit_page(run_id,state,resource_kind,id);

CREATE TABLE site_audit_edge (
 id uuid PRIMARY KEY,
 run_id uuid NOT NULL,
 source_page_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN('link','redirect','sitemap')),
 target_url text NOT NULL CHECK(octet_length(target_url) BETWEEN 1 AND 2048),
 nofollow boolean NOT NULL DEFAULT false,
 anchor text CHECK(anchor IS NULL OR octet_length(anchor)<=2048),
 FOREIGN KEY(run_id,source_page_id) REFERENCES site_audit_page(run_id,id) ON DELETE CASCADE,
 UNIQUE(run_id,source_page_id,kind,target_url)
);
CREATE INDEX site_audit_edge_target_idx ON site_audit_edge(run_id,target_url,id);

CREATE TABLE site_audit_issue (
 id uuid PRIMARY KEY,
 run_id uuid NOT NULL REFERENCES site_audit_run(id) ON DELETE CASCADE,
 page_id uuid,
 target_page_id uuid,
 issue_key text NOT NULL CHECK(issue_key ~ '^[a-f0-9]{64}$'),
 rule_version text NOT NULL CHECK(rule_version IN('static-html-v1','static-graph-v1')),
 code text NOT NULL CHECK(length(code)<=80 AND code ~ '^[a-z][a-z0-9-]*$'),
 severity text NOT NULL CHECK(severity IN('critical','warning','info')),
 details jsonb NOT NULL CHECK(jsonb_typeof(details)='object' AND octet_length(details::text)<=4096),
 related_page_ids jsonb NOT NULL DEFAULT '[]'::jsonb
   CHECK(jsonb_typeof(related_page_ids)='array' AND jsonb_array_length(related_page_ids)<=8 AND octet_length(related_page_ids::text)<=512),
 FOREIGN KEY(run_id,page_id) REFERENCES site_audit_page(run_id,id) ON DELETE CASCADE,
 FOREIGN KEY(run_id,target_page_id) REFERENCES site_audit_page(run_id,id) ON DELETE CASCADE,
 UNIQUE(run_id,issue_key),
 CHECK(page_id IS NOT NULL OR target_page_id IS NULL)
);
CREATE INDEX site_audit_issue_page_idx ON site_audit_issue(run_id,page_id,id);
CREATE INDEX site_audit_issue_target_idx ON site_audit_issue(run_id,target_page_id,id);
CREATE INDEX site_audit_issue_filter_idx ON site_audit_issue(run_id,severity,code,id);
