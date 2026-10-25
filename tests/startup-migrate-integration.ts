import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import pg from 'pg';
import { createMigrationLedger } from '@ten98/runtime';
import { getConfig } from '../src/server/config.ts';
import { getDatabase, migrationFiles, migrationLedger, migrationLockKey } from '../src/server/db.ts';
import { migrateDatabase, StartupError, startWhenDatabaseReady, waitForCurrentSchema } from '../src/server/startup-migrate.ts';

// Creates its own fresh synthetic database beside the isolated local integration database and retains it for
// inspection; it never drops or reuses a database. The bad and slow migrations below exist only in a temporary
// directory passed as a function argument, so no production command or environment variable can load them.
export async function runStartupMigrateChecks() {
  assert.equal(process.env.TEN98_INTEGRATION_TEST, '1');
  const base = new URL(getConfig().databaseUrl);
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(base.hostname), 'Startup migration checks need a local database.');
  const name = `ten98_startup_${randomBytes(6).toString('hex')}`;
  await getDatabase().pool.query(`CREATE DATABASE ${name}`);
  const fresh = new URL(base);
  fresh.pathname = `/${name}`;
  // Two pools stand in for the web and worker processes; settings match the application pool.
  const pool = () => new pg.Pool({ connectionString: fresh.href, max: 3, connectionTimeoutMillis: 5_000, statement_timeout: 10_000 });
  const web = pool(), worker = pool();
  const log = () => {};
  const directory = await mkdtemp(join(tmpdir(), 'ten98-startup-migrate-'));
  const versions = async () => (await web.query<{ version: string }>('SELECT version FROM schema_version ORDER BY version')).rows.map(row => row.version);
  const expected = (await migrationLedger.sources()).map(migration => migration.version);
  try {
    // Concurrent start on a fresh database: one process applies everything, the other waits and finds nothing.
    const results = await Promise.all([migrateDatabase({ pool: web, log }), migrateDatabase({ pool: worker, log })]);
    const [applied, waited] = [...results].sort((a, b) => b.length - a.length);
    assert.deepEqual(applied, expected, 'One startup applies every migration once, in order.');
    assert.deepEqual(waited, [], 'The other startup waits for the lock and finds nothing pending.');
    assert.deepEqual(await versions(), expected);
    await migrationLedger.assertCurrent(worker);
    console.log(`PASS concurrent startup migration applies ${expected.length} migrations exactly once (${name})`);

    // Already current: a fast no-op, and the opt-out wait returns at once.
    const started = performance.now();
    assert.deepEqual(await migrateDatabase({ pool: web, log }), []);
    await waitForCurrentSchema({ pool: worker, timeoutMs: 2_000, log });
    assert.ok(performance.now() - started < 2_000, 'A current schema adds no material startup delay.');
    console.log('PASS startup on a current schema is a no-op');

    for (const file of migrationFiles) await copyFile(join(process.cwd(), 'migrations', file), join(directory, file));
    const withExtra = async (filename: string, sql: string) => {
      await writeFile(join(directory, filename), sql);
      return createMigrationLedger({ directory, files: [...migrationFiles, filename], lockKey: migrationLockKey });
    };
    const probeTable = async () => (await web.query<{ table: string | null }>("SELECT to_regclass('public.startup_failure_probe')::text AS table")).rows[0].table;

    // A failing pending migration: the startup rejects with a redacted error, never starts and applies nothing.
    const bad = await withExtra('9001_startup_failure_probe.sql', 'CREATE TABLE startup_failure_probe (id integer);\nINSERT INTO startup_failure_probe VALUES (1);\nSELECT 1 / 0;\n');
    let servedOrWorked = false;
    await assert.rejects(
      startWhenDatabaseReady('web', async () => { servedOrWorked = true; }, { env: {}, migrate: () => migrateDatabase({ pool: web, ledger: bad, log }), log }),
      (error: Error) => error instanceof StartupError && error.message.includes('22012') && error.message.includes('rolled back') && !error.message.includes(name),
    );
    assert.equal(servedOrWorked, false, 'A failed migration never reaches the server or worker start.');
    assert.deepEqual(await versions(), expected, 'No version is recorded for the failed migration.');
    assert.equal(await probeTable(), null, 'Nothing from the failed migration is partly applied.');
    const lock = await worker.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1, $2) AS locked', [...migrationLockKey]);
    assert.equal(lock.rows[0].locked, true, 'The failed migration released the lock.');
    await worker.query('SELECT pg_advisory_unlock($1, $2)', [...migrationLockKey]);
    await assert.rejects(waitForCurrentSchema({ pool: worker, ledger: bad, timeoutMs: 1_500, intervalMs: 200, log }), StartupError);
    console.log('PASS a failed startup migration rolls back, releases the lock and never starts');

    // A migration that outlives the deadline is abandoned: the startup fails and nothing commits.
    const slow = await withExtra('9001_startup_failure_probe.sql', 'CREATE TABLE startup_failure_probe (id integer);\nSELECT pg_sleep(3);\n');
    const slowStarted = performance.now();
    await assert.rejects(migrateDatabase({ pool: web, ledger: slow, timeoutMs: 1_000, log }), (error: Error) => error instanceof StartupError && error.message.includes('did not finish'));
    assert.ok(performance.now() - slowStarted < 2_900, 'The deadline stops the startup before the slow statement ends.');
    // The abandoned session keeps the lock until PostgreSQL notices it is gone; the next startup waits for it.
    assert.deepEqual(await migrateDatabase({ pool: worker, timeoutMs: 30_000, log }), []);
    assert.deepEqual(await versions(), expected);
    assert.equal(await probeTable(), null);
    console.log('PASS a timed-out startup migration fails and commits nothing');

    // A migration statement longer than the pool's statement_timeout still applies (#467). One connection makes the
    // follow-up request query reuse the migration's session, proving the pool timeout is back in force afterwards.
    const tight = new pg.Pool({ connectionString: fresh.href, max: 1, connectionTimeoutMillis: 5_000, statement_timeout: 500 });
    try {
      await assert.rejects(tight.query('SELECT pg_sleep(1)'), (error: { code?: string }) => error.code === '57014', 'The pool timeout cancels a slow request query.');
      const long = await withExtra('9002_startup_long_probe.sql', 'CREATE TABLE startup_long_probe (id integer);\nSELECT pg_sleep(1.5);\n');
      assert.deepEqual(await migrateDatabase({ pool: tight, ledger: long, timeoutMs: 30_000, log }), ['9002']);
      assert.equal((await web.query<{ table: string | null }>("SELECT to_regclass('public.startup_long_probe')::text AS table")).rows[0].table, 'startup_long_probe');
      await assert.rejects(tight.query('SELECT pg_sleep(1)'), (error: { code?: string }) => error.code === '57014', 'Request queries keep the pool timeout after migrating.');
    } finally {
      await tight.end();
    }
    console.log('PASS a migration statement longer than the pool statement_timeout applies; request queries keep the timeout');
  } finally {
    await Promise.all([web.end(), worker.end()]);
    await rm(directory, { recursive: true, force: true });
  }
}
