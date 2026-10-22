-- Account closure tombstones (docs/account-closure.md). Additive after 0069; no backfill: every existing account stays open.
-- A closed row keeps its id so workspace-billed financial and audit rows that name it as an actor stay intact.
ALTER TABLE "user" ADD COLUMN closed_at timestamptz(3);
ALTER TABLE "user" ADD CONSTRAINT user_closed_tombstone_check CHECK (closed_at IS NULL OR (
  name = 'Closed account' AND email ~ '^closed-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}@invalid$'
  AND image IS NULL AND NOT "emailVerified" AND NOT "twoFactorEnabled"));

-- One security event per closure. It names only account ids; an operator closure records the operator's reason.
CREATE TABLE account_closure_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id text NOT NULL UNIQUE REFERENCES "user"(id),
  actor_user_id text NOT NULL REFERENCES "user"(id),
  kind text NOT NULL CHECK (kind IN ('self','operator')),
  reason text CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND 500),
  created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  CHECK ((kind = 'self') = (reason IS NULL)),
  CHECK ((kind = 'self') = (actor_user_id = user_id))
);

-- A closed account can never regain a credential, session, factor, link, key, membership or role. FOR SHARE waits for an
-- in-flight closure of the same account, then sees its committed closed_at.
CREATE FUNCTION refuse_closed_account() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target text := to_jsonb(NEW) ->> TG_ARGV[0];
BEGIN
  IF target IS NOT NULL THEN
    PERFORM 1 FROM "user" WHERE id = target AND closed_at IS NOT NULL FOR SHARE;
    IF FOUND THEN RAISE EXCEPTION 'The account is closed.' USING ERRCODE = 'check_violation'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER session_closed_account BEFORE INSERT OR UPDATE OF "userId" ON session FOR EACH ROW EXECUTE FUNCTION refuse_closed_account('userId');
CREATE TRIGGER account_closed_account BEFORE INSERT OR UPDATE OF "userId" ON account FOR EACH ROW EXECUTE FUNCTION refuse_closed_account('userId');
CREATE TRIGGER two_factor_closed_account BEFORE INSERT OR UPDATE OF "userId" ON "twoFactor" FOR EACH ROW EXECUTE FUNCTION refuse_closed_account('userId');
CREATE TRIGGER oidc_identity_closed_account BEFORE INSERT OR UPDATE OF user_id ON oidc_identity FOR EACH ROW EXECUTE FUNCTION refuse_closed_account('user_id');
CREATE TRIGGER oidc_transaction_closed_account BEFORE INSERT OR UPDATE OF user_id ON oidc_transaction FOR EACH ROW EXECUTE FUNCTION refuse_closed_account('user_id');
CREATE TRIGGER api_key_closed_account BEFORE INSERT OR UPDATE OF issuer_user_id ON api_key FOR EACH ROW EXECUTE FUNCTION refuse_closed_account('issuer_user_id');
CREATE TRIGGER membership_closed_account BEFORE INSERT OR UPDATE OF user_id ON membership FOR EACH ROW EXECUTE FUNCTION refuse_closed_account('user_id');
CREATE TRIGGER instance_operator_closed_account BEFORE INSERT OR UPDATE OF user_id ON instance_operator FOR EACH ROW EXECUTE FUNCTION refuse_closed_account('user_id');
CREATE TRIGGER user_preference_closed_account BEFORE INSERT OR UPDATE OF user_id ON user_preference FOR EACH ROW EXECUTE FUNCTION refuse_closed_account('user_id');
CREATE TRIGGER workspace_invitation_closed_account BEFORE INSERT OR UPDATE OF inviter_id ON workspace_invitation FOR EACH ROW EXECUTE FUNCTION refuse_closed_account('inviter_id');
CREATE TRIGGER google_oauth_flow_closed_account BEFORE INSERT OR UPDATE OF user_id ON google_oauth_flow FOR EACH ROW EXECUTE FUNCTION refuse_closed_account('user_id');

-- The tombstone is final: no update can reopen, rename or re-address a closed account.
CREATE FUNCTION keep_closed_account() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.closed_at IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'The account is closed.' USING ERRCODE = 'check_violation'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER user_closed_account_final BEFORE UPDATE ON "user" FOR EACH ROW EXECUTE FUNCTION keep_closed_account();
