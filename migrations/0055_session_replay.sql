ALTER TABLE project ADD COLUMN replay_retained_from timestamptz;
CREATE TABLE session_recording (
 id uuid PRIMARY KEY,
 project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
 request_id uuid NOT NULL,
 request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
 origin text NOT NULL,
 entry_path text CHECK(length(entry_path) BETWEEN 1 AND 2048 AND left(entry_path,1)='/'),
 epoch uuid NOT NULL,
 settings jsonb NOT NULL CHECK(jsonb_typeof(settings)='object'),
 settings_hash text NOT NULL CHECK(settings_hash ~ '^[a-f0-9]{64}$'),
 sampled boolean NOT NULL,
 created_at timestamptz NOT NULL,
 deadline_at timestamptz NOT NULL,
 upload_until timestamptz NOT NULL,
 chunk_count integer NOT NULL DEFAULT 0 CHECK(chunk_count BETWEEN 0 AND 1024),
 byte_count integer NOT NULL DEFAULT 0 CHECK(byte_count BETWEEN 0 AND 67108864),
 last_sequence integer CHECK(last_sequence BETWEEN 0 AND 1023),
 first_event_timestamp bigint CHECK(first_event_timestamp BETWEEN 0 AND 8640000000000000),
 last_event_timestamp bigint CHECK(last_event_timestamp BETWEEN 0 AND 8640000000000000),
 complete boolean NOT NULL DEFAULT false,
 missing_fragments integer CHECK(missing_fragments>=0),
 UNIQUE(project_id,request_id),
 CHECK(deadline_at>created_at AND deadline_at<=created_at+interval '20 minutes'),
 CHECK(upload_until=deadline_at+interval '1 minute')
 ,CHECK((first_event_timestamp IS NULL AND last_event_timestamp IS NULL) OR (first_event_timestamp IS NOT NULL AND last_event_timestamp IS NOT NULL AND last_event_timestamp>=first_event_timestamp AND last_event_timestamp-first_event_timestamp<=(extract(epoch FROM deadline_at-created_at)*1000)::bigint))
);
CREATE INDEX session_recording_project_created ON session_recording(project_id,created_at,id);
CREATE TABLE session_recording_chunk (
 recording_id uuid NOT NULL REFERENCES session_recording(id) ON DELETE CASCADE,
 sequence integer NOT NULL CHECK(sequence BETWEEN 0 AND 1023),
 final boolean NOT NULL,
 sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),
 fragment_ids uuid[] NOT NULL DEFAULT '{}' CHECK(cardinality(fragment_ids)<=200),
 payload bytea NOT NULL CHECK(octet_length(payload) BETWEEN 1 AND 262144),
 PRIMARY KEY(recording_id,sequence)
);
CREATE INDEX session_recording_chunk_fragments ON session_recording_chunk USING gin(fragment_ids);
