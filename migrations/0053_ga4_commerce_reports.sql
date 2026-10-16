-- Six fixed range profiles reuse the existing Google snapshot/page stores.
ALTER TABLE google_import DROP CONSTRAINT google_import_report_check;
ALTER TABLE google_import ADD CONSTRAINT google_import_report_check CHECK(report IN ('gsc_daily','gsc_queries','gsc_pages','ga4_traffic','ga4_events','ga4_pages','ga4_acquisition','ga4_key_events','ga4_organic_landing','ga4_organic_daily','ga4_organic_weekly','ga4_ecommerce_items','ga4_ecommerce_landing','ga4_site_search','ga4_audience_device','ga4_audience_country','ga4_audience_returning','ads_daily','ads_campaigns','ads_ad_groups'));
