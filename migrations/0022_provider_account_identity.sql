ALTER TABLE installation ADD COLUMN provider_account_identity jsonb
  CHECK(provider_account_identity IS NULL OR jsonb_typeof(provider_account_identity)='object');
ALTER TABLE keyword_quote ADD COLUMN account_fingerprint_version smallint NOT NULL DEFAULT 1
  CHECK(account_fingerprint_version IN(1,2));
ALTER TABLE saved_keyword_refresh_plan ADD COLUMN account_fingerprint_version smallint NOT NULL DEFAULT 1
  CHECK(account_fingerprint_version IN(1,2));
