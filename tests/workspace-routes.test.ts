import assert from 'node:assert/strict';
import {test} from 'node:test';
import {expandPattern, inventoryPaths, invalidQuery, queryNames, routePatterns, sharedControllerRoutes, workspaceRoutes} from './helpers/workspace-routes.ts';
import {journeysQuery} from '../src/server/journeys.ts';
import {annotationQuery} from '../src/server/annotation-input.ts';
import {readPerformanceQuery} from '../src/lib/web-performance.ts';

test('every workspace and website route pattern in the server expands into concrete routes', () => {
  const patterns = routePatterns();
  assert.ok(patterns.length >= 70, `found ${patterns.length} route patterns`);
  assert.ok(new Set(patterns.map(pattern => pattern.file)).size >= 4, 'delegated route handlers are read as well as api.ts');
  for (const pattern of patterns) assert.ok(expandPattern(pattern.source).length > 0, `${pattern.file}: ${pattern.source}`);
});

test('the route table includes the routes that now check access before reading input', () => {
  const routes = new Set(workspaceRoutes());
  for (const route of [
    '/api/workspaces/{uuid}/projects', '/api/workspaces/{uuid}/transfer-ownership', '/api/workspaces/{uuid}/projects/{uuid}/delete',
    '/api/projects/{uuid}/retention-report', '/api/projects/{uuid}/attribution', '/api/projects/{uuid}/revenue',
    '/api/projects/{uuid}/revenue/sessions', '/api/projects/{uuid}/revenue/sessions/{visitorKey}', '/api/projects/{uuid}/annotations/timeline',
    '/api/projects/{uuid}/prompts/bulk', '/api/projects/{uuid}/prompts/{uuid}/update', '/api/projects/{uuid}/prompts/{uuid}/archive',
    '/api/projects/{uuid}/prompts/{uuid}/restore', '/api/projects/{uuid}/context/update',
    '/api/projects/{uuid}/journeys', '/api/projects/{uuid}/performance', '/api/projects/{uuid}/replays', '/api/projects/{uuid}/replays/{uuid}',
    '/api/projects/{uuid}/replays/saved', '/api/projects/{uuid}/annotations', '/api/projects/{uuid}/funnels', '/api/projects/{uuid}/goals',
    '/api/projects/{uuid}/cohorts', '/api/projects/{uuid}/segments', '/api/projects/{uuid}/prompts', '/api/projects/{uuid}/prompts/{uuid}/versions',
    '/api/projects/{uuid}/context/research-log', '/api/workspaces/{uuid}/boards',
  ]) assert.ok(routes.has(route), route);
  for (const route of inventoryPaths()) assert.ok(routes.has(route), `OpenAPI inventory route ${route}`);
  for (const route of routes) assert.match(route, /^\/api\/(workspaces|projects)\/\{uuid\}(\/|$)/);
});

test('the sweep query carries an unknown name and every declared name with a value the parsers refuse', () => {
  const names = queryNames(), query = invalidQuery();
  for (const name of ['steps', 'cursor', 'from', 'timeZone', 'metric', 'limit', 'after', 'environment', 'revision']) assert.ok(names.includes(name), name);
  assert.equal(query.get('unexpected'), '1');
  for (const name of names) assert.deepEqual(query.getAll(name), ['~'], name);
  assert.throws(() => journeysQuery(query));
  assert.throws(() => annotationQuery(query));
  assert.throws(() => readPerformanceQuery(query));
  // Each declared name alone is refused too, where the route knows it.
  assert.throws(() => journeysQuery(new URLSearchParams({steps: '~'})));
  assert.throws(() => annotationQuery(new URLSearchParams({from: '~', to: '~'})));
  assert.throws(() => readPerformanceQuery(new URLSearchParams({metric: '~'})));
});

test('shared controller routes name current team routes only', () => {
  const routes = new Set(workspaceRoutes());
  for (const entry of sharedControllerRoutes) {
    const [method, route] = entry.split(' ');
    assert.equal(method, 'POST', entry);
    assert.match(route, /^\/api\/workspaces\/\{uuid\}\/(invitations|members\/\{uuid\}\/role|rename|two-factor)$/, entry);
    assert.ok(routes.has(route), `${entry} is no longer a route; remove it from sharedControllerRoutes`);
  }
});

test('a route pattern the expander cannot read fails instead of being skipped', () => {
  assert.deepEqual(expandPattern('^/api/projects/([0-9a-f-]{36})/items(?:/(update|delete))?$'),
    ['/api/projects/{uuid}/items', '/api/projects/{uuid}/items/update', '/api/projects/{uuid}/items/delete']);
  assert.throws(() => expandPattern('^/api/projects/(\\d+)/items$'), /Unsupported route pattern/);
  assert.throws(() => expandPattern('^/api/projects/([0-9a-f-]{36})/items+$'), /Unsupported route pattern/);
});
