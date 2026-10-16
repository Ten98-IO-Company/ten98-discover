-- Workspace-owned layout, not a project alias. Native board reads still authorize every entity.
CREATE TABLE custom_board (
 id uuid PRIMARY KEY,
 workspace_id text NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
 definition jsonb NOT NULL CHECK (jsonb_typeof(definition)='object' AND (definition->>'schemaVersion') IS NOT DISTINCT FROM '1' AND octet_length(definition::text)<=262144),
 revision integer NOT NULL DEFAULT 1 CHECK (revision>0),
 created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz(3) NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX custom_board_page_idx ON custom_board(workspace_id,created_at DESC,id DESC);
-- Identifiers only; survive board deletion so an old clone/create retry cannot create another board.
CREATE TABLE custom_board_request (
 workspace_id text NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
 request_id uuid NOT NULL,
 actor_id text NOT NULL,
 operation text NOT NULL CHECK (operation IN ('create','update','clone','delete')),
 input_hash text NOT NULL CHECK (input_hash ~ '^[a-f0-9]{64}$'),
 board_id uuid NOT NULL,
 applied_revision integer NOT NULL CHECK (applied_revision>0),
 PRIMARY KEY(workspace_id,request_id)
);
