CREATE TABLE analytics_annotation (
  id uuid PRIMARY KEY,
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  user_id text REFERENCES "user"(id) ON DELETE SET NULL,
  date timestamptz(3) NOT NULL CHECK (date >= '1970-01-01T00:00:00Z'::timestamptz AND date < '9999-01-01T00:00:00Z'::timestamptz),
  all_day boolean NOT NULL DEFAULT true,
  note text NOT NULL CHECK (length(note) BETWEEN 1 AND 500),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz(3) NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX analytics_annotation_page_idx ON analytics_annotation(project_id,date DESC,id DESC);
