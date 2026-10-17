-- Project deletion receipts outlive the project; no project FK or copied website data.
CREATE TABLE project_deletion_request (
 workspace_id text NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
 request_id uuid NOT NULL,
 actor_id text NOT NULL,
 project_id text NOT NULL,
 input_hash text NOT NULL CHECK(input_hash ~ '^[a-f0-9]{64}$'),
 applied_revision integer NOT NULL CHECK(applied_revision BETWEEN 1 AND 2147483647),
 deleted_at timestamptz NOT NULL CHECK(isfinite(deleted_at)),
 PRIMARY KEY(workspace_id,request_id)
);
