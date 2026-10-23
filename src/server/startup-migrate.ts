import { setTimeout as delay } from 'node:timers/promises';
import type pg from 'pg';
import { getDatabase, migrationLedger, migrationLockKey } from './db.ts';
import { initializeProviderAccountIdentity } from './provider-account-identity.ts';

// Web and worker apply pending migrations themselves before serving or working (MIGRATE_ON_START, default on).
// Every migration path holds the database's one advisory lock, so only one process migrates at a time; the others
// wait for the lock and then find nothing pending. No provider or other external request is made here.

/** Bound for the lock wait plus the migration, and for the opt-out schema wait. */
export const startupMigrationTimeoutMs = 5 * 60_000;
const progressIntervalMs = 15_000;
const retryIntervalMs = 1_000;

/** Startup failures carry operator-safe text only: never SQL, parameters, connection strings or credentials. */
export class StartupError extends Error {}

type Ledger = Pick<typeof migrationLedger, 'migrate' | 'assertCurrent'>;
type Log = (message: string) => void;
/** `ledger` exists only so integration tests can supply extra migrations; no command, file or environment variable sets it. */
export type MigrationOptions = { pool?: pg.Pool; ledger?: Ledger; timeoutMs?: number; log?: Log };

/** MIGRATE_ON_START: unset, empty, `true` or `1` migrates at startup; `false` or `0` waits for an operator migration. */
export function migrateOnStart(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.MIGRATE_ON_START?.trim().toLowerCase();
  if (value === undefined || value === '' || value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  throw new StartupError('MIGRATE_ON_START must be true or false.');
}

const seconds = (ms: number) => `${Math.round(ms / 1000)} seconds`;

/** Connects and takes the session advisory lock, retrying an unavailable database or a held lock until the deadline. */
async function lockForMigration(pool: pg.Pool, deadline: number, timeoutMs: number, log: Log): Promise<pg.PoolClient> {
  let nextLog = 0;
  for (;;) {
    let client: pg.PoolClient | undefined;
    let waiting = 'the database to accept connections';
    try {
      client = await pool.connect();
      const { rows } = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1, $2) AS locked', [...migrationLockKey]);
      if (rows[0]?.locked) return client;
      client.release();
      waiting = 'another process to finish database migrations';
    } catch {
      client?.release(true);
    }
    if (Date.now() >= deadline) throw new StartupError(`Database migrations could not start within ${seconds(timeoutMs)} while waiting for ${waiting}. Nothing was applied.`);
    if (Date.now() >= nextLog) { log(`Waiting for ${waiting} before applying database migrations.`); nextLog = Date.now() + progressIntervalMs; }
    await delay(Math.min(retryIntervalMs, Math.max(0, deadline - Date.now())));
  }
}

/**
 * Applies pending migrations in the ledger's single transaction. `cli.ts migrate` and both startup paths use this one
 * routine. A failure or timeout rolls the transaction back and rejects with a redacted StartupError.
 */
export async function migrateDatabase({ pool = getDatabase().pool, ledger = migrationLedger, timeoutMs = startupMigrationTimeoutMs, log = console.log }: MigrationOptions = {}): Promise<readonly string[]> {
  const deadline = Date.now() + timeoutMs;
  const client = await lockForMigration(pool, deadline, timeoutMs, log);
  let released = false, timedOut = false;
  const release = (error?: Error) => { if (!released) { released = true; client.release(error); } };
  // Closing the dedicated connection aborts the in-flight statement's transaction; it can never reach COMMIT.
  const timer = setTimeout(() => { timedOut = true; release(new Error('Migration deadline reached.')); }, Math.max(0, deadline - Date.now()));
  try {
    // Identity guards inspect every financial-reference table, so key capture runs after all pending tables exist
    // and inside the same migration transaction.
    return await ledger.migrate(client, {
      afterApply: async (_client, versions) => {
        if (versions.includes('0022') || versions.includes('0023')) await initializeProviderAccountIdentity(client, versions.includes('0022'));
      },
    });
  } catch (error) {
    if (timedOut) throw new StartupError(`Database migrations did not finish within ${seconds(timeoutMs)}; the migration transaction was abandoned and rolls back.`);
    if ((error as { code?: string })?.code === 'SCHEMA_MISMATCH') throw error;
    const code = (error as { code?: unknown })?.code;
    const sqlState = typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? ` (PostgreSQL error ${code})` : '';
    throw new StartupError(`Database migration failed${sqlState} and was rolled back; nothing was applied. Fix the cause, then restart or run the migrate command.`);
  } finally {
    clearTimeout(timer);
    if (!released) {
      try { await client.query('SELECT pg_advisory_unlock($1, $2)', [...migrationLockKey]); release(); }
      catch { release(new Error('Migration lock release failed.')); } // Discarding the session also releases its lock.
    }
  }
}

/** Opt-out path: polls the schema check (no writes) until it is current, or fails at the deadline. */
export async function waitForCurrentSchema({ pool = getDatabase().pool, ledger = migrationLedger, timeoutMs = startupMigrationTimeoutMs, log = console.log, intervalMs = 2_000 }: MigrationOptions & { intervalMs?: number } = {}): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let nextLog = 0;
  for (;;) {
    try { await ledger.assertCurrent(pool); return; } catch { /* Not migrated yet, or the database is still starting. */ }
    if (Date.now() >= deadline) throw new StartupError(`The database schema was not current within ${seconds(timeoutMs)}. Run the migrate command, or leave MIGRATE_ON_START enabled.`);
    if (Date.now() >= nextLog) { log('MIGRATE_ON_START=false: waiting for an operator to apply database migrations.'); nextLog = Date.now() + progressIntervalMs; }
    await delay(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
  }
}

export type StartupRole = 'web' | 'worker';
export type StartupDependencies = { env?: NodeJS.ProcessEnv; migrate?: () => Promise<readonly string[]>; waitForSchema?: () => Promise<void>; log?: Log };

/** Brings the schema current (or waits for it), then starts the role. A rejection means `start` never ran. */
export async function startWhenDatabaseReady(role: StartupRole, start: () => Promise<void>, { env = process.env, migrate = migrateDatabase, waitForSchema = waitForCurrentSchema, log = console.log }: StartupDependencies = {}): Promise<void> {
  if (migrateOnStart(env)) {
    const applied = await migrate();
    log(applied.length ? `Database migrations applied before ${role} start: ${applied.join(', ')}.` : `Database schema is current; ${role} starting.`);
  } else {
    await waitForSchema();
  }
  await start();
}
