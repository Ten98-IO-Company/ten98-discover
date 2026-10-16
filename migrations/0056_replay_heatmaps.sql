ALTER TABLE session_recording ADD COLUMN saved_name text CHECK(length(saved_name) BETWEEN 1 AND 100);
ALTER TABLE session_recording ADD COLUMN saved_at timestamptz;
ALTER TABLE session_recording ADD COLUMN saved_revision integer NOT NULL DEFAULT 0 CHECK(saved_revision BETWEEN 0 AND 2147483647);
ALTER TABLE session_recording ADD CONSTRAINT session_recording_saved_pair CHECK((saved_name IS NULL AND saved_at IS NULL) OR(saved_name IS NOT NULL AND saved_at IS NOT NULL AND saved_revision>0));
CREATE INDEX session_recording_saved ON session_recording(project_id,created_at,id) WHERE saved_at IS NOT NULL;
CREATE TABLE heatmap_capture (
 id uuid NOT NULL,
 project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
 request_id uuid NOT NULL,
 request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
 origin text NOT NULL,
 path text CHECK(length(path) BETWEEN 1 AND 2048 AND left(path,1)='/'),
 epoch uuid NOT NULL,
 settings_hash text NOT NULL CHECK(settings_hash ~ '^[a-f0-9]{64}$'),
 settings jsonb NOT NULL CHECK(jsonb_typeof(settings)='object'),
 sampled boolean NOT NULL,
 created_at timestamptz NOT NULL,
 deadline_at timestamptz NOT NULL,
 upload_until timestamptz NOT NULL,
 batch_count integer NOT NULL DEFAULT 0 CHECK(batch_count BETWEEN 0 AND 256),
 byte_count integer NOT NULL DEFAULT 0 CHECK(byte_count BETWEEN 0 AND 8388608),
 last_offset_ms double precision NOT NULL DEFAULT 0 CHECK(last_offset_ms BETWEEN 0 AND 300000),
 PRIMARY KEY(project_id,id),UNIQUE(project_id,request_id),
 CHECK(deadline_at=created_at+interval '5 minutes' AND upload_until=deadline_at+interval '1 minute')
);
CREATE INDEX heatmap_capture_retention ON heatmap_capture(project_id,created_at,id);
CREATE TABLE heatmap_batch (
 project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
 request_id uuid NOT NULL,
 payload_hash text NOT NULL CHECK(payload_hash ~ '^[a-f0-9]{64}$'),
 capture_id uuid NOT NULL,
 origin text NOT NULL,
 path text NOT NULL CHECK(length(path) BETWEEN 1 AND 2048 AND left(path,1)='/'),
 page_key text NOT NULL CHECK(page_key ~ '^[a-f0-9]{64}$'),
 geometry_key text NOT NULL CHECK(geometry_key ~ '^[a-f0-9]{64}$'),
 geometry jsonb NOT NULL CHECK(jsonb_typeof(geometry)='object'),
 observations jsonb NOT NULL CHECK(jsonb_typeof(observations)='array' AND jsonb_array_length(observations) BETWEEN 1 AND 20),
 received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(project_id,request_id),
 FOREIGN KEY(project_id,capture_id) REFERENCES heatmap_capture(project_id,id) ON DELETE CASCADE,
 CHECK(octet_length(geometry::text)+octet_length(observations::text)<=32768)
);
CREATE INDEX heatmap_batch_retention ON heatmap_batch(project_id,received_at,request_id);
CREATE INDEX heatmap_batch_page_geometry ON heatmap_batch(project_id,page_key,geometry_key,received_at);
