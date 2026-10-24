-- Email suppression follow-ups (#310). Additive after 0074; every existing row is kept unchanged.
-- New rows store an HMAC-SHA256 of the lowercased address keyed with AUTH_SECRET and set keyed=true. Rows recorded under
-- 0071 hold an unkeyed SHA-256 and keep keyed=false: the database cannot derive the keyed digest, so they still block by
-- their unkeyed digest until an operator clears them or, for complaints, they expire. No suppression is lost.
-- Complaint expiry is computed by the application from created_at, so it needs no column.
-- 'cli.ts email-suppression clear' lets a named instance operator clear one address; the existing operator audit records
-- each clear by operator id only, with no scope, address or digest.
ALTER TABLE email_suppression ADD COLUMN keyed boolean NOT NULL DEFAULT false;
ALTER TABLE instance_operator_audit DROP CONSTRAINT instance_operator_audit_action_check;
ALTER TABLE instance_operator_audit ADD CONSTRAINT instance_operator_audit_action_check
  CHECK (action IN ('bootstrap','grant','revoke','paid_work_export','email_suppression_clear'));
