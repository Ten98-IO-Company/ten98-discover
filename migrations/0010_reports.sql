CREATE TABLE report (
  id uuid PRIMARY KEY,
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  source_html text NOT NULL CHECK (octet_length(source_html) BETWEEN 1 AND 1048576),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz(3) NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX report_project_page_idx ON report(project_id,created_at DESC,id DESC);
CREATE TABLE report_template (
  id uuid PRIMARY KEY,
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  brief text NOT NULL CHECK (length(brief) BETWEEN 1 AND 20000),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz(3) NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX report_template_project_page_idx ON report_template(project_id,created_at DESC,id DESC);
CREATE TABLE report_share (
  id uuid PRIMARY KEY,
  report_id uuid NOT NULL REFERENCES report(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  slug_label text NOT NULL CHECK (slug_label ~ '^[a-z0-9][a-z0-9-]{0,47}$'),
  label text NOT NULL CHECK (length(label) BETWEEN 1 AND 120),
  snapshot_html text NOT NULL CHECK (octet_length(snapshot_html) BETWEEN 1 AND 2097152),
  report_revision integer NOT NULL CHECK (report_revision > 0),
  expires_at timestamptz(3) NOT NULL,
  revoked_at timestamptz(3),
  created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  CHECK (expires_at > created_at)
);
CREATE INDEX report_share_report_page_idx ON report_share(report_id,created_at DESC,id DESC);
