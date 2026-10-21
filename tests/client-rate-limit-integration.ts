import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { getConfig } from '../src/server/config.ts';
import { assertSchema, closeDatabase, getDatabase } from '../src/server/db.ts';
import { handleApi } from '../src/server/api.ts';

// Needs an isolated synthetic PostgreSQL database; never a real installation.
// Anonymous identity routes count per client, and the shared OIDC callback ceiling counts only callbacks for an existing flow.
export async function runClientRateLimitChecks() {
  assert.equal(process.env.TEN98_INTEGRATION_TEST, '1');
  const config = getConfig();
  for (const url of [config.appUrl, config.databaseUrl]) assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname));
  await assertSchema();
  const { pool } = getDatabase();
  const keys = ['oidc:callback', 'oidc:callback:client:unknown', 'invitations:public', 'invitations:public:client:unknown'];
  const total = async (key: string) => Number((await pool.query('SELECT COALESCE(sum(count),0)::int AS total FROM request_limit WHERE key=$1 AND minute>=floor(extract(epoch FROM now())/60)-1', [key])).rows[0].total);
  try {
    await pool.query('DELETE FROM request_limit WHERE key=ANY($1::text[])', [keys]);
    // A plain Request has no transport peer, so these use the conservative unknown-client key.
    const state = randomBytes(32).toString('base64url');
    const callback = await handleApi(new Request(`${config.appUrl}/api/auth/oidc/callback?state=${state}&code=synthetic`));
    assert.equal(callback.status, 303);
    assert.match(callback.headers.get('location') ?? '', /#oidc-error=1$/);
    assert.equal(await total('oidc:callback:client:unknown'), 1);
    assert.equal(await total('oidc:callback'), 0, 'A callback without a matching flow counted toward the shared callback ceiling.');
    const inspect = await handleApi(new Request(`${config.appUrl}/api/invitations/inspect`, { method: 'POST', headers: { origin: config.appUrl, 'content-type': 'application/json' }, body: JSON.stringify({ token: randomBytes(32).toString('base64url') }) }));
    assert.ok(inspect.status >= 400 && inspect.status < 500 && inspect.status !== 429);
    assert.equal(await total('invitations:public:client:unknown'), 1);
    assert.equal(await total('invitations:public'), 0);
  } finally { await pool.query('DELETE FROM request_limit WHERE key=ANY($1::text[])', [keys]); }
  return { groups: ['an OIDC callback without a matching flow leaves the shared callback ceiling untouched', 'public invitation routes count per client'] };
}
if (process.env.TEN98_INTEGRATION_TEST === '1' && pathToFileURL(resolve(process.argv[1] ?? '')).href === import.meta.url) try { console.log(await runClientRateLimitChecks()); } finally { await closeDatabase(); }
