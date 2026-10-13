CREATE TABLE meta_app_registration (
  id uuid PRIMARY KEY,
  app_id text NOT NULL UNIQUE CHECK(app_id ~ '^[1-9][0-9]{0,39}$'),
  config_id text NOT NULL CHECK(config_id ~ '^[1-9][0-9]{0,39}$'),
  revision integer NOT NULL CHECK(revision>0),
  credential_revision integer NOT NULL CHECK(credential_revision>0),
  encrypted_config jsonb NOT NULL,
  active boolean NOT NULL DEFAULT false,
  enabled boolean NOT NULL DEFAULT false,
  bound_origin text NOT NULL,
  declared_mode text NOT NULL CHECK(declared_mode IN ('development','live')),
  lifecycle_epoch bigint NOT NULL DEFAULT 1 CHECK(lifecycle_epoch>0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE UNIQUE INDEX meta_app_active_idx ON meta_app_registration((true)) WHERE active;

CREATE TABLE meta_connection (
  id uuid PRIMARY KEY,
  workspace_id text NOT NULL,
  project_id text NOT NULL,
  name text NOT NULL CHECK(length(name) BETWEEN 1 AND 120),
  revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
  status text NOT NULL CHECK(status IN ('select_account','ready','reconnect','disconnected','deleted')),
  current_grant_id uuid,
  encrypted_token jsonb,
  account_id text CHECK(account_id ~ '^[1-9][0-9]{0,39}$'),
  account_name text,
  currency text,
  time_zone text,
  account_status integer,
  validated_at timestamptz,
  disconnected_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(project_id,workspace_id) REFERENCES project(id,workspace_id) ON DELETE CASCADE,
  UNIQUE(id,project_id,workspace_id),
  CHECK((status IN ('disconnected','deleted'))=(encrypted_token IS NULL)),
  CHECK(status<>'ready' OR account_id IS NOT NULL),
  CHECK((status='deleted')=(deleted_at IS NOT NULL))
);
CREATE UNIQUE INDEX meta_connection_account_idx ON meta_connection(project_id,account_id)
  WHERE account_id IS NOT NULL AND status NOT IN ('disconnected','deleted');
CREATE INDEX meta_connection_project_idx ON meta_connection(project_id,created_at,id);

CREATE TABLE meta_oauth_flow (
  id uuid PRIMARY KEY,
  registration_id uuid NOT NULL REFERENCES meta_app_registration(id),
  app_revision integer NOT NULL CHECK(app_revision>0),
  start_epoch bigint NOT NULL CHECK(start_epoch>0),
  workspace_id text NOT NULL,
  project_id text NOT NULL,
  user_id text REFERENCES "user"(id) ON DELETE RESTRICT,
  session_id text,
  state_hash text UNIQUE CHECK(state_hash ~ '^[a-f0-9]{64}$'),
  browser_hash text CHECK(browser_hash ~ '^[a-f0-9]{64}$'),
  connection_id uuid,
  connection_revision integer CHECK(connection_revision>0),
  name text CHECK(length(name) BETWEEN 1 AND 120),
  phase text NOT NULL CHECK(phase IN ('pending','exchanging','completed','failed','cancelled')),
  subject_hash text CHECK(subject_hash ~ '^[a-f0-9]{64}$'),
  scopes jsonb,
  token_type text CHECK(token_type='USER'),
  access_expires_at timestamptz,
  data_access_expires_at timestamptz,
  granted_at timestamptz,
  invalidated_at timestamptz,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(project_id,workspace_id) REFERENCES project(id,workspace_id) ON DELETE CASCADE,
  FOREIGN KEY(connection_id,project_id,workspace_id) REFERENCES meta_connection(id,project_id,workspace_id) ON DELETE CASCADE,
  UNIQUE(id,connection_id,project_id,workspace_id),
  CHECK(phase<>'completed' OR (subject_hash IS NOT NULL AND connection_id IS NOT NULL AND granted_at IS NOT NULL
    AND state_hash IS NULL AND browser_hash IS NULL AND session_id IS NULL)),
  CHECK(phase NOT IN ('pending','exchanging') OR (state_hash IS NOT NULL AND browser_hash IS NOT NULL AND session_id IS NOT NULL AND user_id IS NOT NULL))
);
ALTER TABLE meta_connection ADD CONSTRAINT meta_connection_grant_fk FOREIGN KEY(current_grant_id,id,project_id,workspace_id)
  REFERENCES meta_oauth_flow(id,connection_id,project_id,workspace_id);
CREATE INDEX meta_flow_expiry_idx ON meta_oauth_flow(expires_at,id) WHERE phase<>'completed';
CREATE INDEX meta_grant_subject_idx ON meta_oauth_flow(registration_id,subject_hash,start_epoch,id) WHERE phase='completed';

CREATE TABLE meta_deletion_request (
  id uuid PRIMARY KEY,
  registration_id uuid NOT NULL REFERENCES meta_app_registration(id),
  payload_digest text NOT NULL CHECK(payload_digest ~ '^[a-f0-9]{64}$'),
  subject_hash text NOT NULL CHECK(subject_hash ~ '^[a-f0-9]{64}$'),
  fence_epoch bigint NOT NULL CHECK(fence_epoch>0),
  status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','cleaning','local_deleted')),
  confirmation_hash text NOT NULL UNIQUE CHECK(confirmation_hash ~ '^[a-f0-9]{64}$'),
  encrypted_confirmation jsonb NOT NULL,
  issued_at_seconds bigint CHECK(issued_at_seconds>=0),
  expires_seconds bigint CHECK(expires_seconds>=0),
  cleaned_connections bigint NOT NULL DEFAULT 0 CHECK(cleaned_connections>=0),
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  local_deleted_at timestamptz,
  UNIQUE(registration_id,payload_digest),
  CHECK((status='local_deleted')=(local_deleted_at IS NOT NULL))
);
CREATE INDEX meta_deletion_subject_idx ON meta_deletion_request(registration_id,subject_hash,fence_epoch);
CREATE INDEX meta_deletion_pending_idx ON meta_deletion_request(received_at,id) WHERE status<>'local_deleted';
