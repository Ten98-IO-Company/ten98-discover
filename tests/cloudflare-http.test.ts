import assert from 'node:assert/strict';
import {test} from 'node:test';
import {CloudflareTransportError, cloudflareQueryType, inspectCloudflareCapabilities, inspectCloudflareType, listCloudflareSites, type CloudflareTransportOptions} from '../src/server/cloudflare-http.ts';

const account = 'a'.repeat(32), secret = 'synthetic-secret-never-disclosed';
const tag = (n: number) => n.toString(16).padStart(32, '0');
const site = (n: number) => ({site_tag: tag(n), site_token: 'public-beacon-token', snippet: '<script>not retained</script>', rules: [{host: 'example.test', inclusive: true}], ruleset: {zone_name: 'example.test'}});
const page = (sites = [site(1)], info = {}) => ({success: true, errors: [], result: sites, result_info: {count: sites.length, page: 1, per_page: 50, total_count: sites.length, total_pages: sites.length ? 1 : 0, ...info}});
const options = (value: unknown): CloudflareTransportOptions => ({fetch: async () => Response.json(value)});
const capabilities = {enabled: true, availableFields: ['count', 'sum_visits'], maxPageSize: 100, maxNumberOfFields: 20, notOlderThan: 10000, maxDuration: 1000};
const capReply = (value: unknown = capabilities) => ({data: {viewer: {accounts: [{settings: {rumPageloadEventsAdaptiveGroups: value}}]}}});
async function safeFailure(action: () => Promise<unknown>, code?: string) {
  await assert.rejects(action, error => {
    assert.ok(error instanceof CloudflareTransportError);
    if (code) assert.equal(error.code, code);
    assert.equal('cause' in error, false);
    assert.ok(!JSON.stringify(error).includes(secret)); assert.ok(!String(error.stack).includes(secret));
    return true;
  });
}

test('site discovery uses only the official origin and strips snippets and beacon tokens', async () => {
  let calls = 0;
  const result = await listCloudflareSites(account, secret, {fetch: async (url, init) => {
    calls++; assert.equal(url, `https://api.cloudflare.com/client/v4/accounts/${account}/rum/site_info/list?page=1&per_page=50&order_by=created`);
    assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'error'); assert.equal(init.body, undefined);
    assert.equal(new Headers(init.headers).get('authorization'), `Bearer ${secret}`); assert.ok(init.signal);
    return Response.json(page());
  }});
  assert.equal(calls, 1); assert.deepEqual(result, [{site_tag: tag(1), rules: [{host: 'example.test', inclusive: true}], ruleset: {zone_name: 'example.test'}}]);
  assert.deepEqual(await listCloudflareSites(account, secret, options(page([]))), []);
});

test('site discovery proves completeness across pages and rejects drift, duplicates and missing pagination', async () => {
  const first = Array.from({length: 50}, (_, i) => site(i + 1)); let calls = 0;
  const result = await listCloudflareSites(account, secret, {fetch: async () => Response.json(++calls === 1
    ? page(first, {total_count: 51, total_pages: 2}) : page([site(51)], {page: 2, total_count: 51, total_pages: 2}))});
  assert.equal(result.length, 51); assert.equal(calls, 2);
  for (const bad of [{...page(), result_info: undefined}, page([], {total_count: 1, total_pages: 1}), page([site(1), site(1)]),
    page([site(1)], {page: 2}), page([site(1)], {total_pages: 2}), page([site(1)], {per_page: 0}), page([site(1)], {total_count: 1001})]) {
    await safeFailure(() => listCloudflareSites(account, secret, options(bad)));
  }
  for (const next of [page([site(1)], {page: 2, total_count: 51, total_pages: 2}), page([site(51)], {page: 2, total_count: 52, total_pages: 2})]) {
    calls = 0; await safeFailure(() => listCloudflareSites(account, secret, {fetch: async () => Response.json(++calls === 1 ? page(first, {total_count: 51, total_pages: 2}) : next)}), 'incomplete');
    assert.equal(calls, 2);
  }
});

test('malformed site responses never become empty successful inventories', async () => {
  for (const bad of [null, {}, {...page(), success: false}, {...page(), errors: [{message: secret}]}, {...page(), result: [{site_token: tag(1)}]},
    {...page(), result: [{site_tag: tag(1), rules: [{host: 3}]}]}, {...page(), result: [{site_tag: tag(1), ruleset: {enabled: 'yes'}}]}]) {
    await safeFailure(() => listCloudflareSites(account, secret, options(bad)), 'invalid_response');
  }
});

test('HTTP, GraphQL, parse and transport failures are sanitized and never retried', async () => {
  for (const status of [301, 401, 403, 429, 500]) {
    let calls = 0; await safeFailure(() => cloudflareQueryType(secret, {fetch: async () => {calls++; return new Response(secret, {status, headers: {location: 'https://attacker.test'}});}}),
      status === 401 || status === 403 ? 'denied' : status === 429 ? 'rate_limited' : 'unavailable'); assert.equal(calls, 1);
  }
  for (const response of [() => new Response(secret, {headers: {'content-type': 'application/json'}}), () => new Response('{}'),
    () => Response.json({data: {__schema: {queryType: {name: 'Query'}}}, errors: [{message: secret}]}), () => Response.json({data: null}),
    () => new Response(' '.repeat(524289), {headers: {'content-type': 'application/json'}})]) {
    await safeFailure(() => cloudflareQueryType(secret, {fetch: async () => response()}), 'invalid_response');
  }
  await safeFailure(() => cloudflareQueryType(secret, {fetch: async () => {throw new Error(secret);}}), 'unavailable');
});

test('invalid identifiers and aborted calls cannot send credentials', async () => {
  let calls = 0; const transport = async () => {calls++; return Response.json(page());};
  for (const id of ['../other', 'a'.repeat(31), account + '?x=1', account + '\n']) await safeFailure(() => listCloudflareSites(id, secret, {fetch: transport}), 'input');
  await safeFailure(() => listCloudflareSites(account, secret + '\n', {fetch: transport}), 'input');
  await safeFailure(() => inspectCloudflareType(secret, 'Query") {attack}', {fetch: transport}), 'input');
  const controller = new AbortController(); controller.abort(new Error(secret));
  await safeFailure(() => cloudflareQueryType(secret, {fetch: transport, signal: controller.signal}), 'cancelled');
  assert.equal(calls, 0);
});

test('capability inspection validates account cardinality, limits and fields without querying metrics', async () => {
  assert.deepEqual(await inspectCloudflareCapabilities(account, secret, {fetch: async (url, init) => {
    assert.equal(url, 'https://api.cloudflare.com/client/v4/graphql'); assert.equal(init.method, 'POST');
    const query = JSON.parse(String(init.body)).query as string; assert.ok(query.includes(`accountTag: "${account}"`));
    assert.ok(query.includes('settings { rumPageloadEventsAdaptiveGroups')); assert.ok(!query.includes('sum {')); return Response.json(capReply());
  }}), capabilities);
  for (const bad of [capReply(null), capReply({...capabilities, enabled: 'true'}), capReply({...capabilities, maxPageSize: -1}),
    capReply({...capabilities, maxDuration: 0}), capReply({...capabilities, availableFields: ['count', 'count']}),
    capReply({...capabilities, maxNumberOfFields: undefined}), {data: {viewer: {accounts: []}}},
    {data: {viewer: {accounts: [capReply().data.viewer.accounts[0], capReply().data.viewer.accounts[0]]}}}]) {
    await safeFailure(() => inspectCloudflareCapabilities(account, secret, options(bad)), 'invalid_response');
  }
  assert.equal((await inspectCloudflareCapabilities(account, secret, options(capReply({...capabilities, enabled: false, maxPageSize: 0, maxDuration: 0})))).enabled, false);
});

test('introspection uses discovered type names and rejects unknown or structurally inconsistent types', async () => {
  assert.equal(await cloudflareQueryType(secret, options({data: {__schema: {queryType: {name: 'Query'}}}})), 'Query');
  const object = {name: 'Query', kind: 'OBJECT', fields: [{name: 'viewer', type: {kind: 'OBJECT', name: 'Viewer', ofType: null}, args: []}], inputFields: null, enumValues: null};
  assert.deepEqual(await inspectCloudflareType(secret, 'Query', options({data: {__type: object}})), object);
  for (const value of [null, {...object, name: 'Other'}, {...object, kind: 'NEW_KIND'}, {...object, fields: null},
    {...object, fields: [object.fields[0], object.fields[0]]}, {...object, fields: [{...object.fields[0], type: {kind: 'NON_NULL', name: null}}]}]) {
    await safeFailure(() => inspectCloudflareType(secret, 'Query', options({data: {__type: value}})), 'invalid_response');
  }
  const argument = {name: 'filter', type: {kind: 'INPUT_OBJECT', name: 'Filter'}};
  await safeFailure(() => inspectCloudflareType(secret, 'Query', options({data: {__type: {...object, fields: [{...object.fields[0], args: [argument, argument]}]}}})), 'invalid_response');
  let nested: unknown = {kind: 'SCALAR', name: 'String'};
  for (let depth = 0; depth < 20; depth++) nested = {kind: 'LIST', name: null, ofType: nested};
  await safeFailure(() => inspectCloudflareType(secret, 'Query', options({data: {__type: {...object, fields: [{...object.fields[0], type: nested}]}}})), 'invalid_response');
});

test('shared transport deadline aborts a stalled connection without leaking its exception', async () => {
  const keepAlive = setTimeout(() => undefined, 6500), started = Date.now();
  try {
    await safeFailure(() => cloudflareQueryType(secret, {fetch: async (_url, init) => new Promise((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(new Error(secret)), {once: true});
    })}), 'timeout');
    assert.ok(Date.now() - started < 6200);
  } finally {clearTimeout(keepAlive);}
});

test('shared transport bounds a stalled response body and scrubs abort reasons', async () => {
  const keepAlive = setTimeout(() => undefined, 6500); let cancelled = false;
  try {
    await safeFailure(() => cloudflareQueryType(secret, {fetch: async () => new Response(new ReadableStream({
      start(controller) {controller.enqueue(new TextEncoder().encode('{'));}, cancel() {cancelled = true;},
    }), {headers: {'content-type': 'application/json'}})}), 'timeout');
    assert.equal(cancelled, true);
    const controller = new AbortController();
    await safeFailure(() => cloudflareQueryType(secret, {signal: controller.signal, fetch: async () => {
      controller.abort(new Error(secret)); throw new Error(secret);
    }}), 'cancelled');
  } finally {clearTimeout(keepAlive);}
});
