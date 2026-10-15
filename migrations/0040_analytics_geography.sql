-- Future projects may derive approximate geography when the operator supplies a local database.
-- Existing project settings, revisions, epochs and historical observations are unchanged.
ALTER TABLE project ALTER COLUMN analytics_settings SET DEFAULT '{"enabled":true,"consentMode":"builtin","collectionMode":"cookieless","captureReferrer":false,"captureCampaigns":false,"captureScreen":false,"captureGeography":true,"excludeBots":true,"excludedPaths":[]}'::jsonb;
