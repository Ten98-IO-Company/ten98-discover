import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { getConfig, secret as configSecret } from '../src/server/config.ts';
import { assertSchema, closeDatabase, getDatabase } from '../src/server/db.ts';
import { handleApi } from '../src/server/api.ts';
import { clientLimitKey } from '../src/server/client-rate-limit.ts';
import { networkSettings, useNetwork, withTransport } from './collector-admission-integration.ts';

// Needs an isolated synthetic PostgreSQL database; never a real installation.
// Anonymous identity routes count per client, and the shared OIDC callback ceiling counts only callbacks for an existing flow.
// Unresolved clients share one key per scope with a quarter of the resolved OIDC ceilings (15 starts, 30 callbacks a minute).
export async function runClientRateLimitChecks() {
  assert.equal(process.env.TEN98_INTEGRATION_TEST, '1');
  const config = getConfig();
  for (const url of [config.appUrl, config.databaseUrl]) assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname));
  await assertSchema();
  const { pool } = getDatabase();
  const resolvedStart = clientLimitKey('oidc:start', '198.51.100.41', configSecret('AUTH_SECRET'));
  const keys = ['oidc:callback', 'oidc:callback:client:unresolved', 'invitations:public', 'invitations:public:client:unresolved', 'oidc:start:client:unresolved', resolvedStart];
  const seed = (key: string, count: number) => pool.query('INSERT INTO request_limit(key,minute,count) VALUES($1,floor(extract(epoch FROM now())/60),$2)', [key, count]);
  const total = async (key: string) => Number((await pool.query('SELECT COALESCE(sum(count),0)::int AS total FROM request_limit WHERE key=$1 AND minute>=floor(extract(epoch FROM now())/60)-1', [key])).rows[0].total);
  try {
    await pool.query('DELETE FROM request_limit WHERE key=ANY($1::text[])', [keys]);
    // A plain Request has no transport peer, so these use the conservative unknown-client key.
    const state = randomBytes(32).toString('base64url');
    const callback = await handleApi(new Request(`${config.appUrl}/api/auth/oidc/callback?state=${state}&code=synthetic`));
    assert.equal(callback.status, 303);
    assert.match(callback.headers.get('location') ?? '', /#oidc-error=1$/);
    assert.equal(await total('oidc:callback:client:unresolved'), 1);
    assert.equal(await total('oidc:callback'), 0, 'A callback without a matching flow counted toward the shared callback ceiling.');
    const inspect = await handleApi(new Request(`${config.appUrl}/api/invitations/inspect`, { method: 'POST', headers: { origin: config.appUrl, 'content-type': 'application/json' }, body: JSON.stringify({ token: randomBytes(32).toString('base64url') }) }));
    assert.ok(inspect.status >= 400 && inspect.status < 500 && inspect.status !== 429);
    assert.equal(await total('invitations:public:client:unresolved'), 1);
    assert.equal(await total('invitations:public'), 0);

    // The counter is capped at maximum+1, so a seeded count above 30 reveals the unresolved callback ceiling.
    await pool.query('DELETE FROM request_limit WHERE key=ANY($1::text[])', [keys]);
    await seed('oidc:callback:client:unresolved', 40);
    const limitedCallback = await handleApi(new Request(`${config.appUrl}/api/auth/oidc/callback?state=${state}&code=synthetic`));
    assert.match(limitedCallback.headers.get('location') ?? '', /#oidc-error=1$/);
    assert.equal(await total('oidc:callback:client:unresolved'), 31, 'Unresolved callbacks are limited to 30 a minute.');

    const start = (make: (path: string, init?: RequestInit) => Request) => handleApi(make('/api/auth/oidc/start', { method: 'POST', headers: { origin: config.appUrl, 'content-type': 'application/json' }, body: JSON.stringify({ providerId: randomUUID() }) })).then(response => response.status, (error: { status?: number }) => error.status);
    const plain = (path: string, init?: RequestInit) => new Request(new URL(path, config.appUrl), init);
    await seed('oidc:start:client:unresolved', 14);
    assert.notEqual(await start(plain), 429, 'The fifteenth unresolved start in a minute is admitted.');
    assert.equal(await start(plain), 429, 'The sixteenth unresolved start in a minute is refused.');
    const savedNetwork = Object.fromEntries(networkSettings.map(key => [key, process.env[key]]));
    try {
      useNetwork({ ANALYTICS_NETWORK_MODE: 'off', TRUSTED_PROXIES: '127.0.0.1' });
      await seed(resolvedStart, 59);
      const resolved = await withTransport(config.appUrl, async (_peer, via) => [await start(via('198.51.100.41')), await start(via('198.51.100.41'))]);
      assert.notEqual(resolved[0], 429, 'A resolved client keeps its sixtieth start.');
      assert.equal(resolved[1], 429, 'A resolved client is refused after 60 starts.');
    } finally { useNetwork(savedNetwork); }
  } finally { await pool.query('DELETE FROM request_limit WHERE key=ANY($1::text[])', [keys]); }
  return { groups: ['an OIDC callback without a matching flow leaves the shared callback ceiling untouched', 'public invitation routes count per client', 'unresolved OIDC clients get a quarter of the resolved ceilings'] };
}
if (process.env.TEN98_INTEGRATION_TEST === '1' && pathToFileURL(resolve(process.argv[1] ?? '')).href === import.meta.url) try { console.log(await runClientRateLimitChecks()); } finally { await closeDatabase(); }
