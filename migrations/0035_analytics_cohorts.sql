CREATE TABLE analytics_cohort (
  id uuid PRIMARY KEY,
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version=1),
  query text NOT NULL CHECK (length(query) BETWEEN 1 AND 20000),
  revision integer NOT NULL DEFAULT 1 CHECK (revision>0),
  created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz(3) NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX analytics_cohort_page_idx ON analytics_cohort(project_id,created_at DESC,id DESC);
