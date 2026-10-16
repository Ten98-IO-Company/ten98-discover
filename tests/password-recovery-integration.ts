import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { setImmediate as nextTurn } from 'node:timers/promises';
import test from 'node:test';

// Source API handlers + installed Better Auth + real PostgreSQL. Only the mail
// boundary is mocked; no SMTP, provider calls, web listener or real users.
// Run separately on a fresh, migrated loopback database:
// node --experimental-test-module-mocks --test tests/password-recovery-integration.ts
test('password recovery transaction and public-boundary checks', { timeout: 120_000 }, async t => {
  assert.equal(process.env.TEN98_PASSWORD_RECOVERY_INTEGRATION, '1', 'Explicit isolated recovery-test opt-in is required.');
  const { getConfig } = await import('../src/server/config.ts');
  let config: ReturnType<typeof getConfig>;
  try { config = getConfig(); } catch { throw new Error('Isolated recovery configuration is invalid; values are redacted.'); }
  const local = new Set(['localhost', '127.0.0.1', '[::1]']);
  const app = new URL(config.appUrl), database = new URL(config.databaseUrl);
  assert.ok(local.has(app.hostname) && local.has(database.hostname), 'Only loopback application/database configuration is allowed.');
  assert.ok(!database.search && !database.hash, 'Database query and fragment overrides are not allowed.');
  if (process.env.TEN98_ISOLATED_CI_DATABASE === '1') {
    assert.equal(database.protocol, 'postgres:'); assert.equal(database.hostname, '127.0.0.1'); assert.equal(database.port, '5432');
    assert.equal(database.pathname, '/ten98_password_recovery_ci'); assert.equal(app.origin, 'http://127.0.0.1:3111');
    assert.equal(process.env.ANALYTICS_NETWORK_MODE, 'off');
  }
  const { getDatabase, closeDatabase, assertSchema } = await import('../src/server/db.ts');
  const { pool } = getDatabase();
  t.after(closeDatabase);
  await assertSchema();
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM "user"')).rows[0].count, 0, 'Use a fresh migrated database; fixtures are retained and this check never clears users.');
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM request_limit')).rows[0].count, 0, 'Use a fresh isolated request budget.');

  let configured = true, failDelivery = false, holdDelivery: Promise<void> | null = null;
  const messages: { to: string; token: string; committed: boolean }[] = [], deliveries: Promise<unknown>[] = [];
  t.mock.module(new URL('../src/server/email.ts', import.meta.url).href, { cache: true, namedExports: {
    getEmailStatus: () => ({ configured, transport: configured ? 'smtp' : 'disabled' }),
    sendTransactionalEmail: (message: { to: string; subject: string; text: string }) => {
      const work = (async () => {
        const link = message.text.split('\n').find(line => line.startsWith(config.appUrl + '/#password-reset='));
        assert.ok(link, 'The synthetic email must contain an application-origin fragment link.');
        const url = new URL(link), token = url.hash.slice('#password-reset='.length);
        assert.ok(!url.search && url.origin === config.appUrl && token.length === 24 && /^[A-Za-z0-9]{24}$/.test(token), 'No token may enter a query or external callback.');
        const present = await pool.query('SELECT 1 FROM verification v JOIN "user" u ON u.id=v.value WHERE v.identifier=$1 AND u.email=$2', [`reset-password:${token}`, message.to]);
        messages.push({ to: message.to, token, committed: present.rowCount === 1 });
        if (holdDelivery) await holdDelivery;
        if (failDelivery) throw new Error('Synthetic delivery failure; no external transport was used.');
        return { accepted: true as const, delivery: 'unconfirmed' as const };
      })();
      deliveries.push(work.catch(() => undefined));
      return work;
    },
  } });
  // Reject accidental HTTP/provider work. The native PostgreSQL socket is explicit above.
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Network fetch is forbidden in the recovery fixture.'); });
  const { handleApi } = await import('../src/server/api.ts');
  const { getAuth } = await import('../src/server/auth.ts');
  const { hashPassword, verifyPassword } = await import('better-auth/crypto');
  const { authenticatorCode } = await import('./account-security-integration.ts');
  const diagnostics: string[] = [];
  for (const method of ['error', 'warn'] as const) t.mock.method(console, method, (...args: unknown[]) => { diagnostics.push(args.map(String).join(' ')); });
  const cookies = () => new Map<string, string>();
  type Browser = ReturnType<typeof cookies>;
  async function call(path: string, body?: unknown, options: { method?: string; origin?: string | null; actor?: Browser; headers?: Record<string, string>; raw?: string } = {}) {
    const method = options.method ?? (body === undefined ? 'GET' : 'POST');
    const headers = new Headers(options.headers);
    if (body !== undefined || options.raw !== undefined) headers.set('content-type', headers.get('content-type') ?? 'application/json');
    const origin = options.origin === undefined ? (method === 'POST' ? config.appUrl : null) : options.origin;
    if (origin !== null) headers.set('origin', origin);
    if (options.actor?.size) headers.set('cookie', [...options.actor].map(([key, value]) => `${key}=${value}`).join('; '));
    const response = await handleApi(new Request(new URL(path, config.appUrl), { method, headers, ...(options.raw !== undefined ? { body: options.raw } : body !== undefined ? { body: JSON.stringify(body) } : {}) }));
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(';')[0], split = pair.indexOf('='), key = pair.slice(0, split);
      if (/max-age=0(?:;|$)/i.test(cookie)) options.actor?.delete(key); else options.actor?.set(key, pair.slice(split + 1));
    }
    return { status: response.status, body: await response.json() as Record<string, any>, headers: response.headers };
  }
  async function fixture(password = randomBytes(24).toString('base64url'), localPassword = true) {
    const id = randomUUID(), email = `${id}@password-recovery.integration.test`;
    await pool.query('INSERT INTO "user"(id,name,email) VALUES($1,$2,$3)', [id, 'Synthetic recovery account', email]);
    if (localPassword) await pool.query('INSERT INTO account(id,"accountId","providerId","userId",password) VALUES($1,$2,\'credential\',$2,$3)', [randomUUID(), id, await hashPassword(password)]);
    else await pool.query('INSERT INTO account(id,"accountId","providerId","userId") VALUES($1,$2,\'synthetic-oidc\',$2)', [randomUUID(), id]);
    return { id, email, password };
  }
  async function mint(user: { id: string; email: string }) {
    // Exercise the installed requestPasswordReset token format without calling a sender.
    const client = await pool.connect(); let token = '';
    try {
      await client.query('BEGIN');
      const auth = getAuth(client, message => { assert.ok(message.userId === user.id && message.email === user.email); token = message.token; });
      const response = await auth.handler(new Request(`${config.appUrl}/api/auth/request-password-reset`, { method: 'POST', headers: { origin: config.appUrl, 'content-type': 'application/json' }, body: JSON.stringify({ email: user.email }) }));
      assert.equal(response.status, 200); assert.ok(token.length === 24);
      await client.query('COMMIT');
      return token;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  async function flushMail() { await nextTurn(); await Promise.all(deliveries); }
  const reset = (token: string, newPassword = randomBytes(24).toString('base64url')) => call('/api/auth/reset-password', { token, newPassword });
  const hashFor = async (id: string) => (await pool.query('SELECT password FROM account WHERE "userId"=$1 AND "providerId"=\'credential\'', [id])).rows[0]?.password as string | undefined;
  const tokenPresent = async (token: string) => (await pool.query('SELECT 1 FROM verification WHERE identifier=$1', [`reset-password:${token}`])).rowCount === 1;

  await t.test('opaque request, disabled setup, committed fragment delivery and caught sender failure', async () => {
    const owner = await fixture(), oidc = await fixture(undefined, false), unknown = `${randomUUID()}@password-recovery.integration.test`;
    assert.deepEqual((await call('/api/auth/password-reset-status')).body, { configured: true });
    let release!: () => void; holdDelivery = new Promise(resolve => { release = resolve; });
    try {
      const replies = [];
      for (const email of [owner.email, unknown, oidc.email]) replies.push(await call('/api/auth/request-password-reset', { email }));
      assert.ok(replies.every(reply => reply.status === 200 && JSON.stringify(reply.body) === '{"ok":true}' && !reply.headers.has('set-cookie')), 'A held mail send must not hold or identify a request response.');
    } finally { release(); holdDelivery = null; }
    await flushMail();
    assert.equal(messages.length, 1); assert.ok(messages[0].to === owner.email && messages[0].committed, 'Mail observes a token committed on another database connection.');
    assert.equal((await pool.query('SELECT 1 FROM verification WHERE value=$1', [oidc.id])).rowCount, 0);
    configured = false;
    assert.deepEqual((await call('/api/auth/password-reset-status')).body, { configured: false });
    const disabled = await Promise.all([owner.email, unknown].map(email => call('/api/auth/request-password-reset', { email })));
    assert.ok(disabled.every(reply => reply.status === 503)); assert.deepEqual(disabled[0].body, disabled[1].body);
    configured = true; failDelivery = true;
    assert.equal((await call('/api/auth/request-password-reset', { email: owner.email })).status, 200);
    await flushMail(); failDelivery = false;
    assert.equal(messages.length, 2); assert.ok(messages.every(message => message.committed));
    await nextTurn(); assert.equal(messages.length, 2, 'No automatic delivery retry.');
  });

  await t.test('exact routes, origin, closed body, bounded input and query rejection', async () => {
    const owner = await fixture(), body = { email: owner.email };
    for (const origin of [null, 'https://foreign.invalid', config.appUrl + '/']) assert.equal((await call('/api/auth/request-password-reset', body, { origin })).status, 403);
    for (const path of ['/api/auth/request-password-reset?redirectTo=https://foreign.invalid', '/api/auth/reset-password?token=not-a-capability', '/api/auth/password-reset-status?extra=1']) assert.equal((await call(path, path.includes('status') ? undefined : {})).status, 400);
    for (const path of ['/api/auth/request-password-reset/', '/api/auth/reset-password/not-a-capability', '/api/auth/verify-password', '/api/auth/rotate-verified-session', '/api/auth/complete-oidc-session']) assert.equal((await call(path, {})).status, 404);
    assert.equal((await call('/api/auth/request-password-reset')).status, 405);
    assert.equal((await call('/api/auth/password-reset-status', {})).status, 405);
    assert.equal((await call('/api/auth/password-reset-status', undefined, { headers: { 'content-length': '1' } })).status, 400);
    for (const input of [{ ...body, redirectTo: 'https://foreign.invalid' }, { ...body, callbackURL: config.appUrl }, { email: 'invalid' }, [], null]) assert.equal((await call('/api/auth/request-password-reset', input)).status, 400);
    assert.equal((await call('/api/auth/request-password-reset', body, { headers: { 'content-type': 'text/plain' } })).status, 415);
    assert.equal((await call('/api/auth/request-password-reset', undefined, { method: 'POST', raw: '{' })).status, 400);
    assert.equal((await call('/api/auth/request-password-reset', { email: 'x'.repeat(9000) })).status, 413);
  });

  await t.test('unknown, malformed, expired, consumed and OIDC-only links share a safe error', async () => {
    const user = await fixture(), expired = await mint(user), oidc = await fixture(undefined, false), oidcToken = await mint(oidc);
    await pool.query('UPDATE verification SET "expiresAt"=clock_timestamp()-interval \'1 second\' WHERE identifier=$1', [`reset-password:${expired}`]);
    const invalids = ['Z'.repeat(24), expired, oidcToken, 'x'.repeat(23), 'x'.repeat(24) + '\n', 'x'.repeat(23) + '\n', '%GG'];
    const replies: Awaited<ReturnType<typeof reset>>[] = [];
    for (const token of invalids) replies.push(await reset(token));
    assert.ok(replies.every(reply => reply.status === 400 && JSON.stringify(reply.body) === JSON.stringify(replies[0].body)));
    assert.equal((await pool.query('SELECT 1 FROM account WHERE "userId"=$1 AND "providerId"=\'credential\'', [oidc.id])).rowCount, 0, 'Recovery never creates an OIDC-only credential.');
    const token = await mint(user), password = randomBytes(24).toString('base64url');
    for (const input of [{ token, newPassword: 'x'.repeat(11) }, { token, newPassword: 'x'.repeat(129) }, { token, newPassword: password, callbackURL: config.appUrl }]) {
      const invalid = await call('/api/auth/reset-password', input); assert.equal(invalid.status, 400); assert.deepEqual(invalid.body, replies[0].body);
    }
    assert.ok(await tokenPresent(token), 'Invalid reset bodies must not consume the link.');
    assert.equal((await reset(token, password)).status, 200);
    const consumed = await reset(token, password); assert.equal(consumed.status, 400); assert.deepEqual(consumed.body, replies[0].body);
    assert.ok(await verifyPassword({ password, hash: (await hashFor(user.id))! }));
  });

  await t.test('concurrent one-use reset revokes sessions/links/challenges and preserves real enrolled MFA', async () => {
    const user = await fixture(), actor = cookies();
    assert.equal((await call('/api/auth/sign-in/email', { email: user.email, password: user.password }, { actor })).status, 200);
    const setup = await call('/api/account/two-factor/enable', { password: user.password }, { actor }); assert.equal(setup.status, 200);
    const secret = new URL(setup.body.totpURI).searchParams.get('secret'); assert.ok(secret);
    assert.equal((await call('/api/account/two-factor/verify', { code: authenticatorCode(secret) }, { actor })).status, 200);
    const factorBefore = (await pool.query('SELECT secret,"backupCodes",verified FROM "twoFactor" WHERE "userId"=$1', [user.id])).rows[0];
    const pending = cookies(); assert.equal((await call('/api/auth/sign-in/email', { email: user.email, password: user.password }, { actor: pending })).body.twoFactorRedirect, true);
    const challenge = (await pool.query('SELECT identifier FROM verification WHERE value=$1 AND identifier LIKE \'2fa-%\' ORDER BY "createdAt" DESC LIMIT 1', [user.id])).rows[0]?.identifier as string | undefined;
    assert.ok(challenge, 'The installed authenticator flow must create a real pending challenge.');
    const associated = [`2fa-attempts-${challenge}`, `oidc-challenge:${challenge}`];
    for (const identifier of associated) await pool.query('INSERT INTO verification(id,identifier,value,"expiresAt") VALUES($1,$2,$3,clock_timestamp()+interval \'1 hour\')', [randomUUID(), identifier, randomUUID()]);
    const trust = `trust-device-${randomUUID()}`;
    await pool.query('INSERT INTO verification(id,identifier,value,"expiresAt") VALUES($1,$2,$3,clock_timestamp()+interval \'1 hour\')', [randomUUID(), trust, user.id]);
    const token = await mint(user), other = await mint(user), password = randomBytes(24).toString('base64url');
    const results = await Promise.all([reset(token, password), reset(token, password)]);
    assert.deepEqual(results.map(result => result.status).sort(), [200, 400]);
    assert.ok(results.every(result => !result.headers.has('set-cookie')), 'Reset never automatically signs in.');
    assert.ok(await verifyPassword({ password, hash: (await hashFor(user.id))! }));
    assert.equal((await pool.query('SELECT 1 FROM session WHERE "userId"=$1', [user.id])).rowCount, 0);
    assert.ok(!await tokenPresent(other) && !await tokenPresent(token));
    assert.equal((await pool.query('SELECT 1 FROM verification WHERE value=$1 AND (identifier LIKE \'2fa-%\' OR identifier LIKE \'trust-device-%\')', [user.id])).rowCount, 0);
    assert.equal((await pool.query('SELECT 1 FROM verification WHERE identifier=ANY($1::text[])', [associated])).rowCount, 0, 'Challenge attempt and OIDC binding records must also be removed.');
    assert.ok(JSON.stringify((await pool.query('SELECT secret,"backupCodes",verified FROM "twoFactor" WHERE "userId"=$1', [user.id])).rows[0]) === JSON.stringify(factorBefore), 'Encrypted authenticator secret and recovery codes must be unchanged.');
    assert.equal((await pool.query('SELECT "twoFactorEnabled" FROM "user" WHERE id=$1', [user.id])).rows[0].twoFactorEnabled, true);
    assert.equal((await call('/api/auth/two-factor/verify-backup-code', { code: setup.body.backupCodes[0] }, { actor: pending })).status, 401);
    const fresh = cookies(); assert.equal((await call('/api/auth/sign-in/email', { email: user.email, password }, { actor: fresh })).body.twoFactorRedirect, true);
    assert.equal((await call('/api/auth/two-factor/verify-backup-code', { code: setup.body.backupCodes[0] }, { actor: fresh })).status, 200, 'The preserved recovery code still completes a fresh MFA challenge.');
  });

  await t.test('real PostgreSQL failures roll back token consumption, password and sessions', async () => {
    const user = await fixture(), actor = cookies();
    assert.equal((await call('/api/auth/sign-in/email', { email: user.email, password: user.password }, { actor })).status, 200);
    const token = await mint(user), beforeHash = await hashFor(user.id), beforeSessions = (await pool.query('SELECT id FROM session WHERE "userId"=$1 ORDER BY id', [user.id])).rows;
    const suffix = randomUUID().replaceAll('-', ''), constraint = `recovery_fault_${suffix}`, trigger = `recovery_revoke_${suffix}`, fn = `recovery_revoke_fn_${suffix}`;
    // Names and UUID are fixture-generated, never user input. First fail hashing's
    // subsequent UPDATE, then fail DELETE sessions after the password was updated.
    try {
      await pool.query(`ALTER TABLE account ADD CONSTRAINT ${constraint} CHECK ("userId" <> '${user.id}' OR password = '${beforeHash}') NOT VALID`);
      assert.equal((await reset(token)).status, 503);
      assert.ok(await tokenPresent(token) && await hashFor(user.id) === beforeHash);
      assert.deepEqual((await pool.query('SELECT id FROM session WHERE "userId"=$1 ORDER BY id', [user.id])).rows, beforeSessions);
    } finally { await pool.query(`ALTER TABLE account DROP CONSTRAINT IF EXISTS ${constraint}`); }
    try {
      await pool.query(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN IF OLD."userId" = ''${user.id}'' THEN RAISE EXCEPTION ''synthetic recovery revoke fault''; END IF; RETURN OLD; END;'`);
      await pool.query(`CREATE TRIGGER ${trigger} BEFORE DELETE ON session FOR EACH ROW EXECUTE FUNCTION ${fn}()`);
      assert.equal((await reset(token)).status, 503);
      assert.ok(await tokenPresent(token) && await hashFor(user.id) === beforeHash);
      assert.deepEqual((await pool.query('SELECT id FROM session WHERE "userId"=$1 ORDER BY id', [user.id])).rows, beforeSessions);
    } finally {
      await pool.query(`DROP TRIGGER IF EXISTS ${trigger} ON session`);
      await pool.query(`DROP FUNCTION IF EXISTS ${fn}()`);
    }
    assert.equal((await reset(token)).status, 200, 'Rollback leaves the same link usable after the fault is removed.');
    assert.ok(diagnostics.every(line => !line.includes(token) && !line.includes(beforeHash!) && !line.includes(user.password) && !line.includes('synthetic recovery revoke fault')), 'Unexpected database errors must not leak capability, password, hash or SQL details.');
  });

  await t.test('a failed issuance commit sends no captured link and keeps the response opaque', async () => {
    const user = await fixture(), beforeMessages = messages.length;
    const suffix = randomUUID().replaceAll('-', ''), trigger = `recovery_commit_${suffix}`, fn = `recovery_commit_fn_${suffix}`;
    try {
      // The callback has captured the new token when this deferred COMMIT fault runs.
      await pool.query(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN IF NEW.value = ''${user.id}'' AND NEW.identifier LIKE ''reset-password:%'' THEN RAISE EXCEPTION ''synthetic recovery commit fault''; END IF; RETURN NEW; END;'`);
      await pool.query(`CREATE CONSTRAINT TRIGGER ${trigger} AFTER INSERT ON verification DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ${fn}()`);
      const reply = await call('/api/auth/request-password-reset', { email: user.email });
      assert.equal(reply.status, 200); assert.deepEqual(reply.body, { ok: true });
      await flushMail(); assert.equal(messages.length, beforeMessages);
      assert.equal((await pool.query('SELECT 1 FROM verification WHERE value=$1 AND identifier LIKE \'reset-password:%\'', [user.id])).rowCount, 0);
    } finally {
      await pool.query(`DROP TRIGGER IF EXISTS ${trigger} ON verification`);
      await pool.query(`DROP FUNCTION IF EXISTS ${fn}()`);
    }
  });

  await t.test('password/security session rotation invalidates outstanding recovery links', async () => {
    const user = await fixture(), actor = cookies();
    assert.equal((await call('/api/auth/sign-in/email', { email: user.email, password: user.password }, { actor })).status, 200);
    let token = await mint(user); const nextPassword = randomBytes(24).toString('base64url');
    assert.equal((await call('/api/account/password', { currentPassword: user.password, newPassword: nextPassword }, { actor })).status, 200);
    assert.ok(!await tokenPresent(token));
    token = await mint(user); assert.equal((await call('/api/account/sessions/revoke-others', {}, { actor })).status, 200); assert.ok(!await tokenPresent(token));
    token = await mint(user);
    const security = await call('/api/account/security', undefined, { actor });
    const current = security.body.sessions.find((entry: { current: boolean }) => entry.current); assert.ok(current);
    assert.equal((await call('/api/account/sessions/revoke', { sessionId: current.id }, { actor })).status, 200); assert.ok(!await tokenPresent(token));
  });

  await t.test('global and hashed identity budgets bound requests without storing raw email/token', async () => {
    // These are only this isolated suite's existing recovery budget rows.
    await pool.query("DELETE FROM request_limit WHERE key LIKE 'password-recovery:%'");
    const user = await fixture();
    for (let index = 0; index < 3; index++) assert.equal((await call('/api/auth/request-password-reset', { email: user.email.toUpperCase() })).status, 200);
    assert.equal((await call('/api/auth/request-password-reset', { email: user.email })).status, 429);
    await flushMail();
    const token = 'R'.repeat(24);
    for (let index = 0; index < 5; index++) assert.equal((await reset(token)).status, 400);
    assert.equal((await reset(token)).status, 429);
    const keys = (await pool.query("SELECT key FROM request_limit WHERE key LIKE 'password-recovery:%'")).rows.map(row => row.key as string);
    assert.ok(keys.includes(`password-recovery:email:${createHash('sha256').update(user.email).digest('hex')}`));
    assert.ok(keys.includes(`password-recovery:token:${createHash('sha256').update(token).digest('hex')}`));
    assert.ok(keys.every(key => !key.includes(user.email) && !key.includes(token)));
    for (const [kind, maximum, path, body] of [
      ['request', 20, '/api/auth/request-password-reset', { email: `${randomUUID()}@password-recovery.integration.test` }],
      ['reset', 60, '/api/auth/reset-password', { token: 'S'.repeat(24), newPassword: 'Synthetic password 123' }],
    ] as const) {
      await pool.query('INSERT INTO request_limit(key,minute,count) VALUES($1,floor(extract(epoch FROM now())/60),$2) ON CONFLICT(key,minute) DO UPDATE SET count=$2', [`password-recovery:${kind}:global`, maximum]);
      assert.equal((await call(path, body)).status, 429);
    }
  });
});
