import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {browserSuiteRoutes, discoverBrowserSuites} from './helpers/browser-sweep-routes.ts';

const root = resolve(import.meta.dirname, '..');

test('every browser suite on disk has exactly one sweep route', () => {
  const routed = browserSuiteRoutes.map(route => route.suite);
  assert.deepEqual(routed.filter((suite, index) => routed.indexOf(suite) !== index), [], 'duplicate routes');
  const unrouted = discoverBrowserSuites(root).filter(suite => !routed.includes(suite));
  assert.deepEqual(unrouted, [], 'add these suites to tests/helpers/browser-sweep-routes.ts');
});

test('every sweep route points at an existing browser suite', () => {
  const discovered = discoverBrowserSuites(root);
  for (const {suite} of browserSuiteRoutes) {
    assert.ok(existsSync(resolve(root, suite)), suite + ' does not exist');
    assert.ok(discovered.includes(suite), suite + ' is not discovered as a browser suite');
  }
});

test('routes are well formed and their flags are ones the suite reads', () => {
  for (const route of browserSuiteRoutes) {
    const source = readFileSync(resolve(root, route.suite), 'utf8');
    for (const flag of [...route.flags ?? [], ...route.evidence ?? []]) {
      assert.match(flag, /^TEN98_[A-Z0-9_]+$/);
      assert.ok(source.includes(flag), `${route.suite} never reads ${flag}`);
    }
    if (route.class === 'native') assert.ok(route.harness, route.suite + ' needs a harness');
    else assert.equal(route.harness, undefined, route.suite);
    if (route.class === 'evidence-gated') assert.ok(route.blocked || route.evidence?.length, route.suite + ' needs evidence or a blocked reason');
    for (const option of route.runner ?? []) assert.match(option, /^--(unclaimed|no-worker|self-hosted|database=ten98_[a-z_]+|database-port=\d+)$/);
    if (route.runner?.length || route.port) assert.equal(route.harness, 'native-browser', route.suite);
  }
});

test('discovery excludes fixtures, unit tests and harness helpers', () => {
  const discovered = discoverBrowserSuites(root);
  for (const suite of discovered) assert.doesNotMatch(suite, /-fixture\.|\.test\.|\/(browser-sweep|fixtures?|guard|jobs|preload|provider)\.mjs$|research-ui\/browser\.mjs$/);
  assert.ok(discovered.includes('tests/conversions-ui/browser.mjs'));
});
