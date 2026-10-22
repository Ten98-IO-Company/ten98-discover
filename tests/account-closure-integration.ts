import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { hashPassword } from 'better-auth/crypto';
import { getConfig } from '../src/server/config.ts';
import { assertSchema, closeDatabase, getDatabase } from '../src/server/db.ts';
import { handleApi } from '../src/server/api.ts';
import { createApiKey } from '../src/server/api-keys.ts';
import { inviteMember } from '../src/server/teams.ts';
import { createWebsiteShare, listWebsiteShares, readWebsiteShare } from '../src/server/website-shares.ts';
import { AccountClosureBlocked, closeAccount, type StepUpProof } from '../src/server/account-closure.ts';
import { setTimeout as delay } from 'node:timers/promises';
import { getBoss, stopJobs } from '../src/server/jobs.ts';
import { authenticatorCode } from './account-security-integration.ts';

// Needs an isolated synthetic PostgreSQL database; never a real installation. Every account, workspace and row here is
// created by this module, and fixtures stay for inspection. Account closure contract: https://github.com/Ten98-IO-Company/ten98-discover/wiki/Account-Closure.
type Jar = Map<string, string>;
type Reply = { status: number; body: Record<string, any> };

export async function runAccountClosureChecks() {
  assert.equal(process.env.TEN98_INTEGRATION_TEST, '1');
  const config = getConfig();
  for (const url of [config.appUrl, config.databaseUrl]) assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname));
  await assertSchema();
  const { pool } = getDatabase(), suffix = randomUUID().slice(0, 8);
  // In-process requests have no transport peer and share the unknown-client sign-in budgets; start this module with them empty.
  await pool.query('DELETE FROM request_limit WHERE key=ANY($1::text[])', [['signin:client:unknown', 'two-factor:client:unknown']]);

  async function call(path: string, jar: Jar | null, body?: unknown, bearer?: string): Promise<Reply> {
    const headers = new Headers();
    if (jar?.size) headers.set('cookie', [...jar].map(([name, value]) => `${name}=${value}`).join('; '));
    if (bearer) headers.set('authorization', `Bearer ${bearer}`);
    if (body !== undefined) { headers.set('content-type', 'application/json'); headers.set('origin', config.appUrl); }
    const response = await handleApi(new Request(config.appUrl + path, { method: body === undefined ? 'GET' : 'POST', headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(';'), split = pair.indexOf('=');
      if (/max-age=0(?:;|$)/i.test(cookie)) jar?.delete(pair.slice(0, split)); else jar?.set(pair.slice(0, split), pair.slice(split + 1));
    }
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : {} };
  }
  async function expect(path: string, jar: Jar | null, status: number, body?: unknown, bearer?: string) {
    const reply = await call(path, jar, body, bearer);
    assert.equal(reply.status, status, `Account closure HTTP contract failed at ${path}.`);
    return reply.body;
  }
  async function account(label: string) {
    const id = randomUUID(), email = `${label}-${suffix}@closure.integration.test`, password = randomBytes(18).toString('base64url');
    await pool.query('INSERT INTO "user"(id,name,email,image) VALUES($1,$2,$3,$4)', [id, `Closure ${label}`, email, 'https://closure.integration.test/avatar.png']);
    await pool.query('INSERT INTO account(id,"accountId","providerId","userId",password) VALUES($1,$2,\'credential\',$2,$3)', [randomUUID(), id, await hashPassword(password)]);
    return { id, email, password };
  }
  async function signIn(user: { email: string; password: string }) {
    const jar: Jar = new Map();
    await expect('/api/auth/sign-in/email', jar, 200, { email: user.email, password: user.password });
    return jar;
  }

  // Fixture: closing account A co-owns W with B, solely owns W2 (the blocker), sent an invitation from W and has one
  // addressed to it in W3. Operator O closes account C. Financial and share rows reference A as their actor.
  const a = await account('closing'), b = await account('co-owner'), c = await account('operator-target'), o = await account('operator');
  const w = randomUUID(), w2 = randomUUID(), w3 = randomUUID(), project = randomUUID(), connection = randomUUID();
  await pool.query("INSERT INTO workspace(id,name) VALUES($1,'Closure shared'),($2,'Closure sole'),($3,'Closure other')", [w, w2, w3]);
  await pool.query("INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'owner'),($4,$2,'owner'),($5,$3,'owner'),($1,$6,'editor')", [w, a.id, b.id, w2, w3, c.id]);
  await pool.query("INSERT INTO project(id,workspace_id,name,origin,public_key,retention_next_run_at) VALUES($1,$2,'Closure site',$3,gen_random_uuid(),'infinity')", [project, w, `https://${suffix}.closure.integration.test`]);
  await pool.query('INSERT INTO instance_operator(user_id,source) VALUES($1,\'host\'),($2,\'host\') ON CONFLICT DO NOTHING', [o.id, a.id]);
  await pool.query("INSERT INTO user_preference(user_id,time_zone,locale,theme,revision) VALUES($1,'UTC','en-US','dark',1)", [a.id]);
  await pool.query("INSERT INTO provider_connection(id,workspace_id,provider,name) VALUES($1,$2,'dataforseo','Closure synthetic, no credentials')", [connection, w]);
  const financial = randomUUID();
  await pool.query(`INSERT INTO provider_request(id,workspace_id,connection_id,connection_revision,user_id,request_key,operation,input_hash,estimate_micros,actual_micros,status,budget_month)
    VALUES($1,$2,$3,1,$4,gen_random_uuid(),'closure.fixture',$5,1000,1000,'settled',date_trunc('month',now())::date)`, [financial, w, connection, a.id, 'a'.repeat(64)]);
  const financialRow = async () => (await pool.query('SELECT to_jsonb(p) AS row FROM provider_request p WHERE id=$1', [financial])).rows[0].row;
  const financialBefore = await financialRow();
  const sentInvitation = await inviteMember(w, a.id, { email: `invitee-${suffix}@closure.integration.test`, role: 'viewer' });
  await inviteMember(w3, b.id, { email: a.email, role: 'viewer' });
  await pool.query(`INSERT INTO verification(id,identifier,value,"expiresAt") VALUES($1,$2,$3,clock_timestamp()+interval '1 hour'),($4,$5,'closure-fixture',clock_timestamp()+interval '1 hour')`,
    [randomUUID(), `reset-password:${randomBytes(12).toString('hex')}`, a.id, randomUUID(), `email-fixture:${a.email}`]);
  const { key: apiKey, token } = await createApiKey(w, a.id, { name: 'Closure fixture', scopes: ['projects:read'] });
  await expect(`/api/workspaces/${w}/projects`, null, 200, undefined, token);
  // A queued worker check that cannot start before closure runs.
  const probe = randomUUID();
  await pool.query('INSERT INTO import_probe(id,project_id,user_id,request_id) VALUES($1,$2,$3,gen_random_uuid())', [probe, project, a.id]);
  assert.equal(await (await getBoss()).send('setup-probe', { probeId: probe }, { id: probe, startAfter: 3600 }), probe);
  const shareToken = randomBytes(32).toString('base64url');
  const share = await createWebsiteShare(project, a.id, { requestId: randomUUID(), label: 'Closure share', sections: ['overview'], expiresAt: new Date(Date.now() + 86_400_000).toISOString(), token: shareToken });
  const shareId = share.ack.shareId, today = new Date().toISOString().slice(0, 10);
  await readWebsiteShare(shareId, shareToken, { from: today, to: today });

  // Sessions and two-factor: enrol through the real routes, then open a second session with a recovery code.
  const primary = await signIn(a);
  const enrollment = await expect('/api/account/two-factor/enable', primary, 200, { password: a.password });
  const secret = new URL(enrollment.totpURI).searchParams.get('secret')!, backupCodes = enrollment.backupCodes as string[];
  await expect('/api/account/two-factor/verify', primary, 200, { code: authenticatorCode(secret) });
  const secondary: Jar = new Map();
  assert.equal((await expect('/api/auth/sign-in/email', secondary, 200, { email: a.email, password: a.password })).twoFactorRedirect, true);
  await expect('/api/auth/two-factor/verify-backup-code', secondary, 200, { code: backupCodes[0] });
  await pool.query(`UPDATE session SET "ipAddress"='203.0.113.7',"userAgent"='Closure fixture agent' WHERE "userId"=$1`, [a.id]);
  assert.equal((await pool.query('SELECT 1 FROM session WHERE "userId"=$1', [a.id])).rowCount, 2);
  await expect('/api/me', secondary, 200);

  // Everything closure may change for A, excluding rate-limit counters the requests themselves increment.
  const snapshot = async (userId: string, email: string) => {
    const read = async (sql: string, withEmail = false) => (await pool.query(sql, withEmail ? [userId, email] : [userId])).rows.map(row => row.row);
    return {
      user: await read('SELECT to_jsonb(u) AS row FROM "user" u WHERE id=$1 OR lower(email)=$2', true),
      session: await read('SELECT to_jsonb(s) AS row FROM session s WHERE "userId"=$1 ORDER BY id'),
      account: await read('SELECT to_jsonb(a) AS row FROM account a WHERE "userId"=$1 ORDER BY id'),
      factor: await read('SELECT to_jsonb(f) AS row FROM "twoFactor" f WHERE "userId"=$1'),
      verification: await read("SELECT to_jsonb(v) AS row FROM verification v WHERE value=$1::text OR right(identifier,length($2::text))=$2::text ORDER BY id", true),
      keys: await read('SELECT to_jsonb(k) AS row FROM api_key k WHERE issuer_user_id=$1 ORDER BY id'),
      memberships: await read('SELECT to_jsonb(m) AS row FROM membership m WHERE user_id=$1 ORDER BY workspace_id'),
      invitations: await read('SELECT to_jsonb(i) AS row FROM workspace_invitation i WHERE inviter_id=$1 OR email=$2 ORDER BY id', true),
      operator: await read('SELECT to_jsonb(r) AS row FROM instance_operator r WHERE user_id=$1'),
      preference: await read('SELECT to_jsonb(p) AS row FROM user_preference p WHERE user_id=$1'),
      probes: await read('SELECT to_jsonb(p) AS row FROM import_probe p WHERE user_id=$1 ORDER BY id'),
      audit: await read('SELECT to_jsonb(e) AS row FROM account_closure_audit e WHERE user_id=$1'),
    };
  };
  const proof = () => ({ password: a.password, backupCode: backupCodes.pop() });

  // 1. Last owner: refused with the workspace listed, and nothing changes (the recovery code is not consumed either).
  const beforeOwner = await snapshot(a.id, a.email);
  const status = await expect('/api/account/closure', primary, 200);
  assert.deepEqual(status.blockers, { workspaces: [{ id: w2, name: 'Closure sole' }], lastOperator: false });
  const refused = await expect('/api/account/closure', primary, 409, proof());
  assert.match(refused.error, /Transfer ownership/); assert.deepEqual(refused.blockers.workspaces, [{ id: w2, name: 'Closure sole' }]);
  assert.deepEqual(await snapshot(a.id, a.email), beforeOwner, 'A refused last-owner closure must roll back completely.');
  console.log('PASS account closure refuses the last owner of a workspace, lists it, and rolls back fully');

  // 2. Last operator: refused inside one transaction that removes every other operator, then rolled back.
  await pool.query("INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,'owner')", [w2, b.id]);
  const beforeOperator = await snapshot(a.id, a.email), isolated = await pool.connect();
  try {
    await isolated.query('BEGIN');
    await isolated.query('DELETE FROM instance_operator WHERE user_id<>$1', [a.id]);
    await assert.rejects(closeAccount(isolated, a.id, { kind: 'self', userId: a.id }, { userId: a.id, method: 'password' } as StepUpProof),
      (error: unknown) => error instanceof AccountClosureBlocked && error.blockers.lastOperator && error.blockers.workspaces.length === 0);
  } finally { await isolated.query('ROLLBACK').catch(() => undefined); isolated.release(); }
  assert.deepEqual(await snapshot(a.id, a.email), beforeOperator, 'A refused last-operator closure must roll back completely.');
  console.log('PASS account closure refuses the last instance operator and rolls back fully');

  // 3. Operator closure needs an operator, its step-up proof and a reason.
  const operatorJar = await signIn(o), memberJar = await signIn(b), beforeTarget = await snapshot(c.id, c.email);
  await expect(`/api/identity/accounts/${c.id}/close`, operatorJar, 400, { proof: { password: o.password } });
  await expect(`/api/identity/accounts/${c.id}/close`, operatorJar, 400, { reason: '   ', proof: { password: o.password } });
  await expect(`/api/identity/accounts/${c.id}/close`, operatorJar, 400, { reason: 'Owner request', proof: { password: 'not the password' } });
  await expect(`/api/identity/accounts/${c.id}/close`, memberJar, 403, { reason: 'Owner request', proof: { password: b.password } });
  assert.deepEqual(await snapshot(c.id, c.email), beforeTarget, 'Refused operator closures change nothing.');
  const operatorClosed = await expect(`/api/identity/accounts/${c.id}/close`, operatorJar, 200, { reason: 'Account holder asked for closure', proof: { password: o.password } });
  assert.equal(operatorClosed.userId, c.id);
  assert.deepEqual((await pool.query('SELECT actor_user_id,kind,reason FROM account_closure_audit WHERE user_id=$1', [c.id])).rows, [{ actor_user_id: o.id, kind: 'operator', reason: 'Account holder asked for closure' }]);
  assert.equal((await pool.query('SELECT name FROM "user" WHERE id=$1 AND closed_at IS NOT NULL', [c.id])).rows[0]?.name, 'Closed account');
  console.log('PASS operator closure requires an instance operator, step-up and a reason, and records the operator event');

  // 3b. Race: a closure holds the account locked (not yet committed) while other connections try to give it a membership,
  // a session, an API key and a preference. Each insert must wait on the account row, then be refused once the closure
  // commits; none may slip past the trigger on the pre-closure snapshot.
  const x = await account('race');
  await pool.query("INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,'editor')", [w, x.id]);
  const holder = await pool.connect(), racers = await Promise.all([1, 2, 3, 4].map(() => pool.connect()));
  try {
    await holder.query('BEGIN');
    await closeAccount(holder, x.id, { kind: 'self', userId: x.id }, { userId: x.id, method: 'password' } as StepUpProof);
    const pids = await Promise.all(racers.map(async racer => (await racer.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid));
    const attempts: [string, unknown[]][] = [
      ["INSERT INTO membership(workspace_id,user_id,role) VALUES($2,$1,'viewer')", [x.id, w3]],
      [`INSERT INTO session(id,token,"userId","expiresAt") VALUES(gen_random_uuid()::text,gen_random_uuid()::text,$1,clock_timestamp()+interval '1 day')`, [x.id]],
      ["INSERT INTO api_key(id,workspace_id,issuer_user_id,name,token_hash,scopes,expires_at) VALUES(gen_random_uuid(),$2,$1,'Race',$3,ARRAY['projects:read'],clock_timestamp()+interval '1 day')", [x.id, w, randomBytes(32).toString('hex')]],
      ["INSERT INTO user_preference(user_id,time_zone,locale,theme,revision) VALUES($1,'UTC','en-US','dark',1)", [x.id]],
    ];
    const outcomes = attempts.map(([sql, params], index) => racers[index].query('BEGIN').then(() => racers[index].query(sql, params))
      .then(() => 'inserted', (error: { code?: string }) => error.code ?? 'error'));
    // Every racer must be blocked on a lock behind the uncommitted closure before it commits.
    let waiting = 0;
    for (let tries = 0; tries < 100 && waiting < pids.length; tries++) {
      await delay(50);
      waiting = (await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid=ANY($1::int[]) AND wait_event_type='Lock'", [pids])).rows[0].n;
    }
    assert.equal(waiting, pids.length, 'Each insert waits on the account row held by the in-flight closure.');
    await holder.query('COMMIT');
    assert.deepEqual(await Promise.all(outcomes), ['23514', '23514', '23514', '23514'], 'Each insert is refused once the closure commits.');
  } finally {
    await holder.query('ROLLBACK').catch(() => undefined); holder.release();
    for (const racer of racers) { await racer.query('ROLLBACK').catch(() => undefined); racer.release(); }
  }
  for (const sql of ['SELECT 1 FROM membership WHERE user_id=$1', 'SELECT 1 FROM session WHERE "userId"=$1', 'SELECT 1 FROM api_key WHERE issuer_user_id=$1', 'SELECT 1 FROM user_preference WHERE user_id=$1'])
    assert.equal((await pool.query(sql, [x.id])).rowCount, 0, 'No row exists for the closed account after the race.');
  assert.ok((await pool.query('SELECT closed_at FROM "user" WHERE id=$1', [x.id])).rows[0].closed_at instanceof Date);
  console.log('PASS concurrent membership, session, API key and preference inserts wait for an in-flight closure and are refused after it commits');

  // 4. Self closure with password and a recovery code.
  const oldEmail = a.email, signinKey = `signin:${createHash('sha256').update(oldEmail).digest('hex')}`;
  await pool.query('INSERT INTO request_limit(key,minute,count) VALUES($1,floor(extract(epoch FROM now())/60),1) ON CONFLICT DO NOTHING', [signinKey]);
  const closed = await call('/api/account/closure', primary, proof());
  assert.equal(closed.status, 200); assert.deepEqual(closed.body, { closed: true });
  const tomb = (await pool.query('SELECT * FROM "user" WHERE id=$1', [a.id])).rows[0];
  assert.equal(tomb.name, 'Closed account'); assert.match(tomb.email, /^closed-[0-9a-f-]{36}@invalid$/); assert.equal(tomb.image, null);
  assert.equal(tomb.emailVerified, false); assert.equal(tomb.twoFactorEnabled, false); assert.ok(tomb.closed_at instanceof Date);
  const after = await snapshot(a.id, oldEmail);
  assert.deepEqual({ ...after, user: after.user.length, probes: after.probes.map((row: any) => row.status), audit: after.audit.map((row: any) => [row.kind, row.actor_user_id, row.reason]) },
    { user: 1, session: [], account: [], factor: [], verification: [], keys: [], memberships: [], invitations: [], operator: [], preference: [], probes: ['denied'], audit: [['self', a.id, null]] });
  assert.equal((await pool.query('SELECT 1 FROM workspace_invitation WHERE id=$1', [sentInvitation.invitation.id])).rowCount, 0);
  assert.equal((await pool.query("SELECT state FROM pgboss.job WHERE id=$1 AND name='setup-probe'", [probe])).rows[0]?.state, 'cancelled');
  assert.equal((await pool.query('SELECT 1 FROM request_limit WHERE key=$1::text OR position($2::text IN key)>0', [signinKey, a.id])).rowCount, 0, 'Rate-limit keys tied to the account are removed.');
  assert.deepEqual((await pool.query("SELECT action FROM instance_operator_audit WHERE user_id=$1", [a.id])).rows, [{ action: 'revoke' }]);
  assert.equal((await pool.query('SELECT 1 FROM "user" WHERE lower(email)=$1', [oldEmail])).rowCount, 0, 'The previous email is stored nowhere on the account.');
  assert.deepEqual(await financialRow(), financialBefore, 'Financial rows that name the account as actor stay unchanged.');
  assert.deepEqual((await pool.query('SELECT to_jsonb(k) AS row FROM api_key k WHERE id=$1', [apiKey.id])).rows, []);
  console.log('PASS self closure tombstones the account, scrubs credentials, sessions, keys, links, invitations, verification and rate-limit rows, cancels its queued job and keeps financial rows');

  // 5. Nothing authenticates as the closed account.
  await expect(`/api/workspaces/${w}/projects`, null, 401, undefined, token);
  const mcp = await handleApi(new Request(config.appUrl + '/api/mcp', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) }));
  assert.equal(mcp.status, 401);
  await expect('/api/me', primary, 401); await expect('/api/me', secondary, 401);
  await expect('/api/auth/sign-in/email', new Map(), 401, { email: oldEmail, password: a.password });
  // The tombstone address is not even a valid sign-in email (no dot in its domain), so it is refused before lookup.
  assert.ok([400, 401].includes((await call('/api/auth/sign-in/email', new Map(), { email: tomb.email, password: a.password })).status));
  await assert.rejects(pool.query(`INSERT INTO session(id,token,"userId","expiresAt") VALUES($1,$1,$2,clock_timestamp()+interval '1 day')`, [randomUUID(), a.id]), { code: '23514' });
  await assert.rejects(pool.query(`UPDATE "user" SET name='Reopened' WHERE id=$1`, [a.id]), { code: '23514' });
  console.log('PASS a closed account cannot sign in, use its sessions, API keys or MCP, or regain a session');

  // 6. Share links stay workspace-owned: access never resolves through the creator's membership.
  const read = await readWebsiteShare(shareId, shareToken, { from: today, to: today });
  assert.equal(read.shareId, shareId);
  const listed = await listWebsiteShares(project, b.id, '');
  assert.deepEqual(listed.items.find(item => item.id === shareId)?.creator, { name: 'Closed account', email: '', member: false });
  console.log('PASS a share link keeps working after its creator closes the account, and listings show "Closed account" as creator');
  return { groups: ['last owner refusal', 'last operator refusal', 'operator closure reason and authority', 'self closure scrub and tombstone', 'closed account authentication', 'share link independence'] };
}

if (process.env.TEN98_INTEGRATION_TEST === '1' && pathToFileURL(resolve(process.argv[1] ?? '')).href === import.meta.url)
  try { console.log(await runAccountClosureChecks()); } finally { await stopJobs().catch(() => undefined); await closeDatabase(); }
