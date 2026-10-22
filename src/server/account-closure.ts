import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { FoundationError } from './auth.ts';
import { accountClosureInventory, type ClosureParameter } from './account-closure-inventory.ts';
import { emailLimitKey, emailLimitScopes } from './client-rate-limit.ts';
import { cancelQueuedProbes } from './jobs.ts';

/** Account closure (docs/account-closure.md): a tombstone, not erasure. App-owned identity layer. */
export type ClosureActor = { kind: 'self'; userId: string } | { kind: 'operator'; userId: string; reason: string };
/** Evidence that `userId` completed step-up earlier in the same transaction (account-security.ts creates it). */
export type StepUpProof = { readonly userId: string; readonly method: 'password' | 'oidc' | 'host' };
export type ClosureBlockers = { workspaces: { id: string; name: string }[]; lastOperator: boolean };

export const closureReasonInput = z.string().trim().min(1).max(500);
export const closedAccountName = 'Closed account';

export class AccountClosureBlocked extends FoundationError {
  readonly blockers: ClosureBlockers;
  constructor(blockers: ClosureBlockers) {
    super(409, blockers.lastOperator && !blockers.workspaces.length
      ? 'This is the last instance operator. Grant the role to another account before closing this one.'
      : 'This account is the last owner of a workspace. Transfer ownership of each listed workspace, or delete it, before closing the account.'
        + (blockers.lastOperator ? ' It is also the last instance operator: grant the role to another account first.' : ''));
    this.blockers = blockers;
  }
}

/** Workspaces where the account is the only owner, and whether it holds the only operator role. Read-only. */
export async function closureBlockers(client: Pick<PoolClient, 'query'>, userId: string): Promise<ClosureBlockers> {
  const workspaces = await client.query<{ id: string; name: string }>(
    `SELECT w.id,w.name FROM membership m JOIN workspace w ON w.id=m.workspace_id
     WHERE m.user_id=$1 AND m.role='owner'
       AND NOT EXISTS (SELECT 1 FROM membership o WHERE o.workspace_id=m.workspace_id AND o.role='owner' AND o.user_id<>$1)
     ORDER BY w.name,w.id`, [userId]);
  const operator = await client.query<{ last: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM instance_operator WHERE user_id=$1)
       AND NOT EXISTS (SELECT 1 FROM instance_operator WHERE user_id<>$1) AS last`, [userId]);
  return { workspaces: workspaces.rows, lastOperator: operator.rows[0].last };
}

/**
 * Closes `userId` inside the caller's transaction, which already holds `proof` for the actor. On any refusal or error
 * the caller rolls back, so nothing changes. Lock order: account row, then its workspaces by id, its memberships, then
 * the operator set. ponytail: the owner's own two-factor-requirement toggle locks workspace before user, so a closure
 * racing it can deadlock; PostgreSQL aborts one transaction and nothing commits. Upgrade path: lock the account first
 * there too.
 */
export async function closeAccount(client: PoolClient, userId: string, actor: ClosureActor, proof: StepUpProof): Promise<{ closedAt: Date }> {
  if (proof.userId !== actor.userId) throw new FoundationError(403, 'Verify your identity before closing an account.');
  if (actor.kind === 'self' && actor.userId !== userId) throw new FoundationError(403, 'You can close only your own account.');
  if (actor.kind === 'operator' && actor.userId === userId) throw new FoundationError(400, 'Close your own account from Account security.');
  const reason = actor.kind === 'operator' ? closureReasonInput.safeParse(actor.reason) : null;
  if (reason && !reason.success) throw new FoundationError(400, 'Record a reason between 1 and 500 characters.');

  const target = (await client.query<{ email: string; closed_at: Date | null }>('SELECT email,closed_at FROM "user" WHERE id=$1 FOR UPDATE', [userId])).rows[0];
  if (!target) throw new FoundationError(404, 'Account not found.');
  if (target.closed_at) throw new FoundationError(409, 'This account is already closed.');
  // With the account locked, no new membership can commit for it (the 0070 trigger waits on this row lock).
  const workspaceIds = (await client.query<{ workspace_id: string }>('SELECT workspace_id FROM membership WHERE user_id=$1', [userId])).rows.map((row) => row.workspace_id);
  await client.query('SELECT id FROM workspace WHERE id=ANY($1::text[]) ORDER BY id FOR UPDATE', [workspaceIds]);
  await client.query('SELECT workspace_id FROM membership WHERE user_id=$1 ORDER BY workspace_id FOR UPDATE', [userId]);
  const operators = (await client.query<{ user_id: string }>('SELECT user_id FROM instance_operator ORDER BY user_id FOR UPDATE')).rows.map((row) => row.user_id);
  if (actor.kind === 'operator' && !operators.includes(actor.userId)) throw new FoundationError(403, 'This action requires an instance operator.');
  const blockers = await closureBlockers(client, userId);
  if (blockers.workspaces.length || blockers.lastOperator) throw new AccountClosureBlocked(blockers);

  const email = target.email.toLowerCase();
  const values: Record<ClosureParameter, unknown> = { userId, email, emailLimitKeys: emailLimitScopes.map((scope) => emailLimitKey(scope, email)) };
  await cancelQueuedProbes(client, userId);
  for (const entry of accountClosureInventory) if (entry.sql) await client.query(entry.sql, (entry.params ?? []).map((name) => values[name]));
  if (operators.includes(userId)) await client.query("INSERT INTO instance_operator_audit(user_id,action) VALUES($1,'revoke')", [userId]);
  // A fresh random address: nothing derived from the previous email survives.
  const closed = await client.query<{ closed_at: Date }>(
    `UPDATE "user" SET name=$2,email=$3,image=NULL,"emailVerified"=false,"twoFactorEnabled"=false,closed_at=clock_timestamp(),"updatedAt"=clock_timestamp()
     WHERE id=$1 RETURNING closed_at`, [userId, closedAccountName, `closed-${randomUUID()}@invalid`]);
  await client.query('INSERT INTO account_closure_audit(user_id,actor_user_id,kind,reason) VALUES($1,$2,$3,$4)',
    [userId, actor.userId, actor.kind, reason?.success ? reason.data : null]);
  return { closedAt: closed.rows[0].closed_at };
}
