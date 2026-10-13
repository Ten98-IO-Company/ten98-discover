import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { test } from 'node:test';
import { FoundationError } from '../src/server/auth.ts';
import { verifyMetaSignedRequest } from '../src/server/meta-signed-request.ts';

const secret = 'synthetic-meta-signing-secret';
const payload = '{"algorithm":"HMAC-SHA256","user_id":"123456789"}';
const signEncoded = (encoded: string, key = secret) => createHmac('sha256', key).update(encoded).digest('base64url') + '.' + encoded;
const sign = (text: string | Uint8Array, key = secret) => signEncoded(Buffer.from(text).toString('base64url'), key);
const rejected = (raw: unknown, ...keys: unknown[]) => assert.throws(() => verifyMetaSignedRequest(raw as string, (keys.length ? keys[0] : secret) as string), error => {
  assert.ok(error instanceof FoundationError);
  assert.equal(error.status, 400);
  assert.equal(error.message, 'The Meta signed request is invalid.');
  assert.equal(error.cause, undefined);
  for (const sensitive of [secret, 'sensitive-provider-data', '123456789']) assert.ok(!(JSON.stringify(error) + error.stack).includes(sensitive));
  return true;
});

test('valid signed deletion returns only exact identity/metadata and deterministic encoded-payload digest', () => {
  const raw = sign('{"algorithm":"HMAC-SHA256","user_id":"123456789","issued_at":1,"expires":2,"ignored":{"access_token":"sensitive-provider-data","label":"العربية 😀"}}');
  const result = verifyMetaSignedRequest(raw, secret);
  assert.deepEqual(result, { userId: '123456789', issuedAt: 1, expires: 2, digest: createHash('sha256').update(raw.split('.')[1]).digest('hex') });
  assert.deepEqual(verifyMetaSignedRequest(raw, secret), result);
  assert.equal(Object.keys(result).length, 4);
  assert.deepEqual(verifyMetaSignedRequest(sign(payload), secret), { userId: '123456789', issuedAt: null, expires: null, digest: createHash('sha256').update(sign(payload).split('.')[1]).digest('hex') });
  const rotatedSecret = 'rotated-synthetic-app-secret';
  const resigned = signEncoded(raw.split('.')[1], rotatedSecret);
  assert.notEqual(resigned, raw);
  assert.deepEqual(verifyMetaSignedRequest(resigned, rotatedSecret), result);
  rejected(raw, rotatedSecret);
  rejected(resigned, secret);
  assert.equal(verifyMetaSignedRequest(sign('{"algorithm":"HMAC-SHA256","user_id":123456789,"issued_at":9007199254740991,"expires":0}'), secret).issuedAt, Number.MAX_SAFE_INTEGER);
});

test('HMAC binds the original encoded payload, exact secret and every signature byte', () => {
  const raw = sign(payload), [signature, encoded] = raw.split('.');
  rejected(raw, 'wrong-synthetic-secret');
  rejected(signature + '.' + Buffer.from(payload + ' ').toString('base64url'));
  for (let i = 0; i < 32; i++) {
    const altered = Buffer.from(signature, 'base64url'); altered[i] ^= 1;
    rejected(altered.toString('base64url') + '.' + encoded);
  }
  const withWhitespace = sign(' ' + payload + '\n');
  assert.equal(verifyMetaSignedRequest(withWhitespace, secret).userId, '123456789');
  assert.notEqual(verifyMetaSignedRequest(withWhitespace, secret).digest, verifyMetaSignedRequest(raw, secret).digest);
  rejected(createHmac('sha256', secret).update(payload).digest('base64url') + '.' + encoded);
});

test('two canonical unpadded base64url segments are required, including unused bits', () => {
  const raw = sign(payload), [signature, encoded] = raw.split('.');
  for (const candidate of ['', '.', raw + '.', '.' + encoded, signature + '.', signature + '=' + '.' + encoded, signature + '.' + encoded + '=', signature + '.\n' + encoded, signature + '.' + encoded + '\n', signature + '.+' + encoded, signature + './' + encoded]) rejected(candidate);
  for (const length of [0, 1, 31, 33, 64]) rejected(Buffer.alloc(length).toString('base64url') + '.' + encoded);
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const signatureAlias = signature.slice(0, -1) + alphabet[alphabet.indexOf(signature.at(-1)!) + 1];
  assert.deepEqual(Buffer.from(signatureAlias, 'base64url'), Buffer.from(signature, 'base64url'));
  rejected(signatureAlias + '.' + encoded);
  const short = Buffer.from(payload + ' ').toString('base64url');
  assert.notEqual(short.length % 4, 0);
  const payloadAlias = short.slice(0, -1) + alphabet[alphabet.indexOf(short.at(-1)!) + 1];
  assert.deepEqual(Buffer.from(payloadAlias, 'base64url'), Buffer.from(short, 'base64url'));
  rejected(signEncoded(payloadAlias));
});

test('numeric subject IDs retain exact integer lexemes, with no rounding or alternate forms', () => {
  for (const id of ['1', '9007199254740993', '1234567890123456789012345678901234567890']) {
    assert.equal(verifyMetaSignedRequest(sign('{"algorithm":"HMAC-SHA256","user_id":' + id + '}'), secret).userId, id);
    assert.equal(verifyMetaSignedRequest(sign(JSON.stringify({ algorithm: 'HMAC-SHA256', user_id: id })), secret).userId, id);
  }
  for (const id of ['0', '-1', '1e3', '1.0', '1e999', 'true', 'null', '{}', '[]']) rejected(sign('{"algorithm":"HMAC-SHA256","user_id":' + id + '}'));
  for (const id of ['', '0', '01', '-1', '+1', '1e3', '1.0', '1\n', '١٢٣', '１２３', '\ud800', '1'.repeat(41)]) rejected(sign(JSON.stringify({ algorithm: 'HMAC-SHA256', user_id: id })));
  rejected(sign('{"algorithm":"HMAC-SHA256","user_id":' + '1'.repeat(41) + '}'));
});

test('fatal UTF8, malformed JSON, exact algorithm and root object validation fail uniformly', () => {
  for (const text of ['', '{', 'null', '[]', '"text"', '1', '\ufeff' + payload, payload + 'x', '{"algorithm":"hmac-sha256","user_id":"1"}', '{"algorithm":"HMAC-SHA256 ","user_id":"1"}', '{"user_id":"1"}', '{"algorithm":"HMAC-SHA256"}', '{"algorithm":"HMAC-SHA256","user_id":"1\u0000"}', '{"algorithm":"HMAC-SHA256","user_id":"\\ud800"}']) rejected(sign(text));
  for (const bytes of [Uint8Array.of(0xc3, 0x28), Uint8Array.of(0xed, 0xa0, 0x80), Uint8Array.of(0xf0, 0x80, 0x80, 0x80)]) rejected(sign(bytes));
  for (const value of [undefined, null, 1, {}, new String(sign(payload))]) rejected(value);
});

test('duplicate root members are rejected even with escaped-equivalent keys; nested unknown data cannot change identity', () => {
  for (const text of [
    '{"algorithm":"HMAC-SHA256","user_id":"1","user_id":"2"}',
    '{"algorithm":"HMAC-SHA256","user_id":"1","user_\\u0069d":"1"}',
    '{"algorithm":"wrong","algorithm":"HMAC-SHA256","user_id":"1"}',
    '{"algorithm":"HMAC-SHA256","user_id":"1","issued_at":1,"issued_at":2}',
    '{"algorithm":"HMAC-SHA256","user_id":"1","ignored":1,"ignored":2}',
  ]) rejected(sign(text));
  const tricky = '{"algorithm":"HMAC-SHA256","user_id":"123456789","ignored":{"user_id":"2","user_id":"3","text":"\\\"user_id\\\": 4 { } [ ] \\\\"},"array":[{"user_id":5},"\\\" :"]}';
  assert.equal(verifyMetaSignedRequest(sign(tricky), secret).userId, '123456789');
  assert.equal(verifyMetaSignedRequest(sign('{"algorithm":"HMAC-SHA256","user_id":"1","__proto__":{"user_id":"2"},"constructor":{"algorithm":"wrong"}}'), secret).userId, '1');
});

test('mandatory identity and algorithm must be own fields even if the process prototype was contaminated elsewhere', () => {
  const descriptors = Object.getOwnPropertyDescriptors(Object.prototype);
  try {
    Object.defineProperties(Object.prototype, { algorithm: { value: 'HMAC-SHA256', configurable: true }, user_id: { value: '123456789', configurable: true } });
    rejected(sign('{}'));
    rejected(sign('{"algorithm":"HMAC-SHA256"}'));
    rejected(sign('{"user_id":"123456789"}'));
    assert.equal(verifyMetaSignedRequest(sign(payload), secret).userId, '123456789');
  } finally {
    for (const name of ['algorithm', 'user_id']) {
      if (Object.hasOwn(descriptors, name)) Object.defineProperty(Object.prototype, name, descriptors[name]);
      else Reflect.deleteProperty(Object.prototype, name);
    }
  }
  assert.deepEqual(Object.getOwnPropertyDescriptors(Object.prototype), descriptors);
});

test('optional epoch values must be safe nonnegative integers; no invented delivery-age rule', () => {
  for (const field of ['issued_at', 'expires']) for (const value of ['null', 'true', '"1"', '-1', '-0', '1.5', '1.0000000000000001', '9007199254740991.1', '9007199254740992', '1e3', '1e999', '{}', '[]']) rejected(sign('{"algorithm":"HMAC-SHA256","user_id":"1","' + field + '":' + value + '}'));
  const result = verifyMetaSignedRequest(sign('{"algorithm":"HMAC-SHA256","user_id":"1","issued_at":0,"expires":1}'), secret);
  assert.equal(result.issuedAt, 0); assert.equal(result.expires, 1);
  assert.equal(verifyMetaSignedRequest(sign('{"algorithm":"HMAC-SHA256","user_id":"1","issued_at":9007199254740991}'), secret).issuedAt, Number.MAX_SAFE_INTEGER);
});

test('application payload/request and visible-ASCII secret bounds are enforced', () => {
  const prefix = '{"algorithm":"HMAC-SHA256","user_id":"1","padding":"', suffix = '"}';
  const boundary = prefix + 'x'.repeat(16 * 1024 - Buffer.byteLength(prefix + suffix)) + suffix;
  assert.equal(Buffer.byteLength(boundary), 16 * 1024);
  assert.equal(verifyMetaSignedRequest(sign(boundary), secret).userId, '1');
  rejected(sign(boundary + ' ')); rejected('a'.repeat(24 * 1024 + 1));
  const multibyte = prefix + 'é'.repeat(8192) + suffix;
  assert.ok(multibyte.length < 16 * 1024); rejected(sign(multibyte));
  for (const key of ['', 'x'.repeat(513), 'space key', '\tkey', 'key\n', 'key\0', 'é', '\ud800', undefined, null, 1, {}]) rejected(sign(payload), key);
  const maximumSecret = 'x'.repeat(512);
  assert.equal(verifyMetaSignedRequest(sign(payload, maximumSecret), maximumSecret).userId, '123456789');
});
