import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

test('tracker sends one path-only event without cookies when embedded twice', async () => {
  const sent: { url: URL; options: RequestInit }[] = [];
  const source = readFileSync(new URL('../public/tracker.js', import.meta.url), 'utf8');
  const context = {
    window: {}, URL, Set, crypto: webcrypto, console,
    location: { origin: 'https://site.example', pathname: '/products', search: '?email=private', hash: '#private' },
    document: { currentScript: { src: 'https://monitor.example/tracker.js', getAttribute: (name: string) => name === 'data-site-key' ? 'public-site-key' : null } },
    fetch: async (url: URL, options: RequestInit) => { sent.push({ url, options }); return { ok: true }; },
  };
  runInNewContext(source, context);
  runInNewContext(source, context);
  await Promise.resolve();
  assert.equal(sent.length, 1);
  assert.equal(String(sent[0].url), 'https://monitor.example/api/collect');
  assert.equal(sent[0].options.credentials, 'omit');
  const body = JSON.parse(String(sent[0].options.body));
  assert.equal(body.url, 'https://site.example/products');
  assert.equal(body.name, 'page_view');
  assert.equal(body.siteKey, 'public-site-key');
  assert.match(body.eventId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.ok(!JSON.stringify(body).includes('private'));
});

test('tracker with no embedding script does not attempt ingestion', () => {
  runInNewContext(readFileSync(new URL('../public/tracker.js', import.meta.url), 'utf8'), {
    document: { currentScript: null },
    fetch: () => assert.fail('No script means no configured destination'),
  });
});
