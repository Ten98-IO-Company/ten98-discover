import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {browserSuiteRoutes, discoverBrowserSuites, signalExitCode, stopSequence} from './helpers/browser-sweep-routes.ts';

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
      // An env read (process.env.FLAG / process.env['FLAG']) or a quoted name handed to one, e.g. a required-key list.
      const read = new RegExp(`process\\.env(?:\\.${flag}\\b|\\[\\s*['"]${flag}['"]\\s*\\])|['"]${flag}['"]`);
      assert.match(source, read, `${route.suite} never reads ${flag}`);
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
  for (const suite of discovered) assert.doesNotMatch(suite, /-fixture\.|\.test\.|^tests\/browser-sweep\.ts$|\/(fixtures?|guard|jobs|preload|provider)\.mjs$|research-ui\/browser\.mjs$/);
  assert.ok(!discovered.includes('tests/browser-sweep.ts'), 'the sweep entry point is not a suite');
  assert.ok(discovered.includes('tests/conversions-ui/browser.mjs'));
});

test('suites are stopped with SIGTERM before SIGKILL, with a longer grace for native runners', () => {
  const native = stopSequence({harness: 'native-browser'}), component = stopSequence({});
  assert.deepEqual(native.map(step => step.signal), ['SIGTERM', 'SIGKILL']);
  assert.equal(native[0].afterMs, 0);
  assert.ok(native[1].afterMs >= 20_000 && native[1].afterMs > component[1].afterMs);
  assert.deepEqual([signalExitCode('SIGINT'), signalExitCode('SIGTERM')], [130, 143]);
});
