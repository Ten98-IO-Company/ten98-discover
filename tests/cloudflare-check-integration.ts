import assert from 'node:assert/strict';
import {randomBytes, randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as pause} from 'node:timers/promises';
import {getConfig} from '../src/server/config.ts';
import {assertSchema, closeDatabase, getDatabase} from '../src/server/db.ts';
import {stopJobs} from '../src/server/jobs.ts';
import {checkCloudflareConnection, disconnectCloudflareConnection, rotateCloudflareCredentials, saveCloudflareConnection} from '../src/server/cloudflare-connections.ts';
import {encryptCredentials} from '../src/server/credential-vault.ts';
import {cloudflareConnectionCheckResponse} from '../src/lib/cloudflare-connections.ts';
import type {CloudflareTransportOptions} from '../src/server/cloudflare-http.ts';

export async function runCloudflareCheckChecks() {
  assert.equal(process.env.TEN98_INTEGRATION_TEST, '1'); assert.equal(process.env.TEN98_CLOUDFLARE_CHECK_TEST, '1');
  const database = new URL(getConfig().databaseUrl);
  assert.equal(database.hostname, '127.0.0.1');
  const ci = process.env.GITHUB_ACTIONS === 'true' && process.env.TEN98_ISOLATED_CI_DATABASE === '1' && database.pathname === '/ten98_cloudflare_check_ci';
  assert.equal(database.port, ci ? '5432' : '55501'); if (!ci) assert.match(database.pathname, /^\/ten98_cloudflare_check_[a-f0-9]{12}$/);
  assert.equal(database.search, ''); assert.equal(database.hash, ''); assert.equal(process.env.ANALYTICS_NETWORK_MODE, 'off');
  for (const name of ['PGHOST', 'PGHOSTADDR', 'PGPORT', 'PGDATABASE', 'PGSERVICE', 'PGSERVICEFILE', 'AUTH_SECRET_FILE', 'CREDENTIAL_KEYS_FILE']) assert.equal(process.env[name], undefined);
  await assertSchema(); const pool = getDatabase().pool;
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM workspace')).rows[0].n, 0);
  const originalFetch = globalThis.fetch, previousKeys = process.env.CREDENTIAL_KEYS, previousActive = process.env.CREDENTIAL_ACTIVE_KEY;
  let external = 0, requests = 0; globalThis.fetch = async () => { external++; throw Error('Real external calls are forbidden.'); };
  const firstKey = randomBytes(32).toString('base64'); process.env.CREDENTIAL_KEYS = JSON.stringify({fixture: firstKey}); process.env.CREDENTIAL_ACTIVE_KEY = 'fixture';
  const owner = randomUUID(), coowner = randomUUID(), viewer = randomUUID(), stranger = randomUUID();
  const token = 'synthetic-cloudflare-check-token', accountId = 'a'.repeat(32);
  const capabilities = {enabled: true, availableFields: ['example_field'], maxPageSize: 100, maxNumberOfFields: 20, notOlderThan: 10000, maxDuration: 1000};
  const cap = (value = capabilities) => Response.json({data: {viewer: {accounts: [{settings: {rumPageloadEventsAdaptiveGroups: value}}]}}});
  const site = (n: number) => ({site_tag: n.toString(16).padStart(32, '0'), rules: [{host: 'example.test'}], ruleset: {zone_name: 'zone.example'}, site_token: token, snippet: '<script>untrusted</script>'});
  const page = (values = [site(1)], number = 1, total = values.length, perPage = 50) => Response.json({success: true, errors: [], result: values,
    result_info: {page: number, count: values.length, per_page: perPage, total_count: total, total_pages: Math.ceil(total / perPage)}});
  type Send = NonNullable<CloudflareTransportOptions['fetch']>;
  const transport = (send: Send = async url => url.endsWith('/graphql') ? cap() : page()): CloudflareTransportOptions => ({fetch: async (url, init) => {
    requests++; assert.ok(requests <= 100, 'Synthetic transport request cap');
    assert.equal(new URL(url).hostname, 'api.cloudflare.com'); assert.equal(new Headers(init.headers).get('authorization'), `Bearer ${token}`);
    return send(url, init);
  }});
  type Fixture = {workspace: string; project: string; connection: string};
  const input = (connectionId: string | null = null, expectedRevision = 0) => ({requestId: randomUUID(), connectionId, expectedRevision, accountId, name: 'Cloudflare check fixture', apiToken: token});
  async function fixture(): Promise<Fixture> {
    const workspace = randomUUID(), project = randomUUID();
    await pool.query("INSERT INTO workspace(id,name) VALUES($1,'Cloudflare check fixture')", [workspace]);
    for (const [user, role] of [[owner, 'owner'], [coowner, 'owner'], [viewer, 'viewer']]) await pool.query('INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,$3)', [workspace, user, role]);
    await pool.query("INSERT INTO project(id,workspace_id,name,origin,public_key,retention_next_run_at) VALUES($1,$2,'Cloudflare check fixture','https://cloudflare.example',$3,'infinity')", [project, workspace, randomUUID()]);
    return {workspace, project, connection: (await saveCloudflareConnection(project, owner, input())).ack.connectionId};
  }
  const check = (f: Fixture, options = transport(), user = owner, revision = 1) => checkCloudflareConnection(f.project, user, {connectionId: f.connection, expectedRevision: revision}, options);
  async function denied(action: Promise<unknown>, status: number) {
    await assert.rejects(action, error => {
      assert.equal((error as {status?: number}).status, status); assert.ok(!String(error).includes(token)); assert.ok(!JSON.stringify(error).includes(token)); return true;
    });
  }
  async function workspaceWrite(f: Fixture, sql: string, values: unknown[]) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN'); await client.query("SET LOCAL statement_timeout='1500ms'; SET LOCAL lock_timeout='1500ms'");
      await client.query('SELECT id FROM workspace WHERE id=$1 FOR UPDATE', [f.workspace]); await client.query(sql, values); await client.query('COMMIT');
    } finally { await client.query('ROLLBACK'); client.release(); }
  }
  async function race(change: (f: Fixture) => Promise<unknown>, status: number | null, fail: boolean) {
    const f = await fixture(); let enter!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; }), released = new Promise<void>(resolve => { release = resolve; });
    const pending = check(f, transport(async url => {
      enter(); await released;
      if (fail) return new Response(token, {status: 401});
      return url.endsWith('/graphql') ? cap() : page();
    }));
    const outcome = pending.then(value => ({value, error: null}), error => ({value: null, error}));
    try { await Promise.race([entered, outcome.then(() => { throw Error('Check completed before transport entered.'); })]); await change(f); }
    finally { release(); }
    const result = await outcome;
    if (status === null) { assert.equal(result.error, null); assert.equal(result.value?.connectionId, f.connection); }
    else { assert.ok(result.error); assert.equal(result.error.status, status); assert.ok(!String(result.error).includes(token)); }
  }
  try {
    for (const user of [owner, coowner, viewer, stranger]) await pool.query('INSERT INTO "user"(id,name,email) VALUES($1,\'Cloudflare check fixture\',$2)', [user, `${user}@cloudflare-check.test`]);
    const f = await fixture(), before = (await pool.query('SELECT * FROM cloudflare_connection WHERE id=$1', [f.connection])).rows[0];
    const result = cloudflareConnectionCheckResponse.parse(await check(f));
    assert.equal(result.connectionId, f.connection); assert.equal(result.revision, 1); assert.equal(result.accountId, accountId);
    assert.deepEqual(result.capabilities, capabilities); assert.deepEqual(result.sites, [{site_tag: site(1).site_tag, rules: [{host: 'example.test'}], ruleset: {zone_name: 'zone.example'}}]);
    assert.ok(!JSON.stringify(result).includes(token)); assert.deepEqual((await pool.query('SELECT * FROM cloudflare_connection WHERE id=$1', [f.connection])).rows[0], before);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM project_content_request WHERE project_id=$1', [f.project])).rows[0].n, 1);
    const empty = await check(f, transport(async url => url.endsWith('/graphql') ? cap({...capabilities, enabled: false, maxPageSize: 0, maxDuration: 0}) : page([])));
    assert.deepEqual(empty.sites, []); assert.equal(empty.capabilities.enabled, false);
    const count = requests;
    await denied(check(f, transport(), viewer), 404); await denied(check(f, transport(), stranger), 404); await denied(check(f, transport(), owner, 2), 409);
    await denied(checkCloudflareConnection(f.project, owner, {connectionId: f.connection, expectedRevision: 1, unexpected: true}, transport()), 400);
    const other = await fixture(); await denied(check({...other, connection: f.connection}), 404);
    const binding = {workspaceId: f.workspace, id: f.connection, provider: 'cloudflare', revision: 1};
    await pool.query('UPDATE cloudflare_connection SET encrypted_credentials=$2 WHERE id=$1', [f.connection, encryptCredentials({projectId: other.project, accountId, apiToken: token}, binding)]);
    await denied(check(f), 503); await pool.query('UPDATE cloudflare_connection SET encrypted_credentials=$2 WHERE id=$1', [f.connection, before.encrypted_credentials]);
    assert.equal(requests, count);
    console.log('PASS authorized native decryption, strict input, safe complete/empty/disabled metadata and no persistent check state');

    const start = requests;
    const complete = await check(f, transport(async url => {
      if (url.endsWith('/graphql')) return cap();
      const number = Number(new URL(url).searchParams.get('page')); return page(Array.from({length: 50}, (_, i) => site((number - 1) * 50 + i + 1)), number, 1000);
    }));
    assert.equal(complete.sites.length, 1000); assert.equal(requests - start, 21);
    await denied(check(f, transport(async url => url.endsWith('/graphql') ? cap() : page([{...site(1), rules: [{host: token}]}]))), 502);
    await denied(check(f, transport(async url => {
      if (url.endsWith('/graphql')) return cap();
      const number = Number(new URL(url).searchParams.get('page'));
      const values = Array.from({length: 50}, (_, i) => ({...site((number - 1) * 50 + i + 1), rules: [{host: 'example.test', paths: ['x'.repeat(4000), 'y'.repeat(4000)]}]}));
      return page(values, number, 150);
    })), 502);
    for (const [http, status] of [[401, 502], [429, 429], [500, 503]]) await denied(check(f, transport(async () => new Response(token, {status: http}))), status);
    await denied(check(f, transport(async () => Response.json({errors: [{message: token}]}))), 502);
    await denied(check(f, {...transport(), signal: AbortSignal.abort(new Error(token))}), 503);
    console.log('PASS complete 21-request ceiling, 1 MiB output ceiling, allowed-field token echo rejection and sanitized provider failures');

    const changes: [string, (f: Fixture) => Promise<unknown>, number][] = [
      ['replacement', value => saveCloudflareConnection(value.project, coowner, input(value.connection, 1)), 409],
      ['disconnect', value => disconnectCloudflareConnection(value.project, coowner, {requestId: randomUUID(), connectionId: value.connection, expectedRevision: 1}), 409],
      ['membership', value => workspaceWrite(value, 'DELETE FROM membership WHERE workspace_id=$1 AND user_id=$2', [value.workspace, owner]), 404],
      ['role', value => workspaceWrite(value, "UPDATE membership SET role='viewer' WHERE workspace_id=$1 AND user_id=$2", [value.workspace, owner]), 404],
      ['project', value => workspaceWrite(value, 'DELETE FROM project WHERE id=$1', [value.project]), 404],
      ['account binding', value => workspaceWrite(value, 'UPDATE cloudflare_connection SET account_id=$2,encrypted_credentials=$3 WHERE id=$1', [value.connection, 'b'.repeat(32), encryptCredentials({projectId: value.project, accountId: 'b'.repeat(32), apiToken: token}, {workspaceId: value.workspace, id: value.connection, provider: 'cloudflare', revision: 1})]), 409],
      ['token binding', value => workspaceWrite(value, 'UPDATE cloudflare_connection SET encrypted_credentials=$2 WHERE id=$1', [value.connection, encryptCredentials({projectId: value.project, accountId, apiToken: 'different-synthetic-token'}, {workspaceId: value.workspace, id: value.connection, provider: 'cloudflare', revision: 1})]), 409],
    ];
    for (const [name, change, status] of changes) for (const fail of [false, true]) {
      await race(async value => {
        const timer = new AbortController();
        try { await Promise.race([change(value), pause(1600, undefined, {signal: timer.signal}).then(() => { throw Error(`${name} was blocked by external work`); })]); }
        finally { timer.abort(); }
      }, status, fail);
    }
    console.log('PASS success/error races for replace, disconnect, membership, owner role, project and account/token binding; workspace writes complete while transport waits');

    process.env.CREDENTIAL_KEYS = JSON.stringify({fixture: firstKey, next: randomBytes(32).toString('base64')}); process.env.CREDENTIAL_ACTIVE_KEY = 'next';
    await race(async () => { assert.ok(await rotateCloudflareCredentials() > 0); }, null, false);
    const final = await fixture();
    await denied(check(final, transport(async () => { delete process.env.CREDENTIAL_KEYS; delete process.env.CREDENTIAL_ACTIVE_KEY; return new Response(token, {status: 401}); })), 503);
    console.log('PASS legitimate vault rekey preserves an in-flight check and missing current keys override provider failure');

    process.env.CREDENTIAL_KEYS = JSON.stringify({fixture: firstKey}); process.env.CREDENTIAL_ACTIVE_KEY = 'fixture';
    const timed = await fixture(), began = Date.now();
    await denied(check(timed, transport(async (url, init) => {
      if (url.endsWith('/graphql')) return cap();
      await pause(1700, undefined, {signal: init.signal ?? undefined});
      const number = Number(new URL(url).searchParams.get('page')); return page(Array.from({length: 50}, (_, i) => site((number - 1) * 50 + i + 1)), number, 1000);
    })), 504);
    assert.ok(Date.now() - began >= 29000 && Date.now() - began < 35000, 'One aggregate deadline bounds otherwise-valid paginated requests');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM provider_request')).rows[0].n, 0);
    if ((await pool.query("SELECT to_regclass('pgboss.job') AS jobs")).rows[0].jobs) assert.equal((await pool.query('SELECT count(*)::int AS n FROM pgboss.job')).rows[0].n, 0);
    assert.equal(external, 0); console.log(`PASS real 30-second aggregate deadline, zero jobs/external requests; ${requests}/100 synthetic transport requests`);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousKeys === undefined) delete process.env.CREDENTIAL_KEYS; else process.env.CREDENTIAL_KEYS = previousKeys;
    if (previousActive === undefined) delete process.env.CREDENTIAL_ACTIVE_KEY; else process.env.CREDENTIAL_ACTIVE_KEY = previousActive;
    await stopJobs(); await closeDatabase();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runCloudflareCheckChecks();
