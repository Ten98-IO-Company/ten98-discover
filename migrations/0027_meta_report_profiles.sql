-- Preserve the captured reporting profile even when deletion removes its source.
-- Account names are labels, not measurement dimensions. Use the identical native
-- jsonb representation in enqueue and legacy read fallback; no application hash.
ALTER TABLE meta_import ADD COLUMN definition_key text
  CHECK(definition_key ~ '^[a-f0-9]{64}$');
UPDATE meta_import SET definition_key=encode(sha256(convert_to((source-'accountName')::text,'UTF8')),'hex')
  WHERE source IS NOT NULL;
CREATE INDEX meta_import_complete_selection_idx ON meta_import(connection_id,report,created_at DESC,id DESC)
  WHERE status='completed';
