import assert from 'node:assert/strict';
import {randomBytes, randomUUID} from 'node:crypto';
import {getDatabase} from '../src/server/db.ts';
import {projectInput} from '../src/server/validation.ts';
import {retentionReportQuery} from '../src/server/retention-report-input.ts';
import {attributionQuery} from '../src/server/attribution.ts';
import {revenueQuery} from '../src/server/revenue.ts';
import {annotationQuery} from '../src/server/annotation-input.ts';
import {contextPatch, promptAction, promptBatch, promptPatch} from '../src/server/context-input.ts';
import {projectDeleteInput} from '../src/lib/project-delete.ts';
import {journeysQuery} from '../src/server/journeys.ts';
import {readPerformanceQuery} from '../src/lib/web-performance.ts';
import {apiKeyScopes, createApiKey} from '../src/server/api-keys.ts';
import {concretePath, invalidQuery, sweepExceptions, workspaceRoutes} from './helpers/workspace-routes.ts';

type Role = 'owner' | 'admin' | 'editor' | 'viewer';
type Options = {
  baseUrl: string; appUrl: string; memberCookie: string; outsiderCookie: string; outsiderId: string; outsiderWorkspaceId: string;
  workspaceId: string; projectId: string; createIdentity: (workspaceId: string, role: Role) => Promise<{id: string; cookie: string}>;
};
/** One request. A body is sent as bytes, so it carries only the content type given here: application/json unless null or another. */
type Shape = {method: string; query?: URLSearchParams; body?: Buffer; contentType?: string | null};
type Caller = {cookie: string} | {token: string};
// invalid replaces the valid input: a query for a GET, a JSON array or raw bytes for a POST. Without it a GET sends no query and
// a POST an empty JSON object. memberStatus is what a member gets for the invalid input (400 unless stated).
type Case = {name: string; method: 'GET' | 'POST'; path: string; valid: URLSearchParams | Record<string, unknown>; invalid?: URLSearchParams | unknown[] | Buffer; memberStatus?: number};

const json = (value: unknown) => Buffer.from(JSON.stringify(value));
// Larger than every workspace and website body limit except a report save (6,400,000 bytes), which has its own case below.
const oversize = json({padding: 'x'.repeat(200 * 1024)});

/**
 * A signed-in non-member of the target workspace gets the same 404 whatever the request carries, members keep their field errors,
 * and editors, viewers and API keys get exactly what they got before the dispatcher checked membership first. The sweep covers
 * every workspace and website route from tests/helpers/workspace-routes.ts with every request shape below.
 */
export async function runAccessOrderChecks(options: Options) {
  const {pool} = getDatabase();
  async function send(path: string, shape: Shape, caller: Caller) {
    const query = shape.query?.size ? `?${shape.query}` : '';
    const headers: Record<string, string> = 'cookie' in caller ? {cookie: caller.cookie} : {authorization: `Bearer ${caller.token}`};
    if (shape.method === 'POST' && 'cookie' in caller) headers.origin = options.appUrl;
    if (shape.body && shape.contentType !== null) headers['content-type'] = shape.contentType ?? 'application/json';
    const response = await fetch(new URL(path + query, options.baseUrl), {
      method: shape.method, headers, redirect: 'manual', signal: AbortSignal.timeout(15_000), ...(shape.body ? {body: new Uint8Array(shape.body)} : {}),
    });
    const body = await response.text();
    // Refused requests from one identity add up; per-user request budgets are not what these checks measure.
    if ('cookie' in caller && caller.cookie === options.outsiderCookie) await pool.query("DELETE FROM request_limit WHERE key LIKE '%'||$1||'%'", [options.outsiderId]);
    return {status: response.status, body};
  }
  const outsider = {cookie: options.outsiderCookie}, member = {cookie: options.memberCookie};
  const shapeOf = (method: 'GET' | 'POST', input?: URLSearchParams | Record<string, unknown> | unknown[] | Buffer): Shape =>
    input instanceof URLSearchParams ? {method, query: input} : method === 'GET' ? {method} : {method, body: Buffer.isBuffer(input) ? input : json(input ?? {})};

  const roleMismatches = await checkRoleSample();
  const sweepFailures = await sweep();

  const {workspaceId, projectId} = options;
  const visitorKey = randomBytes(32).toString('hex');
  const dates = {from: '2024-03-01', to: '2024-03-07', timeZone: 'UTC'};
  const revenue = new URLSearchParams({...dates, currency: 'USD'});
  const action = {requestId: randomUUID(), revision: 1};
  const none = new URLSearchParams(), unexpected = new URLSearchParams({unexpected: '1'});
  const cases: Case[] = [
    {name: 'website create', method: 'POST', path: `/api/workspaces/${workspaceId}/projects`, valid: projectInput.parse({name: 'Access order', origin: 'https://access-order.integration.test'})},
    {name: 'retention report', method: 'GET', path: `/api/projects/${projectId}/retention-report`, valid: new URLSearchParams({month: '2024-03', timeZone: 'UTC'})},
    {name: 'attribution', method: 'GET', path: `/api/projects/${projectId}/attribution`, valid: new URLSearchParams({conversionKind: 'custom', conversionValue: 'signup'})},
    {name: 'revenue report', method: 'GET', path: `/api/projects/${projectId}/revenue`, valid: revenue},
    {name: 'revenue sessions', method: 'GET', path: `/api/projects/${projectId}/revenue/sessions`, valid: revenue},
    {name: 'revenue session detail', method: 'GET', path: `/api/projects/${projectId}/revenue/sessions/${visitorKey}`, valid: revenue},
    {name: 'annotation timeline', method: 'GET', path: `/api/projects/${projectId}/annotations/timeline`, valid: new URLSearchParams(dates)},
    {name: 'prompts bulk', method: 'POST', path: `/api/projects/${projectId}/prompts/bulk`, valid: promptBatch.parse({requestId: randomUUID(), prompts: [{text: 'Access order prompt'}]})},
    {name: 'prompt update', method: 'POST', path: `/api/projects/${projectId}/prompts/${randomUUID()}/update`, valid: promptPatch.parse({...action, enabled: false})},
    {name: 'prompt archive', method: 'POST', path: `/api/projects/${projectId}/prompts/${randomUUID()}/archive`, valid: promptAction.parse(action)},
    {name: 'prompt restore', method: 'POST', path: `/api/projects/${projectId}/prompts/${randomUUID()}/restore`, valid: promptAction.parse(action)},
    {name: 'context update', method: 'POST', path: `/api/projects/${projectId}/context/update`, valid: contextPatch.parse({...action, updates: [{kind: 'research', summary: 'Access order'}]})},
    {name: 'ownership transfer', method: 'POST', path: `/api/workspaces/${workspaceId}/transfer-ownership`, valid: {targetUserId: randomUUID(), confirmationEmail: 'access-order@integration.test'}},
    {name: 'website delete', method: 'POST', path: `/api/workspaces/${workspaceId}/projects/${projectId}/delete`, valid: projectDeleteInput.parse({...action, confirmation: 'DELETE'})},
    {name: 'journeys', method: 'GET', path: `/api/projects/${projectId}/journeys`, valid: new URLSearchParams({steps: '3'}), invalid: new URLSearchParams({steps: '9'})},
    {name: 'performance', method: 'GET', path: `/api/projects/${projectId}/performance`, valid: new URLSearchParams({from: dates.from, to: dates.to}), invalid: new URLSearchParams({metric: '~'})},
    {name: 'session replays', method: 'GET', path: `/api/projects/${projectId}/replays`, valid: none, invalid: unexpected},
    {name: 'session replay detail', method: 'GET', path: `/api/projects/${projectId}/replays/${randomUUID()}`, valid: none, invalid: new URLSearchParams({after: '1'})},
    {name: 'saved replays', method: 'GET', path: `/api/projects/${projectId}/replays/saved`, valid: new URLSearchParams({search: 'access'}), invalid: unexpected},
    {name: 'annotations', method: 'GET', path: `/api/projects/${projectId}/annotations`, valid: new URLSearchParams({search: 'access'}), invalid: unexpected},
    {name: 'funnels', method: 'GET', path: `/api/projects/${projectId}/funnels`, valid: none, invalid: unexpected},
    {name: 'goals', method: 'GET', path: `/api/projects/${projectId}/goals`, valid: none, invalid: unexpected},
    {name: 'cohorts', method: 'GET', path: `/api/projects/${projectId}/cohorts`, valid: none, invalid: unexpected},
    {name: 'saved filters', method: 'GET', path: `/api/projects/${projectId}/segments`, valid: none, invalid: unexpected},
    {name: 'prompts', method: 'GET', path: `/api/projects/${projectId}/prompts`, valid: new URLSearchParams({status: 'all'}), invalid: unexpected},
    {name: 'prompt versions', method: 'GET', path: `/api/projects/${projectId}/prompts/${randomUUID()}/versions`, valid: none, invalid: unexpected},
    {name: 'context research log', method: 'GET', path: `/api/projects/${projectId}/context/research-log`, valid: none, invalid: unexpected},
    {name: 'boards', method: 'GET', path: `/api/workspaces/${workspaceId}/boards`, valid: none, invalid: unexpected},
    {name: 'Google connect', method: 'POST', path: `/api/projects/${projectId}/google/connect`, valid: {provider: 'gsc', name: 'Access order'}},
    {name: 'Google disconnect', method: 'POST', path: `/api/projects/${projectId}/google/connections/${randomUUID()}/disconnect`, valid: {revokeAtGoogle: false}},
    {name: 'member remove', method: 'POST', path: `/api/workspaces/${workspaceId}/members/${randomUUID()}/remove`, valid: {}, invalid: []},
    {name: 'invitation revoke', method: 'POST', path: `/api/workspaces/${workspaceId}/invitations/${randomUUID()}/revoke`, valid: {}, invalid: []},
    {name: 'report save over the size limit', method: 'POST', path: `/api/projects/${projectId}/reports`, valid: {}, invalid: Buffer.alloc(6_400_001, 0x20), memberStatus: 413},
  ];
  // The valid inputs above must pass each route's own parser, so the comparison is between a valid and an invalid input.
  retentionReportQuery(cases[1].valid as URLSearchParams);
  attributionQuery(cases[2].valid as URLSearchParams);
  for (const [route, key] of [['report', null], ['sessions', null], ['detail', visitorKey]] as const) revenueQuery(revenue, route, key);
  annotationQuery(cases[6].valid as URLSearchParams, true);
  const byName = (name: string) => cases.find(item => item.name === name)!;
  for (const [name, parse] of [['journeys', journeysQuery], ['performance', readPerformanceQuery], ['annotations', annotationQuery]] as const) {
    parse(byName(name).valid as URLSearchParams);
    assert.throws(() => parse(byName(name).invalid as URLSearchParams), `${name}: the invalid query is one its parser refuses`);
  }

  for (const item of cases) {
    const invalid = await send(item.path, shapeOf(item.method, item.invalid), outsider);
    const valid = await send(item.path, shapeOf(item.method, item.valid), outsider);
    assert.equal(valid.status, 404, `${item.name}: a non-member with a valid input`);
    assert.deepEqual(invalid, valid, `${item.name}: a non-member gets the same answer with an invalid input`);
    const answer = await send(item.path, shapeOf(item.method, item.invalid), member);
    assert.equal(answer.status, item.memberStatus ?? 400, `${item.name}: a member still gets the input error`);
    console.log(`PASS ${item.name} checks workspace access before reading request input`);
  }

  assert.deepEqual(roleMismatches, [], 'Editors, viewers and API keys get what they got before; the observed matrix is logged above.');
  assert.deepEqual(sweepFailures, [], 'Every workspace and website route refuses a non-member before reading its input; failures are logged above.');

  /** Every route, every shape, from the non-member: exactly the dispatcher's 404 and its body. */
  async function sweep() {
    const query = invalidQuery();
    const shapes: [string, Shape][] = [
      ['GET', {method: 'GET'}],
      ['GET with an invalid query', {method: 'GET', query}],
      ['POST with an empty object', {method: 'POST', body: json({})}],
      ['POST with a query', {method: 'POST', query, body: json({})}],
      ['POST with a JSON array', {method: 'POST', body: json([])}],
      ['POST with invalid JSON', {method: 'POST', body: Buffer.from('{"unterminated":')}],
      ['POST without a content type', {method: 'POST', body: json({}), contentType: null}],
      ['POST with a text content type', {method: 'POST', body: json({}), contentType: 'text/plain'}],
      ['POST over the size limit', {method: 'POST', body: oversize}],
      ['HEAD with a query', {method: 'HEAD', query}],
      ['DELETE with a query', {method: 'DELETE', query}],
    ];
    const routes = workspaceRoutes(), failures: string[] = [];
    assert.ok(routes.length > 100, `Expected the route table to name more than 100 workspace and website routes, found ${routes.length}.`);
    let swept = 0;
    for (const route of routes) {
      const workspace = route.startsWith('/api/workspaces/');
      const path = concretePath(route, workspace ? options.workspaceId : options.projectId, randomUUID, visitorKey);
      const refusal = JSON.stringify({error: workspace ? 'Workspace not found or unavailable.' : 'Project not found or unavailable.'});
      for (const [name, shape] of shapes) {
        if (sweepExceptions.has(`${shape.method} ${route}`)) continue;
        const {status, body} = await send(path, shape, outsider);
        swept++;
        if (status !== 404 || shape.method !== 'HEAD' && body !== refusal) failures.push(`${name} ${route}: ${status} ${body.slice(0, 160)}`);
      }
    }
    if (failures.length) console.log(`FAIL ${failures.length} of ${swept} requests from a non-member did not get the 404:\n${failures.slice(0, 80).join('\n')}`);
    else console.log(`PASS ${swept} requests from a non-member (${routes.length} routes, ${shapes.length} shapes each) answer the same 404 whatever the method, query, content type, size or shape of the body`);
    return failures;
  }

  /**
   * Writes from an editor, a viewer, a read-only API key of the workspace and a key of another workspace, each with a valid body
   * and a JSON array. Expected statuses are [valid, invalid], recorded from the server before the dispatcher checked membership
   * first; the change must not move any of them. Runs in its own workspace so a write an editor may make touches no other fixture.
   */
  async function checkRoleSample() {
    const workspace = randomUUID();
    await pool.query('INSERT INTO workspace(id,name) VALUES($1,$2)', [workspace, 'Role sample workspace']);
    const owner = await options.createIdentity(workspace, 'owner');
    const created = await send(`/api/workspaces/${workspace}/projects`, {method: 'POST', body: json({name: 'Role sample', origin: 'https://role-sample.integration.test'})}, owner);
    assert.equal(created.status, 201, created.body);
    const project = JSON.parse(created.body).project.id as string;
    const callers = {
      editor: await options.createIdentity(workspace, 'editor'),
      viewer: await options.createIdentity(workspace, 'viewer'),
      readKey: {token: (await createApiKey(workspace, owner.id, {name: 'Role sample reader', scopes: apiKeyScopes.filter(scope => scope.endsWith(':read'))})).token},
      otherKey: {token: (await createApiKey(options.outsiderWorkspaceId, options.outsiderId, {name: 'Role sample other workspace', scopes: [...apiKeyScopes]})).token},
    };
    const current = JSON.parse((await send(`/api/projects/${project}/analytics-settings`, {method: 'GET'}, owner)).body);
    type Expected = Record<keyof typeof callers, [number, number]>;
    // The shared team controller decides the member removal role after Discover reads the body (sharedControllerRoutes).
    const rows: {name: string; path: string; valid: () => unknown; expected: Expected}[] = [
      {name: 'board delete', path: `/api/workspaces/${workspace}/boards/${randomUUID()}/delete`, valid: () => ({requestId: randomUUID(), revision: 1}),
        expected: {editor: [404, 400], viewer: [404, 404], readKey: [403, 403], otherKey: [403, 403]}},
      {name: 'report delete', path: `/api/projects/${project}/reports/${randomUUID()}/delete`, valid: () => ({revision: 1}),
        expected: {editor: [404, 400], viewer: [403, 400], readKey: [403, 403], otherKey: [403, 403]}},
      {name: 'destination draft', path: `/api/projects/${project}/destinations/draft`, valid: () => ({expectedVersion: 0, configuration: {}}),
        expected: {editor: [404, 404], viewer: [404, 404], readKey: [403, 403], otherKey: [403, 403]}},
      {name: 'website analytics settings', path: `/api/projects/${project}/analytics-settings`, valid: () => ({revision: current.revision, settings: current.settings}),
        expected: {editor: [404, 400], viewer: [404, 400], readKey: [403, 403], otherKey: [403, 403]}},
      {name: 'website delete', path: `/api/workspaces/${workspace}/projects/${project}/delete`, valid: () => projectDeleteInput.parse({requestId: randomUUID(), revision: 1, confirmation: 'DELETE'}),
        expected: {editor: [404, 404], viewer: [404, 404], readKey: [403, 403], otherKey: [403, 403]}},
      {name: 'member remove', path: `/api/workspaces/${workspace}/members/${randomUUID()}/remove`, valid: () => ({}),
        expected: {editor: [403, 400], viewer: [403, 400], readKey: [403, 403], otherKey: [403, 403]}},
      {name: 'prompt create', path: `/api/projects/${project}/prompts/bulk`, valid: () => promptBatch.parse({requestId: randomUUID(), prompts: [{text: 'Role sample prompt'}]}),
        expected: {editor: [201, 400], viewer: [404, 400], readKey: [403, 403], otherKey: [404, 404]}},
      {name: 'audit cancel', path: `/api/projects/${project}/audits/${randomUUID()}/cancel`, valid: () => ({}),
        expected: {editor: [404, 400], viewer: [404, 400], readKey: [403, 403], otherKey: [403, 403]}},
    ];
    const mismatches: string[] = [], observed: string[] = [];
    for (const row of rows) {
      const seen: Partial<Expected> = {};
      for (const [name, caller] of Object.entries(callers) as [keyof typeof callers, Caller][]) {
        const valid = await send(row.path, {method: 'POST', body: json(row.valid())}, caller);
        const invalid = await send(row.path, {method: 'POST', body: json([])}, caller);
        seen[name] = [valid.status, invalid.status];
        const expected = row.expected[name];
        if (valid.status !== expected[0] || invalid.status !== expected[1]) mismatches.push(`${row.name}, ${name}: expected ${expected.join('/')}, got ${valid.status} ${valid.body.slice(0, 120)} / ${invalid.status} ${invalid.body.slice(0, 120)}`);
      }
      observed.push(`${row.name}: ${JSON.stringify(seen)}`);
      // Only an editor may write here at all, and only a prompt; nothing in the matrix grants anyone else a write.
      for (const [name, [valid, invalid]] of Object.entries(row.expected)) {
        assert.ok(invalid >= 400 && (valid >= 400 || name === 'editor' && row.name === 'prompt create'), `${row.name}, ${name}: the recorded matrix grants no write`);
      }
    }
    assert.equal((await send(`/api/workspaces/${workspace}/projects`, {method: 'GET'}, owner)).body.includes(project), true, 'The role sample website is still there.');
    if (mismatches.length) console.log(`FAIL role sample:\n${mismatches.join('\n')}\nObserved [valid, invalid]:\n${observed.join('\n')}`);
    else console.log(`PASS ${rows.length * Object.keys(callers).length * 2} role sample writes from an editor, a viewer and two API keys answer as before`);
    return mismatches;
  }
}
