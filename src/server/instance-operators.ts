import type { Pool, PoolClient } from 'pg';
import { FoundationError } from './auth.ts';
import { getDatabase } from './db.ts';
import { deleteEmailSuppression } from './email-suppression.ts';
import { team, teamFailure, transaction } from './workspace-team.ts';

// Thin adapters over the shared controller: closed accounts never count as operators, and grants and revocations are
// audited only when they change something.

/** Keeps Discover's own invalid-email wording for the host CLI (the controller's only 400 here is invalid input). */
const named = (message: string) => (error: unknown): never => {
  throw error instanceof FoundationError && error.status === 400 ? new FoundationError(400, message) : error;
};

export const isInstanceOperator = (userId: string): Promise<boolean> => team.isInstanceOperator(getDatabase().pool, userId).catch(teamFailure);

export const requireInstanceOperator = (client: PoolClient | Pool, userId: string): Promise<void> => team.requireInstanceOperator(client, userId).catch(teamFailure);

/** Host CLI only. No HTTP endpoint grants operator authority from workspace ownership. */
export const setInstanceOperator = (email: unknown, enabled: boolean): Promise<void> =>
  transaction(client => team.setInstanceOperator(client, email, enabled)).catch(named('Supply the existing account email.'));

/**
 * Host CLI only, inside the caller's transaction: resolves the named open account and holds its operator row. An unknown
 * or closed account gets the same refusal as a non-operator.
 */
export const requireNamedInstanceOperator = (client: PoolClient, email: unknown): Promise<string> =>
  team.requireNamedInstanceOperator(client, email).catch(teamFailure).catch(named('Supply the instance operator account email.'));

/**
 * Host CLI only (#310): the named instance operator clears one address's suppression in the transaction that audits the
 * clear by operator id. Neither the address nor its digest is logged or audited. Returns whether one was recorded.
 */
export async function clearEmailSuppressionAsOperator(operatorEmail: unknown, address: unknown): Promise<boolean> {
  // Deliberately looser than an email validator: SES can report addresses (quoted or unusual local parts) that strict
  // validation rejects, and those must stay clearable. The suppression digest trims and lowercases the same value.
  const value = typeof address === 'string' ? address.trim() : '';
  const parts = value.split('@');
  if (value.length > 320 || parts.length !== 2 || !parts[0] || !parts[1]) throw new FoundationError(400, 'Supply the suppressed email address.');
  const client = await getDatabase().pool.connect();
  try {
    await client.query('BEGIN');
    const operatorId = await requireNamedInstanceOperator(client, operatorEmail);
    const cleared = await deleteEmailSuppression(value, client);
    await client.query("INSERT INTO instance_operator_audit(user_id,action) VALUES($1,'email_suppression_clear')", [operatorId]);
    await client.query('COMMIT');
    return cleared;
  } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
  finally { client.release(); }
}

/**
 * Host CLI only: the named account must be an instance operator, and the paid-work export of `scope` is audited and
 * committed before any archived row is read. An unknown or closed account gets the same refusal as a non-operator.
 */
export async function auditOperatorPaidWorkExport(email: unknown, scope: { workspaceId: string; projectId?: string }): Promise<void> {
  const client = await getDatabase().pool.connect();
  try {
    await client.query('BEGIN');
    const userId = await requireNamedInstanceOperator(client, email);
    await client.query("INSERT INTO instance_operator_audit(user_id,action,scope) VALUES($1,'paid_work_export',$2)",
      [userId, `workspace:${scope.workspaceId}${scope.projectId === undefined ? '' : `/website:${scope.projectId}`}`]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
  finally { client.release(); }
}
