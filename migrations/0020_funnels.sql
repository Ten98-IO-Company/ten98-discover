CREATE TABLE analytics_definition (
  id uuid PRIMARY KEY,
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('funnel','goal')),
  definition jsonb NOT NULL CHECK (jsonb_typeof(definition)='object'),
  revision integer NOT NULL DEFAULT 1 CHECK (revision>0),
  created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  CHECK ((definition->>'kind') IS NOT DISTINCT FROM kind)
);
CREATE INDEX analytics_definition_page_idx ON analytics_definition(project_id,kind,created_at DESC,id DESC);
