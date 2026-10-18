import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

// Source API handlers + installed Better Auth + real PostgreSQL. Only the mail
// boundary is mocked; no SMTP, provider calls, web listener or real users.
// Run separately on a fresh, migrated loopback database:
// node --experimental-test-module-mocks --test tests/invitation-email-integration.ts
test('invitation email: after commit, fixed text, one attempt, hashed per-address limit', { timeout: 120_000 }, async t => {
  assert.equal(process.env.TEN98_INVITATION_EMAIL_INTEGRATION, '1', 'Explicit isolated invitation-email opt-in is required.');
  const { getConfig } = await import('../src/server/config.ts');
  let config: ReturnType<typeof getConfig>;
  try { config = getConfig(); } catch { throw new Error('Isolated invitation-email configuration is invalid; values are redacted.'); }
  const local = new Set(['localhost', '127.0.0.1', '[::1]']);
  const app = new URL(config.appUrl), database = new URL(config.databaseUrl);
  assert.ok(local.has(app.hostname) && local.has(database.hostname), 'Only loopback application/database configuration is allowed.');
  assert.ok(!database.search && !database.hash, 'Database query and fragment overrides are not allowed.');
  if (process.env.TEN98_ISOLATED_CI_DATABASE === '1') {
    assert.equal(database.protocol, 'postgres:'); assert.equal(database.hostname, '127.0.0.1'); assert.equal(database.port, '5432');
    assert.equal(database.pathname, '/ten98_invitation_email_ci'); assert.equal(app.origin, 'http://127.0.0.1:3111');
    assert.equal(process.env.ANALYTICS_NETWORK_MODE, 'off');
  }
  const { getDatabase, closeDatabase, assertSchema } = await import('../src/server/db.ts');
  const { pool } = getDatabase();
  t.after(closeDatabase);
  await assertSchema();
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM "user"')).rows[0].count, 0, 'Use a fresh migrated database; fixtures are retained and this check never clears users.');
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM request_limit')).rows[0].count, 0, 'Use a fresh isolated request budget.');

  // The real transport is mocked away; a synthetic secret still proves nothing echoes transport configuration.
  const transportSecret = randomBytes(24).toString('base64url'), previousSecret = process.env.EMAIL_SMTP_PASSWORD;
  process.env.EMAIL_SMTP_PASSWORD = transportSecret;
  t.after(() => { if (previousSecret === undefined) delete process.env.EMAIL_SMTP_PASSWORD; else process.env.EMAIL_SMTP_PASSWORD = previousSecret; });
  const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
  let configured = false, failSend = false;
  const sends: { to: string; subject: string; text: string; committed: boolean }[] = [];
  t.mock.module(new URL('../src/server/email.ts', import.meta.url).href, { cache: true, namedExports: {
    getEmailStatus: () => ({ configured, transport: configured ? 'smtp' : 'disabled' }),
    sendTransactionalEmail: async (message: { to: string; subject: string; text: string }) => {
      const token = /#invite=([A-Za-z0-9_-]{43})(?![A-Za-z0-9_-])/.exec(message.text)?.[1] ?? '';
      const visible = await pool.query('SELECT 1 FROM workspace_invitation WHERE token_hash=$1 AND email=$2 AND expires_at>clock_timestamp()', [sha256(token), message.to]);
      sends.push({ ...message, committed: visible.rowCount === 1 });
      if (failSend) throw new Error('Synthetic delivery failure; no external transport was used.');
      return { accepted: true as const, delivery: 'unconfirmed' as const };
    },
  } });
  // Reject accidental HTTP/provider work. The native PostgreSQL socket is explicit above.
  const forbidden = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Network fetch is forbidden in the invitation-email fixture.'); });
  const { handleApi } = await import('../src/server/api.ts');
  const { hashPassword } = await import('better-auth/crypto');
  const diagnostics: string[] = [];
  for (const method of ['error', 'warn'] as const) t.mock.method(console, method, (...args: unknown[]) => { diagnostics.push(args.map(String).join(' ')); });
  const actor = new Map<string, string>();
  async function call(path: string, body: unknown) {
    const headers = new Headers({ 'content-type': 'application/json', origin: config.appUrl });
    if (actor.size) headers.set('cookie', [...actor].map(([key, value]) => `${key}=${value}`).join('; '));
    const response = await handleApi(new Request(new URL(path, config.appUrl), { method: 'POST', headers, body: JSON.stringify(body) }));
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(';')[0], split = pair.indexOf('=');
      actor.set(pair.slice(0, split), pair.slice(split + 1));
    }
    return { status: response.status, body: await response.json() as Record<string, any> };
  }

  const ownerId = randomUUID(), ownerName = `Synthetic inviter ${randomUUID()}`, ownerEmail = `${ownerId}@invitation-email.integration.test`, password = randomBytes(24).toString('base64url');
  await pool.query('INSERT INTO "user"(id,name,email) VALUES($1,$2,$3)', [ownerId, ownerName, ownerEmail]);
  await pool.query('INSERT INTO account(id,"accountId","providerId","userId",password) VALUES($1,$2,\'credential\',$2,$3)', [randomUUID(), ownerId, await hashPassword(password)]);
  assert.equal((await call('/api/auth/sign-in/email', { email: ownerEmail, password })).status, 200);
  const workspaceName = `Synthetic workspace ${randomUUID()}`;
  const workspace = await call('/api/workspaces', { name: workspaceName });
  assert.equal(workspace.status, 201);
  const workspaceId = workspace.body.workspace.id as string;
  const addresses: string[] = [], tokens: string[] = [];
  const address = () => { const value = `${randomUUID()}@invitation-email.integration.test`; addresses.push(value); return value; };
  async function invite(email: string, delivery: 'accepted' | 'failed' | 'disabled', role = 'viewer', submitted = email) {
    const reply = await call(`/api/workspaces/${workspaceId}/invitations`, { email: submitted, role });
    assert.equal(reply.status, 201, 'No delivery outcome fails the invitation.');
    assert.deepEqual(Object.keys(reply.body).sort(), ['email', 'invitation', 'inviteUrl']);
    assert.equal(reply.body.email, delivery);
    assert.ok(reply.body.invitation.email === email && reply.body.invitation.role === role);
    const url = new URL(reply.body.inviteUrl);
    assert.ok(url.origin === config.appUrl && url.pathname === '/' && url.search === '' && /^#invite=[A-Za-z0-9_-]{43}$/.test(url.hash), 'The manual link is always returned with its capability in the fragment.');
    const token = url.hash.slice('#invite='.length); tokens.push(token);
    assert.ok(!JSON.stringify(reply.body).includes(transportSecret));
    assert.equal((await pool.query('SELECT 1 FROM workspace_invitation WHERE token_hash=$1 AND workspace_id=$2 AND email=$3', [sha256(token), workspaceId, email])).rowCount, 1);
    return { token, inviteUrl: reply.body.inviteUrl as string };
  }

  await t.test('(a) a disabled transport sends nothing and spends no address budget', async () => {
    await invite(address(), 'disabled');
    assert.equal(sends.length, 0);
    assert.equal((await pool.query("SELECT 1 FROM request_limit WHERE key LIKE 'invitation-email:%'")).rowCount, 0);
  });

  configured = true;
  await t.test('(b) one committed send to the normalized address with fixed text whose only capability is the link', async () => {
    const email = address(), { token, inviteUrl } = await invite(email, 'accepted', 'viewer', `  ${email.toUpperCase()} `);
    assert.equal(sends.length, 1);
    const [sent] = sends;
    assert.ok(sent.committed, 'Mail observes the invitation committed on another database connection.');
    assert.equal(sent.to, email); assert.equal(sent.subject, 'Your ten98 Discover workspace invitation');
    const links = sent.text.match(/https?:\/\/\S+/g) ?? [];
    assert.ok(links.every(link => link === config.appUrl || link === inviteUrl) && links.filter(link => link === inviteUrl).length === 1, 'The emailed text links only the installation and the returned invitation link.');
    assert.equal(sent.text.split(token).length, 2); assert.equal(sent.text.split('#').length, 2);
    assert.match(sent.text, /\bviewer\b/);
    for (const value of [workspaceName, workspaceId, ownerName, ownerEmail, ownerId]) assert.ok(!sent.text.includes(value) && !sent.subject.includes(value), 'No member-chosen workspace or inviter text reaches the sender.');
  });

  await t.test('(c) a throwing sender still answers 201 with the link, failed, and one attempt', async () => {
    failSend = true;
    try {
      const email = address(), { token } = await invite(email, 'failed', 'editor');
      assert.equal(sends.length, 2); assert.ok(sends[1].committed && sends[1].to === email);
      await delay(250); assert.equal(sends.length, 2, 'No automatic delivery retry.');
      const preview = await call('/api/invitations/inspect', { token });
      assert.ok(preview.status === 200 && preview.body.email === email && preview.body.role === 'editor', 'The manual link still works after a failed send.');
    } finally { failSend = false; }
  });

  await t.test('(d) the fourth invitation to one address within a minute is created but not sent', async () => {
    const clock = Number((await pool.query('SELECT extract(epoch FROM clock_timestamp())::float8 AS now')).rows[0].now), left = 60 - clock % 60;
    if (left < 15) await delay(left * 1000 + 250); // Keep the four sends inside one limiter minute.
    const global = async () => Number((await pool.query("SELECT count FROM request_limit WHERE key='invitation-email:global' AND minute=floor(extract(epoch FROM now()) / 60)")).rows[0]?.count ?? 0);
    const email = address(), before = sends.length, spent = await global();
    for (let index = 0; index < 3; index++) await invite(email, 'accepted');
    assert.equal(sends.length, before + 3);
    const { token } = await invite(email, 'failed');
    assert.equal(sends.length, before + 3, 'The address limit refuses the send without failing the invitation.');
    assert.equal(await global(), spent + 3, 'A send the address limit refuses spends none of the installation budget.');
    assert.deepEqual((await pool.query('SELECT token_hash FROM workspace_invitation WHERE workspace_id=$1 AND email=$2', [workspaceId, email])).rows, [{ token_hash: sha256(token) }], 'Only the newest link remains.');
    await invite(address(), 'accepted');
    assert.equal(sends.length, before + 4, 'The limit is per address, not global.');
    const keys = (await pool.query("SELECT key FROM request_limit WHERE key LIKE 'invitation-email:%'")).rows.map(row => row.key as string);
    assert.ok(keys.includes(`invitation-email:${sha256(email)}`));
    assert.ok(keys.every(key => addresses.every(value => !key.includes(value))), 'Limiter keys never store a raw address.');
  });

  await t.test('(e) the installation-wide budget refuses a send to a fresh address after twenty attempts in a minute', async () => {
    const clock = Number((await pool.query('SELECT extract(epoch FROM clock_timestamp())::float8 AS now')).rows[0].now), left = 60 - clock % 60;
    if (left < 20) await delay(left * 1000 + 250); // Keep the budget and the refusal inside one limiter minute.
    const current = "SELECT count FROM request_limit WHERE key='invitation-email:global' AND minute=floor(extract(epoch FROM now()) / 60)";
    const used = (await pool.query(current)).rows[0]?.count ?? 0, before = sends.length;
    assert.ok(used < 20, 'Earlier stages leave part of the installation budget.');
    for (let index = used; index < 20; index++) await invite(address(), 'accepted');
    assert.equal(sends.length, before + 20 - used);
    await invite(address(), 'failed');
    assert.equal(sends.length, before + 20 - used, 'A fresh address gets no send once the installation budget is spent.');
    assert.equal((await pool.query(current)).rows[0]?.count, 21, 'The budget and the refusal fell in one minute.');
    const keys = (await pool.query("SELECT key FROM request_limit WHERE key LIKE 'invitation-email:%'")).rows.map(row => row.key as string);
    assert.ok(keys.every(key => addresses.every(value => !key.includes(value))), 'Limiter keys never store a raw address.');
  });

  assert.equal(forbidden.mock.callCount(), 0);
  assert.ok(diagnostics.every(line => !line.includes(transportSecret) && tokens.every(token => !line.includes(token)) && addresses.every(value => !line.includes(value))), 'Logs never carry an invitation capability, recipient or transport secret.');
});
