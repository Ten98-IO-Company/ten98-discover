ALTER TABLE project ADD CONSTRAINT project_google_workspace_unique UNIQUE(id,workspace_id);
CREATE TABLE google_app (
  id text PRIMARY KEY CHECK(id='instance'),
  revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
  client_id text NOT NULL,
  encrypted_secret jsonb NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  testing boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE google_connection (
  id uuid PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  name text NOT NULL,
  provider text NOT NULL CHECK(provider IN ('gsc','ga4')),
  revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
  app_revision integer NOT NULL,
  encrypted_tokens jsonb,
  scopes jsonb NOT NULL DEFAULT '[]',
  status text NOT NULL CHECK(status IN ('ready','select_property','reconnect','disconnected')),
  property_id text,
  property_name text,
  time_zone text,
  currency_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(project_id,workspace_id) REFERENCES project(id,workspace_id) ON DELETE CASCADE,
  UNIQUE(id,project_id),
  CHECK((status='disconnected')=(encrypted_tokens IS NULL))
);
CREATE INDEX google_connection_project_idx ON google_connection(project_id,created_at,id);
CREATE TABLE google_oauth_flow (
  id uuid PRIMARY KEY,
  state_hash text NOT NULL UNIQUE,
  browser_hash text NOT NULL,
  session_id text NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  workspace_id text NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  connection_id uuid REFERENCES google_connection(id) ON DELETE CASCADE,
  connection_revision integer,
  provider text NOT NULL CHECK(provider IN ('gsc','ga4')),
  name text NOT NULL,
  app_revision integer NOT NULL,
  encrypted_verifier jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(project_id,workspace_id) REFERENCES project(id,workspace_id) ON DELETE CASCADE
);
CREATE INDEX google_oauth_flow_expiry_idx ON google_oauth_flow(expires_at);
CREATE TABLE google_import (
  id uuid PRIMARY KEY,
  connection_id uuid NOT NULL,
  project_id text NOT NULL,
  user_id text NOT NULL REFERENCES "user"(id),
  request_id uuid NOT NULL,
  connection_revision integer NOT NULL,
  app_revision integer NOT NULL,
  report text NOT NULL CHECK(report IN ('gsc_daily','gsc_queries','gsc_pages','ga4_traffic','ga4_events')),
  date_from date NOT NULL,
  date_to date NOT NULL CHECK(date_to>=date_from AND date_to-date_from<366),
  status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','completed','partial','failed','denied')),
  pages integer NOT NULL DEFAULT 0 CHECK(pages BETWEEN 0 AND 10),
  row_count integer NOT NULL DEFAULT 0 CHECK(row_count BETWEEN 0 AND 10000),
  provider_row_count integer,
  source jsonb NOT NULL,
  quality jsonb NOT NULL DEFAULT '{"warnings":[],"metadata":{}}',
  diagnostic text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  FOREIGN KEY(connection_id,project_id) REFERENCES google_connection(id,project_id),
  UNIQUE(project_id,request_id)
);
CREATE INDEX google_import_connection_idx ON google_import(connection_id,created_at DESC,id DESC);
CREATE UNIQUE INDEX google_import_active_idx ON google_import(connection_id) WHERE status IN ('queued','running');
CREATE TABLE google_import_page (
  import_id uuid NOT NULL REFERENCES google_import(id) ON DELETE CASCADE,
  page integer NOT NULL CHECK(page BETWEEN 0 AND 9),
  rows jsonb NOT NULL CHECK(jsonb_typeof(rows)='array' AND jsonb_array_length(rows)<=1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(import_id,page)
);
