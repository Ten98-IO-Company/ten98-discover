import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import { collectionOriginAllowed, servingOriginHost } from '../src/server/collection-origins.ts';
import { explorerQuery } from '../src/server/explorer-input.ts';

test('extra serving origins require exactly serialized HTTPS443 without implicit host expansion', () => {
  assert.equal(servingOriginHost('https://www.example.com'), 'www.example.com');
  assert.equal(servingOriginHost('https://xn--bcher-kva.example.com'), 'xn--bcher-kva.example.com');
  for (const value of ['http://www.example.com','https://www.example.com:443','https://www.example.com:8443','https://www.example.com/','https://user@www.example.com','https://www.example.com?q=1','https://www.example.com#hash','https://WWW.example.com',' https://www.example.com','https://www.example.com\n','null',null,{}]) assert.equal(servingOriginHost(value), null);
});

test('canonical origins use the exact existing contract and extra domains remain project scoped', async () => {
  const calls: unknown[][] = [];
  const db = { query: async (_sql: string, values: unknown[]) => { calls.push(values); return { rowCount: 0 }; } } as unknown as PoolClient;
  const project = { id: 'fixture-project', origin: 'http://localhost:4321' };
  assert.equal(await collectionOriginAllowed(db, project.origin, project), true); assert.equal(calls.length, 0);
  assert.equal(await collectionOriginAllowed(db, 'http://localhost:4322', project), false); assert.equal(calls.length, 0);
  assert.equal(await collectionOriginAllowed(db, 'https://www.example.com', project), false);
  assert.deepEqual(calls, [[project.id, 'www.example.com']]);
});

test('Explorer origin filters are exact origins and cannot hide paths or malformed suffixes', () => {
  const params = new URLSearchParams({ groupBy: 'origin', origin: 'http://localhost:4321' });
  assert.equal(explorerQuery(params).filters.origin, 'http://localhost:4321');
  for (const value of ['https://example.com/','https://example.com:443','https://example.com\n','https://user:password@example.com','null','']) {
    assert.throws(() => explorerQuery(new URLSearchParams({ origin: value })), (error: unknown) => (error as { status: number }).status === 400);
  }
});
