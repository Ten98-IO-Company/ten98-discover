-- Workspace-owned website (project analytics) public share grants. Append after 0068; exactly one table, no backfill.
-- No raw token anywhere: token_hash is the hex sha256 of a 32-byte browser-generated secret that travels only in the URL fragment and X-Ten98-Website-Share.
-- Grants are immutable except revoked_at, which never returns to NULL; a change is revoke plus a new create.
-- Request receipts reuse project_content_request (0014), which already cascades with the project.
-- The workspace derives through project, as for board_share (0060); a project transfer must revoke these rows in its own transaction.
CREATE TABLE project_share (
 id uuid PRIMARY KEY,
 project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
 label text NOT NULL CHECK(length(label) BETWEEN 1 AND 120),
 token_hash text NOT NULL UNIQUE CHECK(token_hash ~ '^[a-f0-9]{64}$'),
 sections text[] NOT NULL CHECK(cardinality(sections) BETWEEN 1 AND 3 AND array_ndims(sections)=1 AND array_position(sections,NULL) IS NULL AND sections <@ ARRAY['overview','events','locations']::text[]),
 created_by text REFERENCES "user"(id) ON DELETE SET NULL,
 created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz(3) NOT NULL,
 revoked_at timestamptz(3),
 CHECK(expires_at>created_at)
);
CREATE INDEX project_share_page_idx ON project_share(project_id,created_at DESC,id DESC);
