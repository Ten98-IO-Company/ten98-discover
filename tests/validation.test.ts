import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import { InputError, eventInput, eventPath, normalizeOrigin, projectInput, readJson } from '../src/server/validation.ts';

const ID1 = '123e4567-e89b-42d3-a456-426614174000';
const ID2 = '123e4567-e89b-42d3-a456-426614174001';
type Body = string | Uint8Array[] | ReadableStream<Uint8Array> | null;

function makeRequest(body: Body, headers: Record<string, string> = { 'content-type': 'application/json' }): Request {
  const init = { method: 'POST' } as RequestInit & { duplex?: 'half' };
  if (typeof body === 'string') init.body = body;
  else if (body !== null) {
    init.body = body instanceof ReadableStream ? body : new ReadableStream<Uint8Array>({
      start(c) { for (const chunk of body) c.enqueue(chunk); c.close(); },
    });
    init.duplex = 'half';
  }
  const request = new Request('http://test/', init);
  // content-length is a forbidden header and gets stripped from Request init; patch it on afterwards.
  Object.defineProperty(request, 'headers', { value: new Headers(headers) });
  return request;
}

const isStatus = (status: number) => (e: unknown) => e instanceof InputError && e.status === status;

test('normalizeOrigin accepts/normalizes http(s), unicode host, loopback', () => {
  assert.equal(normalizeOrigin('http://example.com'), 'http://example.com');
  assert.equal(normalizeOrigin('https://EXAMPLE.com/'), 'https://example.com');
  assert.equal(normalizeOrigin('http://example.com:80/'), 'http://example.com');
  assert.equal(normalizeOrigin('http://münchen.de'), 'http://xn--mnchen-3ya.de');
  assert.equal(normalizeOrigin('http://localhost:3000/'), 'http://localhost:3000');
  assert.equal(normalizeOrigin('http://127.0.0.1:8787'), 'http://127.0.0.1:8787');
});

test('normalizeOrigin rejects path/query/hash/credentials/non-http/empty/oversize as 400', () => {
  const rejected = ['', 'example.com', 'not a url', 'ftp://example.com',
    'http://user@example.com', 'http://user:pass@example.com', 'http://example.com/path',
    'http://example.com?x=1', 'http://example.com#frag', 'http://example.com/' + 'a'.repeat(2050)];
  for (const input of rejected) assert.throws(() => normalizeOrigin(input), isStatus(400));
});

test('projectInput trims name, normalizes origin, rejects blank name/unknown keys/bad origin', () => {
  assert.deepEqual(projectInput.parse({ name: '  site  ', origin: 'http://Example.COM:8080/' }),
    { name: 'site', origin: 'http://example.com:8080' });
  assert.throws(() => projectInput.parse({ name: '   ', origin: 'http://a.com' }), z.ZodError);
  assert.throws(() => projectInput.parse({ name: 'a', origin: 'http://a.com', extra: 1 }), z.ZodError);
  assert.throws(() => projectInput.parse({ name: 'a', origin: 'https://a.com/x' }), isStatus(400));
});

test('eventInput accepts a valid page_view; url may carry query/hash', () => {
  const parsed = eventInput.parse({ siteKey: ID1, eventId: ID2, name: 'page_view', url: 'https://a.com/p?q=1#f' });
  assert.equal(parsed.url, 'https://a.com/p?q=1#f');
});

test('eventInput rejects bad name/uuid/url/unknown keys', () => {
  const base = { siteKey: ID1, eventId: ID2, name: 'page_view', url: 'https://a.com/' };
  assert.equal(eventInput.parse({ ...base, name: 'signup.complete' }).name, 'signup.complete');
  for (const name of ['', 'with spaces', '1starts-with-number', 'x'.repeat(65), 'line\nbreak', 'signup\n', 'signup\r', 'signup\u2028', 'signup\u2029']) {
    assert.throws(() => eventInput.parse({ ...base, name }), z.ZodError);
  }
  assert.throws(() => eventInput.parse({ ...base, siteKey: 'nope' }), z.ZodError);
  assert.throws(() => eventInput.parse({ ...base, url: 'ftp://a.com/' }), z.ZodError);
  assert.throws(() => eventInput.parse({ ...base, url: 'https://u:p@a.com/' }), z.ZodError);
  assert.throws(() => eventInput.parse({ ...base, url: 'notaurl' }), z.ZodError);
  assert.throws(() => eventInput.parse({ ...base, extra: 1 }), z.ZodError);
});

test('eventPath returns pathname only, dropping query and hash', () => {
  assert.equal(eventPath('https://a.com/p/x?q=1#frag'), '/p/x');
  assert.equal(eventPath('https://a.com/'), '/');
});

test('readJson parses valid json with charset parameter', async () => {
  const r = makeRequest('{"a":1}', { 'content-type': 'application/json; charset=utf-8' });
  assert.deepEqual(await readJson(r), { a: 1 });
});

test('readJson rejects wrong or missing content-type as 415', async () => {
  await assert.rejects(readJson(makeRequest('{}', { 'content-type': 'text/plain' })), isStatus(415));
  await assert.rejects(readJson(makeRequest('{}', {})), isStatus(415));
});

test('readJson validates content-length: honest oversize 413, malformed 400', async () => {
  const h = { 'content-type': 'application/json', 'content-length': '9000' };
  await assert.rejects(readJson(makeRequest('{}', h), 100), isStatus(413));
  await assert.rejects(readJson(makeRequest('{}', { ...h, 'content-length': '1.5' })), isStatus(400));
});

test('readJson bounds real bytes despite lying content-length, without leaking body', async () => {
  const chunk = new TextEncoder().encode(`{"s":"${'SECRET-'.repeat(30)}"}`);
  const r = makeRequest([chunk], { 'content-type': 'application/json', 'content-length': '10' });
  await assert.rejects(readJson(r, 64), (e: unknown) => {
    assert.ok(e instanceof InputError);
    assert.equal(e.status, 413);
    assert.ok(!e.message.includes('SECRET'));
    return true;
  });
});

test('readJson bounds body without content-length and cancels stream on overflow', async () => {
  let canceled = false;
  const body = new ReadableStream<Uint8Array>({
    start(c) { c.enqueue(new Uint8Array(32)); },
    cancel() { canceled = true; },
  });
  await assert.rejects(readJson(makeRequest(body), 16), isStatus(413));
  assert.equal(canceled, true);
});

test('readJson rejects malformed utf-8/json, whitespace-only and absent body as 400', async () => {
  await assert.rejects(readJson(makeRequest([new Uint8Array([0xff, 0xfe])])), isStatus(400));
  await assert.rejects(readJson(makeRequest('{nope')), isStatus(400));
  await assert.rejects(readJson(makeRequest('   ')), isStatus(400));
  await assert.rejects(readJson(makeRequest(null)), isStatus(400));
});

test('readJson maps stream read failures to 400', async () => {
  const body = new ReadableStream<Uint8Array>({ start(c) { c.error(new Error('boom')); } });
  await assert.rejects(readJson(makeRequest(body)), isStatus(400));
});
