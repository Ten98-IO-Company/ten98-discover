import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import type pg from 'pg';
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

type Ledger = NonNullable<MigrationOptions['ledger']>;
type RunnerOptions = Parameters<Ledger['migrateWithDeadline']>[1];
const pool = {} as pg.Pool;
const runnerError = (code: string, message: string) => Object.assign(new Error(message), { code });
/** A ledger whose shared runner is scripted; the runner's own lock, deadline and timeout lift are tested in @ten98/runtime and tests/startup-migrate-integration.ts. */
function ledger(run: (options: RunnerOptions) => Promise<readonly string[]>, wait: Ledger['waitForCurrent'] = async () => {}) {
  const seen: { pool?: unknown; options?: RunnerOptions; waitPool?: unknown; waitOptions?: Parameters<Ledger['waitForCurrent']>[1] } = {};
  const fake: Ledger = {
    migrateWithDeadline: async (target, options) => { seen.pool = target; seen.options = options; return run(options); },
    waitForCurrent: async (target, options) => { seen.waitPool = target; seen.waitOptions = options; return wait(target, options); },
  };
  return { fake, seen };
}

test('migration delegates to the shared deadline runner with the five-minute default', async () => {
  const ok = ledger(async () => ['0072']);
  assert.deepEqual(await migrateDatabase({ pool, ledger: ok.fake, log: quiet }), ['0072']);
  assert.equal(ok.seen.pool, pool);
  assert.equal(ok.seen.options?.timeoutMs, 5 * 60_000);
  assert.equal(ok.seen.options?.log, quiet);
  assert.equal(typeof ok.seen.options?.afterApply, 'function', 'Provider account identity capture runs inside the migration transaction.');
  const quick = ledger(async () => []);
  await migrateDatabase({ pool, ledger: quick.fake, timeoutMs: 1_000, log: quiet });
  assert.equal(quick.seen.options?.timeoutMs, 1_000);
  // afterApply only touches the database when 0022 or 0023 was applied.
  await ok.seen.options!.afterApply!({ query: async () => { throw new Error('unexpected query'); } }, ['0072']);
});

test('runner failures become redacted startup errors and a schema mismatch passes through', async () => {
  await assert.rejects(migrateDatabase({ pool, ledger: ledger(async () => { throw runnerError('MIGRATION_FAILED', 'Database migration failed (PostgreSQL error 42601) and was rolled back; nothing was applied.'); }).fake, log: quiet }),
    (error: Error) => error instanceof StartupError && error.message.includes('42601') && error.message.includes('rolled back') && error.message.includes('migrate command'));
  await assert.rejects(migrateDatabase({ pool, ledger: ledger(async () => { throw runnerError('MIGRATION_TIMEOUT', 'Database migrations did not finish within 1 seconds; the migration transaction was abandoned and rolls back.'); }).fake, log: quiet }),
    (error: Error) => error instanceof StartupError && error.message.includes('did not finish'));
  const schemaError = runnerError('SCHEMA_MISMATCH', 'incompatible');
  await assert.rejects(migrateDatabase({ pool, ledger: ledger(async () => { throw schemaError; }).fake, log: quiet }), schemaError);
});

test('the opt-out schema wait delegates to the shared poller and fails as a startup error', async () => {
  const current = ledger(async () => []);
  await waitForCurrentSchema({ pool, ledger: current.fake, timeoutMs: 5_000, intervalMs: 7, log: quiet });
  assert.equal(current.seen.waitPool, pool);
  assert.deepEqual(current.seen.waitOptions, { timeoutMs: 5_000, intervalMs: 7, log: quiet });
  const late = ledger(async () => [], async () => { throw runnerError('MIGRATION_TIMEOUT', 'The database schema was not current within 1 seconds.'); });
  await assert.rejects(waitForCurrentSchema({ pool, ledger: late.fake, timeoutMs: 30, intervalMs: 5, log: quiet }),
    (error: Error) => error instanceof StartupError && !error.message.includes('schema_version'));
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
