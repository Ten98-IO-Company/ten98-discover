CREATE TABLE project_context (
  project_id text PRIMARY KEY REFERENCES project(id) ON DELETE CASCADE,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  brand_name text NOT NULL CHECK (length(brand_name) BETWEEN 1 AND 120),
  brand_aliases jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(brand_aliases)='array')
);
CREATE TABLE context_section (
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  key text NOT NULL,
  title text,
  content text NOT NULL CHECK (length(content) BETWEEN 1 AND 4000),
  updated_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  updated_by text NOT NULL,
  PRIMARY KEY(project_id,key)
);
CREATE TABLE context_competitor (
  id uuid PRIMARY KEY,
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  primary_domain text NOT NULL,
  domains jsonb NOT NULL CHECK (jsonb_typeof(domains)='array'),
  name text CHECK (length(name)<=120),
  aliases jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(aliases)='array'),
  notes text CHECK (length(notes)<=500),
  updated_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  updated_by text NOT NULL,
  UNIQUE(project_id,primary_domain)
);
CREATE TABLE context_key_page (
  id uuid PRIMARY KEY,
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  url text NOT NULL CHECK (length(url)<=2048),
  role text NOT NULL DEFAULT 'other' CHECK (role IN ('hub','spoke','money','other')),
  topic text CHECK (length(topic)<=200),
  notes text CHECK (length(notes)<=500),
  updated_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  updated_by text NOT NULL,
  UNIQUE(project_id,url)
);
CREATE TABLE context_research (
  id uuid PRIMARY KEY,
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  entry_date date NOT NULL DEFAULT (clock_timestamp() AT TIME ZONE 'UTC')::date,
  summary text NOT NULL CHECK (length(summary) BETWEEN 1 AND 1000),
  created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  created_by text NOT NULL
);
CREATE INDEX context_research_page_idx ON context_research(project_id,created_at DESC,id DESC);
CREATE TABLE project_content_request (
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  request_id uuid NOT NULL,
  operation text NOT NULL,
  input_hash text NOT NULL CHECK (input_hash ~ '^[a-f0-9]{64}$'),
  result jsonb NOT NULL,
  created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(project_id,request_id)
);
CREATE TABLE project_prompt (
  id uuid PRIMARY KEY,
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  revision integer NOT NULL DEFAULT 1 CHECK (revision>0),
  current_version_id uuid NOT NULL,
  topic text NOT NULL DEFAULT 'General' CHECK (length(topic) BETWEEN 1 AND 100),
  enabled boolean NOT NULL DEFAULT false,
  user_tags jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(user_tags)='array'),
  archived_at timestamptz(3),
  created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(project_id,id)
);
CREATE INDEX project_prompt_page_idx ON project_prompt(project_id,created_at DESC,id DESC);
CREATE TABLE prompt_text_version (
  id uuid PRIMARY KEY,
  project_id text NOT NULL,
  prompt_id uuid NOT NULL,
  number integer NOT NULL CHECK (number>0),
  text text NOT NULL CHECK (length(text) BETWEEN 1 AND 2000),
  lower_text text NOT NULL,
  created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  created_by text NOT NULL,
  UNIQUE(project_id,prompt_id,id),
  UNIQUE(prompt_id,number),
  FOREIGN KEY(project_id,prompt_id) REFERENCES project_prompt(project_id,id) ON DELETE CASCADE
);
ALTER TABLE project_prompt ADD CONSTRAINT project_prompt_current_version_fk
  FOREIGN KEY(project_id,id,current_version_id) REFERENCES prompt_text_version(project_id,prompt_id,id)
  DEFERRABLE INITIALLY DEFERRED;
-- Text versions are authored evidence. Metadata edits never update these rows.
CREATE FUNCTION reject_prompt_text_version_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Prompt text versions are immutable'; END;
$$;
CREATE TRIGGER prompt_text_version_immutable BEFORE UPDATE ON prompt_text_version
  FOR EACH ROW EXECUTE FUNCTION reject_prompt_text_version_update();
