import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { getConfig } from '../src/server/config.ts';
import { assertSchema, closeDatabase, getDatabase } from '../src/server/db.ts';
import { FoundationError } from '../src/server/auth.ts';
import { handleApi } from '../src/server/api.ts';
import { createApiKey } from '../src/server/api-keys.ts';
import { addDomain, getDomains, issueDomainChallenge, removeDomain, revokeDomain, updateDomain, verifyDomain } from '../src/server/domains.ts';
import { getPublicDestinations } from '../src/server/destinations.ts';
import { collectNative } from '../src/server/native-analytics.ts';
import { exploreAnalytics } from '../src/server/explorer.ts';

export async function runDomainCollectionChecks() {
  assert.equal(process.env.TEN98_INTEGRATION_TEST, '1');
  const config = getConfig();
  for (const url of [config.appUrl, config.databaseUrl]) assert.ok(['localhost','127.0.0.1','[::1]'].includes(new URL(url).hostname));
  await assertSchema();
  const { pool } = getDatabase(), owner = randomUUID(), viewer = randomUUID(), workspace = randomUUID(), foreignWorkspace = randomUUID();
  const project = randomUUID(), foreign = randomUUID(), localProject = randomUUID(), key = randomUUID();
  const canonical = 'https://canonical.example.com', serving = 'https://serving.example.com';
  await pool.query('INSERT INTO "user"(id,name,email) VALUES($1,$2,$3),($4,$2,$5)', [owner, 'Origin fixture', `${owner}@origin.integration.test`, viewer, `${viewer}@origin.integration.test`]);
  await pool.query('INSERT INTO workspace(id,name) VALUES($1,$3),($2,$3)', [workspace, foreignWorkspace, 'Origin fixture']);
  await pool.query("INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'viewer'),($4,$2,'owner')", [workspace, owner, viewer, foreignWorkspace]);
  await pool.query(`INSERT INTO project(id,workspace_id,name,origin,public_key,retention_next_run_at) VALUES
    ($1,$2,'Origin fixture',$3,$4,'infinity'),($5,$6,'Foreign origin','https://foreign.example.com',$7,'infinity'),
    ($8,$2,'Development origin','http://localhost:43199',$9,'infinity')`, [project, workspace, canonical, key, foreign, foreignWorkspace, randomUUID(), localProject, randomUUID()]);
  const fail = (status: number) => (error: unknown) => error instanceof FoundationError && error.status === status;
  const epoch = async () => (await pool.query('SELECT analytics_epoch FROM project WHERE id=$1', [project])).rows[0].analytics_epoch;
  const find = (state: Awaited<ReturnType<typeof getDomains>>, host: string) => { const row = state.domains.find(row => row.hostname === host); assert.ok(row); return row; };
  const canonicalRow = find(await getDomains(project, owner), 'canonical.example.com');
  const initialEpoch = await epoch();
  const domain = find(await addDomain(project, owner, { hostname: 'serving.example.com', role: 'serving' }), 'serving.example.com');
  const redirect = find(await addDomain(project, owner, { hostname: 'alias.example.com', role: 'redirect_alias' }), 'alias.example.com');
  const verify = async (domainId: string) => { const proof = await issueDomainChallenge(project, owner, domainId, {}); return verifyDomain(project, owner, domainId, {}, async name => { assert.equal(name, proof.challenge.name); return [[proof.challenge.value]]; }); };
  await assert.rejects(getPublicDestinations(key, 'live', serving), fail(404));
  assert.equal(await epoch(), initialEpoch, 'Unverified registry edits must not change consent.');
  await verify(redirect.id); await revokeDomain(project, owner, canonicalRow.id, {});
  assert.equal(await epoch(), initialEpoch, 'Redirect and canonical proof state must not change canonical collection eligibility.');
  assert.equal((await getPublicDestinations(key, 'live', canonical)).origin, canonical);
  await assert.rejects(getPublicDestinations(key, 'live', 'https://alias.example.com'), fail(404));
  await verify(domain.id); assert.notEqual(await epoch(), initialEpoch);
  const consent = await getPublicDestinations(key, 'live', serving);
  assert.equal(consent.origin, serving); assert.equal((await getPublicDestinations(key, 'test', serving)).origin, serving);
  assert.equal((await getPublicDestinations(key, 'live', canonical)).consentEpoch, consent.consentEpoch);
  const stableEpoch = await epoch();
  await updateDomain(project, owner, domain.id, { role: 'serving' }); await getDomains(project, owner);
  await updateDomain(project, owner, redirect.id, { role: 'redirect_alias', expectedTargetHost: 'another.example.com' });
  assert.equal(await epoch(), stableEpoch, 'No-op role edits, reads and alias target edits must not invalidate consent.');
  for (const origin of ['http://serving.example.com','https://serving.example.com:8443','https://sub.serving.example.com','https://serving.example.com.evil.com','https://serving.example.com.','https://alias.example.com','https://user@serving.example.com','https://serving.example.com/']) await assert.rejects(getPublicDestinations(key, 'live', origin), fail(404));
  const foreignKey = (await pool.query('SELECT public_key FROM project WHERE id=$1', [foreign])).rows[0].public_key;
  await assert.rejects(getPublicDestinations(foreignKey, 'live', serving), fail(404));
  const localKey = (await pool.query('SELECT public_key FROM project WHERE id=$1', [localProject])).rows[0].public_key;
  assert.equal((await getPublicDestinations(localKey, 'live', 'http://localhost:43199')).origin, 'http://localhost:43199');
  await assert.rejects(getPublicDestinations(localKey, 'live', 'http://localhost:43200'), fail(404));

  async function publicCall(path: string, origin: string, body?: unknown) {
    const response = await handleApi(new Request(config.appUrl + path, { method: body === undefined ? 'OPTIONS' : 'POST', headers: { origin, 'content-type': 'application/json', 'user-agent': 'Origin fixture browser' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
    return { response, data: response.status === 204 ? null : await response.json() };
  }
  const event = (origin = serving, epochValue = consent.consentEpoch) => ({ siteKey: key, eventId: randomUUID(), name: 'page_view', url: `${origin}/shared-path?private-query#private-fragment`, consent: { analytics: true as const, epoch: epochValue } });
  assert.equal((await publicCall('/api/collect', serving)).response.status, 204);
  assert.equal((await publicCall('/api/collect', 'http://serving.example.com')).response.status, 403);
  assert.equal((await publicCall('/api/tracking-config', serving, { siteKey: key, environment: 'live' })).data.origin, serving);
  const native = event(); const accepted = await publicCall('/api/collect', serving, native);
  assert.equal(accepted.response.status, 202); assert.equal(accepted.data.accepted, true); assert.equal(accepted.response.headers.get('access-control-allow-origin'), serving);
  assert.equal((await publicCall('/api/collect', canonical, event())).response.status, 403, 'Allowed hosts cannot attribute one another’s page URLs.');
  assert.equal((await publicCall('/api/collect', serving, { ...event(), siteKey: foreignKey })).response.status, 403);
  assert.equal((await publicCall('/api/collect', serving, { ...event(), dimensions: { origin: canonical } })).response.status, 400);
  assert.equal((await publicCall('/api/collect', serving, { ...event(), url: 'https://user@serving.example.com/private' })).response.status, 400);
  const canonicalEvent = event(canonical); assert.equal((await publicCall('/api/collect', canonical, canonicalEvent)).data.accepted, true);
  const duplicate = await publicCall('/api/collect', canonical, { ...native, url: `${canonical}/changed` });
  assert.deepEqual(duplicate.data, { accepted: true, duplicate: true });
  const original = (await pool.query('SELECT path,dimensions FROM event WHERE project_id=$1 AND id=$2', [project, native.eventId])).rows[0];
  assert.deepEqual(original, { path: '/shared-path', dimensions: { origin: serving } });
  const privateKey = await createApiKey(workspace, owner, { name: 'Origin fixture', scopes: ['events:write','analytics:read'], expiresInDays: 1 });
  async function apiCall(path: string, body?: unknown) {
    return handleApi(new Request(config.appUrl + path, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${privateKey.token}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
  }
  const apiEvent = { eventId: randomUUID(), name: 'signup', url: `${serving}:443/shared-path?private-query#private-fragment`, properties: { origin: 'https://forged.example.com' } };
  assert.equal((await apiCall(`/api/projects/${project}/events`, apiEvent)).status, 202);
  assert.equal((await apiCall(`/api/projects/${project}/events`, { ...apiEvent, eventId: randomUUID(), dimensions: { origin: canonical } })).status, 400);
  for (const origin of ['http://serving.example.com','https://alias.example.com','https://serving.example.com:8443']) assert.equal((await apiCall(`/api/projects/${project}/events`, { ...apiEvent, eventId: randomUUID(), url: origin })).status, 400);
  assert.equal((await apiCall(`/api/projects/${foreign}/events`, { ...apiEvent, eventId: randomUUID() })).status, 404);
  assert.equal((await pool.query('SELECT dimensions->>\'origin\' AS origin FROM event WHERE project_id=$1 AND id=$2', [project, apiEvent.eventId])).rows[0].origin, serving);
  const legacy = randomUUID(); await pool.query("INSERT INTO event(id,project_id,event_name,path) VALUES($1,$2,'page_view','/legacy')", [legacy, project]);
  const today = new Date().toISOString().slice(0, 10), filters = { from: today, to: today, groupBy: 'origin' };
  const report = await exploreAnalytics(project, owner, new URLSearchParams(filters));
  assert.deepEqual(new Map(report.breakdown.groups.map(row => [row.value, row.events])), new Map([[canonical, 2], [serving, 2]]));
  const filtered = await exploreAnalytics(project, viewer, new URLSearchParams({ ...filters, origin: serving }));
  assert.equal(filtered.totals.events, 2); assert.ok(filtered.csv.includes(serving));
  assert.equal((await exploreAnalytics(project, owner, new URLSearchParams({ ...filters, origin: 'https://forged.example.com' }))).totals.events, 0);
  const recent = await (await apiCall(`/api/projects/${project}/events`)).json();
  assert.equal(recent.events.find((row: { id: string }) => row.id === legacy).origin, canonical);
  assert.equal(recent.events.find((row: { id: string }) => row.id === native.eventId).origin, serving);
  await assert.rejects(updateDomain(project, viewer, domain.id, { role: 'redirect_alias' }), fail(404));
  await assert.rejects(revokeDomain(foreign, owner, domain.id, {}), fail(404));

  // Real revocation waits for an existing project reader, then denies collection
  // and configuration queued behind it. This fails if domain writes omit the gate.
  const lock = await pool.connect();
  try {
    await lock.query('BEGIN'); await lock.query('SELECT id FROM project WHERE id=$1 FOR SHARE', [project]);
    let finished = false;
    const revoked = revokeDomain(project, owner, domain.id, {}).then(value => { finished = true; return value; });
    const deadline = Date.now() + 5000;
    for (;;) {
      const waiting = await pool.query(`SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()
        AND wait_event_type='Lock' AND query LIKE '%AND m.role IN%FOR UPDATE OF p%'`);
      if (waiting.rowCount) break;
      if (Date.now() > deadline) { await lock.query('ROLLBACK'); await revoked; assert.fail('Domain revocation did not wait on the project gate.'); }
      await delay(10);
    }
    assert.equal(finished, false);
    const pendingNative = assert.rejects(collectNative(new Request(config.appUrl + '/api/collect', { headers: { origin: serving } }), key, event()), fail(403));
    const pendingConfig = assert.rejects(getPublicDestinations(key, 'live', serving), fail(404));
    await lock.query('COMMIT'); await revoked; await pendingNative; await pendingConfig;
  } finally { await lock.query('ROLLBACK').catch(() => {}); lock.release(); }
  assert.notEqual(await epoch(), stableEpoch);
  assert.equal((await publicCall('/api/collect', canonical, event(canonical))).data.reason, 'consent_required', 'Eligibility changes invalidate old consent even on the canonical origin.');
  assert.equal((await apiCall(`/api/projects/${project}/events`, { ...apiEvent, eventId: randomUUID() })).status, 400);
  assert.equal((await publicCall('/api/collect', serving)).response.status, 403);
  const revokedEpoch = await epoch(); await revokeDomain(project, owner, domain.id, {}); assert.equal(await epoch(), revokedEpoch);
  await verify(domain.id); const enabledEpoch = await epoch();
  await updateDomain(project, owner, domain.id, { role: 'redirect_alias' }); assert.notEqual(await epoch(), enabledEpoch);
  await assert.rejects(getPublicDestinations(key, 'live', serving), fail(404));
  await updateDomain(project, owner, domain.id, { role: 'serving' }); assert.equal((await getPublicDestinations(key, 'live', serving)).origin, serving);
  const beforeProof = await epoch(); await issueDomainChallenge(project, owner, domain.id, {}); assert.notEqual(await epoch(), beforeProof);
  await assert.rejects(getPublicDestinations(key, 'live', serving), fail(404));
  await verify(domain.id); const beforeRemoval = await epoch(); await removeDomain(project, owner, domain.id, {}); assert.notEqual(await epoch(), beforeRemoval);
  await assert.rejects(getPublicDestinations(key, 'live', serving), fail(404));
  console.log('PASS verified serving collection/config/API origins, precise provenance and legacy Explorer, consent changes, redirect exclusion and held revocation; no live DNS/provider requests');
}

if (process.argv[1]?.replaceAll('\\','/').endsWith('/domain-collection-integration.ts')) {
  try { await runDomainCollectionChecks(); }
  finally { await closeDatabase(); }
}
