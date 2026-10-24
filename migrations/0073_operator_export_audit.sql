-- Paid-work export audit (follow-up to #370). Additive after 0072; no backfill, existing audit rows are unchanged.
-- 'cli.ts paid-work export' names an instance operator, who is verified and recorded in the existing operator audit
-- before any archived row is read. scope names only the exported workspace and optional website by opaque id.
ALTER TABLE instance_operator_audit DROP CONSTRAINT instance_operator_audit_action_check;
ALTER TABLE instance_operator_audit ADD COLUMN scope text;
ALTER TABLE instance_operator_audit ADD CONSTRAINT instance_operator_audit_action_check
  CHECK (action IN ('bootstrap','grant','revoke','paid_work_export'));
ALTER TABLE instance_operator_audit ADD CONSTRAINT instance_operator_audit_scope_check
  CHECK ((action = 'paid_work_export') = (scope IS NOT NULL)
    AND (scope IS NULL OR scope ~ '^workspace:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(/website:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?$'));
