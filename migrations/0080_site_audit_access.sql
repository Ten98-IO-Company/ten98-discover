ALTER TABLE project_domain ADD CONSTRAINT project_domain_id_project_unique UNIQUE(id,project_id);

CREATE TABLE site_audit_access (
 id uuid PRIMARY KEY,
 project_id text NOT NULL,
 workspace_id text NOT NULL,
 domain_id uuid,
 origin text NOT NULL,
 revision integer NOT NULL CHECK(revision BETWEEN 1 AND 2147483646),
 encrypted_credentials jsonb,
 expires_at timestamptz NOT NULL,
 verification text NOT NULL CHECK(verification IN('verified','unverified')),
 created_by text NOT NULL REFERENCES "user"(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 revoked_at timestamptz,
 FOREIGN KEY(project_id,workspace_id) REFERENCES project(id,workspace_id) ON DELETE CASCADE,
 FOREIGN KEY(domain_id,project_id) REFERENCES project_domain(id,project_id) ON DELETE CASCADE,
 UNIQUE NULLS NOT DISTINCT(project_id,domain_id),
 CHECK((revoked_at IS NULL)=(encrypted_credentials IS NOT NULL))
);
