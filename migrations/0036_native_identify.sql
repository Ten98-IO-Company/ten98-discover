CREATE TABLE analytics_session_property (
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  visitor_key text NOT NULL CHECK (visitor_key ~ '^[a-f0-9]{64}$'),
  property_key text NOT NULL CHECK (length(property_key) BETWEEN 1 AND 320),
  property jsonb NOT NULL CHECK (jsonb_typeof(property)='object' AND property ? 'type' AND property ? 'value'
    AND property->>'type' IN ('string','number','boolean','null','date','array')),
  updated_at timestamptz NOT NULL,
  PRIMARY KEY(project_id,visitor_key,property_key)
);
CREATE INDEX analytics_session_property_expiry_idx ON analytics_session_property(project_id,updated_at,visitor_key,property_key);

CREATE TABLE analytics_identify_receipt (
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  request_id uuid NOT NULL,
  visitor_key text NOT NULL CHECK (visitor_key ~ '^[a-f0-9]{64}$'),
  operation_hash text NOT NULL CHECK (operation_hash ~ '^[a-f0-9]{64}$'),
  sent_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz NOT NULL,
  CHECK (expires_at=sent_at+interval '24 hours'),
  PRIMARY KEY(project_id,request_id)
);
CREATE INDEX analytics_identify_receipt_expiry_idx ON analytics_identify_receipt(project_id,expires_at,request_id);

-- Separate from event history: profile deadlines cannot move backward after a
-- policy extension, and removing the last expired value cannot erase loss evidence.
ALTER TABLE project ADD COLUMN session_properties_retained_from timestamptz;
ALTER TABLE project ADD COLUMN session_properties_evidence_lost_at timestamptz;
