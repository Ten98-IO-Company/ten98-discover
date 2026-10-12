import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FoundationError } from '../src/server/auth.ts';
import { parseApiKeyHeaders } from '../src/server/api-keys.ts';

const token = `t98k_${Buffer.alloc(32).toString('base64url')}`;
const status = (expected: number) => (error: unknown) => error instanceof FoundationError && error.status === expected;

test('API-key headers accept one canonical bearer token and ordinary cookie-only requests', () => {
  assert.equal(parseApiKeyHeaders(new Headers()), null);
  assert.equal(parseApiKeyHeaders(new Headers({ cookie: 'session=value' })), null);
  assert.equal(parseApiKeyHeaders(new Headers({ authorization: `Bearer ${token}` })), token);
  assert.equal(parseApiKeyHeaders(new Headers({ authorization: `bEaReR ${token}` })), token);
});

test('API-key headers reject malformed or duplicate credentials', () => {
  for (const authorization of ['', `Basic ${token}`, `Bearer  ${token}`, `Bearer\t${token}`, `Bearer ${token}=`,
    `Bearer ${token.slice(0, -1)}`, `Bearer ${token}A`, `Bearer ${token}, Bearer ${token}`,
    `Bearer ${token.slice(0, -1)}B`, `Bearer ${token.replace('t98k_', 'T98K_')}`]) {
    assert.throws(() => parseApiKeyHeaders(new Headers({ authorization })), status(401));
  }
  const duplicate = new Headers({ authorization: `Bearer ${token}` });
  duplicate.append('authorization', `Bearer ${token}`);
  assert.throws(() => parseApiKeyHeaders(duplicate), status(401));
});

test('API-key headers reject cookie mixing and alternate key headers', () => {
  const mixed: Record<string, string>[] = [
    { authorization: `Bearer ${token}`, cookie: 'session=value' },
    { authorization: `Bearer ${token}`, cookie: '' },
    { 'x-api-key': token },
    { 'x-api-key': '', authorization: `Bearer ${token}` },
  ];
  for (const headers of mixed) assert.throws(() => parseApiKeyHeaders(new Headers(headers)), status(400));
});
