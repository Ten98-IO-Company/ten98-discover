CREATE TABLE api_key (
  id uuid PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  issuer_user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  scopes text[] NOT NULL CHECK (
    array_ndims(scopes) = 1 AND cardinality(scopes) BETWEEN 1 AND 5
    AND array_position(scopes, NULL) IS NULL
    AND scopes <@ ARRAY['projects:read', 'projects:write', 'analytics:read', 'events:write', 'team:read']::text[]
  ),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CHECK (expires_at > created_at),
  FOREIGN KEY (workspace_id, issuer_user_id) REFERENCES membership(workspace_id, user_id) ON DELETE CASCADE
);
CREATE INDEX api_key_workspace_created_idx ON api_key(workspace_id, created_at DESC);
