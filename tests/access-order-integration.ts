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
import {concretePath, invalidQuery, sharedControllerRoutes, workspaceRoutes} from './helpers/workspace-routes.ts';

type Options = {baseUrl: string; appUrl: string; memberCookie: string; outsiderCookie: string; outsiderId: string; workspaceId: string; projectId: string};
// invalid is the query a GET sends in place of its valid one; without it the request carries no query and an empty JSON object.
type Case = {name: string; method: 'GET' | 'POST'; path: string; valid: URLSearchParams | Record<string, unknown>; invalid?: URLSearchParams};

/**
 * A signed-in non-member of the target workspace gets the same 404 whether the input is valid or not, and members keep
 * their field errors. The sweep covers every workspace and website route from tests/helpers/workspace-routes.ts, sending each
 * GET both without a query and with one no route accepts.
 */
export async function runAccessOrderChecks(options: Options) {
  const {pool} = getDatabase();
  async function send(path: string, method: 'GET' | 'POST', cookie: string, input?: URLSearchParams | Record<string, unknown>) {
    const query = input instanceof URLSearchParams && input.size ? `?${input}` : '';
    const headers: Record<string, string> = {cookie};
    if (method === 'POST') { headers.origin = options.appUrl; headers['content-type'] = 'application/json'; }
    const response = await fetch(new URL(path + query, options.baseUrl), {
      method, headers, redirect: 'manual', signal: AbortSignal.timeout(15_000),
      ...(method === 'POST' ? {body: JSON.stringify(input instanceof URLSearchParams || input === undefined ? {} : input)} : {}),
    });
    const body = await response.text();
    // The sweep sends hundreds of refused requests from one identity; per-user request budgets are not what it measures.
    if (cookie === options.outsiderCookie) await pool.query("DELETE FROM request_limit WHERE key LIKE '%'||$1||'%'", [options.outsiderId]);
    return {status: response.status, body};
  }

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
  ];
  // The valid inputs above must pass each route's own parser, so the comparison is between a valid and an invalid input.
  retentionReportQuery(cases[1].valid as URLSearchParams);
  attributionQuery(cases[2].valid as URLSearchParams);
  for (const [route, key] of [['report', null], ['sessions', null], ['detail', visitorKey]] as const) revenueQuery(revenue, route, key);
  annotationQuery(cases[6].valid as URLSearchParams, true);
  const byName = (name: string) => cases.find(item => item.name === name)!;
  for (const [name, parse] of [['journeys', journeysQuery], ['performance', readPerformanceQuery], ['annotations', annotationQuery]] as const) {
    parse(byName(name).valid as URLSearchParams);
    assert.throws(() => parse(byName(name).invalid!), `${name}: the invalid query is one its parser refuses`);
  }

  for (const item of cases) {
    const invalid = await send(item.path, item.method, options.outsiderCookie, item.invalid);
    const valid = await send(item.path, item.method, options.outsiderCookie, item.valid);
    assert.equal(valid.status, 404, `${item.name}: a non-member with a valid input`);
    assert.deepEqual(invalid, valid, `${item.name}: a non-member gets the same answer with an invalid input`);
    const member = await send(item.path, item.method, options.memberCookie, item.invalid);
    assert.equal(member.status, 400, `${item.name}: a member still gets field errors for an invalid input`);
    console.log(`PASS ${item.name} checks workspace access before reading request input`);
  }

  const routes = workspaceRoutes();
  const query = invalidQuery();
  let swept = 0;
  for (const route of routes) {
    const path = concretePath(route, route.startsWith('/api/workspaces/') ? workspaceId : projectId, randomUUID, visitorKey);
    for (const [method, input] of [['GET', undefined], ['GET', query], ['POST', undefined]] as const) {
      const {status, body} = await send(path, method, options.outsiderCookie, input);
      const key = `${method} ${route}`;
      const allowed = sharedControllerRoutes.has(key) ? [400, 404] : [404, 405];
      assert.ok(allowed.includes(status), `${key}${input ? ' with an invalid query' : ''}: a non-member with an invalid input answered ${status} ${body.slice(0, 200)}`);
      swept++;
    }
  }
  assert.ok(routes.length > 100, `Expected the route table to name more than 100 workspace and website routes, found ${routes.length}.`);
  console.log(`PASS ${swept} workspace and website requests from a non-member answer 404 or 405 whatever the body or query`);
}
