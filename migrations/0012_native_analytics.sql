ALTER TABLE project ADD COLUMN analytics_settings jsonb NOT NULL DEFAULT '{"enabled":true,"consentMode":"builtin","captureReferrer":false,"captureCampaigns":false,"captureScreen":false,"excludeBots":true,"excludedPaths":[]}'::jsonb;
ALTER TABLE project ADD COLUMN analytics_revision integer NOT NULL DEFAULT 1 CHECK (analytics_revision > 0);
ALTER TABLE project ADD COLUMN analytics_epoch uuid NOT NULL DEFAULT gen_random_uuid();

CREATE TABLE analytics_visitor (
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  id text NOT NULL CHECK (id ~ '^[a-f0-9]{64}$'),
  first_seen_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  CHECK (first_seen_at <= last_seen_at),
  PRIMARY KEY(project_id,id)
);
ALTER TABLE event ADD COLUMN visitor_id text;
ALTER TABLE event ADD COLUMN visit_id text;
ALTER TABLE event ADD COLUMN properties jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(properties) = 'object');
ALTER TABLE event ADD COLUMN dimensions jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(dimensions) = 'object');
ALTER TABLE event ADD COLUMN source text NOT NULL DEFAULT 'legacy' CHECK (source IN ('legacy','browser','api'));
ALTER TABLE event ADD COLUMN metric_version text NOT NULL DEFAULT 'observations-v1';
ALTER TABLE event ADD CONSTRAINT event_identity_pair CHECK ((visitor_id IS NULL AND visit_id IS NULL) OR (visitor_id IS NOT NULL AND visit_id IS NOT NULL AND visitor_id ~ '^[a-f0-9]{64}$' AND visit_id ~ '^[a-f0-9]{64}$'));
ALTER TABLE event ADD CONSTRAINT event_visitor FOREIGN KEY(project_id,visitor_id) REFERENCES analytics_visitor(project_id,id) DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX event_project_visit_time_idx ON event(project_id,visit_id,received_at) WHERE visit_id IS NOT NULL;
