CREATE TABLE analytics_identity_link (
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  visitor_key text NOT NULL CHECK (visitor_key ~ '^[a-f0-9]{64}$'),
  identity_version integer NOT NULL CHECK (identity_version=1),
  key_generation text NOT NULL CHECK (key_generation ~ '^[a-f0-9]{64}$'),
  identity_token text NOT NULL CHECK (identity_token ~ '^[a-f0-9]{64}$'),
  first_accepted_at timestamptz NOT NULL,
  last_accepted_at timestamptz NOT NULL,
  CHECK (first_accepted_at<=last_accepted_at),
  PRIMARY KEY(project_id,visitor_key)
);
CREATE INDEX analytics_identity_link_token_idx ON analytics_identity_link(project_id,identity_version,key_generation,identity_token,visitor_key);
CREATE INDEX analytics_identity_link_expiry_idx ON analytics_identity_link(project_id,last_accepted_at,visitor_key);

-- Opt-in starts on the first explicit settings save; no historical assignment,
-- settings rewrite, traffic manufacture or implicit enablement.
ALTER TABLE project ADD COLUMN identity_links_started_at timestamptz;
ALTER TABLE project ADD COLUMN identity_links_retained_from timestamptz;
ALTER TABLE project ADD COLUMN identity_links_evidence_lost_at timestamptz;
