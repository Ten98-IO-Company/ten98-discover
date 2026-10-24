import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { FoundationError } from './auth.ts';
import { getDatabase } from './db.ts';
import { deleteEmailSuppression } from './email-suppression.ts';

export async function isInstanceOperator(userId: string): Promise<boolean> {
  const result = await getDatabase().pool.query('SELECT 1 FROM instance_operator WHERE user_id=$1', [userId]);
  return !!result.rowCount;
}

export async function requireInstanceOperator(client: PoolClient | Pool, userId: string): Promise<void> {
  const result = await client.query('SELECT user_id FROM instance_operator WHERE user_id=$1 FOR SHARE', [userId]);
  if (!result.rowCount) throw new FoundationError(403, 'This action requires an instance operator.');
}

/** Host CLI only. No HTTP endpoint grants operator authority from workspace ownership. */
export async function setInstanceOperator(email: unknown, enabled: boolean): Promise<void> {
  const result = z.string().trim().toLowerCase().email().max(254).safeParse(email);
  if (!result.success) throw new FoundationError(400, 'Supply the existing account email.');
  const client = await getDatabase().pool.connect();
  try {
    await client.query('BEGIN');
    const user = await client.query('SELECT id FROM "user" WHERE lower(email)=$1 FOR UPDATE', [result.data]);
    if (!user.rowCount) throw new FoundationError(404, 'No existing account has that email.');
    if (enabled) await client.query("INSERT INTO instance_operator(user_id,source) VALUES($1,'host') ON CONFLICT(user_id) DO NOTHING", [user.rows[0].id]);
    else await client.query('DELETE FROM instance_operator WHERE user_id=$1', [user.rows[0].id]);
    await client.query('INSERT INTO instance_operator_audit(user_id,action) VALUES($1,$2)', [user.rows[0].id, enabled ? 'grant' : 'revoke']);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
  finally { client.release(); }
}

/**
 * Host CLI only, inside the caller's transaction: resolves the named open account and holds its operator row. An unknown
 * or closed account gets the same refusal as a non-operator.
 */
export async function requireNamedInstanceOperator(client: PoolClient, email: unknown): Promise<string> {
  const result = z.string().trim().toLowerCase().email().max(254).safeParse(email);
  if (!result.success) throw new FoundationError(400, 'Supply the instance operator account email.');
  const user = (await client.query<{ id: string }>('SELECT id FROM "user" WHERE lower(email)=$1 AND closed_at IS NULL', [result.data])).rows[0];
  if (!user) throw new FoundationError(403, 'This action requires an instance operator.');
  await requireInstanceOperator(client, user.id);
  return user.id;
}

/**
 * Host CLI only (#310): the named instance operator clears one address's suppression in the transaction that audits the
 * clear by operator id. Neither the address nor its digest is logged or audited. Returns whether one was recorded.
 */
export async function clearEmailSuppressionAsOperator(operatorEmail: unknown, address: unknown): Promise<boolean> {
  const parsed = z.string().trim().email().max(254).safeParse(address);
  if (!parsed.success) throw new FoundationError(400, 'Supply the suppressed email address.');
  const client = await getDatabase().pool.connect();
  try {
    await client.query('BEGIN');
    const operatorId = await requireNamedInstanceOperator(client, operatorEmail);
    const cleared = await deleteEmailSuppression(parsed.data, client);
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
