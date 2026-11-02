import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { FoundationError } from '../src/server/auth.ts';
import { getConfig } from '../src/server/config.ts';
import { credentialKeys, decryptCredentials } from '../src/server/credential-vault.ts';
import { getDatabase } from '../src/server/db.ts';
import { assertCredentialKeys, listProviders, revokeProvider, rotateCredentialEncryption, saveProviderRequestControls, saveProvider } from '../src/server/providers.ts';
import { cancelRequest, dispatchRequest, requestHash, reserveRequest, settleRequest } from '../src/server/provider-requests.ts';
import { acceptInvitation, changeRole, createWorkspace, inviteMember, removeMember } from '../src/server/teams.ts';

type Options = { baseUrl: string; appUrl: string; ownerCookie: string; ownerId: string; workspaceId: string };
async function rejects(work: Promise<unknown>, status: number, message: string) {
  await assert.rejects(work, (error: unknown) => error instanceof FoundationError && error.status === status, message);
}

function assertNoApiMoney(value: unknown) {
  if (!value || typeof value !== 'object') return;
  const forbidden = new Set(['budget','estimateUsd','actualUsd','spentUsd','reservedUsd','uncertainUsd','estimateMicros','actualMicros','estimate_micros','actual_micros','cost','price','monthlyLimitUsd','maxSpendUsd','fundedCredits','chargeStatus']);
  for (const [key, child] of Object.entries(value)) {
    assert.equal(forbidden.has(key), false, 'Provider activity must expose requests without financial fields: ' + key);
    assertNoApiMoney(child);
  }
}

export async function runProviderChecks(options: Options) {
  assert.equal(process.env.TEN98_INTEGRATION_TEST, '1', 'Provider checks require the isolated test opt-in.');
  const local = new Set(['localhost', '127.0.0.1', '[::1]']);
  assert.ok([options.baseUrl, options.appUrl, getConfig().databaseUrl].every(value => local.has(new URL(value).hostname)));
  assert.ok(credentialKeys(), 'Provider tests require a synthetic credential keyring.');
  const { pool } = getDatabase();
  const owner = options.ownerId;
  const secret = `synthetic-${randomBytes(24).toString('base64url')}`;
  const input = { name: 'Synthetic provider', provider: 'openrouter', credentials: { apiKey: secret } };
  const ownedWorkspaces: string[] = [];
  const workspace = async () => { const id = (await createWorkspace(owner, { name: 'Provider integration checks' })).workspace.id; ownedWorkspaces.push(id); return id; };
  const request = (connectionId: string) => ({ connectionId, requestKey: randomUUID(), operation: 'fixture.test', inputHash: requestHash('synthetic bounded input') });
  const settle = async (wid: string, id: string, known: boolean, reference: string | null = null) => {
    const client = await pool.connect();
    try { await client.query('BEGIN'); const outcome = await settleRequest(client, wid, id, { known, providerReference: reference }); await client.query('COMMIT'); return outcome; }
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
    const parsedBody = JSON.parse(text); assertNoApiMoney(parsedBody);
    return { body: parsedBody, cookie: response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ') };
  }

  const wid = await workspace();
  const route = `/api/workspaces/${wid}`;
  await http(`${route}/providers`, 401, undefined, '');
  await http(`${route}/providers`, 403, input, options.ownerCookie, 'https://foreign.integration.test');
  await http(`${route}/providers`, 400, { ...input, monthlyLimitUsd: '10' }); // Owner decision D3: the cap field is removed.
  const oversized = { ...input, provider: 'dataforseo', credentials: { login: 'test@integration.test', password: '\u0000'.repeat(4096) } };
  await http(`${route}/providers`, 413, oversized);
  await assert.rejects(saveProvider(wid, owner, oversized), {name:'ZodError'}, 'Internal callers reject control characters before encryption or persistence.');
  const connection = (await http(`${route}/providers`, 201, input)).body.connection;
  assert.equal(connection.checkStatus, 'untested', 'Saving must never call the provider.');
  const initial = (await http(`${route}/providers`, 200)).body;
  assert.equal(initial.requestControls.paused, false);
  assert.deepEqual(initial.requestControls, { paused: false });
  assert.deepEqual(initial.requests, []);
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
  await http(`${route}/provider-requests/control`, 404, { paused: false }, memberCookie);
  await http(`/api/workspaces/${randomUUID()}/providers/${connection.id}/revoke`, 404, {});
  // Owner decision D3: new workspaces start unpaused; only the owner's manual pause stops new provider requests.
  const unpaused = await reserveRequest(wid, owner, request(connection.id));
  assert.equal(unpaused.created, true, 'New workspaces start unpaused (D3).');
  await cancelRequest(wid, owner, unpaused.id);
  await http(`${route}/provider-requests/control`, 200, { paused: true });
  await rejects(reserveRequest(wid, owner, request(connection.id)), 409, 'The manual pause refuses new provider requests.');
  await http(`${route}/provider-requests/control`, 400, { monthlyLimitUsd: '10', paused: false });
  await http(`${route}/provider-requests/control`, 200, { paused: false });
  const concurrent = await Promise.allSettled([reserveRequest(wid, owner, request(connection.id)), reserveRequest(wid, owner, request(connection.id))]);
  assert.equal(concurrent.filter(value => value.status === 'fulfilled').length, 2, 'Without an app cap, concurrent requests with distinct keys both commit (D3).');
  const sameKey = request(connection.id);
  const twins = await Promise.all([reserveRequest(wid, owner, sameKey), reserveRequest(wid, owner, sameKey)]);
  assert.equal(twins[0].id, twins[1].id);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM provider_request WHERE workspace_id=$1 AND request_key=$2', [wid, sameKey.requestKey])).rows[0].n, 1, 'Concurrent requests with one key share one row.');
  for (const saved of [...concurrent.map(value => (value as PromiseFulfilledResult<{ id: string }>).value), twins[0]]) await cancelRequest(wid, owner, saved.id);
  const fixed = request(connection.id); let enqueues = 0;
  const first = await reserveRequest(wid, owner, fixed, async () => { enqueues++; });
  await rejects(cancelRequest(wid, editor, first.id), 409, 'Administrators cannot cancel another issuer\'s reservation.');
  const repeated = await reserveRequest(wid, owner, fixed, async () => { enqueues++; });
  assert.equal(repeated.id, first.id); assert.equal(repeated.created, false); assert.equal(enqueues, 1);
  await rejects(reserveRequest(wid, owner, { ...fixed, inputHash: requestHash('changed') }), 409, 'A reused key cannot change the request.');
  const rollback = request(connection.id);
  await assert.rejects(reserveRequest(wid, owner, rollback, async () => { throw new Error('synthetic enqueue failure'); }));
  assert.equal((await pool.query('SELECT 1 FROM provider_request WHERE request_key=$1', [rollback.requestKey])).rowCount, 0);
  await dispatchRequest(wid, owner, first.id);
  await rejects(dispatchRequest(wid, owner, first.id), 409, 'A dispatched request cannot be sent twice.');
  await rejects(cancelRequest(wid, owner, first.id), 409, 'Dispatched work must retain its request identity.');
  await settle(wid, first.id, true, 'synthetic-reference');
  await settle(wid, first.id, true, 'synthetic-reference');
  await rejects(settle(wid, first.id, true, 'different-reference'), 409, 'Recovery cannot silently change the original provider reference.');
  await rejects(settle(wid, first.id, false, 'synthetic-reference'), 409, 'A verified outcome cannot become ambiguous.');
  const firstActivity = await listProviders(wid, owner); assertNoApiMoney(firstActivity);
  assert.equal(firstActivity.requests.find(row => row.id === first.id)?.providerReference, 'synthetic-reference');
  console.log('PASS provider HTTP privacy, owner access, unpaused new workspace and manual pause (D3), request history, concurrent reservations, idempotency and rollback');

  await changeRole(wid, owner, editor, { role: 'editor' });
  const stale = await reserveRequest(wid, editor, request(connection.id));
  await removeMember(wid, owner, editor);
  await rejects(dispatchRequest(wid, editor, stale.id), 404, 'Revoked editors cannot dispatch reserved work.');
  await cancelRequest(wid, owner, stale.id);
  const rotation = await reserveRequest(wid, owner, request(connection.id));
  const updated = (await http(`${route}/providers/${connection.id}/update`, 200, { name: 'Rotated synthetic provider', credentials: { apiKey: secret } })).body.connection;
  assert.equal(updated.revision, 2);
  await rejects(dispatchRequest(wid, owner, rotation.id), 409, 'Prepared requests must not silently use new credentials.');
  await cancelRequest(wid, owner, rotation.id);
  const uncertainInput = request(connection.id);
  const uncertain = await reserveRequest(wid, owner, uncertainInput);
  await dispatchRequest(wid, owner, uncertain.id);
  await settle(wid, uncertain.id, false);
  // Unknown outcomes stay on their original request without blocking independent reservations or dispatch.
  assert.equal((await listProviders(wid, owner)).requestControls.paused, false);
  assert.deepEqual(await reserveRequest(wid, owner, uncertainInput), { id: uncertain.id, status: 'uncertain', created: false });
  await rejects(dispatchRequest(wid, owner, uncertain.id), 409, 'An uncertain original request cannot be dispatched again.');
  const independent = await reserveRequest(wid, owner, request(connection.id));
  assert.equal(independent.created, true);
  await dispatchRequest(wid, owner, independent.id);
  await settle(wid, independent.id, true);
  assert.deepEqual((await pool.query('SELECT status,actual_micros FROM provider_request WHERE id=$1', [uncertain.id])).rows[0], { status: 'uncertain', actual_micros: null });
  await settle(wid, uncertain.id, true);
  assert.equal((await listProviders(wid, owner)).requestControls.paused, false, 'Recovering an original outcome leaves manual controls unchanged.');
  assert.deepEqual((await pool.query('SELECT status,estimate_micros,actual_micros FROM provider_request WHERE id=$1', [uncertain.id])).rows[0], { status: 'settled', estimate_micros: null, actual_micros: null });
  const uncapped = await reserveRequest(wid, owner, request(connection.id));
  assert.equal(uncapped.created, true, 'Independent requests need no financial input.');
  const reserved = await reserveRequest(wid, owner, request(connection.id));
  const inFlight = await reserveRequest(wid, owner, request(connection.id));
  await dispatchRequest(wid, owner, inFlight.id);
  await revokeProvider(wid, owner, connection.id);
  const afterRevoke = (await pool.query('SELECT id,status FROM provider_request WHERE id=ANY($1::uuid[])', [[reserved.id, inFlight.id]])).rows;
  assert.equal(afterRevoke.find(row => row.id === reserved.id).status, 'cancelled');
  assert.equal(afterRevoke.find(row => row.id === inFlight.id).status, 'dispatched');
  assert.equal((await pool.query('SELECT encrypted_credentials FROM provider_connection WHERE id=$1', [connection.id])).rows[0].encrypted_credentials, null);
  await settle(wid, inFlight.id, true);
  console.log('PASS revocation, stale credentials, owner cancellation and uncertain original-request recovery without automatic pause');

  const rolloverWorkspace = await workspace();
  const rollConnection = (await saveProvider(rolloverWorkspace, owner, input)).connection.id;
  await saveProviderRequestControls(rolloverWorkspace, owner, { paused: false });
  const old = await reserveRequest(rolloverWorkspace, owner, request(rollConnection));
  await pool.query("UPDATE provider_request SET created_at=(date_trunc('month',clock_timestamp() AT TIME ZONE 'UTC')-interval '1 month')::date WHERE id=$1", [old.id]);
  const originalIdentity = (await pool.query('SELECT id,request_key,input_hash,connection_id,connection_revision,created_at,budget_month FROM provider_request WHERE id=$1', [old.id])).rows[0];
  assert.equal(originalIdentity.budget_month, null, 'New requests have no billing period.');
  const historicalActivity = await listProviders(rolloverWorkspace, owner); assertNoApiMoney(historicalActivity);
  assert.equal(historicalActivity.requests.find(row => row.id === old.id)?.status, 'reserved', 'Prior-month requests retain their original request identity.');
  const later = await reserveRequest(rolloverWorkspace, owner, request(rollConnection));
  assert.equal(later.created, true);
  await cancelRequest(rolloverWorkspace, owner, later.id);
  await dispatchRequest(rolloverWorkspace, owner, old.id);
  assert.deepEqual((await pool.query('SELECT id,request_key,input_hash,connection_id,connection_revision,created_at,budget_month FROM provider_request WHERE id=$1', [old.id])).rows[0], originalIdentity, 'Dispatch preserves the original cross-month request identity and timestamp.');
  await settle(rolloverWorkspace, old.id, true, 'cross-month-original');
  const bounded = await reserveRequest(rolloverWorkspace, owner, request(rollConnection));
  await dispatchRequest(rolloverWorkspace, owner, bounded.id);
  await assert.rejects(settle(rolloverWorkspace, bounded.id, true, 'x'.repeat(513)), { name: 'ZodError' }, 'Oversized provider references cannot change a dispatched request.');
  assert.deepEqual(await settle(rolloverWorkspace, bounded.id, false, 'bounded-original'), { status: 'uncertain', recoveryRequired: true });
  const originalOutcome = (await pool.query('SELECT status,estimate_micros,actual_micros,provider_reference FROM provider_request WHERE id=$1', [bounded.id])).rows[0];
  assert.deepEqual(originalOutcome, { status: 'uncertain', estimate_micros: null, actual_micros: null, provider_reference: 'bounded-original' });
  assert.equal((await listProviders(rolloverWorkspace, owner)).requestControls.paused, false, 'An ambiguous outcome leaves manual controls unchanged.');
  const independentAfterBounds = await reserveRequest(rolloverWorkspace, owner, request(rollConnection));
  assert.equal(independentAfterBounds.created, true, 'An ambiguous original request does not block independent work.');
  await cancelRequest(rolloverWorkspace, owner, independentAfterBounds.id);
  await rejects(dispatchRequest(rolloverWorkspace, owner, bounded.id), 409, 'An ambiguous original request cannot be dispatched again.');
  assert.deepEqual((await pool.query('SELECT status,estimate_micros,actual_micros,provider_reference FROM provider_request WHERE id=$1', [bounded.id])).rows[0], originalOutcome);
  await rejects(cancelRequest(rolloverWorkspace, owner, bounded.id), 409, 'An owner cannot cancel an uncertain outcome.');

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
  const requestsWithoutMoney = (await pool.query('SELECT estimate_micros,actual_micros,budget_month FROM provider_request WHERE workspace_id=ANY($1::text[])', [ownedWorkspaces])).rows;
  assert.ok(requestsWithoutMoney.length > 0);
  assert.ok(requestsWithoutMoney.every(row => row.estimate_micros === null && row.actual_micros === null && row.budget_month === null), 'Every new provider request keeps legacy financial columns NULL.');
  assertNoApiMoney(await listProviders(rolloverWorkspace, owner));
  console.log('PASS cross-month request identity, encrypted persistence, missing keys and atomic key rotation; no provider traffic');
}
