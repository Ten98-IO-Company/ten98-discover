import { createWorkspaceTeam, isTeamError } from '@ten98/runtime';
import { hashPassword } from 'better-auth/crypto';
import type { PoolClient } from 'pg';
import { FoundationError } from './auth.ts';
import { getDatabase } from './db.ts';

/** Discover's one shared team controller. Its lockEmail key (109859) is the one Discover has always used. */
export const team = createWorkspaceTeam({ hashPassword });

/** Maps a shared-controller refusal to Discover's error; anything else is rethrown unchanged. */
export function teamFailure(error: unknown): never {
  if (isTeamError(error)) throw new FoundationError(error.status, error.message);
  throw error;
}

/** Runs `run` in one READ COMMITTED transaction (the controller's locks need no 40001 retry there), rolling back on any error. */
export async function transaction<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getDatabase().pool.connect();
  try {
    await client.query('BEGIN');
    const result = await run(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    teamFailure(error);
  } finally { client.release(); }
}
