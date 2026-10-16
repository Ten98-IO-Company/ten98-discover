-- Draft only. Register after the actual ordered0057/0058 prefix is integrated.
-- No DOM copy, replay capability or page URL is stored here.
ALTER TABLE session_recording ADD CONSTRAINT session_recording_project_id_id_key UNIQUE(project_id,id);
CREATE TABLE heatmap_background(
 project_id text NOT NULL,
 capture_id uuid NOT NULL,
 geometry_key text NOT NULL CHECK(geometry_key ~ '^[a-f0-9]{64}$'),
 request_id uuid NOT NULL,
 request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
 batch_request_id uuid NOT NULL,
 recording_id uuid NOT NULL,
 geometry jsonb NOT NULL CHECK(jsonb_typeof(geometry)='object' AND octet_length(geometry::text)<=1024),
 heatmap_offset_ms double precision NOT NULL CHECK(heatmap_offset_ms>=0 AND heatmap_offset_ms<=300000),
 replay_offset_ms integer NOT NULL CHECK(replay_offset_ms>=0 AND replay_offset_ms<=1200000),
 meta jsonb NOT NULL CHECK(jsonb_typeof(meta)='object' AND octet_length(meta::text)<=512),
 snapshot jsonb NOT NULL CHECK(jsonb_typeof(snapshot)='object' AND octet_length(snapshot::text)<=512),
 sequences integer[] NOT NULL CHECK(cardinality(sequences) BETWEEN 1 AND 128),
 observed_at timestamptz NOT NULL,
 accepted_at timestamptz NOT NULL,
 PRIMARY KEY(project_id,capture_id,geometry_key),
 UNIQUE(project_id,request_id),
 FOREIGN KEY(project_id,capture_id) REFERENCES heatmap_capture(project_id,id) ON DELETE CASCADE,
 FOREIGN KEY(project_id,batch_request_id) REFERENCES heatmap_batch(project_id,request_id) ON DELETE CASCADE,
 FOREIGN KEY(project_id,recording_id) REFERENCES session_recording(project_id,id) ON DELETE CASCADE
);
CREATE INDEX heatmap_background_recording ON heatmap_background(project_id,recording_id);
CREATE INDEX heatmap_background_geometry ON heatmap_background(project_id,geometry_key,accepted_at,capture_id);
