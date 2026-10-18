import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { hashPassword } from 'better-auth/crypto';
import { handleApi } from '../src/server/api.ts';
import { getConfig } from '../src/server/config.ts';
import { closeDatabase, getDatabase, assertSchema } from '../src/server/db.ts';
import { getBoss, stopJobs } from '../src/server/jobs.ts';
import { createWorkspace } from '../src/server/teams.ts';
import { googleScopes } from '../src/server/google-reports.ts';
import { withGoogleTransportForTests } from '../src/server/google-http.ts';
import { runGoogleImport, reconcileGoogleImports, googleQueue, startGoogleImportWorker, listGoogleConnections, readGoogleImport } from '../src/server/google-jobs.ts';
import { assertGoogleCredentialsReadable, rotateGoogleCredentials, googleConnectionContext, disconnectGoogle } from '../src/server/google.ts';
import { decryptCredentials } from '../src/server/credential-vault.ts';
import { createApiKey } from '../src/server/api-keys.ts';

export type GoogleBrowserFixture = { email: string; password: string; userId: string; projectId: string; workspaceId: string; clientSecret: string; authorize: (url: string) => string; transport: (url: string, init: RequestInit) => Promise<Response> };
export async function runGoogleChecks(browserCheck?: (fixture: GoogleBrowserFixture) => Promise<void>) {
  assert.equal(process.env.TEN98_INTEGRATION_TEST, '1');
  const config = getConfig(), { pool } = getDatabase(), local = ['localhost', '127.0.0.1', '[::1]'];
  for (const url of [config.appUrl, config.databaseUrl]) assert.ok(local.includes(new URL(url).hostname));
  await assertSchema();
  const userId = randomUUID(), password = randomBytes(24).toString('base64url'), email = `${userId}@google.integration.test`;
  await pool.query('INSERT INTO "user"(id,name,email) VALUES($1,$2,$3)', [userId, 'Google fixture owner', email]);
  await pool.query('INSERT INTO account(id,"accountId","providerId","userId",password) VALUES($1,$2,\'credential\',$2,$3)', [randomUUID(), userId, await hashPassword(password)]);
  await pool.query("INSERT INTO instance_operator(user_id,source) VALUES($1,'host')", [userId]);
  const { workspace } = await createWorkspace(userId, { name: 'Google imports fixture' });
  const projectId = randomUUID();
  await pool.query('INSERT INTO project(id,workspace_id,name,origin,public_key) VALUES($1,$2,$3,$4,$5)', [projectId, workspace.id, 'Google imports fixture', `https://${projectId}.integration.test`, randomUUID()]);
  const viewerId = randomUUID(), viewerEmail = `${viewerId}@google.integration.test`;
  await pool.query('INSERT INTO "user"(id,name,email) VALUES($1,$2,$3)', [viewerId, 'Google viewer', viewerEmail]);
  await pool.query('INSERT INTO account(id,"accountId","providerId","userId",password) VALUES($1,$2,\'credential\',$2,$3)', [randomUUID(), viewerId, await hashPassword(password)]);
  await pool.query("INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,'viewer')", [workspace.id, viewerId]);
  type Browser = Map<string, string>;
  const actor: Browser = new Map(), viewer: Browser = new Map();
  async function call(path: string, body?: unknown, browser = actor, origin = config.appUrl) {
    const headers = new Headers({ cookie: [...browser].map(([key, value]) => `${key}=${value}`).join('; ') });
    if (body !== undefined) { headers.set('origin', origin); headers.set('content-type', 'application/json'); }
    const response = await handleApi(new Request(config.appUrl + path, { method: body === undefined ? 'GET' : 'POST', headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
    for (const cookie of response.headers.getSetCookie()) { const [key, value] = cookie.split(';')[0].split('='); browser.set(key, value); }
    const text = await response.text();
    return { response, data: text ? JSON.parse(text) : {} };
  }
  assert.equal((await call('/api/auth/sign-in/email', { email, password })).response.status, 200);
  assert.equal((await call('/api/auth/sign-in/email', { email: viewerEmail, password }, viewer)).response.status, 200);
  const clientSecret = randomBytes(24).toString('base64url'), accessToken = randomBytes(24).toString('base64url'), refreshToken = randomBytes(24).toString('base64url');
  const rotatedRefreshToken = randomBytes(24).toString('base64url');
  let liveRefreshToken = refreshToken;
  const appInput = { revision: 0, clientId: '123-fixture.apps.googleusercontent.com', clientSecret, enabled: true, testing: true };
  // Another suite may have configured its own app: preserve old encrypted state
  // and restore it at the end, never perform a real provider call.
  const savedApp = (await pool.query("SELECT * FROM google_app WHERE id='instance'")).rows[0];
  appInput.revision = savedApp?.revision ?? 0;
  const codes = new Map<string, { challenge: string; scope: string }>();
  let providerCalls = 0, refreshCalls = 0, fixtureErrors = 0, mode = 'normal', providerOrigin = '';
  const fixture = createServer(async (request, response) => {
    providerCalls++; response.setHeader('content-type', 'application/json');
    try {
      const url = new URL(request.url!, providerOrigin), route = url.pathname;
      let raw = ''; for await (const chunk of request) raw += chunk;
      if (route === '/oauth2.googleapis.com/token') {
        const form = new URLSearchParams(raw);
        assert.ok(form.get('client_secret') === clientSecret, 'Only the configured fixture secret may be exchanged.');
        let scope = googleScopes.gsc as string;
        if (form.get('grant_type') === 'authorization_code') {
          const code = form.get('code')!, state = codes.get(code); codes.delete(code);
          assert.ok(state, 'Authorization code must be one use.');
          assert.equal(createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url'), state.challenge, 'PKCE challenge must bind the code.');
          scope = state.scope;
          liveRefreshToken = refreshToken;
        } else { refreshCalls++; assert.ok(form.get('refresh_token') === liveRefreshToken); scope = mode === 'ga4' ? googleScopes.ga4 : googleScopes.gsc; if (mode === 'rotate_failure') liveRefreshToken = rotatedRefreshToken; }
        response.end(JSON.stringify({ access_token: accessToken, refresh_token: liveRefreshToken, expires_in: ['expire','rotate_failure'].includes(mode) ? 1 : 3600, token_type: 'Bearer', scope: mode === 'missing_scope' ? 'unrelated' : scope })); return;
      }
      if (route === '/oauth2.googleapis.com/revoke') { response.end('{}'); return; }
      assert.ok(request.headers.authorization === `Bearer ${accessToken}`, 'Fixture API requests need the granted token.');
      if (mode === 'quota') { response.statusCode = 429; response.end('{}'); return; }
      if (route === '/www.googleapis.com/webmasters/v3/sites') { response.end(JSON.stringify({ siteEntry: [{ siteUrl: 'sc-domain:example.test', permissionLevel: 'siteOwner' }, { siteUrl: 'https://unverified.test/', permissionLevel: 'siteUnverifiedUser' }] })); return; }
      if (route === '/www.googleapis.com/webmasters/v3/sites/sc-domain%3Aexample.test') { response.end(JSON.stringify({ siteUrl: 'sc-domain:example.test', permissionLevel: 'siteOwner' })); return; }
      if (route === '/analyticsadmin.googleapis.com/v1beta/accountSummaries') { response.end(JSON.stringify({ accountSummaries: [{ propertySummaries: [{ property: 'properties/123', displayName: 'Fixture GA4' }] }], ...(url.searchParams.has('pageToken') ? {} : { nextPageToken: 'next-page' }) })); return; }
      if (route === '/analyticsadmin.googleapis.com/v1beta/properties/123') { response.end(JSON.stringify({ name: 'properties/123', displayName: 'Fixture GA4', timeZone: 'Asia/Dubai', currencyCode: 'AED' })); return; }
      if (route.endsWith('/searchAnalytics/query')) {
        if (mode === 'rotate_failure') { response.statusCode = 503; response.end('{}'); return; }
        const data = JSON.parse(raw); assert.equal(data.rowLimit, 1000); assert.equal(data.dataState, 'final');
        const rows = data.dimensions.includes('query') ? Array.from({ length: data.startRow === 0 ? 1000 : 1 }, (_, index) => ({ keys: [data.startDate, `query-${data.startRow + index}`], clicks: 1, impressions: 10, ctr: .1, position: 2 })) : [{ keys: [data.startDate], clicks: 0, impressions: 4, ctr: 0, position: 3 }];
        response.end(JSON.stringify({ rows, responseAggregationType: 'byProperty' })); return;
      }
      if (route.endsWith('/properties/123:runReport')) {
        const data = JSON.parse(raw); assert.equal(data.returnPropertyQuota, true);
        if (mode === 'empty') { response.end('{}'); return; }
        response.end(JSON.stringify({ dimensionHeaders: data.dimensions, metricHeaders: data.metrics, rowCount: 1,
          rows: [{ dimensionValues: [{ value: data.dateRanges[0].startDate.replaceAll('-', '') }, { value: 'signup' }], metricValues: data.metrics.map(() => ({ value: '1' })) }],
          metadata: { timeZone: 'Asia/Dubai', currencyCode: 'AED', subjectToThresholding: true, schemaRestrictionResponse: { activeMetricRestrictions: [{ metricName: 'keyEvents', restrictedMetricTypes: ['REVENUE_DATA'] }] } } })); return;
      }
      response.statusCode = 404; response.end('{}');
    } catch { fixtureErrors++; response.statusCode = 500; response.end('{}'); }
  });
  await new Promise<void>(resolve => fixture.listen(0, '127.0.0.1', resolve));
  providerOrigin = `http://127.0.0.1:${(fixture.address() as { port: number }).port}`;
  const transport = (url: string, init: RequestInit) => { const target = new URL(url); return fetch(`${providerOrigin}/${target.hostname}${target.pathname}${target.search}`, init); };
  const base = `/api/projects/${projectId}/google`;
  const boss = await getBoss(), originalSend = boss.send;
  // Hold queue fixtures until explicit run/reconciliation; one final job below
  // is released to the actual pg-boss worker against this same HTTP fixture.
  boss.send = async (name: any, data?: any, options?: any) => originalSend.call(boss, name, data, { ...options, startAfter: new Date(Date.now() + 3_600_000) });
  try {
    await withGoogleTransportForTests(transport, async () => {
      assert.equal((await call('/api/google/app', appInput, viewer)).response.status, 403);
      const app = await call('/api/google/app', appInput); assert.equal(app.response.status, 200);
      assert.equal(JSON.stringify(app.data).includes(clientSecret), false);
      assert.equal((await call('/api/google/app', appInput)).response.status, 409);
      assert.equal(providerCalls, 0, 'App configuration must not contact Google.');
      assert.equal((await call(`${base}/connect`, { provider: 'gsc', name: 'Denied' }, viewer)).response.status, 404);
      assert.equal((await call(`${base}/connect`, { provider: 'gsc', name: 'Denied' }, actor, 'https://untrusted.test')).response.status, 403);
      async function connect(provider: 'gsc' | 'ga4', extra: Record<string, unknown> = {}) {
        const started = await call(`${base}/connect`, { provider, name: `Fixture ${provider}`, ...extra }); assert.equal(started.response.status, 200);
        const url = new URL(started.data.authorizationUrl); assert.equal(url.origin, 'https://accounts.google.com'); assert.equal(url.searchParams.get('scope'), googleScopes[provider]);
        const code = randomBytes(24).toString('base64url'); codes.set(code, { challenge: url.searchParams.get('code_challenge')!, scope: url.searchParams.get('scope')! });
        const callback = `/api/google/callback?state=${url.searchParams.get('state')}&code=${code}`;
        return { callback, url };
      }
      const expired = await connect('gsc');
      await pool.query('UPDATE google_oauth_flow SET expires_at=now()-interval \'1 second\' WHERE state_hash=$1', [createHash('sha256').update(expired.url.searchParams.get('state')!).digest('hex')]);
      assert.match((await call(expired.callback)).response.headers.get('location')!, /google=failed$/); assert.equal(providerCalls, 0);
      const demoted = await connect('gsc');
      await pool.query("UPDATE membership SET role='editor' WHERE workspace_id=$1 AND user_id=$2", [workspace.id, userId]);
      assert.match((await call(demoted.callback)).response.headers.get('location')!, /google=failed$/); assert.equal(providerCalls, 0, 'Callback must recheck current workspace ownership.');
      await pool.query("UPDATE membership SET role='owner' WHERE workspace_id=$1 AND user_id=$2", [workspace.id, userId]);
      const deniedConsent = await connect('gsc'); mode = 'missing_scope';
      assert.match((await call(deniedConsent.callback)).response.headers.get('location')!, /google=failed$/); mode = 'normal';
      assert.equal((await pool.query('SELECT 1 FROM google_connection WHERE project_id=$1', [projectId])).rowCount, 0, 'Incomplete scope consent must not create a connection.');
      const usersBeforeOAuth = (await pool.query('SELECT count(*)::int AS count FROM "user"')).rows[0].count;
      const started = await connect('gsc');
      const beforeCallback = providerCalls;
      assert.match((await call(started.callback, undefined, viewer)).response.headers.get('location')!, /google=failed$/);
      assert.equal(providerCalls, beforeCallback, 'Wrong session must fail before token exchange.');
      const wrongBrowser = new Map(actor); for (const key of wrongBrowser.keys()) if (key.startsWith('ten98.google.')) wrongBrowser.set(key, 'wrong');
      assert.match((await call(started.callback, undefined, wrongBrowser)).response.headers.get('location')!, /google=failed$/);
      const callback = await Promise.all([call(started.callback), call(started.callback)]);
      assert.deepEqual(callback.map(item => new URL(item.response.headers.get('location')!).hash.startsWith('#google=connected&')).sort(), [false, true]);
      assert.equal(providerCalls, beforeCallback + 1, 'Only one racing callback may exchange the code.');
      assert.equal((await pool.query('SELECT count(*)::int AS count FROM "user"')).rows[0].count, usersBeforeOAuth, 'Reporting consent must not create or merge dashboard identities.');
      const scoped = await createApiKey(workspace.id, userId, { name: 'Google isolation key', scopes: ['analytics:read'], expiresInDays: 1 });
      const keyResponse = await handleApi(new Request(config.appUrl + base, { headers: { authorization: `Bearer ${scoped.token}` } }));
      assert.equal(keyResponse.status, 403, 'Existing analytics keys cannot acquire report-connection permissions.');
      const connections = await call(base), gsc = connections.data.connections[0]; assert.equal(gsc.status, 'select_property');
      assert.equal(JSON.stringify(connections.data).includes(accessToken), false);
      const stored = (await pool.query('SELECT encrypted_tokens::text FROM google_connection WHERE id=$1', [gsc.id])).rows[0].encrypted_tokens;
      assert.equal(stored.includes(accessToken) || stored.includes(refreshToken), false, 'Tokens must be encrypted at rest.');
      const properties = await call(`${base}/connections/${gsc.id}/properties`, {}); assert.equal(properties.response.status, 200); assert.equal(properties.data.properties.length, 1);
      assert.equal((await call(`${base}/connections/${gsc.id}/select`, { propertyId: 'sc-domain:example.test' })).response.status, 200);
      assert.equal((await call(`${base}/connections/${gsc.id}/select`, { propertyId: 'sc-domain:other.test' })).response.status, 409);
      const input = { requestId: randomUUID(), report: 'gsc_queries', from: '2024-03-01', to: '2024-03-01' };
      const queued = await call(`${base}/connections/${gsc.id}/imports`, input); assert.equal(queued.response.status, 202);
      const importId = queued.data.import.id;
      assert.equal((await call(`${base}/connections/${gsc.id}/imports`, input)).data.import.id, importId);
      assert.equal((await call(`${base}/connections/${gsc.id}/imports`, { ...input, to: '2024-03-02' })).response.status, 409);
      assert.equal((await call(`${base}/imports/${importId}`)).data.rows.length, 0, 'Queued imports cannot masquerade as completed results.');
      await runGoogleImport(importId);
      const report = await call(`${base}/imports/${importId}`, undefined, viewer); assert.equal(report.response.status, 200);
      assert.equal(report.data.import.status, 'completed'); assert.equal(report.data.import.pages, 2); assert.equal(report.data.import.rowCount, 1001); assert.equal(report.data.rows.length, 50); assert.equal(report.data.nextOffset, 50);
      assert.equal(report.data.source.timeZone, 'America/Los_Angeles'); assert.ok(report.data.quality.warnings.length);
      const afterComplete = providerCalls; await runGoogleImport(importId); assert.equal(providerCalls, afterComplete, 'Completed jobs are idempotent.');
      assert.equal((await call(`${base}/imports/${importId}?offset=1000`)).data.rows.length, 1);
      const foreignWorkspace = await createWorkspace(viewerId, { name: 'Foreign Google fixture' });
      const foreignId = randomUUID(); await pool.query('INSERT INTO project(id,workspace_id,name,origin,public_key) VALUES($1,$2,$3,$4,$5)', [foreignId, foreignWorkspace.workspace.id, 'Foreign', `https://${foreignId}.integration.test`, randomUUID()]);
      assert.equal((await call(`/api/projects/${foreignId}/google/imports/${importId}`, undefined, viewer)).response.status, 404);
      assert.equal((await call(`${base}/connections/${gsc.id}/imports`, { ...input, requestId: randomUUID() }, viewer)).response.status, 404);
      console.log('PASS Google app/operator guard, bound one-use PKCE callback, encrypted grants, exact properties, tenant isolation and resumable snapshot pagination');

      // google:read bearer family: only the two saved-snapshot reads, under the content gate; every other Google route stays cookie-only.
      const wire = (value: unknown) => JSON.parse(JSON.stringify(value));
      const bearer = (path: string, token: string, method = 'GET', headers: Record<string, string> = {}) => handleApi(new Request(config.appUrl + path, { method,
        headers: { authorization: `Bearer ${token}`, ...(method === 'POST' ? { 'content-type': 'application/json', origin: config.appUrl } : {}), ...headers }, ...(method === 'POST' ? { body: '{}' } : {}) }));
      const ownerKey = await createApiKey(workspace.id, userId, { name: 'Google snapshot reader', scopes: ['google:read'], expiresInDays: 1 });
      // The viewer allowlist names google:read: issue as admin, then return the issuer to the fixture's viewer role.
      await pool.query("UPDATE membership SET role='admin' WHERE workspace_id=$1 AND user_id=$2", [workspace.id, viewerId]);
      const viewerKey = await createApiKey(workspace.id, viewerId, { name: 'Google viewer reader', scopes: ['google:read'], expiresInDays: 1 });
      await pool.query("UPDATE membership SET role='viewer' WHERE workspace_id=$1 AND user_id=$2", [workspace.id, viewerId]);
      const { app: cookieApp, ...cookieSources } = (await call(base)).data;
      assert.deepEqual(Object.keys(cookieApp).sort(), ['configured', 'enabled', 'testing'], 'The cookie route keeps the instance app configuration.');
      for (const [key, uid, role] of [[ownerKey, userId, 'owner'], [viewerKey, viewerId, 'viewer']] as const) {
        const listed = await bearer(base, key.token); assert.equal(listed.status, 200); assert.equal(listed.headers.get('cache-control'), 'no-store');
        const sources = await listed.json();
        assert.deepEqual(sources, wire(await listGoogleConnections(projectId, uid, key.token)), 'The bearer route equals the direct read under the same key.');
        assert.deepEqual(Object.keys(sources).sort(), ['connections', 'role'], 'A key never receives the instance app configuration.'); assert.equal(sources.role, role);
        assert.deepEqual(sources.connections, cookieSources.connections, 'Sources and import receipts equal the cookie DTO.');
        const text = JSON.stringify(sources); assert.equal(text.includes(accessToken) || text.includes(refreshToken) || text.includes(clientSecret), false, 'No token or secret reaches a key.');
        for (const suffix of [`/imports/${importId}`, `/imports/${importId}?offset=1000`]) {
          const snapshot = await bearer(base + suffix, key.token); assert.equal(snapshot.status, 200, suffix);
          const body = await snapshot.json();
          assert.deepEqual(body, wire(await readGoogleImport(projectId, uid, importId, new URL(config.appUrl + base + suffix).searchParams.get('offset') ?? 0, key.token)));
          assert.deepEqual(body, (await call(base + suffix)).data, 'The snapshot equals the cookie read.');
        }
      }
      const importsBefore = (await pool.query('SELECT count(*)::int AS n FROM google_import WHERE project_id=$1', [projectId])).rows[0].n, callsBefore = providerCalls;
      for (const [path, method] of [[`${base}/connect`, 'POST'], [`${base}/connections/${gsc.id}/properties`, 'POST'], [`${base}/connections/${gsc.id}/select`, 'POST'], [`${base}/connections/${gsc.id}/disconnect`, 'POST'],
        [`${base}/connections/${gsc.id}/imports`, 'POST'], [`${base}/connections/${gsc.id}/inspect`, 'POST'], [`${base}/imports/${importId}`, 'POST'], ['/api/google/app', 'GET'], ['/api/google/app', 'POST'], ['/api/google/callback?state=x&code=y', 'GET'], [`/api/projects/${projectId}/events`, 'GET']] as const)
        assert.equal((await bearer(path, ownerKey.token, method)).status, 403, `${method} ${path}`);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM google_import WHERE project_id=$1', [projectId])).rows[0].n, importsBefore); assert.equal(providerCalls, callsBefore, 'No refused route reaches Google.');
      for (const suffix of ['?unknown=1', '?offset=0', `/imports/${importId}?offset=0&offset=50`, `/imports/${importId}?limit=10`]) assert.equal((await bearer(base + suffix, ownerKey.token)).status, 400, suffix);
      assert.equal((await call(`${base}/imports/${importId}?unknown=1`)).response.status, 200, 'The cookie route keeps ignoring unknown parameters.');
      const foreignKey = await createApiKey(foreignWorkspace.workspace.id, viewerId, { name: 'Foreign Google reader', scopes: ['google:read'], expiresInDays: 1 });
      for (const path of [base, `${base}/imports/${importId}`, `/api/projects/${foreignId}/google/imports/${importId}`]) assert.equal((await bearer(path, foreignKey.token)).status, 404, path);
      assert.equal((await bearer(`/api/projects/${foreignId}/google/imports/${importId}`, ownerKey.token)).status, 404, 'A key cannot reach a project of another workspace.');
      assert.equal((await bearer(base, ownerKey.token, 'GET', { cookie: [...actor].map(([name, value]) => `${name}=${value}`).join('; ') })).status, 400, 'Cookie plus bearer is refused.');
      await pool.query('UPDATE api_key SET revoked_at=clock_timestamp() WHERE id=$1', [viewerKey.key.id]);
      for (const path of [base, `${base}/imports/${importId}`]) assert.equal((await bearer(path, viewerKey.token)).status, 401, path);
      console.log('PASS google:read bearer list and snapshot equal the direct and cookie reads without the app configuration or tokens, viewer keys allowed, every other Google route 403, strict query, foreign 404, mixed credentials 400 and revoked 401');
      await pool.query('DELETE FROM request_limit WHERE key=$1', [`google:write:${userId}`]);

      // Reconnect with a short-lived access token; the actual refresh endpoint
      // is exercised, without any real Google request or personal account.
      mode = 'expire'; const reconnect = await connect('gsc', { connectionId: gsc.id }); await call(reconnect.callback); mode = 'normal';
      const refreshed = await call(`${base}/connections/${gsc.id}/imports`, { ...input, requestId: randomUUID(), report: 'gsc_daily' }); assert.equal(refreshed.response.status, 202);
      await runGoogleImport(refreshed.data.import.id); assert.equal(refreshCalls, 1);
      const refreshResult = (await call(`${base}/imports/${refreshed.data.import.id}`)).data; assert.equal(refreshResult.rows[0].metrics.clicks, '0');
      mode = 'expire'; const rotating = await connect('gsc', { connectionId: gsc.id }); await call(rotating.callback); mode = 'rotate_failure';
      const interruptedRefresh = await call(`${base}/connections/${gsc.id}/imports`, { ...input, requestId: randomUUID(), report: 'gsc_daily' }); assert.equal(interruptedRefresh.response.status, 202);
      await assert.rejects(runGoogleImport(interruptedRefresh.data.import.id));
      const rotatedRow = (await pool.query('SELECT * FROM google_connection WHERE id=$1', [gsc.id])).rows[0];
      assert.ok((decryptCredentials(rotatedRow.encrypted_tokens, googleConnectionContext(rotatedRow)) as { refreshToken: string }).refreshToken === rotatedRefreshToken, 'A downstream report failure must not roll back a rotated refresh token.');
      await delay(1100); mode = 'normal'; await runGoogleImport(interruptedRefresh.data.import.id);
      assert.equal((await pool.query('SELECT status FROM google_import WHERE id=$1', [interruptedRefresh.data.import.id])).rows[0].status, 'completed');
      assert.equal(refreshCalls, 3, 'Retry must successfully exchange the newly persisted refresh token.');
      const ga = await connect('ga4'); await call(ga.callback);
      const ga4 = (await call(base)).data.connections.find((row: any) => row.provider === 'ga4');
      assert.equal((await call(`${base}/connections/${ga4.id}/properties`, {})).data.nextPageToken, 'next-page');
      assert.equal((await call(`${base}/connections/${ga4.id}/properties`, { pageToken: 'next-page' })).data.nextPageToken, null);
      assert.equal((await call(`${base}/connections/${ga4.id}/select`, { propertyId: 'properties/123' })).response.status, 200);
      const gaInput = { ...input, requestId: randomUUID(), report: 'ga4_events' };
      const gaQueued = await call(`${base}/connections/${ga4.id}/imports`, gaInput); await runGoogleImport(gaQueued.data.import.id);
      const gaReport = (await call(`${base}/imports/${gaQueued.data.import.id}`)).data;
      assert.equal(gaReport.import.status, 'completed'); assert.equal(gaReport.source.currencyCode, 'AED'); assert.equal(gaReport.rows[0].metrics.keyEvents, null); assert.equal(gaReport.rows[0].metrics.totalUsers, '1'); assert.ok(gaReport.quality.warnings.length >= 2);
      mode = 'empty'; const empty = await call(`${base}/connections/${ga4.id}/imports`, { ...gaInput, requestId: randomUUID() }); await runGoogleImport(empty.data.import.id);
      const emptyReport = (await call(`${base}/imports/${empty.data.import.id}`)).data; assert.equal(emptyReport.import.status, 'completed'); assert.deepEqual(emptyReport.rows, []); mode = 'normal';
      assert.equal((await pool.query('SELECT count(*)::int AS count FROM event WHERE project_id=$1', [projectId])).rows[0].count, 0, 'Imported analytics must never enter native collection.');
      await assertGoogleCredentialsReadable(); await rotateGoogleCredentials(); await assertGoogleCredentialsReadable();

      const rollbackId = randomUUID();
      boss.send = async (name: any, data?: any, options?: any) => { await originalSend.call(boss, name, data, { ...options, startAfter: new Date(Date.now() + 3_600_000) }); throw new Error('Synthetic post-enqueue failure.'); };
      assert.equal((await call(`${base}/connections/${gsc.id}/imports`, { ...input, requestId: rollbackId })).response.status, 500);
      assert.equal((await pool.query('SELECT 1 FROM google_import WHERE request_id=$1', [rollbackId])).rowCount, 0);
      boss.send = async (name: any, data?: any, options?: any) => originalSend.call(boss, name, data, { ...options, startAfter: new Date(Date.now() + 3_600_000) });
      const denied = await call(`${base}/connections/${gsc.id}/imports`, { ...input, requestId: randomUUID() }); assert.equal(denied.response.status, 202);
      await pool.query("UPDATE membership SET role='editor' WHERE workspace_id=$1 AND user_id=$2", [workspace.id, userId]);
      const beforeDeny = providerCalls; await runGoogleImport(denied.data.import.id); assert.equal(providerCalls, beforeDeny); assert.equal((await pool.query('SELECT status FROM google_import WHERE id=$1', [denied.data.import.id])).rows[0].status, 'denied');
      await pool.query("UPDATE membership SET role='owner' WHERE workspace_id=$1 AND user_id=$2", [workspace.id, userId]);
      const interrupted = await call(`${base}/connections/${gsc.id}/imports`, { ...input, requestId: randomUUID() }); await boss.deleteJob(googleQueue, interrupted.data.import.id); await reconcileGoogleImports();
      assert.equal((await pool.query('SELECT status FROM google_import WHERE id=$1', [interrupted.data.import.id])).rows[0].status, 'failed');
      mode = 'quota'; const quota = await call(`${base}/connections/${gsc.id}/imports`, { ...input, requestId: randomUUID() }); await assert.rejects(runGoogleImport(quota.data.import.id));
      assert.equal((await pool.query('SELECT status FROM google_import WHERE id=$1', [quota.data.import.id])).rows[0].status, 'queued'); mode = 'normal'; await runGoogleImport(quota.data.import.id);
      const disconnected = await call(`${base}/connections/${gsc.id}/imports`, { ...input, requestId: randomUUID() });
      const beforeDisconnect = providerCalls; const removed = await call(`${base}/connections/${gsc.id}/disconnect`, { revokeAtGoogle: false }); assert.equal(removed.data.remoteRevocation, 'not_requested'); assert.equal(providerCalls, beforeDisconnect);
      await runGoogleImport(disconnected.data.import.id); assert.equal(providerCalls, beforeDisconnect); assert.equal((await pool.query('SELECT encrypted_tokens FROM google_connection WHERE id=$1', [gsc.id])).rows[0].encrypted_tokens, null);
      assert.equal((await call(`${base}/connections/${gsc.id}/properties`, {})).response.status, 409);
      console.log('PASS Google refresh, GA4 restrictions/empty reports, no native mixing, rekey, atomic enqueue, revocation, quota retry and failed-queue reconciliation');

      // Reset only this fixture actor's minute budget so the separate worker case
      // does not depend on wall-clock minute boundaries after many guarded APIs.
      await pool.query('DELETE FROM request_limit WHERE key IN ($1,$2)', [`google:write:${userId}`, `google:read:${userId}`]);
      boss.send = originalSend;
      await startGoogleImportWorker(boss);
      const worker = await call(`${base}/connections/${ga4.id}/imports`, { ...gaInput, requestId: randomUUID() }); assert.equal(worker.response.status, 202);
      const deadline = Date.now() + 30_000;
      let status = 'queued';
      while (Date.now() < deadline && ['queued', 'running'].includes(status)) { await delay(100); status = (await pool.query('SELECT status FROM google_import WHERE id=$1', [worker.data.import.id])).rows[0].status; }
      assert.equal(status, 'completed', 'The actual pg-boss worker must complete through the synthetic HTTP provider.');
      const revoke = await call(`${base}/connections/${ga4.id}/disconnect`, { revokeAtGoogle: true }); assert.equal(revoke.data.remoteRevocation, 'confirmed');
      const unavailable = await connect('gsc'); await call(unavailable.callback);
      const lostKey = (await call(base)).data.connections.find((row: any) => row.status === 'select_property');
      await pool.query("UPDATE google_connection SET encrypted_tokens=jsonb_set(encrypted_tokens,'{keyId}','\"missing-fixture-key\"'::jsonb) WHERE id=$1", [lostKey.id]);
      const beforeLostKey = providerCalls;
      const erased = await disconnectGoogle(projectId, userId, lostKey.id, { revokeAtGoogle: true });
      assert.equal(erased.remoteRevocation, 'unconfirmed'); assert.equal(providerCalls, beforeLostKey);
      assert.equal((await pool.query('SELECT encrypted_tokens FROM google_connection WHERE id=$1', [lostKey.id])).rows[0].encrypted_tokens, null, 'Lost keys must never block local disconnect.');
      if (browserCheck) {
        await pool.query('DELETE FROM request_limit WHERE key IN ($1,$2)', [`google:write:${userId}`, `google:read:${userId}`]);
        await browserCheck({ email, password, userId, projectId, workspaceId: workspace.id, clientSecret, transport, authorize: value => {
          const url = new URL(value);
          assert.equal(url.origin, 'https://accounts.google.com');
          const code = randomBytes(24).toString('base64url');
          codes.set(code, { challenge: url.searchParams.get('code_challenge')!, scope: url.searchParams.get('scope')! });
          return `${config.appUrl}/api/google/callback?state=${url.searchParams.get('state')}&code=${code}`;
        } });
      }
      assert.equal(fixtureErrors, 0, 'Synthetic provider assertions must hold.');
      console.log('PASS actual PostgreSQL queue worker and explicit remote revocation with synthetic HTTP only');
    });
  } finally {
    boss.send = originalSend;
    // Any retained terminal synthetic records remain inspectable; stop only this
    // process's queue clients before restoring the optional prior app state.
    await stopJobs();
    await new Promise<void>((resolve, reject) => fixture.close(error => error ? reject(error) : resolve()));
    if (savedApp) await pool.query("UPDATE google_app SET revision=$1,client_id=$2,encrypted_secret=$3,enabled=$4,testing=$5,updated_at=$6 WHERE id='instance'", [savedApp.revision, savedApp.client_id, savedApp.encrypted_secret, savedApp.enabled, savedApp.testing, savedApp.updated_at]);
    else await pool.query("DELETE FROM google_app WHERE id='instance'");
  }
}

if (process.argv[1]?.replaceAll('\\', '/').endsWith('/google-integration.ts')) {
  try { await runGoogleChecks(); }
  catch (error) { console.error('Google integration checks failed. Synthetic fixtures remain; credentials and response bodies are redacted.'); if (error instanceof assert.AssertionError) console.error(error.message); process.exitCode = 1; }
  finally { await stopJobs(); await closeDatabase(); }
}
