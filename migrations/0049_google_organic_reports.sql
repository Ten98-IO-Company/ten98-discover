-- Fixed organic profiles reuse the existing Google snapshot and page stores.
ALTER TABLE google_import DROP CONSTRAINT google_import_report_check;
ALTER TABLE google_import ADD CONSTRAINT google_import_report_check CHECK(report IN ('gsc_daily','gsc_queries','gsc_pages','ga4_traffic','ga4_events','ga4_pages','ga4_acquisition','ga4_key_events','ga4_organic_landing','ga4_organic_daily','ga4_organic_weekly','ads_daily','ads_campaigns','ads_ad_groups'));
