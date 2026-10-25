import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';

// The auth instance's own reset must end trusted devices and pending two-factor challenges through the database
// adapter, independently of the route's extra cleanup in account-security.ts. Installed Better Auth + real PostgreSQL;
// no web listener, mail transport or provider. Run on a fresh, migrated loopback database:
// node --test tests/password-reset-cleanup-integration.ts
test('a password reset deletes the account\'s trust-device and two-factor rows through the adapter', { timeout: 120_000 }, async t => {
  assert.equal(process.env.TEN98_PASSWORD_RESET_CLEANUP_INTEGRATION, '1', 'Explicit isolated reset-cleanup opt-in is required.');
  const { getConfig } = await import('../src/server/config.ts');
  let config: ReturnType<typeof getConfig>;
  try { config = getConfig(); } catch { throw new Error('Isolated reset-cleanup configuration is invalid; values are redacted.'); }
  const local = new Set(['localhost', '127.0.0.1', '[::1]']);
  const app = new URL(config.appUrl), database = new URL(config.databaseUrl);
  assert.ok(local.has(app.hostname) && local.has(database.hostname), 'Only loopback application/database configuration is allowed.');
  assert.ok(!database.search && !database.hash, 'Database query and fragment overrides are not allowed.');
  if (process.env.TEN98_ISOLATED_CI_DATABASE === '1') {
    assert.equal(database.protocol, 'postgres:'); assert.equal(database.hostname, '127.0.0.1'); assert.equal(database.port, '5432');
    assert.equal(database.pathname, '/ten98_password_reset_cleanup_ci');
  }
  const { getDatabase, closeDatabase, assertSchema } = await import('../src/server/db.ts');
  const { pool } = getDatabase();
  t.after(closeDatabase);
  await assertSchema();
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM "user"')).rows[0].count, 0, 'Use a fresh migrated database; fixtures are retained and this check never clears users.');
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Network fetch is forbidden in the reset-cleanup fixture.'); });
  const { getAuth } = await import('../src/server/auth.ts');
  const { hashPassword, verifyPassword } = await import('better-auth/crypto');

  const fixture = async () => {
    const id = randomUUID(), email = `${id}@password-reset-cleanup.integration.test`;
    await pool.query('INSERT INTO "user"(id,name,email) VALUES($1,$2,$3)', [id, 'Synthetic reset-cleanup account', email]);
    await pool.query('INSERT INTO account(id,"accountId","providerId","userId",password) VALUES($1,$2,\'credential\',$2,$3)', [randomUUID(), id, await hashPassword(randomBytes(24).toString('base64url'))]);
    return { id, email };
  };
  const verification = (identifier: string, value: string) => pool.query('INSERT INTO verification(id,identifier,value,"expiresAt") VALUES($1,$2,$3,clock_timestamp()+interval \'1 hour\')', [randomUUID(), identifier, value]);
  // Each auth call runs in one transaction, as Discover's security routes bind it.
  async function inTransaction<T>(work: (client: import('pg').PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try { await client.query('BEGIN'); const result = await work(client); await client.query('COMMIT'); return result; }
    catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  const post = (path: string, body: unknown) => new Request(`${config.appUrl}/api/auth${path}`, { method: 'POST', headers: { origin: config.appUrl, 'content-type': 'application/json' }, body: JSON.stringify(body) });

  const user = await fixture(), bystander = await fixture();
  // More rows than an adapter's default findMany page (100), so a capped delete would leave some behind.
  const trusted = Array.from({ length: 150 }, () => `trust-device-${randomUUID()}`);
  for (const identifier of trusted) await verification(identifier, user.id);
  const challenges = [`2fa-${randomUUID()}`, `2fa-${randomUUID()}`];
  for (const identifier of challenges) await verification(identifier, user.id);
  // Rows that must survive: another account's device and challenge, and this account's unrelated identifier.
  const kept = [[`trust-device-${randomUUID()}`, bystander.id], [`2fa-${randomUUID()}`, bystander.id], [`totp-used:${user.id}:${randomUUID()}`, user.id]] as const;
  for (const [identifier, value] of kept) await verification(identifier, value);

  let token = '';
  const requested = await inTransaction(client => getAuth(client, message => { token = message.token; }).handler(post('/request-password-reset', { email: user.email })));
  assert.equal(requested.status, 200); assert.equal(token.length, 24);
  const password = randomBytes(24).toString('base64url');
  // The auth handler directly, without the route's own invalidateChallenges.
  const reset = await inTransaction(client => getAuth(client).handler(post('/reset-password', { token, newPassword: password })));
  assert.equal(reset.status, 200);
  const hash = (await pool.query('SELECT password FROM account WHERE "userId"=$1 AND "providerId"=\'credential\'', [user.id])).rows[0]?.password as string;
  assert.ok(await verifyPassword({ password, hash }), 'The reset changed the password.');
  const remaining = await pool.query('SELECT 1 FROM verification WHERE value=$1 AND (identifier LIKE \'trust-device-%\' OR identifier LIKE \'2fa-%\')', [user.id]);
  assert.equal(remaining.rowCount, 0, 'Every trusted device and pending two-factor challenge of the account is deleted.');
  const survivors = await pool.query<{ identifier: string }>('SELECT identifier FROM verification WHERE identifier=ANY($1::text[])', [kept.map(([identifier]) => identifier)]);
  assert.deepEqual(survivors.rows.map(row => row.identifier).sort(), kept.map(([identifier]) => identifier).sort(), 'Other accounts\' rows and unrelated identifiers are kept.');
});
