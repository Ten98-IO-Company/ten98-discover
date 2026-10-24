import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { FoundationError } from '../src/server/auth.ts';
import { handleAccountSecurity } from '../src/server/account-security.ts';
import { clientLimitKey, clientRateKey, requestClientAddress, visitorRateKey } from '../src/server/client-rate-limit.ts';
import { getConfig } from '../src/server/config.ts';

const appUrl = 'http://localhost:3000';
const baseEnv = { APP_URL: appUrl, AUTH_SECRET: 'a'.repeat(32), DATABASE_URL: 'postgresql://synthetic@localhost:5432/synthetic' };

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
  assert.match(first, /^signin:client:[A-Za-z0-9_-]{43}$/);
  assert.ok(!first.includes('198.51.100.7'));
  assert.notEqual(clientLimitKey('signin', '198.51.100.7', 'j'.repeat(32)), first, 'the key is a keyed hash, not a plain digest');
  assert.equal(clientLimitKey('signin', null, 'k'.repeat(32)), 'signin:client:unresolved');
  assert.equal(clientRateKey(new Request(`${appUrl}/api/auth/sign-in/email`, { headers: { 'x-forwarded-for': '198.51.100.7' } }), 'signin', baseEnv), 'signin:client:unresolved', 'headers never stand in for a missing transport');
});

test('IPv6 clients are keyed per /56 network and IPv4 per address, through the runtime clientLimitKey', () => {
  const key = (address: string | null, scope = 'signin') => clientLimitKey(scope, address, 'k'.repeat(32));
  // 2001:db8:0:00xx::/56 holds the first 56 bits; the low byte of the fourth group and the interface id stay inside it.
  const network = key('2001:db8:0:ff::1');
  for (const address of ['2001:db8::1', '2001:db8:0:1::', '2001:db8:0:aa:ffff:ffff:ffff:ffff', '2001:0db8:0000:00ff:0000:0000:0000:0002']) assert.equal(key(address), network, address);
  for (const address of ['2001:db8:0:100::1', '2001:db8:1::1', '2001:db9::1']) assert.notEqual(key(address), network, address);
  assert.match(network, /^signin:client:[A-Za-z0-9_-]{43}$/);
  assert.ok(!network.includes('2001'), 'the key never contains the address or its network');
  assert.notEqual(key('198.51.100.7'), key('198.51.100.8'), 'IPv4 clients are not grouped');
  assert.equal(key('::ffff:198.51.100.7'), key('198.51.100.7'), 'an IPv4-mapped address is its IPv4 client');
  assert.throws(() => key('unknown'), TypeError, 'a placeholder is refused rather than becoming a shared key');
});

test('an unresolved client has its own key per scope, apart from every resolved client and from other scopes', () => {
  const secret = 'k'.repeat(32), scopes = ['setup', 'signin', 'two-factor', 'password-recovery:request', 'password-recovery:reset', 'oidc:start', 'oidc:callback', 'invitations:public'];
  const unresolved = scopes.map(scope => clientLimitKey(scope, null, secret));
  assert.deepEqual(unresolved, scopes.map(scope => `${scope}:client:unresolved`), 'existing scope prefixes are kept');
  assert.equal(new Set(unresolved).size, scopes.length, 'no global key is shared across scopes');
  for (const scope of scopes) for (const address of ['198.51.100.7', '2001:db8::1', '127.0.0.1']) assert.notEqual(clientLimitKey(scope, address, secret), clientLimitKey(scope, null, secret));
});

test('sign-in and setup keys group IPv6 clients behind a trusted proxy by /56', async () => {
  await withTransport(async fromPeer => {
    const env = { ...baseEnv, TRUSTED_PROXIES: '127.0.0.1' };
    const via = (forwarded: string, scope: string) => clientRateKey(fromPeer('/api/auth/sign-in/email', { headers: { 'x-forwarded-for': forwarded } }), scope, env);
    for (const scope of ['signin', 'setup']) {
      assert.equal(via('2001:db8:0:ff::1', scope), via('2001:db8:0:1:abcd::7', scope), `${scope}: one /56 shares a limit`);
      assert.notEqual(via('2001:db8:0:ff::1', scope), via('2001:db8:0:100::1', scope), `${scope}: another /56 does not`);
      assert.equal(via('2001:db8:0:ff::1', scope), clientLimitKey(scope, '2001:db8::', baseEnv.AUTH_SECRET));
    }
    assert.equal(clientRateKey(fromPeer('/api/setup'), 'setup', env), 'setup:client:unresolved', 'a trusted peer without a chain is unresolved');
    assert.equal(clientRateKey(fromPeer('/api/setup', { headers: { 'x-forwarded-for': '2001:db8::1' } }), 'setup', { ...baseEnv, TRUSTED_PROXIES: '10.0.0.0/8' }), clientLimitKey('setup', '127.0.0.1', baseEnv.AUTH_SECRET), 'an untrusted peer cannot choose its key');
  });
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

test('collection per-client keys exist only where an address identifies one visitor', async () => {
  const secretEnv = { AUTH_SECRET: 'a'.repeat(32) };
  await withTransport(async fromPeer => {
    const direct = fromPeer('/api/collect');
    assert.equal(visitorRateKey(direct, 'collector', secretEnv), null, 'with no trusted proxy and no direct mode the peer may be a shared proxy');
    assert.equal(visitorRateKey(new Request(`${appUrl}/api/collect`), 'collector', { ...secretEnv, TRUSTED_PROXIES: '127.0.0.1' }), null, 'an unresolved client gets no shared key');
    assert.equal(visitorRateKey(fromPeer('/api/collect'), 'collector', { ...secretEnv, TRUSTED_PROXIES: '127.0.0.1' }), null, 'a trusted peer without a chain is unresolved');
    assert.equal(visitorRateKey(direct, 'collector', { ...secretEnv, ANALYTICS_NETWORK_MODE: 'direct' }), clientLimitKey('collector', '127.0.0.1', secretEnv.AUTH_SECRET), 'direct mode asserts the peer is the visitor');
    assert.equal(visitorRateKey(direct, 'collector', { ...secretEnv, ANALYTICS_NETWORK_MODE: 'proxy', ANALYTICS_TRUSTED_PROXIES: '10.0.0.1' }), clientLimitKey('collector', '127.0.0.1', secretEnv.AUTH_SECRET), 'the analytics proxy list enables per-client limits');
    // Behind a trusted gateway that appends the real client, a client-supplied left-most entry cannot choose the key.
    const gateway = { ...secretEnv, TRUSTED_PROXIES: '127.0.0.1' }, real = clientLimitKey('collector', '198.51.100.7', secretEnv.AUTH_SECRET);
    const first = visitorRateKey(fromPeer('/api/collect', { headers: { 'x-forwarded-for': '203.0.113.66, 198.51.100.7' } }), 'collector', gateway);
    const second = visitorRateKey(fromPeer('/api/collect', { headers: { 'x-forwarded-for': '192.0.2.44, 198.51.100.7' } }), 'collector', gateway);
    assert.equal(first, real, 'the right-most untrusted entry is the client');
    assert.equal(second, first, 'different spoofed prefixes from the same real client share one key');
    assert.notEqual(first, clientLimitKey('collector', '203.0.113.66', secretEnv.AUTH_SECRET));
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
      assert.equal(counts.get('signin:client:unresolved'), 61);
      assert.deepEqual([...counts.keys()].filter(key => key !== 'signin:client:unresolved').map(key => /^signin:client:[A-Za-z0-9_-]{43}$/.test(key)), [true, true, true]);
    });
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  }
});
