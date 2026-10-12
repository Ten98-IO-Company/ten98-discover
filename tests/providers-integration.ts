import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { FoundationError } from '../src/server/auth.ts';
import { getConfig } from '../src/server/config.ts';
import { credentialKeys, decryptCredentials } from '../src/server/credential-vault.ts';
import { getDatabase } from '../src/server/db.ts';
import { assertCredentialKeys, listProviders, revokeProvider, rotateCredentialEncryption, saveBudget, saveProvider } from '../src/server/providers.ts';
import { cancelReservation, dispatchSpend, requestHash, reserveSpend, settleSpend } from '../src/server/spending.ts';
import { acceptInvitation, changeRole, createWorkspace, inviteMember, removeMember } from '../src/server/teams.ts';

type Options = { baseUrl: string; appUrl: string; ownerCookie: string; ownerId: string; workspaceId: string };
async function rejects(work: Promise<unknown>, status: number, message: string) {
  await assert.rejects(work, (error: unknown) => error instanceof FoundationError && error.status === status, message);
}

export async function runProviderChecks(options: Options) {
  assert.equal(process.env.TEN98_INTEGRATION_TEST, '1', 'Provider checks require the isolated test opt-in.');
  const local = new Set(['localhost', '127.0.0.1', '[::1]']);
  assert.ok([options.baseUrl, options.appUrl, getConfig().databaseUrl].every(value => local.has(new URL(value).hostname)));
  assert.ok(credentialKeys(), 'Provider tests require a synthetic credential keyring.');
  const { pool } = getDatabase();
  const owner = options.ownerId;
  const secret = `synthetic-${randomBytes(24).toString('base64url')}`;
  const input = { name: 'Synthetic provider', provider: 'openrouter', credentials: { apiKey: secret }, monthlyLimitUsd: '10' };
  const workspace = async () => (await createWorkspace(owner, { name: 'Provider integration checks' })).workspace.id;
  const request = (connectionId: string, estimateUsd = '6') => ({ connectionId, estimateUsd, requestKey: randomUUID(), operation: 'fixture.test', inputHash: requestHash('synthetic bounded input') });
  const settle = async (wid: string, id: string, amount: string | null, reference: string | null = null) => {
    const client = await pool.connect();
    try { await client.query('BEGIN'); const outcome = await settleSpend(client, wid, id, amount, reference); await client.query('COMMIT'); return outcome; }
    catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  };
  async function http(path: string, expected: number, body?: unknown, cookie = options.ownerCookie, origin = options.appUrl) {
    const response = await fetch(new URL(path, options.baseUrl), {
      method: body === undefined ? 'GET' : 'POST',
      headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json', origin }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15_000),
    });
    assert.equal(response.status, expected, `Provider HTTP contract failed at ${path}.`);
    const text = await response.text();
    assert.ok(!text.includes(secret) && !text.includes('encrypted_credentials') && !text.includes('ciphertext'), 'HTTP must not disclose provider secrets or ciphertext.');
    return { body: JSON.parse(text), cookie: response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ') };
  }

  const wid = await workspace();
  const route = `/api/workspaces/${wid}`;
  await http(`${route}/providers`, 401, undefined, '');
  await http(`${route}/providers`, 403, input, options.ownerCookie, 'https://foreign.integration.test');
  await http(`${route}/providers`, 400, { ...input, monthlyLimitUsd: 'NaN' });
  const oversized = { ...input, provider: 'dataforseo', credentials: { login: 'test@integration.test', password: '\u0000'.repeat(4096) } };
  await http(`${route}/providers`, 413, oversized);
  await rejects(saveProvider(wid, owner, oversized), 400, 'Internal callers must not persist an undecryptable oversized credential.');
  const connection = (await http(`${route}/providers`, 201, input)).body.connection;
  assert.equal(connection.checkStatus, 'untested', 'Saving must never call the provider.');
  const initial = (await http(`${route}/providers`, 200)).body;
  assert.equal(initial.budget.paused, true);
  assert.equal(initial.budget.monthlyLimitUsd, '0.000000');
  assert.equal(initial.budget.spentUsd, '0.000000');
  const stored = (await pool.query('SELECT encrypted_credentials FROM provider_connection WHERE id=$1', [connection.id])).rows[0].encrypted_credentials;
  assert.ok(!JSON.stringify(stored).includes(secret), 'Stored JSON must not contain plaintext credentials.');
  const context = { id: connection.id, workspaceId: wid, provider: 'openrouter', revision: 1 };
  assert.deepEqual(decryptCredentials(stored, context), input.credentials);
  assert.throws(() => decryptCredentials(stored, { ...context, workspaceId: randomUUID() }), (error: unknown) => error instanceof FoundationError && error.status === 503);

  const email = `${randomUUID()}@providers.integration.test`;
  const password = randomBytes(24).toString('base64url');
  const invitation = await inviteMember(wid, owner, { email, role: 'admin' });
  await acceptInvitation({ token: invitation.token, name: 'Provider editor', password });
  const editor = (await pool.query('SELECT id FROM "user" WHERE email=$1', [email])).rows[0].id;
  const memberCookie = (await http('/api/auth/sign-in/email', 200, { email, password }, '')).cookie;
  await http(`${route}/providers`, 404, undefined, memberCookie);
  await http(`${route}/budget`, 404, { monthlyLimitUsd: '100', paused: false }, memberCookie);
  await http(`/api/workspaces/${randomUUID()}/providers/${connection.id}/revoke`, 404, {});
  await rejects(reserveSpend(wid, owner, request(connection.id)), 409, 'Spending starts paused.');
  await http(`${route}/budget`, 200, { monthlyLimitUsd: '10', paused: false });
  const concurrent = await Promise.allSettled([reserveSpend(wid, owner, request(connection.id)), reserveSpend(wid, owner, request(connection.id))]);
  assert.equal(concurrent.filter(value => value.status === 'fulfilled').length, 1, 'Concurrent requests must share one budget.');
  const denied = concurrent.find(value => value.status === 'rejected') as PromiseRejectedResult;
  assert.ok(denied.reason instanceof FoundationError && denied.reason.status === 409);
  const successful = concurrent.find(value => value.status === 'fulfilled') as PromiseFulfilledResult<{ id: string }>;
  await cancelReservation(wid, owner, successful.value.id);
  const fixed = request(connection.id, '2'); let enqueues = 0;
  const first = await reserveSpend(wid, owner, fixed, async () => { enqueues++; });
  await rejects(cancelReservation(wid, editor, first.id), 409, 'Administrators cannot cancel another issuer\'s reservation.');
  const repeated = await reserveSpend(wid, owner, fixed, async () => { enqueues++; });
  assert.equal(repeated.id, first.id); assert.equal(repeated.created, false); assert.equal(enqueues, 1);
  await rejects(reserveSpend(wid, owner, { ...fixed, inputHash: requestHash('changed') }), 409, 'A reused key cannot change the request.');
  const rollback = request(connection.id, '1');
  await assert.rejects(reserveSpend(wid, owner, rollback, async () => { throw new Error('synthetic enqueue failure'); }));
  assert.equal((await pool.query('SELECT 1 FROM provider_request WHERE request_key=$1', [rollback.requestKey])).rowCount, 0);
  await dispatchSpend(wid, owner, first.id);
  await rejects(dispatchSpend(wid, owner, first.id), 409, 'A dispatched request cannot be sent twice.');
  await rejects(cancelReservation(wid, owner, first.id), 409, 'Dispatched work must retain its charge reservation.');
  await settle(wid, first.id, '1.250001', 'synthetic-reference');
  await settle(wid, first.id, '1.250001', 'synthetic-reference');
  await rejects(settle(wid, first.id, '1.25', 'synthetic-reference'), 409, 'Settlement cannot silently change a recorded charge.');
  assert.equal((await listProviders(wid, owner)).budget.spentUsd, '1.250001');
  console.log('PASS provider HTTP privacy, owner access, exact budgets, concurrent reservations, idempotency and rollback');

  await changeRole(wid, owner, editor, { role: 'editor' });
  const stale = await reserveSpend(wid, editor, request(connection.id, '1'));
  await removeMember(wid, owner, editor);
  await rejects(dispatchSpend(wid, editor, stale.id), 404, 'Revoked editors cannot dispatch reserved work.');
  await cancelReservation(wid, owner, stale.id);
  const rotation = await reserveSpend(wid, owner, request(connection.id, '1'));
  const updated = (await http(`${route}/providers/${connection.id}/update`, 200, { name: 'Rotated synthetic provider', credentials: { apiKey: secret }, monthlyLimitUsd: '10' })).body.connection;
  assert.equal(updated.revision, 2);
  await rejects(dispatchSpend(wid, owner, rotation.id), 409, 'Old quotes must not silently use new credentials.');
  await cancelReservation(wid, owner, rotation.id);
  const uncertain = await reserveSpend(wid, owner, request(connection.id, '1'));
  await dispatchSpend(wid, owner, uncertain.id);
  await settle(wid, uncertain.id, null);
  assert.equal((await listProviders(wid, owner)).budget.paused, true);
  await saveBudget(wid, owner, { monthlyLimitUsd: '10', paused: false });
  await rejects(reserveSpend(wid, owner, request(connection.id, '1')), 409, 'Unpausing cannot bypass unresolved charges.');
  await settle(wid, uncertain.id, '1.5');
  assert.equal((await listProviders(wid, owner)).budget.paused, true, 'A charge exceeding the quote pauses spending.');
  await saveBudget(wid, owner, { monthlyLimitUsd: '100', paused: false });
  await rejects(reserveSpend(wid, owner, request(connection.id, '8')), 409, 'Connection caps apply even with a larger workspace cap.');
  const reserved = await reserveSpend(wid, owner, request(connection.id, '1'));
  const inFlight = await reserveSpend(wid, owner, request(connection.id, '1'));
  await dispatchSpend(wid, owner, inFlight.id);
  await revokeProvider(wid, owner, connection.id);
  const afterRevoke = (await pool.query('SELECT id,status FROM provider_request WHERE id=ANY($1::uuid[])', [[reserved.id, inFlight.id]])).rows;
  assert.equal(afterRevoke.find(row => row.id === reserved.id).status, 'cancelled');
  assert.equal(afterRevoke.find(row => row.id === inFlight.id).status, 'dispatched');
  assert.equal((await pool.query('SELECT encrypted_credentials FROM provider_connection WHERE id=$1', [connection.id])).rows[0].encrypted_credentials, null);
  await settle(wid, inFlight.id, '0.5');
  console.log('PASS revocation, stale credentials, owner cancellation and uncertain/over-estimate reconciliation');

  const rolloverWorkspace = await workspace();
  const rollConnection = (await saveProvider(rolloverWorkspace, owner, input)).connection.id;
  await saveBudget(rolloverWorkspace, owner, { monthlyLimitUsd: '10', paused: false });
  const old = await reserveSpend(rolloverWorkspace, owner, request(rollConnection, '6'));
  await pool.query("UPDATE provider_request SET budget_month=(date_trunc('month',clock_timestamp() AT TIME ZONE 'UTC')-interval '1 month')::date WHERE id=$1", [old.id]);
  await rejects(reserveSpend(rolloverWorkspace, owner, request(rollConnection, '5')), 409, 'Prior-month outstanding work must still consume available budget.');
  await dispatchSpend(rolloverWorkspace, owner, old.id);
  const currentMonth = await pool.query("SELECT budget_month=date_trunc('month',clock_timestamp() AT TIME ZONE 'UTC')::date AS current FROM provider_request WHERE id=$1", [old.id]);
  assert.equal(currentMonth.rows[0].current, true, 'Dispatch must move its charge period to the actual month.');
  await settle(rolloverWorkspace, old.id, '4');
  const overflow = await reserveSpend(rolloverWorkspace, owner, request(rollConnection, '1'));
  await dispatchSpend(rolloverWorkspace, owner, overflow.id);
  assert.deepEqual(await settle(rolloverWorkspace, overflow.id, '1000000.000001', 'synthetic-overflow'), {
    status: 'uncertain', reconciliationRequired: true, reportedAmount: '1000000.000001',
  });
  await settle(rolloverWorkspace, overflow.id, null);
  const overflowRow = (await pool.query('SELECT status,actual_micros,provider_reference FROM provider_request WHERE id=$1', [overflow.id])).rows[0];
  assert.deepEqual(overflowRow, { status: 'uncertain', actual_micros: null, provider_reference: 'synthetic-overflow' });
  assert.equal((await listProviders(rolloverWorkspace, owner)).budget.paused, true);
  await saveBudget(rolloverWorkspace, owner, { monthlyLimitUsd: '10', paused: false });
  await rejects(reserveSpend(rolloverWorkspace, owner, request(rollConnection, '1')), 409, 'An oversized reported charge must block further spending.');
  await rejects(cancelReservation(rolloverWorkspace, owner, overflow.id), 409, 'An owner cannot cancel an uncertain charge.');

  // Rotate only synthetic data; restore the original active key before the running web/worker use it.
  const originalKeys = process.env.CREDENTIAL_KEYS; const originalFile = process.env.CREDENTIAL_KEYS_FILE;
  const originalActive = process.env.CREDENTIAL_ACTIVE_KEY;
  const ring = credentialKeys()!;
  const expanded = Object.fromEntries([...ring.keys].map(([id, bytes]) => [id, bytes.toString('base64')]));
  const nextKey = `test_${randomBytes(8).toString('hex')}`;
  expanded[nextKey] = randomBytes(32).toString('base64');
  try {
    delete process.env.CREDENTIAL_KEYS_FILE;
    process.env.CREDENTIAL_KEYS = JSON.stringify(expanded); process.env.CREDENTIAL_ACTIVE_KEY = nextKey;
    const count = await rotateCredentialEncryption(); assert.ok(count >= 1);
    await assertCredentialKeys();
    const sealed = (await pool.query('SELECT encrypted_credentials FROM provider_connection WHERE id=$1', [rollConnection])).rows[0].encrypted_credentials;
    assert.equal(sealed.keyId, nextKey);
    process.env.CREDENTIAL_KEYS = JSON.stringify({ [ring.active]: expanded[ring.active] }); process.env.CREDENTIAL_ACTIVE_KEY = ring.active;
    await rejects(assertCredentialKeys(), 503, 'A missing required key must stop readiness.');
    process.env.CREDENTIAL_KEYS = JSON.stringify(expanded); process.env.CREDENTIAL_ACTIVE_KEY = nextKey;
    await pool.query('UPDATE provider_connection SET encrypted_credentials=$2 WHERE id=$1', [rollConnection, { ...sealed, tag: 'AAAAAAAAAAAAAAAAAAAAAA==' }]);
    const before = (await pool.query('SELECT id,encrypted_credentials FROM provider_connection WHERE encrypted_credentials IS NOT NULL ORDER BY id')).rows;
    try {
      await rejects(rotateCredentialEncryption(), 503, 'Tampered ciphertext must reject the complete rekey transaction.');
      const after = (await pool.query('SELECT id,encrypted_credentials FROM provider_connection WHERE encrypted_credentials IS NOT NULL ORDER BY id')).rows;
      assert.deepEqual(after, before, 'Failed key rotation must leave all stored envelopes unchanged.');
    } finally { await pool.query('UPDATE provider_connection SET encrypted_credentials=$2 WHERE id=$1', [rollConnection, sealed]); }
  } finally {
    process.env.CREDENTIAL_KEYS = JSON.stringify(expanded); process.env.CREDENTIAL_ACTIVE_KEY = ring.active;
    try { await rotateCredentialEncryption(); }
    finally {
      if (originalKeys === undefined) delete process.env.CREDENTIAL_KEYS; else process.env.CREDENTIAL_KEYS = originalKeys;
      if (originalFile === undefined) delete process.env.CREDENTIAL_KEYS_FILE; else process.env.CREDENTIAL_KEYS_FILE = originalFile;
      if (originalActive === undefined) delete process.env.CREDENTIAL_ACTIVE_KEY; else process.env.CREDENTIAL_ACTIVE_KEY = originalActive;
    }
  }
  await assertCredentialKeys();
  console.log('PASS month rollover, encrypted persistence, missing keys and atomic key rotation; no provider traffic');
}
