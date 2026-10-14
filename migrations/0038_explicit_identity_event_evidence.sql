-- Forward proof only: existing events and projects remain unproven.
ALTER TABLE event ADD COLUMN identity_link_evidence_version smallint
  CHECK (identity_link_evidence_version IS NULL OR
    (identity_link_evidence_version=1 AND source='browser' AND visitor_id IS NOT NULL AND visit_id IS NOT NULL));
ALTER TABLE project ADD COLUMN identity_event_evidence_started_at timestamptz;
