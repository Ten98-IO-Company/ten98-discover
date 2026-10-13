-- Provider-observed limits are independent of an import's terminal outcome.
-- Separate scopes preserve overlapping hints without widening either deadline.
ALTER TABLE meta_import ADD COLUMN app_cooldown_until timestamptz,
  ADD COLUMN account_cooldown_until timestamptz;
ALTER TABLE meta_campaign_inventory ADD COLUMN app_cooldown_until timestamptz,
  ADD COLUMN account_cooldown_until timestamptz;

-- Preserve only previously recorded live hints; retry timestamps without these
-- diagnostics are ordinary scheduling, not provider-observed rate authority.
UPDATE meta_import SET
 app_cooldown_until=CASE WHEN diagnostic_code='app_throttled' THEN next_attempt_at END,
 account_cooldown_until=CASE WHEN diagnostic_code='account_throttled' THEN next_attempt_at END
 WHERE status IN ('queued','submitting','waiting','reading') AND deleted_at IS NULL AND data_expired_at IS NULL
 AND source IS NOT NULL AND next_attempt_at>statement_timestamp() AND diagnostic_code IN ('app_throttled','account_throttled');
UPDATE meta_campaign_inventory SET
 app_cooldown_until=CASE WHEN diagnostic_code='app_throttled' THEN next_attempt_at END,
 account_cooldown_until=CASE WHEN diagnostic_code='account_throttled' THEN next_attempt_at END
 WHERE status IN ('queued','reading') AND deleted_at IS NULL AND data_expired_at IS NULL
 AND source IS NOT NULL AND next_attempt_at>statement_timestamp() AND diagnostic_code IN ('app_throttled','account_throttled');
