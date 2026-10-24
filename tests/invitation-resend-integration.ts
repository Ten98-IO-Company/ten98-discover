import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';

// Source API handlers + installed Better Auth + real PostgreSQL. Only the mail
// boundary is mocked; no SMTP, provider calls, web listener or real users.
// Run separately on a fresh, migrated loopback database:
// node --experimental-test-module-mocks --test tests/invitation-resend-integration.ts
test('invitation resend and new link: managers only, pending only, rotate the link, bounded sends', { timeout: 120_000 }, async t => {
  assert.equal(process.env.TEN98_INVITATION_RESEND_INTEGRATION, '1', 'Explicit isolated invitation-resend opt-in is required.');
  const { getConfig } = await import('../src/server/config.ts');
  let config: ReturnType<typeof getConfig>;
  try { config = getConfig(); } catch { throw new Error('Isolated invitation-resend configuration is invalid; values are redacted.'); }
  const local = new Set(['localhost', '127.0.0.1', '[::1]']);
  const app = new URL(config.appUrl), database = new URL(config.databaseUrl);
  assert.ok(local.has(app.hostname) && local.has(database.hostname), 'Only loopback application/database configuration is allowed.');
  assert.ok(!database.search && !database.hash, 'Database query and fragment overrides are not allowed.');
  if (process.env.TEN98_ISOLATED_CI_DATABASE === '1') {
    assert.equal(database.protocol, 'postgres:'); assert.equal(database.hostname, '127.0.0.1'); assert.equal(database.port, '5432');
    assert.equal(database.pathname, '/ten98_invitation_resend_ci'); assert.equal(app.origin, 'http://127.0.0.1:3111');
    assert.equal(process.env.ANALYTICS_NETWORK_MODE, 'off');
  }
  const { getDatabase, closeDatabase, assertSchema } = await import('../src/server/db.ts');
  const { pool } = getDatabase();
  t.after(closeDatabase);
  await assertSchema();
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM "user"')).rows[0].count, 0, 'Use a fresh migrated database; fixtures are retained and this check never clears users.');
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM request_limit')).rows[0].count, 0, 'Use a fresh isolated request budget.');

  const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
  let configured = false, failSend = false;
  const sends: { to: string; subject: string; text: string; committed: boolean }[] = [];
  t.mock.module(new URL('../src/server/email.ts', import.meta.url).href, { cache: true, namedExports: {
    getEmailStatus: () => ({ configured, transport: configured ? 'ses' : 'disabled' }),
    sendTransactionalEmail: async (message: { to: string; subject: string; text: string }) => {
      const token = /#invite=([A-Za-z0-9_-]{43})(?![A-Za-z0-9_-])/.exec(message.text)?.[1] ?? '';
      const visible = await pool.query('SELECT 1 FROM workspace_invitation WHERE token_hash=$1 AND email=$2 AND expires_at>clock_timestamp()', [sha256(token), message.to]);
      sends.push({ ...message, committed: visible.rowCount === 1 });
      if (failSend) throw new Error('Synthetic delivery failure; no external transport was used.');
      return { accepted: true as const, delivery: 'unconfirmed' as const };
    },
  } });
  const forbidden = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Network fetch is forbidden in the invitation-resend fixture.'); });
  const { handleApi } = await import('../src/server/api.ts');
  const { hashPassword } = await import('better-auth/crypto');
  const diagnostics: string[] = [];
  for (const method of ['error', 'warn', 'log', 'info'] as const) t.mock.method(console, method, (...args: unknown[]) => { diagnostics.push(args.map(String).join(' ')); });
  const replies: string[] = [];

  type Jar = Map<string, string>;
  async function call(jar: Jar, path: string, body: unknown) {
    const headers = new Headers({ 'content-type': 'application/json', origin: config.appUrl });
    if (jar.size) headers.set('cookie', [...jar].map(([key, value]) => `${key}=${value}`).join('; '));
    const response = await handleApi(new Request(new URL(path, config.appUrl), { method: 'POST', headers, body: JSON.stringify(body) }));
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(';')[0], split = pair.indexOf('=');
      jar.set(pair.slice(0, split), pair.slice(split + 1));
    }
    const text = await response.text();
    replies.push(text);
    return { status: response.status, body: JSON.parse(text) as Record<string, any> };
  }
  async function member(role: 'owner' | 'admin' | 'editor' | 'viewer') {
    const id = randomUUID(), email = `${id}@invitation-resend.integration.test`, password = randomBytes(24).toString('base64url');
    await pool.query('INSERT INTO "user"(id,name,email) VALUES($1,$2,$3)', [id, `Synthetic ${role}`, email]);
    await pool.query('INSERT INTO account(id,"accountId","providerId","userId",password) VALUES($1,$2,\'credential\',$2,$3)', [randomUUID(), id, await hashPassword(password)]);
    const jar: Jar = new Map();
    assert.equal((await call(jar, '/api/auth/sign-in/email', { email, password })).status, 200);
    return { id, jar };
  }

  const owner = await member('owner');
  const workspace = await call(owner.jar, '/api/workspaces', { name: `Synthetic workspace ${randomUUID()}` });
  assert.equal(workspace.status, 201);
  const workspaceId = workspace.body.workspace.id as string;
  const [admin, editor, viewer] = [await member('admin'), await member('editor'), await member('viewer')];
  for (const [user, role] of [[admin, 'admin'], [editor, 'editor'], [viewer, 'viewer']] as const) {
    await pool.query('INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,$3)', [workspaceId, user.id, role]);
  }

  const tokens: string[] = [], addresses: string[] = [];
  const tokenOf = (inviteUrl: string) => {
    const url = new URL(inviteUrl);
    assert.ok(url.origin === config.appUrl && url.pathname === '/' && url.search === '' && /^#invite=[A-Za-z0-9_-]{43}$/.test(url.hash), 'The capability travels only in the link fragment.');
    const token = url.hash.slice('#invite='.length); tokens.push(token); return token;
  };
  // Created while no transport is configured, so creation spends no email budget.
  async function invite(role: 'admin' | 'editor' | 'viewer' = 'viewer') {
    const wasConfigured = configured; configured = false;
    try {
      const email = `${randomUUID()}@invitation-resend.integration.test`; addresses.push(email);
      const reply = await call(owner.jar, `/api/workspaces/${workspaceId}/invitations`, { email, role });
      assert.equal(reply.status, 201); assert.equal(reply.body.email, 'disabled');
      return { id: reply.body.invitation.id as string, email, token: tokenOf(reply.body.inviteUrl) };
    } finally { configured = wasConfigured; }
  }
  const action = (jar: Jar, id: string, kind: 'resend' | 'new-link') => call(jar, `/api/workspaces/${workspaceId}/invitations/${id}/${kind}`, {});
  const works = async (token: string) => (await call(new Map(), '/api/invitations/inspect', { token })).status === 200;
  const stored = async (id: string) => (await pool.query('SELECT token_hash, expires_at FROM workspace_invitation WHERE id=$1', [id])).rows[0];

  await t.test('(a) without a transport, resend answers 409, sends nothing and keeps the link', async () => {
    const inv = await invite();
    const before = await stored(inv.id);
    const reply = await action(owner.jar, inv.id, 'resend');
    assert.equal(reply.status, 409);
    assert.match(reply.body.error, /Email is not set up/); assert.match(reply.body.error, /New link/);
    assert.equal(sends.length, 0);
    assert.deepEqual(await stored(inv.id), before);
    assert.ok(await works(inv.token), 'The current link still works.');
    assert.equal((await pool.query("SELECT 1 FROM request_limit WHERE key LIKE 'invitation-%'")).rowCount, 0, 'No budget is spent.');
  });

  configured = true;
  await t.test('(b) editors and viewers are refused, and admins cannot touch admin invitations', async () => {
    const inv = await invite(), adminInvite = await invite('admin');
    for (const user of [editor, viewer]) for (const kind of ['resend', 'new-link'] as const) {
      assert.equal((await action(user.jar, inv.id, kind)).status, 404, 'Non-managers see the workspace as unavailable.');
    }
    for (const kind of ['resend', 'new-link'] as const) assert.equal((await action(admin.jar, adminInvite.id, kind)).status, 403);
    assert.ok(await works(inv.token) && await works(adminInvite.token));
    assert.equal(sends.length, 0);
    assert.equal((await pool.query("SELECT 1 FROM request_limit WHERE key LIKE 'invitation-%'")).rowCount, 0, 'Refused callers spend no budget.');
  });

  await t.test('(c) resend emails a committed new link through the transport and the old link stops working', async () => {
    const inv = await invite('editor');
    await pool.query("UPDATE workspace_invitation SET expires_at=clock_timestamp()+interval '1 day' WHERE id=$1", [inv.id]);
    const reply = await action(owner.jar, inv.id, 'resend');
    assert.equal(reply.status, 200);
    assert.deepEqual(Object.keys(reply.body).sort(), ['email', 'invitation', 'inviteUrl']);
    assert.equal(reply.body.email, 'accepted');
    assert.ok(reply.body.invitation.id === inv.id && reply.body.invitation.email === inv.email && reply.body.invitation.role === 'editor');
    assert.ok(new Date(reply.body.invitation.expiresAt).getTime() > Date.now() + 6.9 * 86_400_000, 'The seven days restart.');
    const token = tokenOf(reply.body.inviteUrl);
    assert.equal(sends.length, 1);
    const [sent] = sends;
    assert.ok(sent.committed, 'Mail observes the rotated link committed.');
    assert.equal(sent.to, inv.email); assert.equal(sent.subject, 'Your ten98 Discover workspace invitation');
    assert.equal(sent.text.split(token).length, 2); assert.match(sent.text, /\beditor\b/);
    assert.ok(!(await works(inv.token)), 'The previous link is invalid.');
    assert.ok(await works(token));

    failSend = true;
    try {
      const failed = await action(owner.jar, inv.id, 'resend');
      assert.equal(failed.status, 200); assert.equal(failed.body.email, 'failed');
      const next = tokenOf(failed.body.inviteUrl);
      assert.equal(sends.length, 2);
      assert.ok(await works(next) && !(await works(token)), 'A failed send still returns the working rotated link.');
    } finally { failSend = false; }
  });

  await t.test('(d) new link rotates without email', async () => {
    const inv = await invite();
    const reply = await action(owner.jar, inv.id, 'new-link');
    assert.equal(reply.status, 200);
    assert.deepEqual(Object.keys(reply.body).sort(), ['invitation', 'inviteUrl']);
    assert.equal(reply.body.invitation.id, inv.id);
    const token = tokenOf(reply.body.inviteUrl);
    assert.equal(sends.length, 2, 'No email is sent.');
    assert.ok(!(await works(inv.token)) && await works(token));
    const managed = await invite('editor');
    const byAdmin = await action(admin.jar, managed.id, 'new-link');
    assert.equal(byAdmin.status, 200, 'An admin may rotate an editor invitation.');
    assert.ok(!(await works(managed.token)) && await works(tokenOf(byAdmin.body.inviteUrl)));
  });

  await t.test('(e) accepted, revoked, expired and unknown invitations are refused with 409', async () => {
    const accepted = await invite();
    assert.equal((await call(new Map(), '/api/invitations/accept', { token: accepted.token, name: 'Synthetic invitee', password: randomBytes(24).toString('base64url') })).status, 200);
    const revoked = await invite();
    assert.equal((await call(owner.jar, `/api/workspaces/${workspaceId}/invitations/${revoked.id}/revoke`, {})).status, 200);
    const expired = await invite();
    await pool.query("UPDATE workspace_invitation SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [expired.id]);
    const before = await stored(expired.id), sent = sends.length;
    for (const id of [accepted.id, revoked.id, expired.id, randomUUID()]) for (const kind of ['resend', 'new-link'] as const) {
      const reply = await action(owner.jar, id, kind);
      assert.equal(reply.status, 409, `${kind} is refused for a non-pending invitation`);
      assert.match(reply.body.error, /no longer pending/);
    }
    assert.deepEqual(await stored(expired.id), before, 'An expired invitation is not revived.');
    assert.equal(sends.length, sent);
  });

  await t.test('(f) resends are limited per invitation and per workspace before the link changes', async () => {
    const inv = await invite();
    let token = inv.token;
    for (let index = 0; index < 3; index++) {
      const reply = await action(owner.jar, inv.id, 'resend');
      assert.equal(reply.status, 200); assert.equal(reply.body.email, 'accepted');
      token = tokenOf(reply.body.inviteUrl);
    }
    const before = await stored(inv.id), sent = sends.length;
    const refused = await action(owner.jar, inv.id, 'resend');
    assert.equal(refused.status, 429);
    assert.equal(sends.length, sent); assert.deepEqual(await stored(inv.id), before);
    assert.ok(await works(token), 'A refused resend keeps the current link working.');
    assert.equal((await action(owner.jar, inv.id, 'new-link')).status, 200, 'New link is not a resend and stays available.');

    // Resends so far in this workspace: two in (c) and three here. The workspace allows 20 per hour.
    const spent = Number((await pool.query('SELECT sum(count)::int AS total FROM request_limit WHERE key=$1', [`invitation-resend:workspace:${workspaceId}`])).rows[0].total);
    assert.equal(spent, 5);
    const pending = [];
    for (let index = spent; index < 21; index++) pending.push(await invite());
    for (const item of pending.slice(0, -1)) assert.equal((await action(admin.jar, item.id, 'resend')).status, 200);
    const last = pending.at(-1)!, lastBefore = await stored(last.id), lastSent = sends.length;
    assert.equal((await action(admin.jar, last.id, 'resend')).status, 429, 'The 21st resend in a workspace hour is refused.');
    assert.equal(sends.length, lastSent); assert.deepEqual(await stored(last.id), lastBefore);
    assert.ok(await works(last.token));
  });

  await t.test('(g) no invitation capability reaches logs, limiter keys, error replies or stored rows', async () => {
    assert.ok(tokens.length > 20);
    const keys = (await pool.query('SELECT key FROM request_limit')).rows.map(row => row.key as string);
    const hashes = (await pool.query('SELECT token_hash FROM workspace_invitation')).rows.map(row => row.token_hash as string);
    for (const token of tokens) {
      assert.ok(diagnostics.every(line => !line.includes(token)), 'Logs never carry an invitation capability.');
      assert.ok(keys.every(key => !key.includes(token)));
      assert.ok(hashes.every(hash => hash !== token && !hash.includes(token)), 'Only digests are stored.');
      assert.ok(replies.every(reply => !reply.includes(token) || reply.includes(`#invite=${token}`)), 'Only the invite link itself carries the token.');
    }
    assert.ok(keys.every(key => addresses.every(value => !key.includes(value))), 'Limiter keys never store a raw address.');
    assert.ok(diagnostics.every(line => addresses.every(value => !line.includes(value))), 'Logs never carry a recipient.');
  });

  assert.equal(forbidden.mock.callCount(), 0);
});
