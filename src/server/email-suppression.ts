import { createHash, createHmac } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { getConfig } from './config.ts';
import { getDatabase } from './db.ts';

/** Reasons that block transactional sends (#304). Transient and undetermined bounces never do. */
export type EmailSuppressionReason = 'permanent-bounce' | 'complaint';

/**
 * A complaint stops blocking this many days after it was recorded (#310). A single complaint, such as a reset email
 * marked as spam, must not lock a mailbox out of password recovery forever, yet a recipient who complained should not
 * hear from the instance again soon. 180 days matches the conservative end of common sender practice for re-mailing
 * complainers. A later complaint starts a new period. Hard bounces never expire; an operator clears them.
 */
export const complaintSuppressionDays = 180;

const normalise = (address: string) => address.trim().toLowerCase();

/**
 * Suppressions are keyed by an HMAC-SHA256 of the lowercased address with the server secret under its own label (#310),
 * so the table holds no address text and a guessed address cannot be confirmed without AUTH_SECRET. Lowercasing the local
 * part too errs towards blocking a case variant of a bounced address. Rotating AUTH_SECRET orphans keyed rows, which then
 * stop blocking; this is the same trade-off as the other AUTH_SECRET-keyed digests.
 */
export function emailAddressDigest(address: string): string {
  return createHmac('sha256', getConfig().authSecret).update('ten98.email-suppression.v1:' + normalise(address)).digest('hex');
}

/** The unkeyed SHA-256 that 0071 stored. Only matched and cleared, never written (keyed=false rows). */
export function legacyEmailAddressDigest(address: string): string {
  return createHash('sha256').update(normalise(address)).digest('hex');
}

const active = `(reason='permanent-bounce' OR created_at>clock_timestamp()-make_interval(days=>${complaintSuppressionDays}))`;
const matches = '((address_hash=$1 AND keyed) OR (address_hash=$2 AND NOT keyed))';

export async function isEmailSuppressed(address: string, db: Pool | PoolClient = getDatabase().pool): Promise<boolean> {
  return (await db.query(`SELECT 1 FROM email_suppression WHERE ${matches} AND ${active} LIMIT 1`, [emailAddressDigest(address), legacyEmailAddressDigest(address)])).rowCount === 1;
}

/**
 * Idempotent: SNS delivers at least once. A hard bounce is kept over a later complaint, a hard bounce after a complaint
 * makes the suppression permanent, and a complaint after an expired one starts a new period. Each write first purges
 * expired complaints, so they are not kept as personal data.
 */
export async function recordEmailSuppression(address: string, reason: EmailSuppressionReason, db: Pool | PoolClient = getDatabase().pool): Promise<void> {
  await db.query(`DELETE FROM email_suppression WHERE NOT ${active}`);
  await db.query(`INSERT INTO email_suppression(address_hash,reason,keyed) VALUES($1,$2,true)
    ON CONFLICT (address_hash) DO UPDATE SET reason=EXCLUDED.reason, created_at=clock_timestamp()
    WHERE email_suppression.reason='complaint' AND EXCLUDED.reason='permanent-bounce'`, [emailAddressDigest(address), reason]);
}

/** Removes one address's suppression, keyed or legacy, and reports whether one was recorded. Callers authorize and audit. */
export async function deleteEmailSuppression(address: string, db: Pool | PoolClient): Promise<boolean> {
  return ((await db.query(`DELETE FROM email_suppression WHERE ${matches}`, [emailAddressDigest(address), legacyEmailAddressDigest(address)])).rowCount ?? 0) > 0;
}
