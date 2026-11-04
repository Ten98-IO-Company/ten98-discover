CREATE TABLE site_audit_schedule (
 project_id text PRIMARY KEY,
 workspace_id text NOT NULL,
 revision integer NOT NULL CHECK(revision BETWEEN 1 AND 2147483646),
 enabled boolean NOT NULL,
 definition jsonb NOT NULL CHECK(jsonb_typeof(definition)='object'),
 calendar jsonb NOT NULL CHECK(jsonb_typeof(calendar)='object'),
 approval_id uuid NOT NULL,
 approval_user_id text NOT NULL REFERENCES "user"(id),
 origin text NOT NULL,
 domain_hostname text,
 domain_verified_at timestamptz,
 domain_revision bigint CHECK(domain_revision IS NULL OR domain_revision>0),
 approved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 next_due_at timestamptz,
 last_status text,
 history_retained_from timestamptz NOT NULL DEFAULT '-infinity',
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(project_id,workspace_id),
 FOREIGN KEY(project_id,workspace_id) REFERENCES project(id,workspace_id) ON DELETE CASCADE,
 CHECK(enabled=(next_due_at IS NOT NULL)),
 CHECK((domain_hostname IS NULL AND domain_verified_at IS NULL AND domain_revision IS NULL) OR
       (domain_hostname IS NOT NULL AND domain_verified_at IS NOT NULL AND domain_revision IS NOT NULL))
);
CREATE INDEX site_audit_schedule_due_idx ON site_audit_schedule(next_due_at,project_id) WHERE enabled;
CREATE TABLE site_audit_occurrence (
 id uuid PRIMARY KEY,
 project_id text NOT NULL REFERENCES site_audit_schedule(project_id) ON DELETE CASCADE,
 approval_id uuid NOT NULL,
 scheduled_for timestamptz NOT NULL,
 request_id uuid NOT NULL UNIQUE,
 run_id uuid UNIQUE REFERENCES site_audit_run(id) ON DELETE SET NULL,
 status text NOT NULL CHECK(status IN('queued','skipped')),
 reason text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 data_expired_at timestamptz,
 UNIQUE(project_id,scheduled_for)
);
CREATE INDEX site_audit_occurrence_history_idx ON site_audit_occurrence(project_id,created_at DESC,id DESC);
