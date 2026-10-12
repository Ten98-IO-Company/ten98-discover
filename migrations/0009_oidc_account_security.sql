ALTER TABLE oidc_transaction DROP CONSTRAINT oidc_transaction_purpose_check;
ALTER TABLE oidc_transaction ADD CONSTRAINT oidc_transaction_purpose_check
  CHECK (purpose IN ('test','link','login','invite','account'));
