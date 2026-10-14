-- Explicit, immutable per-run opt-in. Existing audits have no retained body text.
ALTER TABLE site_audit_page
  ADD COLUMN body_capture_state text NOT NULL DEFAULT 'not_recorded',
  ADD COLUMN body_extraction_version text,
  ADD COLUMN body_text text,
  ADD CONSTRAINT site_audit_body_capture CHECK (
    (body_capture_state='not_recorded' AND body_extraction_version IS NULL AND body_text IS NULL)
    OR (resource_kind='html' AND body_extraction_version IS NOT NULL AND body_extraction_version='static-dom-body-v1' AND (
      (body_capture_state='available' AND (body_text IS NULL OR (analysis_coverage='analyzed' AND octet_length(body_text) BETWEEN 1 AND 65536)))
      OR (body_capture_state='empty' AND (body_text IS NULL OR (analysis_coverage='analyzed' AND body_text='')))
      OR (body_capture_state IN ('unavailable','over_limit') AND body_text IS NULL)
    ))
  );
