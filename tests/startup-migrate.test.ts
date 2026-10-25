import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import type pg from 'pg';
import { migrationLockKey } from '../src/server/db.ts';
import { migrateDatabase, migrateOnStart, StartupError, startWhenDatabaseReady, waitForCurrentSchema, type MigrationOptions } from '../src/server/startup-migrate.ts';

const quiet = () => {};

test('MIGRATE_ON_START defaults on and accepts only explicit booleans', () => {
  for (const value of [undefined, '', 'true', 'TRUE', ' 1 ']) assert.equal(migrateOnStart({ MIGRATE_ON_START: value }), true, String(value));
  for (const value of ['false', 'False', '0']) assert.equal(migrateOnStart({ MIGRATE_ON_START: value }), false, value);
  for (const value of ['no', 'off', 'yes', '2']) assert.throws(() => migrateOnStart({ MIGRATE_ON_START: value }), StartupError);
});

function recorder() {
  const calls: string[] = [];
  return {
    calls,
    migrate: async () => { calls.push('migrate'); return ['0072']; },
    waitForSchema: async () => { calls.push('wait'); },
    start: async () => { calls.push('start'); },
  };
}

test('startup migrates before starting by default and only waits when opted out', async () => {
  const on = recorder();
  await startWhenDatabaseReady('web', on.start, { env: {}, migrate: on.migrate, waitForSchema: on.waitForSchema, log: quiet });
  assert.deepEqual(on.calls, ['migrate', 'start']);
  const off = recorder();
  await startWhenDatabaseReady('worker', off.start, { env: { MIGRATE_ON_START: 'false' }, migrate: off.migrate, waitForSchema: off.waitForSchema, log: quiet });
  assert.deepEqual(off.calls, ['wait', 'start']);
});

test('a failed migration, schema wait or invalid opt-out never starts the role', async () => {
  const failed = recorder();
  await assert.rejects(startWhenDatabaseReady('web', failed.start, { env: {}, migrate: async () => { throw new StartupError('failed'); }, waitForSchema: failed.waitForSchema, log: quiet }), StartupError);
  assert.deepEqual(failed.calls, []);
  const waited = recorder();
  await assert.rejects(startWhenDatabaseReady('worker', waited.start, { env: { MIGRATE_ON_START: '0' }, migrate: waited.migrate, waitForSchema: async () => { throw new StartupError('late'); }, log: quiet }), StartupError);
  assert.deepEqual(waited.calls, []);
  const invalid = recorder();
  await assert.rejects(startWhenDatabaseReady('web', invalid.start, { env: { MIGRATE_ON_START: 'maybe' }, migrate: invalid.migrate, waitForSchema: invalid.waitForSchema, log: quiet }), StartupError);
  assert.deepEqual(invalid.calls, []);
});

test('the opt-out schema wait resolves once current and fails at its deadline', async () => {
  let polls = 0;
  const becomesCurrent = { assertCurrent: async () => { if (++polls < 3) throw Object.assign(new Error('pending'), { code: 'SCHEMA_MISMATCH' }); }, migrate: async () => [] };
  await waitForCurrentSchema({ pool: {} as pg.Pool, ledger: becomesCurrent, timeoutMs: 5_000, intervalMs: 1, log: quiet });
  assert.equal(polls, 3);
  const never = { assertCurrent: async () => { throw new Error('relation "schema_version" does not exist'); }, migrate: async () => [] };
  const logs: string[] = [];
  await assert.rejects(waitForCurrentSchema({ pool: {} as pg.Pool, ledger: never, timeoutMs: 30, intervalMs: 5, log: message => logs.push(message) }),
    (error: Error) => error instanceof StartupError && !error.message.includes('schema_version'));
  assert.ok(logs.length >= 1, 'The wait logs its progress.');
});

/** A fake pool whose clients record SQL; `locked` decides pg_try_advisory_lock. */
function fakePool({ locked = true, connectFails = false } = {}) {
  const sql: string[] = [];
  const releases: (Error | boolean | undefined)[] = [];
  const pool = {
    connect: async () => {
      if (connectFails) throw Object.assign(new Error('connect ECONNREFUSED postgres://user:secret@db'), { code: 'ECONNREFUSED' });
      return {
        query: async (text: string, params?: unknown[]) => {
          sql.push(text);
          if (text.includes('advisory')) assert.deepEqual(params, [...migrationLockKey]);
          return { rows: text.includes('pg_try_advisory_lock') ? [{ locked }] : [] };
        },
        release: (error?: Error | boolean) => { releases.push(error); },
      };
    },
  } as unknown as pg.Pool;
  return { pool, sql, releases };
}
type Ledger = NonNullable<MigrationOptions['ledger']>;
const ledger = (migrate: Ledger['migrate']): Ledger => ({ migrate, assertCurrent: async () => {} });

test('migration holds the well-known session lock and releases it after success or failure', async () => {
  const ok = fakePool();
  assert.deepEqual(await migrateDatabase({ pool: ok.pool, ledger: ledger(async () => ['0072']), timeoutMs: 1_000, log: quiet }), ['0072']);
  // The pool statement_timeout is lifted only around the migration and restored before the connection returns (#467).
  assert.deepEqual(ok.sql, ['SELECT pg_try_advisory_lock($1, $2) AS locked', 'SET statement_timeout = 0', 'RESET statement_timeout', 'SELECT pg_advisory_unlock($1, $2)']);
  assert.deepEqual(ok.releases, [undefined]);

  const failed = fakePool();
  const sqlError = Object.assign(new Error('syntax error at "secret-value"'), { code: '42601' });
  await assert.rejects(migrateDatabase({ pool: failed.pool, ledger: ledger(async () => { throw sqlError; }), timeoutMs: 1_000, log: quiet }),
    (error: Error) => error instanceof StartupError && error.message.includes('42601') && error.message.includes('rolled back') && !error.message.includes('secret'));
  assert.deepEqual(failed.sql.slice(-2), ['RESET statement_timeout', 'SELECT pg_advisory_unlock($1, $2)']);
  assert.equal(failed.releases.length, 1);

  const mismatch = fakePool();
  const schemaError = Object.assign(new Error('incompatible'), { code: 'SCHEMA_MISMATCH' });
  await assert.rejects(migrateDatabase({ pool: mismatch.pool, ledger: ledger(async () => { throw schemaError; }), timeoutMs: 1_000, log: quiet }), schemaError);
});

test('a held lock or unavailable database fails at the deadline with a redacted error', async () => {
  const held = fakePool({ locked: false });
  const logs: string[] = [];
  let migrated = false;
  await assert.rejects(migrateDatabase({ pool: held.pool, ledger: ledger(async () => { migrated = true; return []; }), timeoutMs: 20, log: message => logs.push(message) }),
    (error: Error) => error instanceof StartupError && error.message.includes('another process'));
  assert.equal(migrated, false);
  assert.match(logs[0], /another process/);
  const down = fakePool({ connectFails: true });
  await assert.rejects(migrateDatabase({ pool: down.pool, ledger: ledger(async () => []), timeoutMs: 20, log: quiet }),
    (error: Error) => error instanceof StartupError && !error.message.includes('secret') && !error.message.includes('postgres://'));
});

test('a migration that outlives the deadline is abandoned and fails', async () => {
  const slow = fakePool();
  await assert.rejects(migrateDatabase({ pool: slow.pool, ledger: ledger(() => new Promise((_resolve, reject) => setTimeout(() => reject(new Error('Connection terminated')), 60))), timeoutMs: 20, log: quiet }),
    (error: Error) => error instanceof StartupError && error.message.includes('did not finish'));
  assert.equal(slow.releases.length, 1);
  assert.ok(slow.releases[0] instanceof Error, 'The timed-out connection is discarded, never returned to the pool.');
});

test('the image starts web through start-web and the CLI wires the opt-out before any database access', async () => {
  const dockerfile = await readFile(new URL('../Dockerfile', import.meta.url), 'utf8');
  assert.match(dockerfile, /^CMD \["node", "src\/server\/cli\.ts", "start-web"\]$/m);
  const compose = await readFile(new URL('../compose.yaml', import.meta.url), 'utf8');
  assert.match(compose, /MIGRATE_ON_START: \$\{MIGRATE_ON_START:-true\}/);
  assert.match(compose, /command: \["node", "src\/server\/cli\.ts", "worker"\]/);
  // An invalid opt-out stops start-web before configuration, database or server loading; no listener starts.
  const env = { ...process.env, MIGRATE_ON_START: 'maybe', DATABASE_URL: 'postgres://user:secret@127.0.0.1:1/none' };
  for (const command of ['start-web', 'worker']) {
    const result = spawnSync(process.execPath, ['src/server/cli.ts', command], { env, encoding: 'utf8', timeout: 30_000 });
    assert.equal(result.status, 1, command);
    assert.match(result.stderr, /MIGRATE_ON_START must be true or false\./);
    assert.doesNotMatch(result.stdout + result.stderr, /secret/);
  }
});
