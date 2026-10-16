CREATE TABLE web_performance (
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  navigation_id uuid NOT NULL,
  metric text NOT NULL CHECK (metric IN ('lcp','inp','cls','fcp','ttfb')),
  value double precision NOT NULL,
  revision integer NOT NULL CHECK (revision BETWEEN 1 AND 1000000),
  origin text NOT NULL,
  path text NOT NULL CHECK (length(path) BETWEEN 1 AND 2048 AND left(path,1)='/'),
  dimensions jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(dimensions)='object'),
  collection_basis text NOT NULL CHECK (collection_basis IN ('consent','cookieless')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (project_id,navigation_id,metric),
  CHECK (value >= 0 AND value <= CASE WHEN metric='cls' THEN 1000 ELSE 3600000 END)
);
CREATE INDEX web_performance_project_created ON web_performance(project_id,created_at,navigation_id);
