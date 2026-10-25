import type pg from 'pg';
import { migrateOnStart as migrateOnStartSetting } from '@ten98/runtime';
import { getDatabase, migrationLedger } from './db.ts';
import { initializeProviderAccountIdentity } from './provider-account-identity.ts';

// Web and worker apply pending migrations themselves before serving or working (MIGRATE_ON_START, default on).
// The shared runner holds the database's one advisory lock, so only one process migrates at a time; the others wait
// for the lock and then find nothing pending. It lifts the pool's statement_timeout for the migration only (#467).
// No provider or other external request is made here.

/** Bound for the connect, the lock wait plus the migration, and for the opt-out schema wait. */
export const startupMigrationTimeoutMs = 5 * 60_000;

/** Startup failures carry operator-safe text only: never SQL, parameters, connection strings or credentials. */
export class StartupError extends Error {}

type Ledger = Pick<typeof migrationLedger, 'migrateWithDeadline' | 'waitForCurrent'>;
type Log = (message: string) => void;
/** `ledger` exists only so integration tests can supply extra migrations; no command, file or environment variable sets it. */
export type MigrationOptions = { pool?: pg.Pool; ledger?: Ledger; timeoutMs?: number; log?: Log };

/** MIGRATE_ON_START: unset, empty, `true` or `1` migrates at startup; `false` or `0` waits for an operator migration. */
export function migrateOnStart(env: NodeJS.ProcessEnv = process.env): boolean {
  try { return migrateOnStartSetting(env.MIGRATE_ON_START); }
  catch { throw new StartupError('MIGRATE_ON_START must be true or false.'); }
}

const fixCause = 'Fix the cause, then restart or run the migrate command.';

/**
 * Maps a runner failure to operator-safe text. MIGRATION_TIMEOUT carries the runner's fixed deadline text,
 * MIGRATION_FAILED is rebuilt from its validated SQLSTATE, SCHEMA_MISMATCH passes through, and anything else (such as
 * a connection error naming the database URL) becomes the generic message.
 */
function startupError(error: unknown, generic: string): unknown {
  const { code, sqlState } = (error ?? {}) as { code?: unknown; sqlState?: unknown };
  if (code === 'SCHEMA_MISMATCH') return error;
  if (code === 'MIGRATION_TIMEOUT') return new StartupError((error as Error).message);
  if (code === 'MIGRATION_FAILED') {
    const state = typeof sqlState === 'string' && /^[0-9A-Z]{5}$/.test(sqlState) ? ` (PostgreSQL error ${sqlState})` : '';
    return new StartupError(`Database migration failed${state} and was rolled back; nothing was applied. ${fixCause}`);
  }
  return new StartupError(generic);
}

/**
 * Applies pending migrations in the ledger's single transaction. `cli.ts migrate` and both startup paths use this one
 * routine. A failure or timeout rolls the transaction back and rejects with a redacted StartupError.
 */
export async function migrateDatabase({ pool = getDatabase().pool, ledger = migrationLedger, timeoutMs = startupMigrationTimeoutMs, log = console.log }: MigrationOptions = {}): Promise<readonly string[]> {
  try {
    return await ledger.migrateWithDeadline(pool, {
      timeoutMs, log,
      // Identity guards inspect every financial-reference table, so key capture runs after all pending tables exist
      // and inside the same migration transaction.
      afterApply: async (client, versions) => {
        if (versions.includes('0022') || versions.includes('0023')) await initializeProviderAccountIdentity(client as pg.PoolClient, versions.includes('0022'));
      },
    });
  } catch (error) { throw startupError(error, `Database migration failed and was rolled back; nothing was applied. ${fixCause}`); }
}

/** Opt-out path: polls the schema check (no writes) until it is current, or fails at the deadline. */
export async function waitForCurrentSchema({ pool = getDatabase().pool, ledger = migrationLedger, timeoutMs = startupMigrationTimeoutMs, log = console.log, intervalMs = 2_000 }: MigrationOptions & { intervalMs?: number } = {}): Promise<void> {
  try { await ledger.waitForCurrent(pool, { timeoutMs, intervalMs, log }); }
  catch (error) { throw startupError(error, 'The database schema could not be checked. Run the migrate command, or leave MIGRATE_ON_START enabled.'); }
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
