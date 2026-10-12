CREATE TABLE provider_connection (
  id uuid PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('openrouter','dataforseo')),
  name text NOT NULL,
  encrypted_credentials jsonb,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  monthly_limit_micros bigint NOT NULL DEFAULT 0 CHECK (monthly_limit_micros BETWEEN 0 AND 1000000000000),
  check_status text NOT NULL DEFAULT 'untested' CHECK (check_status IN ('untested','ok','error')),
  diagnostic text,
  last_checked_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id,workspace_id)
);
CREATE INDEX provider_connection_workspace_idx ON provider_connection(workspace_id);

CREATE TABLE workspace_budget (
  workspace_id text PRIMARY KEY REFERENCES workspace(id) ON DELETE CASCADE,
  monthly_limit_micros bigint NOT NULL DEFAULT 0 CHECK (monthly_limit_micros BETWEEN 0 AND 1000000000000),
  paused boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE provider_request (
  id uuid PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL,
  connection_revision integer NOT NULL CHECK (connection_revision > 0),
  user_id text NOT NULL REFERENCES "user"(id),
  request_key uuid NOT NULL,
  operation text NOT NULL CHECK (length(operation) BETWEEN 1 AND 120),
  input_hash text NOT NULL CHECK (length(input_hash)=64),
  estimate_micros bigint NOT NULL CHECK (estimate_micros BETWEEN 1 AND 1000000000000),
  actual_micros bigint CHECK (actual_micros BETWEEN 0 AND 1000000000000),
  status text NOT NULL CHECK (status IN ('reserved','dispatched','uncertain','settled','cancelled')),
  budget_month date NOT NULL,
  provider_reference text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (connection_id,workspace_id) REFERENCES provider_connection(id,workspace_id),
  UNIQUE (workspace_id,request_key)
);
CREATE INDEX provider_request_budget_idx ON provider_request(workspace_id,budget_month);
