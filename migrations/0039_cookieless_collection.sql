-- Future projects count basic observations; existing settings and epochs are unchanged.
ALTER TABLE project ALTER COLUMN analytics_settings SET DEFAULT '{"enabled":true,"consentMode":"builtin","collectionMode":"cookieless","captureReferrer":false,"captureCampaigns":false,"captureScreen":false,"excludeBots":true,"excludedPaths":[]}'::jsonb;

-- Historical and authenticated API observations make no browser permission claim.
ALTER TABLE event ADD COLUMN collection_basis text;
ALTER TABLE event ADD CONSTRAINT event_collection_basis CHECK (
  collection_basis IS NULL OR (source='browser' AND
    (collection_basis='consent' OR (collection_basis='cookieless' AND identity_link_evidence_version IS NULL)))
);
