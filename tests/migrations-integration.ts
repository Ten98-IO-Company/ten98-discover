import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { hashPassword } from 'better-auth/crypto';
import { getConfig } from '../src/server/config.ts';
import { assertSchema, closeDatabase, getDatabase, migrationSource, migrationSources } from '../src/server/db.ts';

// This consumes a separate empty local database and retains its synthetic fixtures.
// It never drops a schema/database or clears existing data.
assert.equal(process.env.TEN98_INTEGRATION_TEST, '1', 'Set TEN98_INTEGRATION_TEST=1 for an isolated migration test database.');
const config = (() => {
  try { return getConfig(); }
  catch {
    console.error('Migration test configuration is invalid; credentials are redacted.');
    process.exit(1);
  }
})();
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(new URL(config.databaseUrl).hostname), 'Migration tests require a local database.');
const { pool } = getDatabase();
const checkout = process.cwd();
const cli = join(checkout, 'src/server/cli.ts');
let stage = 'empty-database safety check';
let brokenCheckout: string | undefined;

function runMigrate(expected: number, cwd = checkout) {
  const result = spawnSync(process.execPath, [cli, 'migrate'], { cwd, env: process.env, encoding: 'utf8', timeout: 45_000, maxBuffer: 512_000 });
  assert.equal(result.status, expected, `${stage}: migration CLI exit status`);
  for (const secret of [config.authSecret, config.bootstrapToken, config.databaseUrl]) {
    assert.ok(!(result.stdout + result.stderr).includes(secret), 'Migration output must not expose configuration secrets.');
  }
  return result.stdout + result.stderr;
}

async function history() {
  return (await pool.query<{ version: string; checksum: string }>('SELECT version, checksum FROM schema_version ORDER BY version')).rows;
}

async function schemaSnapshot() {
  const [columns, constraints, indexes] = await Promise.all([
    pool.query(`SELECT table_name, column_name, data_type, is_nullable, column_default
      FROM information_schema.columns WHERE table_schema = 'public' ORDER BY table_name, ordinal_position`),
    pool.query(`SELECT t.relname AS table_name, c.conname AS name, pg_get_constraintdef(c.oid) AS definition
      FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = 'public' ORDER BY t.relname, c.conname`),
    pool.query("SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' ORDER BY tablename, indexname"),
  ]);
  return { columns: columns.rows, constraints: constraints.rows, indexes: indexes.rows };
}

const fixtureTables = ['installation', 'user', 'account', 'session', 'workspace', 'membership', 'project', 'event'] as const;
async function records() {
  const snapshot: Record<string, Record<string, unknown>[]> = {};
  for (const table of fixtureTables) snapshot[table] = (await pool.query<{ data: Record<string, unknown> }>(`SELECT row_to_json(t) AS data FROM "${table}" t`)).rows.map((row) => row.data);
  return snapshot;
}

try {
  const existing = await pool.query(`SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f') LIMIT 1`);
  assert.equal(existing.rowCount, 0, 'Use a separate empty test database; existing schemas and data will not be modified.');
  const sources = await migrationSources();
  assert.deepEqual(sources.map(({ version }) => version), ['0001', '0002', '0003', '0004', '0005', '0006', '0007', '0008', '0009']);
  const foundation = await migrationSource();

  stage = 'seed original foundation schema and data';
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('CREATE TABLE schema_version(version text PRIMARY KEY, checksum text NOT NULL)');
    await client.query(foundation.sql);
    await client.query('INSERT INTO schema_version(version,checksum) VALUES($1,$2)', [foundation.version, foundation.checksum]);
    const userId = randomUUID(), workspaceId = randomUUID(), projectId = randomUUID();
    await client.query('INSERT INTO "user"(id,name,email) VALUES($1,$2,$3)', [userId, 'Preserved owner', `${userId}@migration.test`]);
    await client.query('INSERT INTO account(id,"accountId","providerId","userId",password) VALUES($1,$2,\'credential\',$2,$3)', [randomUUID(), userId, await hashPassword(randomBytes(24).toString('base64url'))]);
    await client.query('INSERT INTO session(id,token,"userId","expiresAt","userAgent") VALUES($1,$2,$3,clock_timestamp()+interval \'1 day\',$4)', [randomUUID(), randomBytes(32).toString('base64url'), userId, 'Migration fixture']);
    await client.query('INSERT INTO workspace(id,name) VALUES($1,$2)', [workspaceId, 'Preserved workspace']);
    await client.query("INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,'owner')", [workspaceId, userId]);
    await client.query('INSERT INTO project(id,workspace_id,name,origin,public_key) VALUES($1,$2,$3,$4,$5)', [projectId, workspaceId, 'Preserved site', 'https://migration.test', randomUUID()]);
    await client.query("INSERT INTO event(id,project_id,event_name,path) VALUES($1,$2,'page_view',$3)", [randomUUID(), projectId, '/preserved-page']);
    await client.query("UPDATE installation SET claimed = true WHERE id = 'instance'");
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
  const originalHistory = await history();
  const originalSchema = await schemaSnapshot();
  const originalRecords = await records();
  await assert.rejects(assertSchema(), { code: 'SCHEMA_MISMATCH' });

  stage = 'reject changed checksums without applying pending migrations';
  await pool.query('UPDATE schema_version SET checksum=$1 WHERE version=$2', ['deliberately-invalid-checksum', '0001']);
  try {
    assert.match(runMigrate(1), /schema is incompatible/);
    await assert.rejects(assertSchema(), { code: 'SCHEMA_MISMATCH' });
    assert.deepEqual(await history(), [{ version: '0001', checksum: 'deliberately-invalid-checksum' }]);
    assert.deepEqual(await schemaSnapshot(), originalSchema);
  } finally {
    await pool.query('UPDATE schema_version SET checksum=$1 WHERE version=$2', [foundation.checksum, '0001']);
  }

  stage = 'reject unknown future history';
  await pool.query('INSERT INTO schema_version(version,checksum) VALUES($1,$2)', ['9999', 'unknown-future-version']);
  try {
    assert.match(runMigrate(1), /schema is incompatible/);
    await assert.rejects(assertSchema(), { code: 'SCHEMA_MISMATCH' });
    assert.equal((await history()).length, 2);
    assert.deepEqual(await schemaSnapshot(), originalSchema);
  } finally { await pool.query('DELETE FROM schema_version WHERE version=$1', ['9999']); }

  stage = 'reject missing prior migration';
  await pool.query('UPDATE schema_version SET version=$1, checksum=$2 WHERE version=$3', ['0002', sources[1].checksum, '0001']);
  try {
    assert.match(runMigrate(1), /schema is incompatible/);
    await assert.rejects(assertSchema(), { code: 'SCHEMA_MISMATCH' });
    assert.deepEqual(await history(), [{ version: '0002', checksum: sources[1].checksum }]);
    assert.deepEqual(await schemaSnapshot(), originalSchema);
  } finally {
    await pool.query('UPDATE schema_version SET version=$1, checksum=$2 WHERE version=$3', ['0001', foundation.checksum, '0002']);
  }
  console.log('PASS changed checksum, future version and missing predecessor rejection');

  stage = 'all pending migrations roll back on a later SQL failure';
  brokenCheckout = await mkdtemp(join(tmpdir(), 'ten98-migrations-'));
  await mkdir(join(brokenCheckout, 'migrations'));
  for (const migration of sources) {
    await writeFile(join(brokenCheckout, 'migrations', migration.filename), migration.sql + (migration.version === sources.at(-1)!.version ? '\nSELECT 1 / 0;\n' : ''));
  }
  runMigrate(1, brokenCheckout);
  assert.deepEqual(await history(), originalHistory, 'A later failure must not commit an earlier pending migration.');
  assert.deepEqual(await schemaSnapshot(), originalSchema, 'All pending tables, indexes and constraints must roll back together.');
  assert.deepEqual(await records(), originalRecords, 'Failed migration must preserve original records.');
  console.log('PASS multi-migration transaction rollback');

  stage = 'upgrade original data and rerun idempotently';
  runMigrate(0);
  await assertSchema();
  const upgradedHistory = sources.map(({ version, checksum }) => ({ version, checksum }));
  assert.deepEqual(await history(), upgradedHistory);
  const upgradedRecords = await records();
  for (const table of fixtureTables) {
    assert.equal(upgradedRecords[table].length, originalRecords[table].length, `${table} record count must survive upgrade.`);
    for (let index = 0; index < originalRecords[table].length; index++) {
      const expected = originalRecords[table][index];
      const actual = Object.fromEntries(Object.keys(expected).map((key) => [key, upgradedRecords[table][index][key]]));
      assert.deepEqual(actual, expected, `${table} original fields must survive upgrade.`);
    }
  }
  for (const user of upgradedRecords.user) assert.equal(user.twoFactorEnabled, false, 'Existing accounts must not be enrolled in two-factor authentication automatically.');
  for (const session of upgradedRecords.session) assert.equal(session.oidcProviderId, null, 'Existing sessions must remain local sessions after upgrade.');
  for (const table of ['instance_operator', 'instance_operator_audit']) {
    assert.equal((await pool.query(`SELECT 1 FROM ${table}`)).rowCount, 0, 'Upgrade must not grant instance authority or record an implicit grant.');
  }
  const upgradedSchema = await schemaSnapshot();
  runMigrate(0);
  assert.deepEqual(await history(), upgradedHistory);
  assert.deepEqual(await schemaSnapshot(), upgradedSchema);
  assert.deepEqual(await records(), upgradedRecords);
  await assertSchema();
  console.log('PASS original owner, credentials, sessions, workspace, project and event preserved; no operator grants; repeat migration is idempotent');
  console.log('Migration integration checks passed. Synthetic fixtures remain in the isolated database.');
} catch {
  console.error(`Migration integration checks failed during: ${stage}.`);
  process.exitCode = 1;
} finally {
  await closeDatabase().catch(() => { console.error('Migration test database shutdown failed.'); process.exitCode = 1; });
  if (brokenCheckout) {
    const temporaryRoot = resolve(tmpdir()) + sep;
    assert.ok(resolve(brokenCheckout).startsWith(temporaryRoot) && basename(brokenCheckout).startsWith('ten98-migrations-'), 'Temporary migration fixture must stay inside its named temporary directory.');
    await rm(brokenCheckout, { recursive: true, force: true });
  }
}
