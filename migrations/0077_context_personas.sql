CREATE TABLE context_persona (
  id uuid PRIMARY KEY,
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  description text NOT NULL CHECK (length(description)<=4000),
  updated_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  updated_by text NOT NULL
);
CREATE INDEX context_persona_project ON context_persona(project_id,name,id);
