-- Upgraded installations intentionally begin without operators. Only the host
-- command or a fresh atomic owner claim grants this separate instance authority.
CREATE TABLE instance_operator (
  user_id text PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
  source text NOT NULL CHECK (source IN ('bootstrap','host')),
  granted_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE instance_operator_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id text NOT NULL,
  action text NOT NULL CHECK (action IN ('bootstrap','grant','revoke')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE oidc_provider (
  id uuid PRIMARY KEY,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  draft jsonb NOT NULL,
  credential jsonb NOT NULL,
  active_revision integer,
  active jsonb,
  active_credential jsonb,
  tested_revision integer,
  tested_at timestamptz,
  enabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((active_revision IS NULL AND active IS NULL AND active_credential IS NULL AND NOT enabled)
    OR (active_revision > 0 AND active IS NOT NULL AND active_credential IS NOT NULL))
);

CREATE TABLE oidc_transaction (
  id uuid PRIMARY KEY,
  provider_id uuid NOT NULL REFERENCES oidc_provider(id) ON DELETE CASCADE,
  provider_revision integer NOT NULL CHECK (provider_revision > 0),
  purpose text NOT NULL CHECK (purpose IN ('test','link','login','invite')),
  state_hash text NOT NULL UNIQUE,
  browser_hash text NOT NULL,
  user_id text REFERENCES "user"(id) ON DELETE CASCADE,
  session_id text,
  credential jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','exchanging','verified')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX oidc_transaction_expiry_idx ON oidc_transaction(expires_at);

CREATE TABLE oidc_identity (
  id uuid PRIMARY KEY,
  provider_id uuid NOT NULL REFERENCES oidc_provider(id),
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  issuer text NOT NULL,
  subject text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(issuer,subject)
);
CREATE INDEX oidc_identity_user_idx ON oidc_identity(user_id);
ALTER TABLE session ADD COLUMN "oidcProviderId" uuid REFERENCES oidc_provider(id);
