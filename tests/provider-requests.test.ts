import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, test } from 'node:test';
import type { PoolClient } from 'pg';
import { cancelRequest, dispatchRequest, reserveRequest, reserveRequestInTransaction, settleRequest } from '../src/server/provider-requests.ts';
import { listProviders, saveProviderRequestControls } from '../src/server/providers.ts';

type Row = { id: string; workspace_id: string; connection_id: string; connection_revision: number; user_id: string; request_key: string; operation: string; input_hash: string; status: string; provider_reference: string | null };
const workspace = randomUUID(), user = randomUUID(), connection = randomUUID();
const databaseKey = Symbol.for('ten98-monitor.database');
const globals = globalThis as typeof globalThis & { [databaseKey]?: unknown };
let prior: unknown, rows: Row[], queries: string[], revision: number, revoked: boolean, paused: boolean, role: string;
let backup: Row[];
const result = (values: unknown[] = []) => ({ rows: values, rowCount: values.length });
const client = { release() {}, async query(sql: string, values: unknown[] = []) {
  queries.push(sql);
  if (sql === 'BEGIN') { backup = structuredClone(rows); return result(); }
  if (sql === 'ROLLBACK') { rows = backup; return result(); }
  if (sql === 'COMMIT' || sql.startsWith('SET LOCAL')) return result();
  if (sql.startsWith('SELECT id FROM workspace')) return result([{ id: workspace }]);
  if (sql.startsWith('SELECT role FROM membership')) return result(role ? [{ role }] : []);
  if (sql.includes('FROM provider_connection')) return result(sql.includes('revoked_at,revision') ? [{ revoked_at: revoked ? new Date() : null, revision }] : []);
  if (sql.startsWith('SELECT') && sql.includes('workspace_provider_control')) return result([{ paused }]);
  if (sql.startsWith('INSERT INTO workspace_provider_control')) { paused = values[1] as boolean; return result(); }
  if (sql.startsWith('SELECT') && sql.includes('FROM provider_request')) {
    if (sql.includes('request_key=$2')) return result(rows.filter(row => row.workspace_id === values[0] && row.request_key === values[1]));
    if (sql.includes('WHERE id=$1')) return result(rows.filter(row => row.id === values[0] && row.workspace_id === values[1]));
    return result(rows.map(row => ({ id: row.id, connectionId: row.connection_id, operation: row.operation, status: row.status })));
  }
  if (sql.startsWith('INSERT INTO provider_request')) {
    const [id, workspace_id, connection_id, user_id, request_key, operation, input_hash, connection_revision] = values;
    rows.push({ id, workspace_id, connection_id, user_id, request_key, operation, input_hash, connection_revision, status: 'reserved', provider_reference: null } as Row);
    return result();
  }
  if (sql.startsWith('UPDATE provider_request')) {
    const row = rows.find(row => row.id === values[0]);
    if (!row) return result();
    if (sql.includes("status='dispatched'")) row.status = 'dispatched';
    else if (sql.includes("status='cancelled'")) {
      if (row.workspace_id !== values[1] || (row.user_id !== values[2] && !values[3]) || row.status !== 'reserved') return result();
      row.status = 'cancelled';
    } else { row.status = values[1] as string; row.provider_reference = values[2] as string | null; }
    return result([{ id: row.id }]);
  }
  throw new Error(`Unexpected query: ${sql}`);
} } as unknown as PoolClient;
const input = () => ({ connectionId: connection, requestKey: randomUUID(), operation: 'fixture.request', inputHash: 'a'.repeat(64) });
const fails = (status: number) => (error: unknown) => !!error && typeof error === 'object' && 'status' in error && error.status === status;

beforeEach(() => { prior = globals[databaseKey]; globals[databaseKey] = { pool: { connect: async () => client } }; rows = []; queries = []; revision = 1; revoked = paused = false; role = 'owner'; });
afterEach(() => { if (prior === undefined) delete globals[databaseKey]; else globals[databaseKey] = prior; });

test('request validation refuses monetary inputs and malformed identities before database access', async () => {
  for (const extra of [{ estimateUsd: '1' }, { actualUsd: '0' }, { budget: 1 }, { requestKey: 'invalid' }]) await assert.rejects(reserveRequest(workspace, user, { ...input(), ...extra }), { name: 'ZodError' });
  await assert.rejects(settleRequest(client, workspace, randomUUID(), { known: true, cost: 1 } as never), { name: 'ZodError' });
  assert.deepEqual(queries, []);
});

test('one request identity enqueues once, refuses changed inputs and never reads or writes money', async () => {
  const request = input(); let enqueues = 0;
  const first = await reserveRequest(workspace, user, request, async () => { enqueues++; });
  assert.deepEqual(await reserveRequest(workspace, user, request), { id: first.id, status: 'reserved', created: false });
  for (const change of [{ connectionId: randomUUID() }, { operation: 'fixture.other' }, { inputHash: 'b'.repeat(64) }]) await assert.rejects(reserveRequest(workspace, user, { ...request, ...change }), fails(409));
  assert.equal(enqueues, 1); assert.equal(rows.length, 1);
  assert.doesNotMatch(queries.join('\n'), /micros|budget|price|cost|SELECT \*/i);
});

test('enqueue failure rolls back the request; direct transaction reservations use the same identity', async () => {
  const request = input();
  await assert.rejects(reserveRequest(workspace, user, request, async () => { throw new Error('Synthetic queue failure'); }), /Synthetic queue failure/);
  assert.equal(rows.length, 0);
  await client.query('BEGIN');
  const first = await reserveRequestInTransaction(client, workspace, user, request);
  assert.equal((await reserveRequestInTransaction(client, workspace, user, request)).id, first.id);
  await client.query('COMMIT'); assert.equal(rows.length, 1);
});

test('dispatch persists the fence after preparation and cannot repeat an uncertain original request', async () => {
  const { id } = await reserveRequest(workspace, user, input());
  await dispatchRequest(workspace, user, id, async () => { assert.equal(rows[0].status, 'reserved'); });
  assert.equal(rows[0].status, 'dispatched');
  assert.deepEqual(await settleRequest(client, workspace, id, { known: false, providerReference: 'original' }), { status: 'uncertain', recoveryRequired: true });
  await assert.rejects(dispatchRequest(workspace, user, id), fails(409));
  assert.deepEqual(await settleRequest(client, workspace, id, { known: true, providerReference: 'original' }), { status: 'settled', recoveryRequired: false });
  assert.equal(rows[0].provider_reference, 'original');
  await settleRequest(client, workspace, id, { known: true });
  await assert.rejects(settleRequest(client, workspace, id, { known: false }), fails(409));
  await assert.rejects(settleRequest(client, workspace, id, { known: true, providerReference: 'different' }), fails(409));
});

test('current authorization, pause, revocation, revision and preparation checks prevent dispatch', async () => {
  const { id } = await reserveRequest(workspace, user, input());
  role = 'viewer'; await assert.rejects(dispatchRequest(workspace, user, id), fails(404)); role = 'owner';
  paused = true; await assert.rejects(dispatchRequest(workspace, user, id), fails(409)); paused = false;
  revoked = true; await assert.rejects(dispatchRequest(workspace, user, id), fails(404)); revoked = false;
  revision++; await assert.rejects(dispatchRequest(workspace, user, id), fails(409)); revision--;
  await assert.rejects(dispatchRequest(workspace, user, id, async () => { throw new Error('Changed request'); }), /Changed request/);
  assert.equal(rows[0].status, 'reserved');
  await cancelRequest(workspace, user, id); assert.equal(rows[0].status, 'cancelled');
  await assert.rejects(dispatchRequest(workspace, user, id), fails(409));
});

test('connections expose request activity and a nonfinancial manual stop only', async () => {
  await reserveRequest(workspace, user, input());
  const listing = await listProviders(workspace, user);
  assert.deepEqual(listing.requestControls, { paused: false }); assert.equal(listing.requests.length, 1);
  assert.doesNotMatch(JSON.stringify(listing), /budget|ledger|Usd|micros|cost|spent|balance/i);
  await saveProviderRequestControls(workspace, user, { paused: true }); assert.equal(paused, true);
  assert.doesNotMatch(queries.join('\n'), /workspace_budget|micros|budget_month/);
});
