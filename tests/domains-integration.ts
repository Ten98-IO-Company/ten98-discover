import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Resolver } from 'node:dns/promises';
import { hashPassword } from 'better-auth/crypto';
import { FoundationError, getAuth } from '../src/server/auth.ts';
import { handleApi } from '../src/server/api.ts';
import { createApiKey } from '../src/server/api-keys.ts';
import { getConfig } from '../src/server/config.ts';
import { assertSchema, closeDatabase, getDatabase } from '../src/server/db.ts';
import { addDomain, getDomains, issueDomainChallenge, removeDomain, revokeDomain, updateDomain, verifyDomain } from '../src/server/domains.ts';

// Standalone, newly migrated local test database only. Retains synthetic fixtures; never deletes a database.
assert.equal(process.env.TEN98_INTEGRATION_TEST, '1', 'Domain checks require the isolated test opt-in.');
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(new URL(getConfig().databaseUrl).hostname), 'Local PostgreSQL required.');
await assertSchema();
const { pool } = getDatabase();
assert.equal((await pool.query('SELECT count(*)::int AS count FROM "user"')).rows[0].count, 0, 'Use a new empty migrated database.');
const fail = (status: number) => (error: unknown) => error instanceof FoundationError && error.status === status;
const owner = randomUUID(), manager = randomUUID(), viewer = randomUUID(), stranger = randomUUID();
const workspace = randomUUID(), project = randomUUID(), otherProject = randomUUID(), localProject = randomUUID();
const origin = 'https://canonical.example.com', publicKey = randomUUID();
const email = `${randomUUID()}@example.com`, password = randomBytes(24).toString('base64url');
const select = (state: Awaited<ReturnType<typeof getDomains>>, host: string) => {
  const row = state.domains.find(row => row.hostname === host); assert.ok(row); return row;
};
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

try {
  await pool.query('INSERT INTO "user"(id,name,email) VALUES($1,$2,$3),($4,$5,$6),($7,$8,$9)',
    [owner, 'Domain owner', email, manager, 'Domain admin', `${randomUUID()}@example.com`, viewer, 'Domain viewer', `${randomUUID()}@example.com`]);
  await pool.query('INSERT INTO account(id,"accountId","providerId","userId",password) VALUES($1,$2,$3,$2,$4)', [randomUUID(), owner, 'credential', await hashPassword(password)]);
  await pool.query('INSERT INTO workspace(id,name) VALUES($1,$2)', [workspace, 'Domain proof fixtures']);
  await pool.query("INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'admin'),($1,$4,'viewer')", [workspace, owner, manager, viewer]);
  await pool.query(`INSERT INTO project(id,workspace_id,name,origin,public_key) VALUES($1,$2,'Canonical fixture',$3,$4),
    ($5,$2,'Other fixture','https://other.example.com',$6),($7,$2,'Local fixture','http://localhost:43199',$8)`,
    [project, workspace, origin, publicKey, otherProject, randomUUID(), localProject, randomUUID()]);
  let state = await getDomains(project, owner);
  assert.deepEqual(state.project, { id: project, origin, canonicalHost: 'canonical.example.com', canonicalVerifiable: true });
  assert.equal(state.domains.length, 1);
  const canonical = state.domains[0];
  assert.equal(canonical.role, 'canonical');
  assert.equal(canonical.status, 'unverified');
  assert.equal(state.limit, 50);
  assert.deepEqual(Object.keys(canonical).sort(), ['id','hostname','role','expectedTargetHost','status','createdAt','verifiedAt','challengeExpiresAt'].sort());
  for (const uid of [viewer, stranger]) await assert.rejects(getDomains(project, uid), fail(404));
  for (const action of [() => removeDomain(project, owner, canonical.id, {}), () => updateDomain(project, owner, canonical.id, { role: 'serving' })]) await assert.rejects(action(), fail(409));
  const local = await getDomains(localProject, owner);
  assert.equal(local.project.canonicalVerifiable, false); assert.equal(local.domains.length, 0);
  await assert.rejects(addDomain(localProject, owner, { hostname: 'old.example.com', role: 'redirect_alias' }), fail(400));
  assert.equal((await addDomain(localProject, owner, { hostname: 'old.example.com', role: 'redirect_alias', expectedTargetHost: 'new.example.com' })).domains.length, 1);

  // A public expected target is intent only; only the registered alias needs a TXT name.
  const longTarget=['a'.repeat(63),'b'.repeat(63),'c'.repeat(63),'d'.repeat(57),'com'].join('.'),longProject=randomUUID();
  await pool.query("INSERT INTO project(id,workspace_id,name,origin,public_key) VALUES($1,$2,'Long canonical fixture',$3,$4)",[longProject,workspace,`https://${longTarget}`,randomUUID()]);
  const longCanonical=await getDomains(longProject,owner);
  assert.equal(longCanonical.project.canonicalVerifiable,false);assert.equal(longCanonical.domains.length,0);
  const defaultTarget=select(await addDomain(longProject,owner,{hostname:'short-proof.example.com',role:'redirect_alias'}),'short-proof.example.com');
  assert.equal(defaultTarget.expectedTargetHost,longTarget);
  assert.equal((await issueDomainChallenge(longProject,owner,defaultTarget.id,{})).challenge.name,'_ten98-challenge.short-proof.example.com');
  await assert.rejects(addDomain(project,owner,{hostname:longTarget,role:'serving'}),fail(400));

  state = await addDomain(project, manager, { hostname: 'BÜCHER.example.com.', role: 'redirect_alias' });
  const alias = select(state, 'xn--bcher-kva.example.com');
  assert.equal(alias.expectedTargetHost, 'canonical.example.com');
  assert.equal(select(await updateDomain(project,owner,alias.id,{role:'redirect_alias',expectedTargetHost:longTarget}),alias.hostname).expectedTargetHost,longTarget);
  await assert.rejects(addDomain(project, owner, { hostname: alias.hostname, role: 'serving' }), fail(409));
  await assert.rejects(addDomain(project, owner, { hostname: 'invalid.example.com', role: 'canonical' }), fail(400));
  await assert.rejects(addDomain(project, owner, { hostname: 'invalid.example.com', role: 'serving', expectedTargetHost: 'canonical.example.com' }), fail(400));
  await assert.rejects(updateDomain(project, owner, alias.id, { hostname: 'changed.example.com', role: 'serving' }), fail(400));
  await assert.rejects(updateDomain(project, owner, alias.id, { role: 'redirect_alias', expectedTargetHost: alias.hostname }), fail(400));
  state = await updateDomain(project, owner, alias.id, { role: 'serving' }); assert.equal(select(state, alias.hostname).expectedTargetHost, null);
  await updateDomain(project, owner, alias.id, { role: 'redirect_alias', expectedTargetHost: 'Target.Example.com' });
  await assert.rejects(issueDomainChallenge(otherProject, owner, alias.id, {}), fail(404));

  let proof = await issueDomainChallenge(project, manager, alias.id, {});
  assert.equal(proof.challenge.name, `_ten98-challenge.${alias.hostname}`);
  assert.equal(proof.challenge.type, 'TXT');
  assert.ok(proof.challenge.value.startsWith(`ten98-verification=${project}.${alias.id}.`));
  assert.equal(select(proof.state, alias.hostname).status, 'pending');
  assert.ok(new Date(proof.challenge.expiresAt).getTime() > Date.now() + 23.9 * 3_600_000);
  const stored = (await pool.query('SELECT challenge_hash FROM project_domain WHERE id=$1', [alias.id])).rows[0].challenge_hash;
  assert.equal(stored, createHash('sha256').update(proof.challenge.value).digest('hex'));
  assert.ok(!JSON.stringify(await getDomains(project, owner)).includes(stored));
  assert.ok(!JSON.stringify(proof.state).includes(proof.challenge.value));
  await assert.rejects(verifyDomain(project, owner, alias.id, {}, async () => [['unrelated']]), fail(422));
  await assert.rejects(verifyDomain(project, owner, alias.id, {}, async () => { throw { code: 'ENODATA' }; }), fail(422));
  await assert.rejects(verifyDomain(project, owner, alias.id, {}, async () => { throw { code: 'ETIMEOUT', secret: 'must not echo' }; }), fail(503));
  state = await verifyDomain(project, owner, alias.id, {}, async name => {
    assert.equal(name, proof.challenge.name); return [[proof.challenge.value.slice(0, 30), proof.challenge.value.slice(30)]];
  });
  assert.equal(select(state, alias.hostname).status, 'verified'); assert.ok(select(state, alias.hostname).verifiedAt);
  assert.equal(select(state, alias.hostname).challengeExpiresAt, null);
  assert.deepEqual((await pool.query('SELECT challenge_hash,challenge_expires_at FROM project_domain WHERE id=$1', [alias.id])).rows[0], { challenge_hash: null, challenge_expires_at: null });
  await assert.rejects(verifyDomain(project, owner, alias.id, {}, async () => { throw new Error('Should not resolve twice'); }), fail(409));
  assert.equal((await pool.query('SELECT origin FROM project WHERE id=$1', [project])).rows[0].origin, origin);
  const aliasOrigin = `https://${alias.hostname}`;
  for (const [path, body] of [
    ['/api/collect', { siteKey: publicKey, eventId: randomUUID(), name: 'page_view', url: aliasOrigin }],
    ['/api/tracking-config', { siteKey: publicKey, environment: 'live' }],
  ] as const) {
    const response = await handleApi(new Request(`${getConfig().appUrl}${path}`, { method: 'POST',
      headers: { origin: aliasOrigin, 'content-type': 'application/json' }, body: JSON.stringify(body) }));
    assert.equal(response.status, 403, 'A verified redirect alias must never enable collector or destination configuration access.');
  }

  // Challenge replacement while DNS is pending invalidates the observed old token.
  proof = await issueDomainChallenge(project, owner, alias.id, {});
  assert.equal(select(proof.state, alias.hostname).verifiedAt, null);
  const entered = deferred<void>(), answer = deferred<string[][]>();
  const verification = verifyDomain(project, owner, alias.id, {}, async () => { entered.resolve(); return answer.promise; });
  const verificationCheck = assert.rejects(verification, fail(409));
  await entered.promise;
  const replacement = await issueDomainChallenge(project, owner, alias.id, {});
  assert.notEqual(replacement.challenge.value, proof.challenge.value);
  answer.resolve([[proof.challenge.value]]); await verificationCheck;
  await assert.rejects(verifyDomain(project, owner, alias.id, {}, async () => [[proof.challenge.value]]), fail(422));

  // Exact-host and project binding: another project with the same domain needs its own proof.
  const otherAlias = select(await addDomain(otherProject, owner, { hostname: alias.hostname, role: 'serving' }), alias.hostname);
  await issueDomainChallenge(otherProject, owner, otherAlias.id, {});
  await assert.rejects(verifyDomain(otherProject, owner, otherAlias.id, {}, async () => [[replacement.challenge.value]]), fail(422));

  for (const change of ['revoke', 'expire', 'role'] as const) {
    proof = await issueDomainChallenge(project, manager, alias.id, {});
    const started = deferred<void>(), reply = deferred<string[][]>();
    const inFlight = verifyDomain(project, manager, alias.id, {}, async () => { started.resolve(); return reply.promise; });
    const checked = assert.rejects(inFlight, fail(change === 'role' ? 404 : 409));
    await started.promise;
    if (change === 'revoke') await revokeDomain(project, owner, alias.id, {});
    if (change === 'expire') await pool.query("UPDATE project_domain SET challenge_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [alias.id]);
    if (change === 'role') {
      const lock = await pool.connect();
      try { await lock.query('BEGIN'); await lock.query('SELECT id FROM workspace WHERE id=$1 FOR UPDATE', [workspace]);
        await lock.query("UPDATE membership SET role='viewer' WHERE workspace_id=$1 AND user_id=$2", [workspace, manager]); await lock.query('COMMIT');
      } finally { lock.release(); }
    }
    reply.resolve([[proof.challenge.value]]); await checked;
  }
  await pool.query("UPDATE membership SET role='admin' WHERE workspace_id=$1 AND user_id=$2", [workspace, manager]);
  await pool.query("UPDATE project_domain SET challenge_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [alias.id]);
  assert.equal(select(await getDomains(project, owner), alias.hostname).status, 'expired');
  await assert.rejects(verifyDomain(project, owner, alias.id, {}, async () => { assert.fail('Expired challenges must not perform DNS'); }), fail(409));

  proof = await issueDomainChallenge(project, owner, alias.id, {});
  const both = deferred<void>(); let arrivals = 0;
  const simultaneous = [owner, manager].map(uid => verifyDomain(project, uid, alias.id, {}, async () => {
    if (++arrivals === 2) both.resolve(); await both.promise; return [[proof.challenge.value]];
  }));
  const results = await Promise.allSettled(simultaneous);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.ok(results.some(result => result.status === 'rejected' && fail(409)(result.reason)));
  state = await revokeDomain(project, owner, alias.id, {});
  assert.equal(select(state, alias.hostname).status, 'revoked'); assert.equal(select(state, alias.hostname).verifiedAt, null);
  assert.ok(!(await removeDomain(project, owner, alias.id, {})).domains.some(row => row.id === alias.id));

  // A write waiting on a role change must read the post-lock role.
  const lock = await pool.connect();
  try {
    await lock.query('BEGIN'); await lock.query('SELECT id FROM workspace WHERE id=$1 FOR UPDATE', [workspace]);
    await lock.query("UPDATE membership SET role='viewer' WHERE workspace_id=$1 AND user_id=$2", [workspace, manager]);
    const pending = assert.rejects(addDomain(project, manager, { hostname: 'forbidden.example.com', role: 'serving' }), fail(404));
    await lock.query('COMMIT'); await pending;
  } finally { await lock.query('ROLLBACK').catch(() => undefined); lock.release(); }

  // Real API handler validates cookie-only authorization, CSRF, method, input and no-store responses.
  const appUrl = getConfig().appUrl;
  const signIn = await getAuth().handler(new Request(`${appUrl}/api/auth/sign-in/email`, { method: 'POST',
    headers: { origin: appUrl, 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) }));
  assert.equal(signIn.status, 200);
  const cookie = signIn.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  assert.ok(cookie);
  const request = (path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) =>
    handleApi(new Request(`${appUrl}${path}`, { method, headers: { cookie, origin: appUrl, 'content-type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
  const path = `/api/projects/${project}/domains`;
  const listed = await request(path); assert.equal(listed.status, 200); assert.equal(listed.headers.get('cache-control'), 'no-store');
  assert.equal((await request(path, 'GET', undefined, { cookie: '' })).status, 401);
  const key = await createApiKey(workspace, owner, { name: 'Domain boundary', scopes: ['projects:read','projects:write'], expiresInDays: 1 });
  assert.equal((await handleApi(new Request(`${appUrl}${path}`, { headers: { authorization: `Bearer ${key.token}` } }))).status, 403);

  // domains:read bearer family: owner/admin keys read stored rows through the content gate and never create the canonical row.
  const bearer = (suffix: string, token: string, method = 'GET', headers: Record<string, string> = {}) => handleApi(new Request(`${appUrl}${suffix}`, { method,
    headers: { authorization: `Bearer ${token}`, ...(method === 'POST' ? { 'content-type': 'application/json', origin: appUrl } : {}), ...headers }, ...(method === 'POST' ? { body: '{}' } : {}) }));
  const freshProject = randomUUID(), freshPath = `/api/projects/${freshProject}/domains`, rows = async () => (await pool.query('SELECT count(*)::int AS n FROM project_domain WHERE project_id=$1', [freshProject])).rows[0].n;
  await pool.query("INSERT INTO project(id,workspace_id,name,origin,public_key) VALUES($1,$2,'Fresh bearer fixture','https://fresh.example.com',$3)", [freshProject, workspace, randomUUID()]);
  const reader = await createApiKey(workspace, owner, { name: 'Domain reader', scopes: ['domains:read'], expiresInDays: 1 });
  const unvisited = await bearer(freshPath, reader.token); assert.equal(unvisited.status, 200); assert.equal(unvisited.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await unvisited.json(), { project: { id: freshProject, origin: 'https://fresh.example.com', canonicalHost: 'fresh.example.com', canonicalVerifiable: true }, domains: [], limit: 50 });
  assert.equal(await rows(), 0, 'A bearer read creates no canonical row.');
  assert.deepEqual(JSON.parse(JSON.stringify(await getDomains(freshProject, owner, reader.token))), { project: { id: freshProject, origin: 'https://fresh.example.com', canonicalHost: 'fresh.example.com', canonicalVerifiable: true }, domains: [], limit: 50 });
  assert.equal(await rows(), 0, 'The direct bearer read creates no canonical row either.');
  const cookieState = await request(freshPath); assert.equal(cookieState.status, 200); assert.equal(await rows(), 1, 'The cookie read keeps creating the canonical row lazily.');
  const cookieBody = await cookieState.json(), keyed = await bearer(freshPath, reader.token); assert.equal(keyed.status, 200);
  assert.deepEqual(await keyed.json(), cookieBody, 'After the cookie read the bearer response equals it.'); assert.equal(cookieBody.domains.length, 1);
  const canonicalId = cookieBody.domains[0].id;
  for (const [suffix, method] of [[freshPath, 'POST'], ...['update', 'challenge', 'verify', 'revoke', 'remove'].map(action => [`${freshPath}/${canonicalId}/${action}`, 'POST']), [`${freshPath}/${canonicalId}/redirect-checks`, 'POST'], [`/api/projects/${freshProject}/domain-research`, 'GET']] as const)
    assert.equal((await bearer(suffix, reader.token, method)).status, 403, `${method} ${suffix}`);
  assert.equal(await rows(), 1, 'No refused write changed the registry.');
  assert.equal((await bearer(`${freshPath}?unexpected=true`, reader.token)).status, 400);
  assert.equal((await bearer(freshPath, reader.token, 'GET', { cookie })).status, 400, 'Cookie plus bearer is refused.');
  assert.equal((await bearer(`/api/projects/${freshProject}/events`, reader.token)).status, 403, 'domains:read does not reach analytics.');
  // Only current owners and admins hold domains:read: an admin issuer demoted to editor or viewer loses it, and regains it with the role.
  const reviewer = randomUUID();
  await pool.query('INSERT INTO "user"(id,name,email) VALUES($1,$2,$3)', [reviewer, 'Domain reviewer', `${randomUUID()}@example.com`]);
  await pool.query("INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,'admin')", [workspace, reviewer]);
  const reviewerKey = await createApiKey(workspace, reviewer, { name: 'Admin domain reader', scopes: ['domains:read'], expiresInDays: 1 });
  assert.equal((await bearer(freshPath, reviewerKey.token)).status, 200);
  for (const role of ['editor', 'viewer']) {
    await pool.query('UPDATE membership SET role=$3 WHERE workspace_id=$1 AND user_id=$2', [workspace, reviewer, role]);
    assert.equal((await bearer(freshPath, reviewerKey.token)).status, 403, role);
    await assert.rejects(getDomains(freshProject, reviewer, reviewerKey.token), fail(403));
  }
  await pool.query("UPDATE membership SET role='admin' WHERE workspace_id=$1 AND user_id=$2", [workspace, reviewer]);
  assert.equal((await bearer(freshPath, reviewerKey.token)).status, 200);
  const foreignWorkspace = randomUUID(), foreignProject = randomUUID();
  await pool.query("INSERT INTO workspace(id,name) VALUES($1,'Foreign domain fixtures')", [foreignWorkspace]);
  await pool.query("INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,'owner')", [foreignWorkspace, owner]);
  await pool.query("INSERT INTO project(id,workspace_id,name,origin,public_key) VALUES($1,$2,'Foreign fixture','https://foreign.example.com',$3)", [foreignProject, foreignWorkspace, randomUUID()]);
  const foreignKey = await createApiKey(foreignWorkspace, owner, { name: 'Foreign domain reader', scopes: ['domains:read'], expiresInDays: 1 });
  assert.equal((await bearer(freshPath, foreignKey.token)).status, 404, 'A key cannot reach a project of another workspace.');
  assert.equal((await bearer(`/api/projects/${foreignProject}/domains`, reader.token)).status, 404);
  await pool.query('UPDATE api_key SET revoked_at=clock_timestamp() WHERE id=$1', [reviewerKey.key.id]);
  assert.equal((await bearer(freshPath, reviewerKey.token)).status, 401, 'A revoked key is refused.');
  console.log('PASS domains:read bearer list: stored rows only with no canonical INSERT, equal to the cookie read afterwards, every write 403, strict query, mixed credentials 400, owner/admin-only by current role, foreign 404 and revoked 401');
  assert.equal((await request(path, 'POST', { hostname: 'http.example.com', role: 'serving' }, { origin: 'https://other.example.com' })).status, 403);
  assert.equal((await request(path, 'PUT', {})).status, 405);
  assert.equal((await request(`${path}?unexpected=true`)).status, 400);
  assert.equal((await request(path, 'POST', { hostname: 'http.example.com', role: 'serving', extra: true })).status, 400);
  const created = await request(path, 'POST', { hostname: 'http.example.com', role: 'serving' }); assert.equal(created.status, 201);
  const httpDomain = select(await created.json(), 'http.example.com');
  const challengeReply = await request(`${path}/${httpDomain.id}/challenge`, 'POST', {}); assert.equal(challengeReply.status, 200);
  const httpProof = (await challengeReply.json()).challenge;
  assert.equal(httpProof.type, 'TXT');
  const resolveTxt = Resolver.prototype.resolveTxt;
  try {
    Resolver.prototype.resolveTxt = async name => { assert.equal(name, httpProof.name); return []; };
    assert.equal((await request(`${path}/${httpDomain.id}/verify`, 'POST', {})).status, 422);
    Resolver.prototype.resolveTxt = async name => { assert.equal(name, httpProof.name); return [[httpProof.value]]; };
    const verified = await request(`${path}/${httpDomain.id}/verify`, 'POST', {});
    assert.equal(verified.status, 200);
    assert.equal(select(await verified.json(), 'http.example.com').status, 'verified');
  } finally { Resolver.prototype.resolveTxt = resolveTxt; }
  assert.equal((await request(`${path}/${httpDomain.id}/revoke`, 'POST', { extra: true })).status, 400);
  assert.equal((await request(`${path}/${httpDomain.id}/revoke`, 'POST', {})).status, 200);
  assert.equal((await request(`${path}/${httpDomain.id}/remove`, 'POST', {})).status, 200);

  for (let index = 0; index < 49; index++) await addDomain(project, owner, { hostname: `limit-${index}.example.com`, role: 'serving' });
  assert.equal((await getDomains(project, owner)).domains.length, 50);
  await assert.rejects(addDomain(project, owner, { hostname: 'over-limit.example.com', role: 'serving' }), fail(409));

  // New websites record the referrer hostname by default (J2); websites that already exist keep their stored choice.
  const referrer = async (id: string) => (await pool.query("SELECT analytics_settings->'captureReferrer' AS value FROM project WHERE id=$1", [id])).rows[0].value
  const website = await request(`/api/workspaces/${workspace}/projects`, 'POST', { name: 'Referrer default', origin: `https://${randomUUID()}.example.com` })
  assert.equal(website.status, 201)
  assert.equal(await referrer((await website.json()).project.id), true)
  assert.equal(await referrer(project), false, 'An existing website keeps referrer capture off until its owner turns it on.')
  console.log('Domain integration passed: canonical/IDN registry, role/tenant isolation, hash-only exact TXT proof, expiry/reissue/revoke races, cookie API boundaries, unchanged canonical origin, excluded redirect aliases, new-website referrer default and 50-domain limit. DNS was mocked; no external DNS checks ran.');
} finally { await closeDatabase(); }
