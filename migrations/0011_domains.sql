CREATE TABLE project_domain (
  id uuid PRIMARY KEY,
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  hostname text NOT NULL CHECK (length(hostname) BETWEEN 3 AND 253),
  role text NOT NULL CHECK (role IN ('canonical', 'serving', 'redirect_alias')),
  expected_target_host text,
  created_at timestamptz NOT NULL DEFAULT now(),
  verified_at timestamptz,
  revoked_at timestamptz,
  challenge_hash text CHECK (challenge_hash ~ '^[0-9a-f]{64}$'),
  challenge_expires_at timestamptz,
  UNIQUE(project_id, hostname),
  CHECK ((role = 'redirect_alias') = (expected_target_host IS NOT NULL)),
  CHECK (expected_target_host IS NULL OR (length(expected_target_host) BETWEEN 3 AND 253 AND expected_target_host <> hostname)),
  CHECK ((challenge_hash IS NULL) = (challenge_expires_at IS NULL)),
  CHECK (verified_at IS NULL OR (challenge_hash IS NULL AND revoked_at IS NULL)),
  CHECK (revoked_at IS NULL OR (challenge_hash IS NULL AND verified_at IS NULL))
);
CREATE UNIQUE INDEX project_domain_canonical_idx ON project_domain(project_id) WHERE role = 'canonical';
