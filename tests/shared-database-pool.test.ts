import assert from 'node:assert/strict';
import test from 'node:test';
import * as first from '../src/server/db.ts';

test('separate bundle instances of db.ts share one pool, close it once and reopen a fresh one', async () => {
  const names = ['APP_URL', 'DATABASE_URL', 'AUTH_SECRET', 'BOOTSTRAP_TOKEN', 'ANALYTICS_NETWORK_MODE'] as const, saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
  // The pool never connects here: nothing is queried, and ending an idle pool opens no connection.
  Object.assign(process.env, { APP_URL: 'http://localhost:3099', DATABASE_URL: 'postgres://127.0.0.1:55509/ten98_shared_pool_unit', AUTH_SECRET: 'a'.repeat(64), BOOTSTRAP_TOKEN: 'b'.repeat(64), ANALYTICS_NETWORK_MODE: 'off' });
  try {
    // A second module instance reproduces the Nitro entry and TanStack Start SSR bundles' separate copies.
    const second: typeof first = await import(new URL('../src/server/db.ts?second-bundle', import.meta.url).href);
    assert.notEqual(second.getDatabase, first.getDatabase, 'The two imports are separate module instances.');
    const opened = first.getDatabase();
    assert.equal(second.getDatabase(), opened, 'Both bundles use the same pool.');
    let ends = 0;
    const end = opened.pool.end.bind(opened.pool);
    opened.pool.end = (async () => { ends++; await end(); }) as typeof opened.pool.end;
    // Both bundles register their cleanup and the shutdown hook runs them concurrently.
    await Promise.all([first.closeDatabase(), second.closeDatabase()]);
    assert.equal(ends, 1, 'The shared pool is ended exactly once.');
    await first.closeDatabase();
    assert.equal(ends, 1);
    const reopened = second.getDatabase();
    assert.notEqual(reopened, opened, 'The next request after closing opens a fresh pool.');
    assert.equal(first.getDatabase(), reopened);
    await second.closeDatabase();
  } finally {
    for (const name of names) if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name];
  }
});
