import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Resolver } from 'node:dns/promises';
import test from 'node:test';
import { FoundationError } from '../src/server/auth.ts';
import { hasDomainProof, lookupDomainTxt, normalizeDomainHost } from '../src/server/domains.ts';

test('domain normalization preserves the exact host and canonicalizes IDNs', () => {
  assert.equal(normalizeDomainHost('Alias.Example.COM.'), 'alias.example.com');
  assert.equal(normalizeDomainHost('bücher.example.com'), 'xn--bcher-kva.example.com');
  assert.equal(normalizeDomainHost('www。example.com'), 'www.example.com');
  assert.equal(normalizeDomainHost('xn--bcher-kva.example.com'), 'xn--bcher-kva.example.com');
  assert.equal(normalizeDomainHost('a-b.example.com'), 'a-b.example.com');
});

test('domain fields reject URLs, ambiguous labels, IP spellings and local names', () => {
  const invalid: unknown[] = [null, {}, '', ' example.com', 'example.com\n', 'https://example.com', 'user@example.com',
    'example.com:443', 'example.com/path', 'example.com\\path', 'example.com?query', 'example.com#hash', '*.example.com',
    '_ten98-challenge.example.com', 'ex%61mple.com', '-x.example.com', 'x-.example.com', 'example..com', 'example.com..',
    'localhost', 'foo.localhost', 'local', 'example.local', 'example.internal', 'foo.home.arpa', 'foo.invalid', 'foo.test',
    'foo.onion', '127.0.0.1', '10.1.2.3', '8.8.8.8', '[::1]', '::1', '2130706433', '0x7f000001', '0177.0.0.1',
    '127.1', 'example.123', 'xn--.example.com', `${'x'.repeat(64)}.example.com`, '\u0000example.com',
    `${'x'.repeat(63)}.${'x'.repeat(63)}.${'x'.repeat(63)}.${'x'.repeat(48)}.com`];
  for (const host of invalid) assert.throws(() => normalizeDomainHost(host), error => error instanceof FoundationError && error.status === 400, String(host));
});

test('TXT proof joins one record fragments but never joins unrelated records or accepts a prefix', () => {
  const token = 'ten98-verification=project.domain.random-value';
  const hash = createHash('sha256').update(token).digest('hex');
  assert.equal(hasDomainProof([[token]], hash), true);
  assert.equal(hasDomainProof([['unrelated'], [token.slice(0, 16), token.slice(16)]], hash), true);
  for (const records of [[], [[token.slice(0, 16)], [token.slice(16)]], [[`${token}\n`]], [[`prefix${token}`]], [[`${token}suffix`]], [[`"${token}"`]]]) {
    assert.equal(hasDomainProof(records, hash), false);
  }
  assert.equal(hasDomainProof([[token]], createHash('sha256').update('another challenge').digest('hex')), false);
});

test('TXT proof bounds response shape and aggregate bytes', () => {
  const token = 'ten98-verification=project.domain.random-value';
  const hash = createHash('sha256').update(token).digest('hex');
  assert.equal(hasDomainProof(Array.from({ length: 65 }, () => [token]), hash), false);
  assert.equal(hasDomainProof([[token], ['x'.repeat(65_536)]], hash), false);
  assert.equal(hasDomainProof([Array.from({ length: 257 }, () => '')], hash), false);
  assert.equal(hasDomainProof([[123]] as unknown as string[][], hash), false);
  assert.equal(hasDomainProof([[token]], 'invalid'), false);
  assert.equal(hasDomainProof([[token]], `${hash}\n`), false);
});

test('DNS deadline cancels only each request resolver and returns a bounded error', async context => {
  const resolvers = new Set<Resolver>(), cancelled = new Set<Resolver>();
  context.mock.method(Resolver.prototype, 'resolveTxt', function(this: Resolver, name: string) {
    assert.ok(name.startsWith('_ten98-challenge.')); resolvers.add(this);
    return new Promise<string[][]>(() => undefined);
  });
  context.mock.method(Resolver.prototype, 'cancel', function(this: Resolver) { cancelled.add(this); });
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const first = assert.rejects(lookupDomainTxt('_ten98-challenge.first.example.com'), (error: unknown) => (error as { code?: string }).code === 'ETIMEOUT');
  const second = assert.rejects(lookupDomainTxt('_ten98-challenge.second.example.com'), (error: unknown) => (error as { code?: string }).code === 'ETIMEOUT');
  context.mock.timers.tick(5000);
  await Promise.all([first, second]);
  assert.equal(resolvers.size, 2);
  assert.deepEqual(cancelled, resolvers);
});

test('successful DNS lookup clears its deadline without cancelling completed work', async context => {
  context.mock.method(Resolver.prototype, 'resolveTxt', async () => [['mocked TXT']]);
  const cancel = context.mock.method(Resolver.prototype, 'cancel', () => undefined);
  context.mock.timers.enable({ apis: ['setTimeout'] });
  assert.deepEqual(await lookupDomainTxt('_ten98-challenge.success.example.com'), [['mocked TXT']]);
  context.mock.timers.tick(5000);
  assert.equal(cancel.mock.callCount(), 0);
});
