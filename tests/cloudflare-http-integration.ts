import assert from 'node:assert/strict';
import {randomBytes, randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {hashPassword} from 'better-auth/crypto';
import {getConfig} from '../src/server/config.ts';
import {assertSchema, closeDatabase, getDatabase} from '../src/server/db.ts';
import {getAuth} from '../src/server/auth.ts';
import {handleApi} from '../src/server/api.ts';
import {createApiKey} from '../src/server/api-keys.ts';
import {stopJobs} from '../src/server/jobs.ts';
import {cloudflareConnectionsResponse, cloudflareConnectionMutationResponse, cloudflareConnectionCheckResponse} from '../src/lib/cloudflare-connections.ts';

export async function runCloudflareHttpChecks() {
  assert.equal(process.env.TEN98_INTEGRATION_TEST, '1'); assert.equal(process.env.TEN98_CLOUDFLARE_HTTP_TEST, '1');
  const config = getConfig(), database = new URL(config.databaseUrl), origin = 'http://127.0.0.1:3111';
  assert.equal(config.appUrl, origin); assert.equal(database.hostname, '127.0.0.1');
  const ci = process.env.GITHUB_ACTIONS === 'true' && process.env.TEN98_ISOLATED_CI_DATABASE === '1' && database.pathname === '/ten98_cloudflare_http_ci';
  assert.equal(database.port, ci ? '5432' : '55501'); if (!ci) assert.match(database.pathname, /^\/ten98_cloudflare_http_[a-f0-9]{12}$/);
  assert.equal(database.search, ''); assert.equal(database.hash, ''); assert.equal(process.env.ANALYTICS_NETWORK_MODE, 'off');
  for (const name of ['PGHOST', 'PGHOSTADDR', 'PGPORT', 'PGDATABASE', 'PGSERVICE', 'PGSERVICEFILE', 'AUTH_SECRET_FILE', 'CREDENTIAL_KEYS_FILE']) assert.equal(process.env[name], undefined);
  await assertSchema(); const pool = getDatabase().pool;
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM workspace')).rows[0].n, 0);
  const originalFetch = globalThis.fetch, previousKeys = process.env.CREDENTIAL_KEYS, previousActive = process.env.CREDENTIAL_ACTIVE_KEY;
  let external = 0, requests = 0, providerRequests = 0;
  let providerReply: ((url: URL) => Promise<Response>) | undefined;
  globalThis.fetch = async (target, init) => {
    if (!providerReply) { external++; throw Error('HTTP contract checks forbid outbound calls.'); }
    countRequest(); providerRequests++;
    const url = new URL(typeof target === 'string' ? target : target instanceof URL ? target.href : target.url);
    assert.equal(url.origin, 'https://api.cloudflare.com');
    assert.ok(url.pathname === '/client/v4/graphql' || url.pathname === `/client/v4/accounts/${input.accountId}/rum/site_info/list`);
    assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${replacementToken}`);
    return providerReply(url);
  };
  process.env.CREDENTIAL_KEYS = JSON.stringify({fixture: randomBytes(32).toString('base64')}); process.env.CREDENTIAL_ACTIVE_KEY = 'fixture';
  const owner = randomUUID(), coowner = randomUUID(), admin = randomUUID(), editor = randomUUID(), viewer = randomUUID(), stranger = randomUUID();
  const workspace = randomUUID(), project = randomUUID(), foreignWorkspace = randomUUID(), foreignProject = randomUUID();
  const password = randomBytes(24).toString('hex'), cookies = new Map<string, string>();
  const apiToken = 'synthetic-cloudflare-original-token', replacementToken = 'synthetic-cloudflare-replacement-token', secrets = [password, apiToken, replacementToken];
  const input = {requestId: randomUUID(), connectionId: null, expectedRevision: 0, accountId: 'a'.repeat(32), name: 'Cloudflare HTTP fixture', apiToken};
  const countRequest = () => { requests++; assert.ok(requests <= 100, 'HTTP request cap'); };
  async function login(user: string) {
    countRequest();
    const response = await getAuth().handler(new Request(origin + '/api/auth/sign-in/email', {method: 'POST', headers: {origin, 'content-type': 'application/json'}, body: JSON.stringify({email: `${user}@cloudflare-http.test`, password})}));
    assert.equal(response.status, 200); const cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    assert.ok(cookie); cookies.set(user, cookie);
  }
  async function request(path = '', options: {user?: string | null; project?: string; method?: string; body?: unknown; raw?: string; origin?: string; token?: string; extra?: Record<string, string>} = {}) {
    countRequest(); const user = options.user === undefined ? owner : options.user, hasBody = options.body !== undefined || options.raw !== undefined;
    return handleApi(new Request(`${origin}/api/projects/${options.project ?? project}/cloudflare/connections${path}`, {
      method: options.method ?? (hasBody ? 'POST' : 'GET'),
      headers: {...user ? {cookie: cookies.get(user)!} : {}, origin: options.origin ?? origin, 'content-type': 'application/json', ...options.token ? {authorization: `Bearer ${options.token}`} : {}, ...options.extra},
      ...hasBody ? {body: options.raw ?? JSON.stringify(options.body)} : {},
    }));
  }
  async function expect(response: Promise<Response>, status: number) {
    const result = await response, text = await result.text();
    for (const secret of secrets) assert.ok(!text.includes(secret) && !JSON.stringify([...result.headers]).includes(secret), 'HTTP response must redact credentials');
    assert.equal(result.status, status, text);
    const body: unknown = JSON.parse(text);
    if (status >= 400) { assert.ok(body && typeof body === 'object'); assert.deepEqual(Object.keys(body), ['error']); }
    return body;
  }
  const mutate = async (body: unknown, path = '') => cloudflareConnectionMutationResponse.parse(await expect(request(path, {body}), 200));
  try {
    const passwordHash = await hashPassword(password);
    for (const user of [owner, coowner, admin, editor, viewer, stranger]) {
      await pool.query('INSERT INTO "user"(id,name,email) VALUES($1,\'Cloudflare HTTP fixture\',$2)', [user, `${user}@cloudflare-http.test`]);
      await pool.query('INSERT INTO account(id,"accountId","providerId","userId",password) VALUES($1,$2,\'credential\',$2,$3)', [randomUUID(), user, passwordHash]); await login(user);
    }
    for (const id of [workspace, foreignWorkspace]) await pool.query("INSERT INTO workspace(id,name) VALUES($1,'Cloudflare HTTP fixture')", [id]);
    for (const [user, role] of [[owner, 'owner'], [coowner, 'owner'], [admin, 'admin'], [editor, 'editor'], [viewer, 'viewer']]) await pool.query('INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,$3)', [workspace, user, role]);
    await pool.query("INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,'owner')", [foreignWorkspace, stranger]);
    for (const [id, workspaceId] of [[project, workspace], [foreignProject, foreignWorkspace]]) await pool.query("INSERT INTO project(id,workspace_id,name,origin,public_key,retention_next_run_at) VALUES($1,$2,'Cloudflare HTTP fixture','https://cloudflare.example',$3,'infinity')", [id, workspaceId, randomUUID()]);
    const initial = cloudflareConnectionsResponse.parse(await expect(request(), 200));
    assert.equal(initial.projectId, project); assert.equal(initial.role, 'owner'); assert.equal(initial.vaultConfigured, true); assert.deepEqual(initial.connections, []);
    for (const path of ['', '/disconnect']) await expect(request(path, {user: null, body: input}), 401);
    await expect(request('', {user: null}), 401); await expect(request('', {user: stranger}), 404); await expect(request('', {project: foreignProject}), 404);
    const saved = await mutate(input), connectionId = saved.ack.connectionId;
    assert.equal(saved.ack.requestId, input.requestId); assert.equal(saved.ack.operation, 'save'); assert.equal(saved.ack.revision, 1);
    assert.equal(saved.connections[0].state, 'configured'); assert.deepEqual((await mutate(input)).ack, saved.ack);
    const disconnect = {requestId: randomUUID(), connectionId, expectedRevision: 1};
    for (const [user, role] of [[admin, 'admin'], [editor, 'editor'], [viewer, 'viewer']]) {
      const listed = cloudflareConnectionsResponse.parse(await expect(request('', {user}), 200)); assert.equal(listed.role, role); assert.equal(listed.connections[0].id, connectionId);
      await expect(request('', {user, body: {...input, requestId: randomUUID()}}), 404); await expect(request('/disconnect', {user, body: disconnect}), 404);
    }
    await expect(request('', {user: coowner, body: input}), 409);
    await expect(request('', {body: {...input, name: 'Changed replay'}}), 409);
    await expect(request('', {project: foreignProject, body: input}), 404); await expect(request('/disconnect', {project: foreignProject, body: disconnect}), 404);
    console.log('PASS real browser sessions, owner mutations, current member metadata, concealed foreign authority and actor-bound replay');

    const replace = {...input, requestId: randomUUID(), connectionId, expectedRevision: 1, apiToken: replacementToken};
    const replaced = await mutate(replace); assert.equal(replaced.ack.revision, 2); assert.equal(replaced.connections[0].revision, 2);
    const oldSave = await mutate(input); assert.equal(oldSave.ack.revision, 1); assert.equal(oldSave.connections[0].revision, 2);
    await expect(request('', {body: {...replace, requestId: randomUUID()}}), 409);
    const remove = {...disconnect, expectedRevision: 2}, removed = await mutate(remove, '/disconnect');
    assert.equal(removed.ack.operation, 'disconnect'); assert.equal(removed.ack.revision, 3); assert.equal(removed.connections[0].state, 'disconnected');
    assert.equal((await pool.query('SELECT encrypted_credentials FROM cloudflare_connection WHERE id=$1', [connectionId])).rows[0].encrypted_credentials, null);
    assert.deepEqual((await mutate(remove, '/disconnect')).ack, removed.ack);
    const restored = await mutate({...replace, requestId: randomUUID(), expectedRevision: 3}); assert.equal(restored.ack.revision, 4);
    const oldDisconnect = await mutate(remove, '/disconnect'); assert.equal(oldDisconnect.ack.revision, 3); assert.equal(oldDisconnect.connections[0].state, 'configured'); assert.equal(oldDisconnect.connections[0].revision, 4);
    const persisted = await pool.query('SELECT encrypted_credentials FROM cloudflare_connection WHERE id=$1', [connectionId]);
    for (const secret of secrets) assert.ok(!JSON.stringify(persisted.rows).includes(secret));
    const receipts = await pool.query('SELECT result FROM project_content_request WHERE project_id=$1', [project]);
    assert.equal(receipts.rowCount, 4); for (const secret of secrets) assert.ok(!JSON.stringify(receipts.rows).includes(secret));
    console.log('PASS HTTP replacement, stale revisions, disconnect/restore and original acknowledgments with current safe metadata');

    await expect(request('', {body: input, origin: 'https://foreign.test'}), 403);
    await expect(request('/disconnect', {body: remove, origin: 'https://foreign.test'}), 403);
    for (const query of ['?unknown=1', '?x=1&x=2']) {
      await expect(request(query), 400); await expect(request(query, {body: input}), 400); await expect(request('/disconnect' + query, {body: remove}), 400);
    }
    await expect(request('', {method: 'PUT', body: input}), 405); await expect(request('/disconnect'), 405);
    await expect(request('/disconnect', {method: 'DELETE'}), 405);
    await expect(request('', {extra: {'content-length': '1'}}), 400); await expect(request('', {extra: {'transfer-encoding': 'chunked'}}), 400);
    for (const [path, valid, bytes] of [['', input, 8192], ['/disconnect', remove, 2048]] as const) {
      await expect(request(path, {body: {...valid, unexpected: true}}), 400); await expect(request(path, {raw: '{'}), 400);
      await expect(request(path, {raw: 'x'.repeat(bytes + 1)}), 413);
    }
    const key = await createApiKey(workspace, owner, {name: 'Cloudflare browser-only fixture', scopes: ['analytics:read']}); secrets.push(key.token);
    await expect(request('', {user: null, token: key.token}), 403); await expect(request('', {user: null, token: key.token, body: input}), 403);
    await expect(request('/disconnect', {user: null, token: key.token, body: remove}), 403); await expect(request('', {token: key.token}), 400);
    console.log('PASS same-origin writes, method/query/body bounds, strict DTOs, API-key denial and credential-free error responses');

    const checkInput = {connectionId, expectedRevision: 4};
    const capabilities = {enabled: true, availableFields: ['example_field'], maxPageSize: 100, maxNumberOfFields: 20, notOlderThan: 10000, maxDuration: 1000};
    const site = {site_tag: 'b'.repeat(32), rules: [{host: 'fixture.cloudflare.test'}], ruleset: {zone_name: 'fixture.cloudflare.test'}};
    const providerSuccess = async (url: URL) => url.pathname.endsWith('/graphql')
      ? Response.json({data: {viewer: {accounts: [{settings: {rumPageloadEventsAdaptiveGroups: capabilities}}]}}})
      : Response.json({success: true, errors: [], result: [{...site, site_token: replacementToken, snippet: 'untrusted-site-snippet'}],
        result_info: {page: 1, count: 1, per_page: 50, total_count: 1, total_pages: 1}});
    providerReply = providerSuccess;
    const beforeCheck = (await pool.query('SELECT * FROM cloudflare_connection WHERE id=$1', [connectionId])).rows[0];
    const checked = cloudflareConnectionCheckResponse.parse(await expect(request('/check', {body: checkInput}), 200));
    assert.equal(checked.projectId, project); assert.equal(checked.connectionId, connectionId); assert.equal(checked.accountId, input.accountId); assert.equal(checked.revision, 4);
    assert.deepEqual(checked.capabilities, capabilities); assert.deepEqual(checked.sites, [site]); assert.ok(!JSON.stringify(checked).includes('untrusted-site-snippet'));
    assert.equal(providerRequests, 2);
    await expect(request('/check', {user: null, body: checkInput}), 401);
    await expect(request('/check', {user: null, token: key.token, body: checkInput}), 403);
    for (const user of [admin, editor, viewer]) await expect(request('/check', {user, body: checkInput}), 404);
    await expect(request('/check', {project: foreignProject, body: checkInput}), 404);
    await expect(request('/check', {origin: 'https://foreign.test', body: checkInput}), 403);
    await expect(request('/check?unknown=1', {body: checkInput}), 400);
    await expect(request('/check'), 405); await expect(request('/check', {method: 'DELETE'}), 405);
    await expect(request('/check', {user: admin, body: {...checkInput, apiToken}}), 400);
    await expect(request('/check', {user: editor, raw: '{'}), 400);
    await expect(request('/check', {user: viewer, raw: 'x'.repeat(2049)}), 413);
    await expect(request('/check', {body: {...checkInput, expectedRevision: 1}}), 409);
    assert.equal(providerRequests, 2, 'Rejected HTTP checks must not reach Cloudflare');
    console.log('PASS explicit check shape, current stored credential, provider-field redaction and browser-only owner/HTTP constraints');

    for (const [change, user, role, status] of [['expiry', coowner, 'owner', 401], ['deletion', admin, 'admin', 401], ['factor', editor, 'editor', 403]] as const) {
      await pool.query("UPDATE membership SET role='owner' WHERE workspace_id=$1 AND user_id=$2", [workspace, user]);
      for (const fail of [false, true]) {
        const session = (await pool.query('SELECT id FROM session WHERE "userId"=$1', [user])).rows;
        assert.equal(session.length, 1);
        let enter!: () => void, release!: () => void;
        const entered = new Promise<void>(resolve => { enter = resolve; }), released = new Promise<void>(resolve => { release = resolve; });
        providerReply = async url => { enter(); await released; return fail ? new Response(replacementToken, {status: 401}) : providerSuccess(url); };
        const pending = request('/check', {user, body: checkInput});
        try {
          await Promise.race([entered, pending.then(() => { throw Error('HTTP check completed before provider response was held.'); })]);
          if (change === 'expiry') await pool.query('UPDATE session SET "expiresAt"=clock_timestamp()-interval \'1 minute\' WHERE id=$1', [session[0].id]);
          else if (change === 'deletion') await pool.query('DELETE FROM session WHERE id=$1', [session[0].id]);
          else await pool.query('INSERT INTO workspace_two_factor_requirement(workspace_id) VALUES($1)', [workspace]);
        } finally { release(); }
        try { await expect(pending, status); }
        finally {
          if (change === 'factor') await pool.query('DELETE FROM workspace_two_factor_requirement WHERE workspace_id=$1', [workspace]);
        }
        if (change !== 'factor' && !fail) await login(user);
      }
      await pool.query('UPDATE membership SET role=$3 WHERE workspace_id=$1 AND user_id=$2', [workspace, user, role]);
    }
    providerReply = undefined;
    assert.equal(providerRequests, 11);
    assert.deepEqual((await pool.query('SELECT * FROM cloudflare_connection WHERE id=$1', [connectionId])).rows[0], beforeCheck);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM project_content_request WHERE project_id=$1', [project])).rows[0].n, 4);
    console.log('PASS original-session expiry/deletion and newly required workspace factor override both provider success and failure, without storing check evidence');

    await pool.query('INSERT INTO workspace_two_factor_requirement(workspace_id) VALUES($1)', [workspace]);
    await expect(request(), 403); await expect(request('', {body: input}), 403); await expect(request('/disconnect', {body: remove}), 403);
    await pool.query('DELETE FROM workspace_two_factor_requirement WHERE workspace_id=$1', [workspace]);
    await pool.query('DELETE FROM membership WHERE workspace_id=$1 AND user_id=$2', [workspace, viewer]); await expect(request('', {user: viewer}), 404);
    await pool.query("UPDATE membership SET role='viewer' WHERE workspace_id=$1 AND user_id=$2", [workspace, owner]);
    await expect(request('', {body: input}), 404); await expect(request('/disconnect', {body: remove}), 404);
    assert.equal(cloudflareConnectionsResponse.parse(await expect(request(), 200)).role, 'viewer');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM cloudflare_connection')).rows[0].n, 1);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM provider_request')).rows[0].n, 0);
    if ((await pool.query("SELECT to_regclass('pgboss.job') AS jobs")).rows[0].jobs) assert.equal((await pool.query('SELECT count(*)::int AS n FROM pgboss.job')).rows[0].n, 0);
    assert.equal(external, 0); console.log(`PASS current workspace factor, revoked membership/ownership before receipt replay, zero provider work; ${requests}/100 HTTP requests`);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousKeys === undefined) delete process.env.CREDENTIAL_KEYS; else process.env.CREDENTIAL_KEYS = previousKeys;
    if (previousActive === undefined) delete process.env.CREDENTIAL_ACTIVE_KEY; else process.env.CREDENTIAL_ACTIVE_KEY = previousActive;
    await stopJobs(); await closeDatabase();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runCloudflareHttpChecks();
