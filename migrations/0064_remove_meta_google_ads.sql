-- Owner decision 2026-10-18: the Meta integration and Google Ads imports are removed; Search Console and GA4 stay.
-- This permanently deletes imported Ads reports, Ads sources and their pending authorizations, then every Meta table.
-- Ads rows go first so the narrowed checks below validate every remaining Search Console and GA4 row.
DELETE FROM google_import WHERE report IN ('ads_daily','ads_campaigns','ads_ad_groups');
DELETE FROM google_import i USING google_connection c WHERE i.connection_id=c.id AND c.provider='ads';
DELETE FROM google_oauth_flow WHERE provider='ads';
DELETE FROM google_connection WHERE provider='ads';
ALTER TABLE google_connection DROP CONSTRAINT google_connection_ads_login_check;
ALTER TABLE google_connection DROP COLUMN login_customer_id;
ALTER TABLE google_connection DROP CONSTRAINT google_connection_provider_check;
ALTER TABLE google_connection ADD CONSTRAINT google_connection_provider_check CHECK(provider IN ('gsc','ga4'));
ALTER TABLE google_oauth_flow DROP CONSTRAINT google_oauth_flow_provider_check;
ALTER TABLE google_oauth_flow ADD CONSTRAINT google_oauth_flow_provider_check CHECK(provider IN ('gsc','ga4'));
ALTER TABLE google_import DROP CONSTRAINT google_import_report_check;
ALTER TABLE google_import ADD CONSTRAINT google_import_report_check CHECK(report IN ('gsc_daily','gsc_queries','gsc_pages','ga4_traffic','ga4_events','ga4_pages','ga4_acquisition','ga4_key_events','ga4_organic_landing','ga4_organic_daily','ga4_organic_weekly','ga4_ecommerce_items','ga4_ecommerce_landing','ga4_site_search','ga4_audience_device','ga4_audience_country','ga4_audience_returning'));
-- One statement drops the circular connection/grant references together; RESTRICT refuses any unexpected dependant.
DROP TABLE meta_campaign_inventory_page, meta_campaign_inventory, meta_import_page, meta_import, meta_deletion_request, meta_oauth_flow, meta_connection, meta_app_registration;
