import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { getDatabase } from './db.ts';

/** Reasons that block transactional sends (#304). Transient and undetermined bounces never do. */
export type EmailSuppressionReason = 'permanent-bounce' | 'complaint';

/**
 * Suppressions are keyed by an unkeyed SHA-256 of the lowercased address, like the per-address rate-limit keys, so the
 * table holds no address text. Lowercasing the local part too errs towards blocking a case variant of a bounced address.
 * An unkeyed digest is derivable by anyone who knows the address, so it is personal data, not anonymisation.
 * ponytail: suppression is permanent and has no operator clear or expiry; removing a row takes SQL. A clear/expiry
 * operation is the upgrade path.
 */
export function emailAddressDigest(address: string): string {
  return createHash('sha256').update(address.trim().toLowerCase()).digest('hex');
}

export async function isEmailSuppressed(address: string, db: Pool | PoolClient = getDatabase().pool): Promise<boolean> {
  return (await db.query('SELECT 1 FROM email_suppression WHERE address_hash=$1', [emailAddressDigest(address)])).rowCount === 1;
}

/** Idempotent: SNS delivers at least once, and the first recorded reason is kept. */
export async function recordEmailSuppression(address: string, reason: EmailSuppressionReason, db: Pool | PoolClient = getDatabase().pool): Promise<void> {
  await db.query('INSERT INTO email_suppression(address_hash,reason) VALUES($1,$2) ON CONFLICT (address_hash) DO NOTHING', [emailAddressDigest(address), reason]);
}
