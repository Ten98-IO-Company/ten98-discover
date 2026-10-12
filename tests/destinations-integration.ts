import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { FoundationError } from '../src/server/auth.ts';
import { getConfig } from '../src/server/config.ts';
import { getDatabase } from '../src/server/db.ts';
import { createWorkspace } from '../src/server/teams.ts';
import { createApiKey } from '../src/server/api-keys.ts';
import { trackingConsentEpoch } from '../src/server/native-analytics.ts';
import { getDestinations, getPublicDestinations, saveDestinationsDraft, previewDestinations,
  publishDestinations, rollbackDestinations } from '../src/server/destinations.ts';

type Options = { baseUrl: string; appUrl: string; ownerCookie: string; ownerId: string; workspaceId: string };
const rejected = (status: number) => (error: unknown) => error instanceof FoundationError && error.status === status;

export async function runDestinationChecks(options: Options): Promise<void> {
  assert.equal(process.env.TEN98_INTEGRATION_TEST, '1', 'Destination checks require the isolated integration-test opt-in.');
  const local = new Set(['localhost', '127.0.0.1', '[::1]']);
  assert.ok(local.has(new URL(getConfig().databaseUrl).hostname), 'Destination checks require local PostgreSQL.');
  assert.ok(local.has(new URL(options.baseUrl).hostname) && local.has(new URL(options.appUrl).hostname));
  const { pool } = getDatabase();
  const workspaceId = (await createWorkspace(options.ownerId, { name: 'Destination isolation checks' })).workspace.id;
  const projectId = randomUUID(), otherProjectId = randomUUID(), siteKey = randomUUID();
  const memberId = randomUUID();
  const origin = 'https://destination.integration.test';
  await pool.query('INSERT INTO project(id,workspace_id,name,origin,public_key) VALUES($1,$2,$3,$4,$5),($6,$2,$7,$8,$9)',
    [projectId, workspaceId, 'Destination checks', origin, siteKey, otherProjectId, 'Other destination', 'https://other.destination.integration.test', randomUUID()]);
  await pool.query('INSERT INTO "user"(id,name,email) VALUES($1,$2,$3)', [memberId, 'Destination manager', `${randomUUID()}@destination.integration.test`]);
  await pool.query("INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,'admin')", [workspaceId, memberId]);
  const config = { destinations: [{ provider: 'ga4', assetId: 'G-TEST1234', enabled: true,
    owner: 'managed', ownershipConfirmed: true, mappings: [{ event: 'page_view' }] }] };
  try {
    const initial = await getDestinations(projectId, options.ownerId, 'live');
    assert.equal(initial.draftVersion, 0);
    assert.equal(initial.active, null);
    assert.deepEqual(initial.draft, { destinations: [] });
    assert.equal(initial.catalog.length, 10);
    const saved = await saveDestinationsDraft(projectId, memberId, 'live', { expectedVersion: 0, configuration: config });
    assert.equal(saved.draftVersion, 1);
    await assert.rejects(saveDestinationsDraft(projectId, options.ownerId, 'live', { expectedVersion: 0, configuration: config }), rejected(409));
    const publicDraft = await getPublicDestinations(siteKey, 'live', origin);
    assert.deepEqual(publicDraft.configuration, { destinations: [] }, 'Unpublished drafts must not be public.');
    assert.equal(publicDraft.revisionId, null);
    const preview = await previewDestinations(projectId, options.ownerId, 'live', { expectedVersion: 1,
      event: { name: 'page_view' }, consent: { analytics: true, advertising: false, adUserData: false, adPersonalization: false } });
    assert.equal(preview.dryRun, true);
    assert.equal(preview.routes[0].status, 'would_invoke');
    const first = await publishDestinations(projectId, options.ownerId, 'live', { expectedVersion: 1 });
    assert.ok(first.active);
    assert.equal(first.draftVersion, 2);
    const active = await getPublicDestinations(siteKey, 'live', origin);
    assert.equal(active.revisionId, first.active.id);
    const nativeEpoch = (await pool.query('SELECT analytics_epoch FROM project WHERE id=$1', [projectId])).rows[0].analytics_epoch;
    assert.equal(active.consentEpoch, trackingConsentEpoch(nativeEpoch, first.active.consentEpoch));
    assert.deepEqual(active.configuration, config);
    assert.deepEqual(Object.keys(active).sort(), ['schemaVersion', 'siteKey', 'environment', 'origin', 'revisionId', 'consentEpoch', 'validUntil', 'configuration', 'nativeTracking'].sort());
    assert.equal(active.schemaVersion, 2);
    assert.ok(new Date(active.validUntil).getTime() > Date.now());
    assert.ok(new Date(active.validUntil).getTime() <= Date.now() + 65_000);
    assert.deepEqual((await getPublicDestinations(siteKey, 'test', origin)).configuration, { destinations: [] });
    // Exercise the actual public HTTP boundary, not just its domain function.
    const publicRequest = (headers: Record<string, string>, method = 'POST', body: unknown = { siteKey, environment: 'live' }) =>
      fetch(new URL('/api/tracking-config', options.baseUrl), { method, headers, redirect: 'manual', signal: AbortSignal.timeout(10_000),
        ...(['GET', 'OPTIONS'].includes(method) ? {} : { body: JSON.stringify(body) }) });
    const publicHeaders = { origin, 'content-type': 'application/json' };
    const publicReply = await publicRequest(publicHeaders);
    assert.equal(publicReply.status, 200);
    assert.equal(publicReply.headers.get('access-control-allow-origin'), origin);
    assert.equal(publicReply.headers.get('access-control-allow-credentials'), null);
    assert.equal(publicReply.headers.get('cache-control'), 'no-store');
    assert.equal(publicReply.headers.get('set-cookie'), null);
    const publicBody = await publicReply.json();
    assert.deepEqual({ ...publicBody, validUntil: active.validUntil }, active);
    assert.equal((await publicRequest({ origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' }, 'OPTIONS')).status, 204);
    assert.equal((await publicRequest(publicHeaders, 'GET')).status, 405);
    assert.equal((await publicRequest({ 'content-type': 'application/json' })).status, 403);
    assert.equal((await publicRequest({ ...publicHeaders, origin: 'https://unconfigured.integration.test' })).status, 403);
    assert.equal((await publicRequest({ ...publicHeaders, origin: 'https://other.destination.integration.test' })).status, 404);
    assert.equal((await publicRequest(publicHeaders, 'POST', { siteKey, environment: 'live', extra: true })).status, 400);
    const { token } = await createApiKey(workspaceId, options.ownerId, { name: 'Destination boundary', scopes: ['analytics:read'], expiresInDays: 1 });
    assert.equal((await publicRequest({ ...publicHeaders, authorization: `Bearer ${token}` })).status, 403);
    const management = new URL(`/api/projects/${projectId}/destinations?environment=live`, options.baseUrl);
    assert.equal((await fetch(management, { signal: AbortSignal.timeout(10_000) })).status, 401);
    assert.equal((await fetch(management, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) })).status, 403);
    assert.equal((await fetch(management, { headers: { cookie: options.ownerCookie }, signal: AbortSignal.timeout(10_000) })).status, 200);
    for (const badOrigin of ['https://evil.integration.test', `${origin}.evil.test`, `${origin}/path`, 'null', '']) {
      await assert.rejects(getPublicDestinations(siteKey, 'live', badOrigin), error => error instanceof FoundationError && [400, 403, 404].includes(error.status));
    }
    await assert.rejects(rollbackDestinations(otherProjectId, options.ownerId, 'live', { expectedVersion: 0, revisionId: first.active.id }), rejected(404));
    await assert.rejects(rollbackDestinations(projectId, options.ownerId, 'test', { expectedVersion: 0, revisionId: first.active.id }), rejected(404));
    const empty = await saveDestinationsDraft(projectId, options.ownerId, 'live', { expectedVersion: 2, configuration: { destinations: [] } });
    const stopped = await publishDestinations(projectId, options.ownerId, 'live', { expectedVersion: empty.draftVersion });
    assert.ok(stopped.active);
    assert.notEqual(stopped.active.consentEpoch, first.active.consentEpoch);
    assert.deepEqual((await getPublicDestinations(siteKey, 'live', origin)).configuration, { destinations: [] });
    const restored = await rollbackDestinations(projectId, options.ownerId, 'live', { expectedVersion: stopped.draftVersion, revisionId: first.active.id });
    assert.ok(restored.active);
    assert.notEqual(restored.active.id, first.active.id);
    assert.notEqual(restored.active.consentEpoch, first.active.consentEpoch);
    assert.deepEqual(restored.draft, config);
    assert.equal(restored.history[0].rollbackOf, first.active.id);
    await assert.rejects(publishDestinations(projectId, options.ownerId, 'live', { expectedVersion: stopped.draftVersion }), rejected(409));
    // The destination operation must wait for the same workspace lock as role changes,
    // then read current membership rather than relying on authorization from before it waited.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT id FROM workspace WHERE id=$1 FOR UPDATE', [workspaceId]);
      await client.query("UPDATE membership SET role='viewer' WHERE workspace_id=$1 AND user_id=$2", [workspaceId, memberId]);
      const pending = getDestinations(projectId, memberId, 'live');
      const assertion = assert.rejects(pending, rejected(404));
      await client.query('COMMIT');
      await assertion;
    } finally { await client.query('ROLLBACK').catch(() => undefined); client.release(); }
    await assert.rejects(saveDestinationsDraft(projectId, memberId, 'live', { expectedVersion: restored.draftVersion, configuration: config }), rejected(404));
    const unrelatedUser = randomUUID();
    await assert.rejects(getDestinations(projectId, unrelatedUser, 'live'), rejected(404));
    const unconfirmed = structuredClone(config);
    unconfirmed.destinations[0].ownershipConfirmed = false;
    const needsReview = await saveDestinationsDraft(projectId, options.ownerId, 'live', { expectedVersion: restored.draftVersion, configuration: unconfirmed });
    await assert.rejects(publishDestinations(projectId, options.ownerId, 'live', { expectedVersion: needsReview.draftVersion }), rejected(400));
    const mixedOwners = { destinations: [...config.destinations, { provider: 'google_ads', assetId: 'AW-1234', enabled: true,
      owner: 'external', ownershipConfirmed: false, mappings: [] }] };
    const mixed = await saveDestinationsDraft(projectId, options.ownerId, 'live', { expectedVersion: needsReview.draftVersion, configuration: mixedOwners });
    await assert.rejects(publishDestinations(projectId, options.ownerId, 'live', { expectedVersion: mixed.draftVersion }), rejected(400));
    const concurrent = await Promise.allSettled([config, { destinations: [] }].map(configuration =>
      saveDestinationsDraft(projectId, options.ownerId, 'live', { expectedVersion: mixed.draftVersion, configuration })));
    assert.equal(concurrent.filter(result => result.status === 'fulfilled').length, 1, 'Exactly one concurrent draft must win.');
    const losingWrite = concurrent.find(result => result.status === 'rejected');
    assert.ok(losingWrite?.status === 'rejected' && rejected(409)(losingWrite.reason));
    // The composite FK must reject activating another project's revision.
    await getDestinations(otherProjectId, options.ownerId, 'live');
    await assert.rejects(pool.query('UPDATE tracking_state SET active_revision=$1 WHERE project_id=$2 AND environment=$3',
      [first.active.id, otherProjectId, 'live']), (error: unknown) => (error as { code?: string }).code === '23503');
  } finally {
    await pool.query('DELETE FROM workspace WHERE id=$1', [workspaceId]);
    await pool.query('DELETE FROM "user" WHERE id=$1', [memberId]);
  }
}
