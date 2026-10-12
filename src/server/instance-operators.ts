import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { FoundationError } from './auth.ts';
import { getDatabase } from './db.ts';

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
