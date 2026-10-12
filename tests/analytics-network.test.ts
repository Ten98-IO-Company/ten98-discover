import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { extractAnalyticsPeer, resolveAnalyticsNetwork, validateAnalyticsNetworkConfig } from '../src/server/analytics-network.ts';

function request(forwarded?: string) {
  return new Request('http://localhost/api/collect', { headers: forwarded === undefined ? {} : { 'x-forwarded-for': forwarded } });
}
const direct = { ANALYTICS_NETWORK_MODE: 'direct' };
const proxy = { ANALYTICS_NETWORK_MODE: 'proxy', ANALYTICS_TRUSTED_PROXIES: '10.0.0.0/24,2001:db8:1::/48' };

test('network identity defaults off, and direct mode ignores all forwarding headers', () => {
  assert.equal(resolveAnalyticsNetwork(request('203.0.113.2'), '192.0.2.1', {}), null);
  assert.equal(resolveAnalyticsNetwork(request('203.0.113.2'), '192.0.2.1', direct), '192.0.2.1');
  assert.equal(resolveAnalyticsNetwork(request('malformed'), '2001:0db8:0:0::1', direct), '2001:db8::1');
  assert.equal(resolveAnalyticsNetwork(request('192.0.2.1'), undefined, direct), null);
  const fakeHeaders = new Request('http://localhost/', { headers: { 'cf-connecting-ip': '192.0.2.1', 'x-real-ip': '192.0.2.2', forwarded: 'for=192.0.2.3' } });
  assert.equal(resolveAnalyticsNetwork(fakeHeaders, undefined, direct), null);
});

test('proxy mode resolves right to left only behind a trusted transport peer', () => {
  assert.equal(resolveAnalyticsNetwork(request('198.51.100.4, 203.0.113.8, 10.0.0.2'), '10.0.0.3', proxy), '203.0.113.8');
  assert.equal(resolveAnalyticsNetwork(request('198.51.100.4, 10.0.0.2'), '10.0.0.3', proxy), '198.51.100.4');
  assert.equal(resolveAnalyticsNetwork(request('198.51.100.4'), '192.0.2.9', proxy), null);
  assert.equal(resolveAnalyticsNetwork(request('198.51.100.4'), undefined, proxy), null);
  assert.equal(resolveAnalyticsNetwork(request(), '10.0.0.3', proxy), null);
  assert.equal(resolveAnalyticsNetwork(request('10.0.0.2, 10.0.0.1'), '10.0.0.3', proxy), null);
});

test('mapped IPv4 and ordinary IPv6 use canonical identities and matching proxy ranges', () => {
  for (const ip of ['::ffff:192.0.2.3', '::ffff:c000:203']) assert.equal(resolveAnalyticsNetwork(request(), ip, direct), '192.0.2.3');
  assert.equal(resolveAnalyticsNetwork(request('::ffff:c000:203, ::ffff:a00:2'), '::ffff:a00:3', proxy), '192.0.2.3');
  assert.equal(resolveAnalyticsNetwork(request('2001:db8:2::1, 2001:db8:1::4'), '2001:db8:1::8', proxy), '2001:db8:2::1');
  const mapped = { ANALYTICS_NETWORK_MODE: 'proxy', ANALYTICS_TRUSTED_PROXIES: '::ffff:0a00:0000/120' };
  assert.equal(resolveAnalyticsNetwork(request('192.0.2.1'), '10.0.0.3', mapped), '192.0.2.1');
  const exact = { ANALYTICS_NETWORK_MODE: 'proxy', ANALYTICS_TRUSTED_PROXIES: '::ffff:10.0.0.3' };
  assert.equal(resolveAnalyticsNetwork(request('192.0.2.1'), '10.0.0.3', exact), '192.0.2.1');
  assert.equal(resolveAnalyticsNetwork(request('192.0.2.1'), '10.0.0.4', exact), null);
});

test('malformed, nonliteral and oversized forwarding chains remain unknown', () => {
  for (const value of [
    'unknown', '192.0.2.1:80', '[2001:db8::1]:80', '"192.0.2.1"', 'fe80::1%eth0',
    '010.0.0.1', 'example.test', '192.0.2.1,,10.0.0.2', 'garbage,192.0.2.1', '\u00a0192.0.2.1',
    '192.0.2.1,' + ' '.repeat(4096) + '10.0.0.2', Array(21).fill('192.0.2.1').join(','),
  ]) assert.equal(resolveAnalyticsNetwork(request(value), '10.0.0.3', proxy), null);
  assert.equal(resolveAnalyticsNetwork(request(Array(20).fill('192.0.2.1').join(',')), '10.0.0.3', proxy), '192.0.2.1');
  for (const peer of ['', ' 192.0.2.1', '192.0.2.1:80', '[::1]', 'fe80::1%2', 'unknown']) {
    assert.equal(resolveAnalyticsNetwork(request('192.0.2.1'), peer, direct), null);
  }
});

test('invalid configuration fails closed with redacted errors even when mode is off', () => {
  const invalid = [
    { ANALYTICS_NETWORK_MODE: 'secret-sentinel' }, { ANALYTICS_NETWORK_MODE: '' },
    { ANALYTICS_NETWORK_MODE: 'proxy' },
    { ANALYTICS_TRUSTED_PROXIES: 'secret-sentinel' }, { ANALYTICS_TRUSTED_PROXIES: '10.0.0.1,,10.0.0.2' },
    ...['10.0.0.0/33', '2001:db8::/129', '10.0.0.1/-1', '10.0.0.0/01', '::ffff:10.0.0.1/24', 'fe80::1%eth0', '10.0.0.0/24/1'].map(ANALYTICS_TRUSTED_PROXIES => ({ ANALYTICS_TRUSTED_PROXIES })),
    { ANALYTICS_TRUSTED_PROXIES: Array(33).fill('10.0.0.1').join(',') },
    { ANALYTICS_TRUSTED_PROXIES: ' '.repeat(4097) },
  ];
  for (const env of invalid) {
    assert.throws(() => validateAnalyticsNetworkConfig(env), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ANALYTICS_NETWORK_CONFIG' && error.message === 'Invalid analytics network configuration.');
    assert.throws(() => resolveAnalyticsNetwork(request(), '192.0.2.1', env));
  }
  assert.doesNotThrow(() => validateAnalyticsNetworkConfig({ ANALYTICS_TRUSTED_PROXIES: Array(32).fill('10.0.0.1').join(',') }));
});

test('inherited or accessor metadata cannot invent transport or enable a mode', () => {
  let calls = 0;
  const inherited = Object.create({ ANALYTICS_NETWORK_MODE: 'direct' });
  assert.equal(resolveAnalyticsNetwork(request(), '192.0.2.1', inherited), null);
  const env = Object.defineProperty({}, 'ANALYTICS_NETWORK_MODE', { get() { calls++; return 'direct'; } });
  assert.throws(() => validateAnalyticsNetworkConfig(env));
  const original = request('198.51.100.1');
  assert.equal(extractAnalyticsPeer(original), undefined);
  Object.defineProperty(original, 'runtime', { get() { calls++; return {}; } });
  assert.equal(extractAnalyticsPeer(original), undefined);
  const fabricated = Object.assign(request(), { runtime: { name: 'node', node: { req: { socket: { remoteAddress: '192.0.2.1' } } } } });
  assert.equal(extractAnalyticsPeer(fabricated), undefined);
  const fakeSocket = Object.create(Socket.prototype);
  Object.defineProperty(fakeSocket, 'remoteAddress', { get() { throw new Error('No real socket'); } });
  const broken = Object.assign(request(), { runtime: { name: 'node', node: { req: { socket: fakeSocket } } } });
  assert.equal(extractAnalyticsPeer(broken), undefined);
  assert.equal(calls, 0);
});

test('original Node transport yields the socket peer and a plain clone loses it', async () => {
  let result: string | undefined;
  let cloned: string | undefined = 'unset';
  const server = createServer((req, res) => {
    const original = Object.assign(request('203.0.113.99'), { runtime: { name: 'node', node: { req } } });
    result = extractAnalyticsPeer(original);
    cloned = extractAnalyticsPeer(new Request(original));
    res.end('ok');
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    await response.text();
    assert.equal(result, '127.0.0.1');
    assert.equal(cloned, undefined);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
