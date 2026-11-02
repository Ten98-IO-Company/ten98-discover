import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { credentialKeys, decryptCredentials, encryptCredentials } from '../src/server/credential-vault.ts';
import { providerAccountCheck, providerRequestDiagnostic, saveProviderRequestControls, saveProvider } from '../src/server/providers.ts';

test('versioned authenticated encryption rejects tampering, missing keys and cross-resource substitution', () => {
  const first = randomBytes(32).toString('base64'), next = randomBytes(32).toString('base64');
  const ring = credentialKeys({ CREDENTIAL_KEYS: JSON.stringify({ first, next }), CREDENTIAL_ACTIVE_KEY: 'first' })!;
  const context = { id: 'connection', workspaceId: 'workspace', provider: 'openrouter', revision: 1 };
  const value = { apiKey: 'synthetic-secret-for-test' };
  const sealed = encryptCredentials(value, context, ring);
  assert.ok(!JSON.stringify(sealed).includes(value.apiKey));
  assert.deepEqual(decryptCredentials(sealed, context, ring), value);
  assert.notDeepEqual(encryptCredentials(value, context, ring), sealed, 'A fresh nonce is required for every encryption.');
  for (const changed of [{ ...context, workspaceId: 'other' }, { ...context, id: 'other' }, { ...context, provider: 'dataforseo' }, { ...context, revision: 2 }]) assert.throws(() => decryptCredentials(sealed, changed, ring), { status: 503 });
  assert.throws(() => decryptCredentials({ ...sealed, ciphertext: Buffer.alloc(40).toString('base64') }, context, ring), { status: 503 });
  const shortenedTag = Buffer.from(sealed.tag, 'base64').subarray(0, 4).toString('base64').padEnd(24, ' ');
  assert.throws(() => decryptCredentials({ ...sealed, tag: shortenedTag }, context, ring), { status: 503 }, 'A padded 32-bit tag must not weaken GCM authentication.');
  assert.throws(() => decryptCredentials({ ...sealed, ciphertext: `${sealed.ciphertext}\n` }, context, ring), { status: 503 }, 'Envelope base64 must be canonical.');
  const rotated = { ...ring, active: 'next' };
  assert.deepEqual(decryptCredentials(sealed, context, rotated), value);
  const resealed = encryptCredentials(decryptCredentials(sealed, context, rotated), context, rotated);
  assert.equal(resealed.keyId, 'next');
  assert.deepEqual(decryptCredentials(resealed, context, { active: 'next', keys: new Map([['next', Buffer.from(next, 'base64')]]) }), value);
  assert.throws(() => decryptCredentials(sealed, context, null), { status: 503 });
  assert.equal(credentialKeys({}), null);
  assert.throws(() => credentialKeys({ CREDENTIAL_KEYS: JSON.stringify({ first: 'not-a-key' }), CREDENTIAL_ACTIVE_KEY: 'first' }));
  assert.throws(() => credentialKeys({ CREDENTIAL_KEYS: JSON.stringify({ first }), CREDENTIAL_ACTIVE_KEY: 'missing' }));
});

test('credential encryption refuses data that its bounded decryptor could not restore', () => {
  const ring = credentialKeys({ CREDENTIAL_KEYS: JSON.stringify({ test: randomBytes(32).toString('base64') }), CREDENTIAL_ACTIVE_KEY: 'test' })!;
  const context = { id: 'connection', workspaceId: 'workspace', provider: 'openrouter', revision: 1 };
  const maximum = 'x'.repeat(17_998); // JSON string quotes bring this to exactly 18,000 UTF-8 bytes.
  const sealed = encryptCredentials(maximum, context, ring);
  assert.equal(sealed.ciphertext.length, 24_000);
  assert.equal(decryptCredentials(sealed, context, ring), maximum);
  for (const oversized of [`${maximum}x`, '€'.repeat(6000), { apiKey: '\u0000'.repeat(4096) }]) {
    assert.throws(() => encryptCredentials(oversized, context, ring), { status: 400 }, 'Reject excessive encoded credentials before persistence.');
  }
});

test('financial fields and malformed request controls are refused before database access', async () => {
  const connection = { name: 'Synthetic', credentials: { apiKey: 'never-read' } };
  for (const amount of ['0', '10', '1e3', null]) {
    await assert.rejects(saveProvider(randomUUID(), randomUUID(), { ...connection, provider: 'openrouter', monthlyLimitUsd: amount }), { name: 'ZodError' });
    await assert.rejects(saveProvider(randomUUID(), randomUUID(), { ...connection, monthlyLimitUsd: amount }, randomUUID()), { name: 'ZodError' });
    await assert.rejects(saveProviderRequestControls(randomUUID(), randomUUID(), { paused: true, monthlyLimitUsd: amount }), { name: 'ZodError' });
  }
  for (const input of [{ paused: 'yes' }, { paused: false, extra: true }, {}, null]) await assert.rejects(saveProviderRequestControls(randomUUID(), randomUUID(), input), { name: 'ZodError' });
});

test('provider account checks use fixed read-only URLs, reject redirects, bound responses and redact errors', async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const send = (body: unknown, status = 200) => (async (url, init) => { calls.push({ url: String(url), init }); return Response.json(body, { status }); }) as typeof fetch;
  const secret = 'private-test-value';
  assert.equal((await providerAccountCheck('openrouter', { apiKey: secret }, send({ data: { is_free_tier: false } }))).checkStatus, 'ok');
  assert.equal(calls[0].url, 'https://openrouter.ai/api/v1/key');
  assert.equal(calls[0].init?.redirect, 'error');
  assert.equal(calls[0].init?.method, undefined);
  assert.equal(calls[0].init?.credentials, 'omit');
  assert.equal((await providerAccountCheck('dataforseo', { login: 'test@example.test', password: secret }, send({ status_code: 20000, tasks: [{ status_code: 20000, result: [{}] }] }))).checkStatus, 'ok');
  assert.equal(calls[1].url, 'https://api.dataforseo.com/v3/appendix/user_data');
  // Each provider sends only its own credential: OpenRouter's bearer comes from openRouterFetch; DataForSEO's request is unchanged Basic auth.
  assert.equal(new Headers(calls[0].init?.headers).get('authorization'), `Bearer ${secret}`);
  const { signal, ...dataForSeoInit } = calls[1].init ?? {};
  assert.ok(signal instanceof AbortSignal);
  assert.deepEqual(dataForSeoInit, { headers: { authorization: `Basic ${Buffer.from(`test@example.test:${secret}`).toString('base64')}`, accept: 'application/json' }, redirect: 'error', credentials: 'omit' });
  assert.equal((await providerAccountCheck('openrouter', { apiKey: secret }, send({ data: {} }))).checkStatus, 'ok', 'Accepted credentials do not require any funding or financial account metadata.');
  for (const status of [401,403,429,500]) {
    const result = await providerAccountCheck('openrouter', { apiKey: secret }, send({ error: secret }, status));
    assert.equal(result.checkStatus, 'error'); assert.ok(!JSON.stringify(result).includes(secret));
  }
  for (const body of [{}, { data: 'wrong' }, { data: { is_free_tier: false }, excess: 'a'.repeat(1_048_576) }]) assert.equal((await providerAccountCheck('openrouter', { apiKey: secret }, send(body))).checkStatus, 'error');
  const failure = await providerAccountCheck('openrouter', { apiKey: secret }, (async () => { throw new Error(secret); }) as typeof fetch);
  assert.ok(!JSON.stringify(failure).includes(secret));
});

test('provider credential validation rejects strings the shared authenticated transport cannot send',async()=>{
  let calls=0;const send:typeof fetch=async()=>{calls++;return Response.json({});};
  for(const password of ['bad\0secret','bad\tsecret','bad\u007fsecret','bad\ud800secret']){
    await assert.rejects(providerAccountCheck('dataforseo',{login:'synthetic@example.com',password},send),{name:'ZodError'});
  }
  assert.equal(calls,0);
});

test('historical financial diagnostics project to request outcomes while technical failures remain actionable',()=>{
 for(const diagnostic of ['Charge recovered; unavailable content is not recreated.','No credit left','Wallet unavailable','Billing declined','Price changed','USD 0.01 incurred','$0.01 estimate'])assert.equal(providerRequestDiagnostic(diagnostic),'Inspect the original provider request for its outcome and available results.');
 for(const diagnostic of ['The provider timed out.','Connection credentials changed.','No result was returned.'])assert.equal(providerRequestDiagnostic(diagnostic),diagnostic);
 for(const missing of [null,undefined,'',42])assert.equal(providerRequestDiagnostic(missing),null);
 assert.equal(providerRequestDiagnostic('Old charge text','uncertain'),'The original provider request outcome is unknown. Check this request before starting it again.');
});
