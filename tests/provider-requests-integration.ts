import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createMigrationLedger } from '@ten98/runtime';
import type { PoolClient } from 'pg';
import { FoundationError } from '../src/server/auth.ts';
import { getConfig } from '../src/server/config.ts';
import { closeDatabase, getDatabase, migrationFiles, migrationLedger, migrationLockKey } from '../src/server/db.ts';
import { cancelRequest, dispatchRequest, requestHash, reserveRequest, settleRequest } from '../src/server/provider-requests.ts';
import { listProviders, revokeProvider, saveProvider } from '../src/server/providers.ts';

// This standalone runner deliberately keeps its fixtures for inspection. Never point it at an application database.
assert.equal(process.env.TEN98_INTEGRATION_TEST, '1', 'Set TEN98_INTEGRATION_TEST=1 for an isolated local fixture database.');
assert.equal(process.env.TEN98_PROVIDER_REQUEST_TEST, '1', 'Set TEN98_PROVIDER_REQUEST_TEST=1 to run the native request regressions.');
assert.equal(process.env.DATABASE_URL_FILE, undefined, 'Supply a direct synthetic DATABASE_URL; credential files are not accepted.');
assert.equal(process.env.AUTH_SECRET_FILE, undefined, 'Credential files are not accepted by this fixture runner.');
assert.equal(process.env.CREDENTIAL_KEYS_FILE, undefined, 'Credential files are not accepted by this fixture runner.');
assert.equal(process.env.CREDENTIAL_ACTIVE_KEY_FILE, undefined, 'Credential files are not accepted by this fixture runner.');
const databaseUrl = new URL(process.env.DATABASE_URL ?? 'invalid:');
const localHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
assert.ok(['postgres:', 'postgresql:'].includes(databaseUrl.protocol) && localHosts.has(databaseUrl.hostname), 'DATABASE_URL must identify a loopback PostgreSQL fixture.');
assert.equal(databaseUrl.search, '', 'Database URL query parameters may override the fixture connection and are not accepted.');
assert.equal(databaseUrl.hash, '', 'Database URL fragments are not accepted.');
const databaseName = databaseUrl.pathname.slice(1);
assert.match(databaseName, /^ten98_provider_requests_(?:test|fixture)(?:_[a-z0-9]+)*$/, 'Use a named fixture database such as ten98_provider_requests_fixture_484.');
assert.ok(localHosts.has(new URL(process.env.APP_URL ?? 'http://localhost:3000').hostname), 'APP_URL must be local.');
process.env.AUTH_SECRET = randomBytes(48).toString('base64url');
process.env.CREDENTIAL_KEYS = JSON.stringify({ fixture: randomBytes(32).toString('base64') });
process.env.CREDENTIAL_ACTIVE_KEY = 'fixture';
getConfig();

const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('Provider and HTTP requests are forbidden in this fixture runner.'); };
const watchdog = setTimeout(() => {
  console.error('Provider request integration exceeded its 120-second deadline. Fixtures remain in the isolated database.');
  process.exit(1);
}, 120_000);
const { pool } = getDatabase();
const owner = randomUUID(), editor = randomUUID(), otherEditor = randomUUID(), workspace = randomUUID(), foreignWorkspace = randomUUID();
const historicalId = randomUUID(), historicalConnection = randomUUID();
const syntheticCredentials = { apiKey: 'synthetic-provider-request-' + randomBytes(24).toString('base64url') };
let stage = 'fixture safety';

const rejects = (work: Promise<unknown>, status: number, message: string) => assert.rejects(work, (error: unknown) => error instanceof FoundationError && error.status === status, message);
const request = (connectionId: string) => ({ connectionId, requestKey: randomUUID(), operation: 'fixture.request', inputHash: requestHash('synthetic request input') });
const row = async (id: string) => (await pool.query('SELECT * FROM provider_request WHERE id=$1', [id])).rows[0];
async function transaction<T>(run: (client: PoolClient) => Promise<T>) {
  const client = await pool.connect();
  try { await client.query('BEGIN'); const value = await run(client); await client.query('COMMIT'); return value; }
  catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

try {
  const target = await pool.query('SELECT current_database() AS name, host(inet_server_addr()) AS address');
  assert.equal(target.rows[0].name, databaseName, 'The connected database must match the named fixture.');
  const expectedContainerAddress = process.env.TEN98_PROVIDER_REQUEST_SERVER_ADDRESS;
  if (expectedContainerAddress !== undefined) {
    assert.match(expectedContainerAddress, /^(?:\d{1,3}\.){3}\d{1,3}$/, 'Supply one exact inspected fixture-container IPv4 address.');
    assert.equal(databaseUrl.hostname, '127.0.0.1');
    assert.equal(databaseUrl.port, '55501', 'Container admission is limited to the task-owned loopback fixture port.');
    assert.equal(target.rows[0].address, expectedContainerAddress, 'The connected server must match the inspected task-owned fixture container.');
  } else assert.ok(['127.0.0.1', '::1'].includes(target.rows[0].address), 'The connected PostgreSQL server must be loopback.');
  const existing = await pool.query("SELECT count(*)::int AS n FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','f')");
  assert.equal(existing.rows[0].n, 0, 'Use a fresh fixture database; this runner never clears existing objects.');

  stage = 'historical migration preservation';
  const forwardIndex = migrationFiles.indexOf('0076_provider_request_activity.sql');
  assert.ok(forwardIndex > 0, 'The request migration must follow the historical ledger.');
  const historicalLedger = createMigrationLedger({ directory: new URL('../migrations/', import.meta.url), files: migrationFiles.slice(0, forwardIndex), lockKey: migrationLockKey });
  await historicalLedger.migrateWithDeadline(pool, { timeoutMs: 60_000, log: () => {} });
  await transaction(async client => {
    for (const id of [owner, editor, otherEditor]) await client.query('INSERT INTO "user"(id,name,email) VALUES($1,$2,$3)', [id, 'Request integration fixture', `${id}@provider-requests.integration.test`]);
    for (const id of [workspace, foreignWorkspace]) await client.query('INSERT INTO workspace(id,name) VALUES($1,$2)', [id, 'Provider request fixture']);
    for (const [userId, role] of [[owner, 'owner'], [editor, 'editor'], [otherEditor, 'editor']]) await client.query('INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,$3)', [workspace, userId, role]);
    await client.query('INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,$3)', [foreignWorkspace, owner, 'owner']);
    await client.query("INSERT INTO provider_connection(id,workspace_id,provider,name) VALUES($1,$2,'openrouter','Historical fixture')", [historicalConnection, workspace]);
    await client.query("INSERT INTO workspace_budget(workspace_id,paused) VALUES($1,true)", [workspace]);
    await client.query(`INSERT INTO provider_request(id,workspace_id,connection_id,connection_revision,user_id,request_key,operation,input_hash,estimate_micros,actual_micros,status,budget_month,provider_reference)
      VALUES($1,$2,$3,1,$4,$5,'fixture.historical',$6,123456,120000,'settled','2026-10-01','historical-provider-reference')`, [historicalId, workspace, historicalConnection, owner, randomUUID(), requestHash('historical input')]);
  });
  const historicalBefore = await row(historicalId);
  const checksumsBefore = (await pool.query('SELECT version,checksum FROM schema_version ORDER BY version')).rows;
  await migrationLedger.migrateWithDeadline(pool, { timeoutMs: 30_000, log: () => {} });
  await migrationLedger.assertCurrent(pool);
  assert.deepEqual(await row(historicalId), historicalBefore, 'Forward migration must preserve every historical request value.');
  assert.deepEqual((await pool.query("SELECT version,checksum FROM schema_version WHERE version<'0076' ORDER BY version")).rows, checksumsBefore, 'Forward migration must not rewrite historical ledger checksums.');
  assert.equal((await pool.query('SELECT paused FROM workspace_provider_control WHERE workspace_id=$1', [workspace])).rows[0].paused, true, 'The manual emergency pause must survive migration.');
  await pool.query('UPDATE workspace_provider_control SET paused=false WHERE workspace_id=$1', [workspace]);
  console.log('PASS forward migration preserves historical request values, checksums and manual pause');

  const connection = (await saveProvider(workspace, owner, { name: 'Synthetic request connection', provider: 'openrouter', credentials: syntheticCredentials })).connection;
  const alternate = (await saveProvider(workspace, owner, { name: 'Alternate synthetic connection', provider: 'openrouter', credentials: syntheticCredentials })).connection;
  const foreignConnection = (await saveProvider(foreignWorkspace, owner, { name: 'Foreign synthetic connection', provider: 'openrouter', credentials: syntheticCredentials })).connection;
  assert.equal(connection.checkStatus, 'untested', 'Saving synthetic credentials must not call a provider.');

  stage = 'concurrent request identity and enqueue rollback';
  const fixed = request(connection.id); let enqueues = 0;
  const twins = await Promise.all(Array.from({ length: 6 }, () => reserveRequest(workspace, editor, fixed, async (client, id) => {
    enqueues++;
    await client.query("INSERT INTO worker_heartbeat(id,last_seen_at) VALUES($1,now())", ['request-fixture:' + id]);
  })));
  assert.equal(new Set(twins.map(value => value.id)).size, 1);
  assert.equal(twins.filter(value => value.created).length, 1);
  assert.equal(enqueues, 1, 'Concurrent identical starts must enqueue exactly once.');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM provider_request WHERE workspace_id=$1 AND request_key=$2', [workspace, fixed.requestKey])).rows[0].n, 1);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM worker_heartbeat WHERE id=$1', ['request-fixture:' + twins[0].id])).rows[0].n, 1, 'Exactly one transaction enqueue marker must commit.');
  for (const change of [{ connectionId: alternate.id }, { operation: 'fixture.other' }, { inputHash: requestHash('changed input') }]) await rejects(reserveRequest(workspace, editor, { ...fixed, ...change }), 409, 'A reused key must not authorize changed work.');
  await rejects(reserveRequest(workspace, otherEditor, fixed), 409, 'A reused key must remain bound to its initiating actor.');
  await rejects(reserveRequest(workspace, editor, request(foreignConnection.id)), 404, 'A connection in another workspace must be unavailable.');
  const rollback = request(connection.id), rollbackMarker = 'request-rollback:' + randomUUID();
  const injected = new Error('synthetic enqueue failure');
  await assert.rejects(reserveRequest(workspace, editor, rollback, async client => {
    await client.query('INSERT INTO worker_heartbeat(id,last_seen_at) VALUES($1,now())', [rollbackMarker]);
    throw injected;
  }), error => error === injected);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM provider_request WHERE request_key=$1', [rollback.requestKey])).rows[0].n, 0);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM worker_heartbeat WHERE id=$1', [rollbackMarker])).rows[0].n, 0, 'Enqueue failure must roll back both database writes.');
  console.log('PASS concurrent starts enqueue once, changed identities conflict, and enqueue failures roll back');

  stage = 'current actor and credential dispatch fences';
  const restricted = await reserveRequest(workspace, editor, request(connection.id));
  await pool.query("UPDATE membership SET role='viewer' WHERE workspace_id=$1 AND user_id=$2", [workspace, editor]);
  await rejects(dispatchRequest(workspace, editor, restricted.id), 404, 'Current role must authorize dispatch.');
  await pool.query('DELETE FROM membership WHERE workspace_id=$1 AND user_id=$2', [workspace, editor]);
  await rejects(dispatchRequest(workspace, editor, restricted.id), 404, 'Removed membership must prevent dispatch.');
  await pool.query("INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,'editor')", [workspace, editor]);
  await rejects(dispatchRequest(workspace, otherEditor, restricted.id), 404, 'Another editor must not dispatch the original actor request.');
  await rejects(dispatchRequest(foreignWorkspace, owner, restricted.id), 404, 'Cross-workspace request IDs must be unavailable.');
  await saveProvider(workspace, owner, { name: 'Rotated synthetic connection', credentials: { apiKey: syntheticCredentials.apiKey + '-rotated' } }, connection.id);
  await rejects(dispatchRequest(workspace, editor, restricted.id), 409, 'Credential rotation must invalidate reserved revision pins.');
  assert.equal((await row(restricted.id)).status, 'reserved');
  const revoked = await reserveRequest(workspace, editor, request(alternate.id));
  await revokeProvider(workspace, owner, alternate.id);
  await rejects(dispatchRequest(workspace, editor, revoked.id), 409, 'Revocation must cancel undispatched work.');
  assert.equal((await row(revoked.id)).status, 'cancelled');
  await rejects(reserveRequest(workspace, editor, request(alternate.id)), 404, 'Revoked credentials must not authorize new work.');
  console.log('PASS current roles, membership, tenancy, actor, rotation and revocation prevent stale dispatch');

  stage = 'dispatch commit, ambiguous outcome and original completion';
  const original = await reserveRequest(workspace, editor, request(connection.id));
  await dispatchRequest(workspace, editor, original.id, async client => {
    assert.equal((await client.query('SELECT status FROM provider_request WHERE id=$1', [original.id])).rows[0].status, 'reserved');
  });
  assert.equal((await row(original.id)).status, 'dispatched', 'The dispatch fence must be committed before the caller can send.');
  const reference = 'synthetic-original-reference';
  assert.deepEqual(await transaction(client => settleRequest(client, workspace, original.id, { known: false, providerReference: reference })), { status: 'uncertain', recoveryRequired: true });
  await rejects(dispatchRequest(workspace, editor, original.id), 409, 'An ambiguous request must never dispatch again.');
  await rejects(cancelRequest(workspace, owner, original.id), 409, 'An owner must not cancel an already dispatched request.');
  await pool.query('DELETE FROM membership WHERE workspace_id=$1 AND user_id=$2', [workspace, editor]);
  assert.deepEqual(await transaction(client => settleRequest(client, workspace, original.id, { known: true })), { status: 'settled', recoveryRequired: false });
  await transaction(client => settleRequest(client, workspace, original.id, { known: true }));
  await rejects(transaction(client => settleRequest(client, workspace, original.id, { known: true, providerReference: 'different-reference' })), 409, 'Original completion identity must be immutable.');
  const completed = await row(original.id);
  assert.equal(completed.status, 'settled'); assert.equal(completed.provider_reference, reference);
  assert.ok(completed.updated_at instanceof Date);
  console.log('PASS committed dispatch, uncertain replay prevention and original completion survive actor removal');

  stage = 'request activity and NULL financial columns';
  const activity = await listProviders(workspace, owner);
  const visible = activity.requests.find((value: { id: string }) => value.id === original.id);
  assert.ok(visible, 'The original request must appear in provider activity.');
  assert.equal(visible.status, 'settled'); assert.equal(visible.providerReference, reference);
  assert.doesNotMatch(JSON.stringify(activity), /budget|ledger|micros|estimate|price|cost|spent|balance|charge|Usd|encrypted_credentials|ciphertext/);
  assert.ok(!JSON.stringify(activity).includes(syntheticCredentials.apiKey));
  const financial = await pool.query('SELECT id,estimate_micros,actual_micros,budget_month FROM provider_request WHERE workspace_id=$1 AND id<>$2', [workspace, historicalId]);
  assert.ok(financial.rows.length > 0);
  for (const value of financial.rows) {
    assert.equal(value.estimate_micros, null, 'New requests must not write estimates or zero substitutes.');
    assert.equal(value.actual_micros, null, 'New requests must not write API charges.');
    assert.equal(value.budget_month, null, 'New requests must not attach a budget month.');
  }
  assert.deepEqual(await row(historicalId), historicalBefore, 'Later request operations must leave historical records intact.');
  console.log('PASS request activity exposes status and references without money; new financial columns remain NULL');
  console.log('Provider request integration passed. Synthetic fixtures remain in the isolated database.');
} catch (error) {
  console.error(`Provider request integration failed during: ${stage}.`);
  if (error instanceof assert.AssertionError) console.error(error.message);
  else console.error('Unexpected fixture or database failure. Connection details and credentials are redacted.');
  process.exitCode = 1;
} finally {
  globalThis.fetch = originalFetch;
  await closeDatabase().catch(() => { console.error('Fixture database shutdown failed.'); process.exitCode = 1; });
  clearTimeout(watchdog);
}
