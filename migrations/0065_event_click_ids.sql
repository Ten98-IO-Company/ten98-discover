-- Owner decision D1 (2026-10-17): the six raw paid-click identifiers pinned Umami 3.4.0 stores on each event, with its VarChar(255) bound.
-- Nullable without a default: existing rows stay historical unknowns and the table is neither rewritten nor scanned. No index: only
-- attribution reads them, on touches it has already joined by visitor key. The collector writes them only for consented browser events.
ALTER TABLE event ADD COLUMN gclid varchar(255), ADD COLUMN fbclid varchar(255), ADD COLUMN msclkid varchar(255),
  ADD COLUMN ttclid varchar(255), ADD COLUMN li_fat_id varchar(255), ADD COLUMN twclid varchar(255);
-- An analytics grant now also covers these identifiers on projects with campaign capture on, so grants given under the earlier notice
-- must not carry over: rotate those projects' consent epoch once, as a collection-scope change does (domains.ts rotateCollectionConsent).
UPDATE project SET analytics_epoch=gen_random_uuid() WHERE analytics_settings @> '{"captureCampaigns":true}'::jsonb;
