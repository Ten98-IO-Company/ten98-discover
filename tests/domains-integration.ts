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

  state = await addDomain(project, manager, { hostname: 'BÜCHER.example.com.', role: 'redirect_alias' });
  const alias = select(state, 'xn--bcher-kva.example.com');
  assert.equal(alias.expectedTargetHost, 'canonical.example.com');
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
  console.log('Domain integration passed: canonical/IDN registry, role/tenant isolation, hash-only exact TXT proof, expiry/reissue/revoke races, cookie API boundaries, unchanged canonical origin, excluded redirect aliases and 50-domain limit. DNS was mocked; no external DNS checks ran.');
} finally { await closeDatabase(); }
