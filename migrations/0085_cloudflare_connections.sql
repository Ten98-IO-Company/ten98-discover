CREATE TABLE cloudflare_connection (
  id uuid PRIMARY KEY,
  project_id text NOT NULL,
  workspace_id text NOT NULL,
  account_id text NOT NULL CHECK(account_id ~ '^[a-f0-9]{32}$'),
  name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 120),
  revision integer NOT NULL CHECK(revision BETWEEN 1 AND 2147483646),
  encrypted_credentials jsonb,
  created_by text NOT NULL REFERENCES "user"(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  revoked_at timestamptz,
  FOREIGN KEY(project_id,workspace_id) REFERENCES project(id,workspace_id) ON DELETE CASCADE,
  UNIQUE(project_id,account_id),
  CHECK((revoked_at IS NULL)=(encrypted_credentials IS NOT NULL)),
  CHECK(encrypted_credentials IS NULL OR jsonb_typeof(encrypted_credentials)='object')
);
