-- Paid-work archive (#292, #291; owner decision ten98-code-system#39). Additive after 0071; starts empty, no backfill.
-- Website and workspace deletion copy every paid-work ledger and receipt row of the deleted scope here, in the deleting
-- transaction, before those rows go with the website or workspace. Only ids, amounts, counts, flags, statuses, hashes and
-- timestamps are copied (src/server/paid-work-archive.ts): no credential, fingerprint, name, free text or JSON content.
-- account_ids holds the opaque account ids the row named. The daily retention job deletes a row 7 years after created_at,
-- the source row's own creation time. There are no foreign keys: the workspace and website rows are gone.
CREATE TABLE paid_work_archive (
  source_table text NOT NULL CHECK (source_table ~ '^[a-z][a-z_]*$'),
  source_id uuid NOT NULL,
  workspace_id text NOT NULL,
  project_id text,
  account_ids text[] NOT NULL CHECK (array_position(account_ids, NULL) IS NULL),
  record jsonb NOT NULL CHECK (jsonb_typeof(record) = 'object'),
  created_at timestamptz NOT NULL,
  archived_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (source_table, source_id)
);
CREATE INDEX paid_work_archive_scope ON paid_work_archive (workspace_id, project_id, created_at);
CREATE INDEX paid_work_archive_created ON paid_work_archive (created_at);
CREATE INDEX paid_work_archive_accounts ON paid_work_archive USING gin (account_ids);
