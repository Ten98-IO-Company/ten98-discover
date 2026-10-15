ALTER TABLE google_connection DROP CONSTRAINT google_connection_provider_check;
ALTER TABLE google_connection ADD CONSTRAINT google_connection_provider_check CHECK(provider IN ('gsc','ga4','ads'));
ALTER TABLE google_oauth_flow DROP CONSTRAINT google_oauth_flow_provider_check;
ALTER TABLE google_oauth_flow ADD CONSTRAINT google_oauth_flow_provider_check CHECK(provider IN ('gsc','ga4','ads'));
ALTER TABLE google_import DROP CONSTRAINT google_import_report_check;
ALTER TABLE google_import ADD CONSTRAINT google_import_report_check CHECK(report IN ('gsc_daily','gsc_queries','gsc_pages','ga4_traffic','ga4_events','ads_daily','ads_campaigns','ads_ad_groups'));
ALTER TABLE google_connection ADD COLUMN login_customer_id text;
ALTER TABLE google_connection ADD CONSTRAINT google_connection_ads_login_check CHECK(login_customer_id IS NULL OR (provider='ads' AND login_customer_id ~ '^[1-9][0-9]{9}$'));
