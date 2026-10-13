-- Metadata edits need optimistic concurrency without renewing or invalidating
-- paid approval. Existing revision/keywords_revision keep their paid meanings.
ALTER TABLE rank_config ADD COLUMN authored_revision integer NOT NULL DEFAULT 1
  CHECK (authored_revision BETWEEN 1 AND 2147483646);
