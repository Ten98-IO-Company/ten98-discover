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

test('basic collection envelope is strict; authenticated API retains its identity-free input contract',()=>{
  const base={siteKey:ID1,eventId:ID2,name:'page_view',url:'https://a.com/'},collection={mode:'cookieless',epoch:ID1};
  assert.deepEqual(eventInput.parse({...base,collection}).collection,collection);
  for(const collection of [null,{},[],{mode:'consent',epoch:ID1},{mode:'cookieless',epoch:'bad'},{mode:'cookieless',epoch:ID1,extra:true}])assert.throws(()=>eventInput.parse({...base,collection}),z.ZodError);
  assert.throws(()=>eventInput.parse({...base,collection,distinctId:'not-a-top-level-field'}),z.ZodError);
  const apiInput=eventInput.omit({siteKey:true,consent:true,collection:true,context:true}),{siteKey:_,...apiEvent}=base;
  assert.deepEqual(apiInput.parse(apiEvent),apiEvent);
  for(const fields of [{collection},{consent:{analytics:true,epoch:ID1}},{context:'browser-memory-context'}])assert.throws(()=>apiInput.parse({...apiEvent,...fields}),z.ZodError);
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

test('readJson Content-Length precheck uses the runtime limit mode: oversize 413, invalid 400 before reading', async () => {
  const h = { 'content-type': 'application/json' };
  const refused = (status: number, message: string) => (e: unknown) => e instanceof InputError && e.status === status && e.message === message;
  for (const length of ['abc', '-1', '1.5', '1e3', '010', '12345678901234567']) {
    let pulled = false;
    const body = new ReadableStream<Uint8Array>({ pull(c) { pulled = true; c.enqueue(new TextEncoder().encode('{}')); c.close(); } }, { highWaterMark: 0 });
    await assert.rejects(readJson(makeRequest(body, { ...h, 'content-length': length })), refused(400, 'invalid content-length'), length);
    assert.equal(pulled, false, `an invalid Content-Length (${length}) is refused before the body is read`);
  }
  await assert.rejects(readJson(makeRequest('{}', { ...h, 'content-length': '101' }), 100), refused(413, 'body too large'));
  await assert.rejects(readJson(makeRequest('{}', { ...h, 'content-length': '9007199254740993' }), 100), refused(413, 'body too large'));
  assert.deepEqual(await readJson(makeRequest('{}', { ...h, 'content-length': '100' }), 100), {}, 'a declaration at the limit is admitted; limit mode does not demand an exact count');
  assert.deepEqual(await readJson(makeRequest('{}', { ...h, 'content-length': '0' })), {}, 'limit mode does not demand an exact count');
  await assert.rejects(readJson(makeRequest(null, { ...h, 'content-length': '2' })), refused(400, 'empty body'));
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

test('readJson keeps its fixed messages when delegating to the runtime reader', async () => {
  const message = (text: string, status: number) => (e: unknown) => e instanceof InputError && e.status === status && e.message === text;
  await assert.rejects(readJson(makeRequest([new Uint8Array(32)]), 16), message('body too large', 413));
  await assert.rejects(readJson(makeRequest([new Uint8Array([0x7b, 0xff, 0x7d])])), message('body is not valid utf-8', 400));
  // A multibyte sequence truncated at the end of the body is malformed too.
  await assert.rejects(readJson(makeRequest([new Uint8Array([0x22, 0xe2, 0x82])])), message('body is not valid utf-8', 400));
  await assert.rejects(readJson(makeRequest(new ReadableStream<Uint8Array>({ start(c) { c.error(new Error('boom')); } }))), message('failed to read request body', 400));
  // A stream that fails with its own RangeError is a read failure, not the byte limit.
  await assert.rejects(readJson(makeRequest(new ReadableStream<Uint8Array>({ start(c) { c.error(new RangeError('upstream')); } }))), message('failed to read request body', 400));
  assert.deepEqual(await readJson(makeRequest([new TextEncoder().encode('{"a":'), new TextEncoder().encode('"é"}')]), 16), { a: 'é' });
});

test('readJson accepts exactly the byte limit across chunks and strips a leading BOM', async () => {
  const bytes = new TextEncoder().encode('{"k":"é"}');
  const split = [bytes.subarray(0, 7), bytes.subarray(7)];
  assert.deepEqual(await readJson(makeRequest(split), bytes.byteLength), { k: 'é' });
  await assert.rejects(readJson(makeRequest(split), bytes.byteLength - 1), isStatus(413));
  assert.deepEqual(await readJson(makeRequest([new Uint8Array([0xef, 0xbb, 0xbf]), new TextEncoder().encode('{}')])), {});
});

test('readJson rejects a body that is both malformed and oversized without reading past the bad chunk', async () => {
  // Decoding is now incremental, so malformed bytes before the limit is crossed report 400 rather than 413.
  let pulls = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(c) { pulls++; c.enqueue(pulls === 1 ? new Uint8Array([0xff]) : new Uint8Array(32)); },
  });
  await assert.rejects(readJson(makeRequest(body), 16), isStatus(400));
  assert.ok(pulls <= 2);
});
