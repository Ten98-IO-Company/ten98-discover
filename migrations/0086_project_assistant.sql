ALTER TABLE project ADD COLUMN assistant_payload_retained_from timestamptz NOT NULL DEFAULT '-infinity';

CREATE TABLE assistant_conversation (
 id uuid PRIMARY KEY,
 project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
 created_by text NOT NULL REFERENCES "user"(id),
 revision bigint NOT NULL DEFAULT 0 CHECK(revision BETWEEN 0 AND 9007199254740991),
 created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(project_id,id)
);
CREATE TABLE assistant_event (
 id uuid PRIMARY KEY,
 project_id text NOT NULL,
 conversation_id uuid NOT NULL,
 sequence bigint NOT NULL CHECK(sequence BETWEEN 1 AND 9007199254740991),
 actor_id text NOT NULL REFERENCES "user"(id),
 payload_sha256 text NOT NULL CHECK(payload_sha256 ~ '^[a-f0-9]{64}$'),
 payload_bytes integer NOT NULL CHECK(payload_bytes BETWEEN 1 AND 131072),
 created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(project_id,id),
 UNIQUE(conversation_id,sequence),
 FOREIGN KEY(project_id,conversation_id) REFERENCES assistant_conversation(project_id,id) ON DELETE CASCADE
);
CREATE TABLE assistant_event_payload (
 event_id uuid PRIMARY KEY,
 project_id text NOT NULL,
 exact_text text NOT NULL CHECK(octet_length(exact_text) BETWEEN 1 AND 131072),
 FOREIGN KEY(project_id,event_id) REFERENCES assistant_event(project_id,id) ON DELETE CASCADE
);
CREATE INDEX assistant_conversation_project_created_idx ON assistant_conversation(project_id,created_at,id);
CREATE INDEX assistant_event_project_created_idx ON assistant_event(project_id,created_at,id);
CREATE INDEX assistant_conversation_creator_idx ON assistant_conversation(created_by);
CREATE INDEX assistant_event_actor_idx ON assistant_event(actor_id);

-- Retention deletes payloads; neither content nor its original provenance is rewritten.
CREATE FUNCTION reject_assistant_content_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Assistant content is immutable' USING ERRCODE='23514'; END;
$$;
CREATE TRIGGER assistant_event_immutable BEFORE UPDATE ON assistant_event FOR EACH ROW EXECUTE FUNCTION reject_assistant_content_update();
CREATE TRIGGER assistant_payload_immutable BEFORE UPDATE ON assistant_event_payload FOR EACH ROW EXECUTE FUNCTION reject_assistant_content_update();
