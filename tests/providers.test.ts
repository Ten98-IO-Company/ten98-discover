import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { credentialKeys, decryptCredentials, encryptCredentials } from '../src/server/credential-vault.ts';
import { providerAccountCheck, saveBudget, saveProvider, usd, usdMicros } from '../src/server/providers.ts';
import { reserveSpend, settleSpend } from '../src/server/spending.ts';

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

test('USD micro-unit arithmetic preserves cents and rejects ambiguous or unbounded amounts', () => {
  assert.equal(usdMicros('0.000001'), 1n);
  assert.equal(usd(usdMicros('10.20') + usdMicros('0.000001')), '10.200001');
  assert.equal(usdMicros('1000000'), 1_000_000_000_000n);
  for (const value of ['-1','01','1e3','NaN','1,000',' 1','1.0000001','1000000.000001','','1\n','1.2\r','1.25\u2028']) assert.throws(() => usdMicros(value), { name: 'ZodError' }, 'Bad money must be a validation error, not a native BigInt failure.');
});

test('settlement rejects trailing line terminators before reading or changing a financial receipt', async () => {
  for (const amount of ['1\n','1.2\r','1.25\u2028','0.1\u2029']) {
    await assert.rejects(settleSpend(null as never, randomUUID(), randomUUID(), amount), {name:'ZodError'});
  }
});

test('reservation validation rejects malformed and zero estimates before touching the database', async () => {
  for (const estimateUsd of ['1e3', 'NaN', 'x', '0', '0.000000']) {
    await assert.rejects(reserveSpend(randomUUID(), randomUUID(), { connectionId: randomUUID(), requestKey: randomUUID(), operation: 'unit.check', inputHash: 'a'.repeat(64), estimateUsd }), { name: 'ZodError' });
  }
});

// Owner decision D3: the cap route and fields are gone; strict schemas refuse them instead of ignoring them.
test('removed cap fields and malformed pause bodies are refused before database access', async () => {
  const connection = { name: 'Synthetic', credentials: { apiKey: 'never-read' } };
  for (const amount of ['0', '10', '1e3', null]) {
    await assert.rejects(saveProvider(randomUUID(), randomUUID(), { ...connection, provider: 'openrouter', monthlyLimitUsd: amount }), { name: 'ZodError' });
    await assert.rejects(saveProvider(randomUUID(), randomUUID(), { ...connection, monthlyLimitUsd: amount }, randomUUID()), { name: 'ZodError' });
    await assert.rejects(saveBudget(randomUUID(), randomUUID(), { paused: true, monthlyLimitUsd: amount }), { name: 'ZodError' });
  }
  for (const input of [{ paused: 'yes' }, { paused: false, extra: true }, {}, null]) await assert.rejects(saveBudget(randomUUID(), randomUUID(), input), { name: 'ZodError' });
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
