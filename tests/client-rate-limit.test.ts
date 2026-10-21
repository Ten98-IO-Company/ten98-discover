import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { FoundationError } from '../src/server/auth.ts';
import { handleAccountSecurity } from '../src/server/account-security.ts';
import { clientLimitKey, clientRateKey, requestClientAddress } from '../src/server/client-rate-limit.ts';
import { getConfig } from '../src/server/config.ts';

const appUrl = 'http://localhost:3000';
const baseEnv = { APP_URL: appUrl, AUTH_SECRET: 'a'.repeat(32), BOOTSTRAP_TOKEN: 'b'.repeat(32), DATABASE_URL: 'postgresql://synthetic@localhost:5432/synthetic' };

// Runs the check with a Request carrying a real loopback Node transport, as srvx supplies it.
async function withTransport(check: (fromPeer: (path: string, init?: RequestInit) => Request) => Promise<void>) {
  let failure: unknown;
  const server = createServer((req: IncomingMessage, res) => {
    const fromPeer = (path: string, init?: RequestInit) => Object.assign(new Request(new URL(path, appUrl), init), { runtime: { name: 'node', node: { req } } });
    check(fromPeer).catch(error => { failure = error; }).finally(() => res.end('ok'));
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  try {
    await (await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)).text();
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
  if (failure) throw failure;
}

test('per-client limit keys separate clients, keep no address and give unknown clients one conservative key', () => {
  const first = clientLimitKey('signin', '198.51.100.7', 'k'.repeat(32)), second = clientLimitKey('signin', '198.51.100.8', 'k'.repeat(32));
  assert.notEqual(first, second);
  assert.equal(clientLimitKey('signin', '198.51.100.7', 'k'.repeat(32)), first);
  assert.match(first, /^signin:client:[0-9a-f]{64}$/);
  assert.ok(!first.includes('198.51.100.7'));
  assert.notEqual(clientLimitKey('signin', '198.51.100.7', 'j'.repeat(32)), first, 'the key is a keyed hash, not a plain digest');
  assert.equal(clientLimitKey('signin', null, 'k'.repeat(32)), 'signin:client:unknown');
  assert.equal(clientRateKey(new Request(`${appUrl}/api/auth/sign-in/email`, { headers: { 'x-forwarded-for': '198.51.100.7' } }), 'signin', baseEnv), 'signin:client:unknown', 'headers never stand in for a missing transport');
});

test('forwarding headers are honoured only from configured trusted proxies', async () => {
  await withTransport(async fromPeer => {
    const spoofed = fromPeer('/api/auth/sign-in/email', { headers: { 'x-forwarded-for': '198.51.100.7' } });
    assert.equal(requestClientAddress(spoofed, {}), '127.0.0.1', 'without trusted proxies the transport peer is the client');
    assert.equal(requestClientAddress(spoofed, { TRUSTED_PROXIES: '10.0.0.0/8' }), '127.0.0.1', 'an untrusted peer cannot choose its key');
    assert.equal(requestClientAddress(spoofed, { TRUSTED_PROXIES: '127.0.0.1' }), '198.51.100.7');
    const chained = fromPeer('/', { headers: { 'x-forwarded-for': '203.0.113.9, 198.51.100.7, 127.0.0.1' } });
    assert.equal(requestClientAddress(chained, { TRUSTED_PROXIES: '127.0.0.0/8' }), '198.51.100.7', 'the right-most untrusted hop is the client');
    assert.equal(requestClientAddress(fromPeer('/'), { TRUSTED_PROXIES: '127.0.0.1' }), null, 'a trusted peer without a chain is unknown');
    assert.equal(requestClientAddress(fromPeer('/', { headers: { 'x-forwarded-for': 'malformed' } }), { TRUSTED_PROXIES: '127.0.0.1' }), null);
    assert.equal(requestClientAddress(spoofed, { ANALYTICS_TRUSTED_PROXIES: '127.0.0.1' }), '198.51.100.7', 'the analytics proxy list applies when TRUSTED_PROXIES is unset');
    assert.equal(requestClientAddress(spoofed, { TRUSTED_PROXIES: '10.0.0.0/8', ANALYTICS_TRUSTED_PROXIES: '127.0.0.1' }), '127.0.0.1', 'an explicit TRUSTED_PROXIES wins');
  });
});

test('TRUSTED_PROXIES is validated with the application configuration without echoing it', () => {
  assert.doesNotThrow(() => getConfig(baseEnv));
  assert.doesNotThrow(() => getConfig({ ...baseEnv, TRUSTED_PROXIES: '172.16.0.0/12, ::1' }));
  for (const value of ['not-an-address', '10.0.0.0/33', Array(33).fill('10.0.0.1').join(',')]) {
    assert.throws(() => getConfig({ ...baseEnv, TRUSTED_PROXIES: value }), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'CLIENT_ADDRESS_CONFIG' && !error.message.includes(value));
  }
});

test('sign-in limits count per client, and the same client is still limited', async () => {
  const previous = { ...process.env };
  Object.assign(process.env, baseEnv, { TRUSTED_PROXIES: '127.0.0.1' });
  const counts = new Map<string, number>();
  const accountKeys: string[] = [];
  // Counts like request_limit within one minute; the per-account key ends the request before the database transaction.
  const limit = async (key: string, maximum: number) => {
    if (!key.includes(':client:')) { accountKeys.push(key); throw new Error('reached account limit'); }
    const count = (counts.get(key) ?? 0) + 1;
    counts.set(key, count);
    if (count > maximum) throw new FoundationError(429, 'Too many requests. Wait a minute and try again.');
  };
  const signIn = (make: (path: string, init?: RequestInit) => Request, client?: string) => handleAccountSecurity(make('/api/auth/sign-in/email', {
    method: 'POST',
    headers: { origin: appUrl, 'content-type': 'application/json', ...(client ? { 'x-forwarded-for': client } : {}) },
    body: JSON.stringify({ email: `${crypto.randomUUID()}@client-rate-limit.test`, password: 'Synthetic password 123' }),
  }), limit).then(() => 'completed', (error: unknown) => error instanceof FoundationError ? error.status : (error as Error).message);
  try {
    await withTransport(async fromPeer => {
      for (let index = 0; index < 60; index++) assert.equal(await signIn(fromPeer, '198.51.100.7'), 'reached account limit');
      assert.equal(await signIn(fromPeer, '198.51.100.7'), 429);
      assert.equal(await signIn(fromPeer, '198.51.100.8'), 'reached account limit', 'another client keeps its own budget');
      assert.equal(accountKeys.length, 61, 'per-account limits still apply after the client limit');
      const plain = (path: string, init?: RequestInit) => new Request(new URL(path, appUrl), init);
      for (let index = 0; index < 60; index++) assert.equal(await signIn(plain), 'reached account limit');
      assert.equal(await signIn(plain), 429, 'unknown clients share one conservative key');
      assert.equal(await signIn(fromPeer, '198.51.100.9'), 'reached account limit', 'the unknown key does not limit resolved clients');
      assert.equal(counts.get('signin:client:unknown'), 61);
      assert.deepEqual([...counts.keys()].filter(key => key !== 'signin:client:unknown').map(key => /^signin:client:[0-9a-f]{64}$/.test(key)), [true, true, true]);
    });
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  }
});
