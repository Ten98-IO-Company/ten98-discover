import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import { analyticsIdentity, analyticsPathExcluded, insertApiObservation, trackingConsentEpoch } from '../src/server/native-analytics.ts';
import { InputError } from '../src/server/validation.ts';

const projectId = '00000000-0000-4000-8000-000000000001';
const otherProject = '00000000-0000-4000-8000-000000000002';
const secret = 'identity-unit-fixture-secret-32-characters';
const base = { projectId, ip: '192.0.2.1', userAgent: 'Fixture browser user-agent', secret };
function identity(at: string, extra: Partial<Parameters<typeof analyticsIdentity>[0]> = {}) {
  const value = analyticsIdentity({ ...base, now: new Date(at), ...extra });
  assert.ok(value);
  return value;
}
function contextBody(context: string) {
  return JSON.parse(Buffer.from(context.split('.')[0], 'base64url').toString('utf8')) as Record<string, unknown>;
}
function signFixture(body: Record<string, unknown>) {
  const encoded = Buffer.from(JSON.stringify(body)).toString('base64url');
  const signature = createHmac('sha256', secret).update(JSON.stringify(['ten98.analytics.context.v1', encoded])).digest('hex');
  return `${encoded}.${signature}`;
}

test('visitor keys are stable within a UTC month, scoped to project and never expose identity inputs', () => {
  const first = identity('2026-10-01T08:00:00Z', { distinctId: 'private-customer-sentinel' });
  const later = identity('2026-10-30T22:00:00Z', { distinctId: 'private-customer-sentinel' });
  assert.equal(first.visitor, later.visitor);
  assert.match(first.visitor, /^[a-f0-9]{64}$/);
  assert.match(first.visit, /^[a-f0-9]{64}$/);
  assert.equal(first.metricVersion, 'umami-3.4-hour-cache-v1');
  for (const extra of [{ projectId: otherProject }, { ip: '192.0.2.2' }, { userAgent: 'Different browser' }, { distinctId: 'different-customer' }, { secret: secret + '-rotated' }]) {
    assert.notEqual(identity('2026-10-01T08:00:00Z', { distinctId: 'private-customer-sentinel', ...extra }).visitor, first.visitor);
  }
  const visible = JSON.stringify({ ...first, body: contextBody(first.context) });
  for (const sentinel of [base.ip, base.userAgent, 'private-customer-sentinel', secret]) assert.equal(visible.includes(sentinel), false);
});

test('identify changes the visitor key without changing or merging an earlier anonymous identity', () => {
  const anonymous = identity('2026-10-13T09:00:00Z');
  const identified = identity('2026-10-13T09:01:00Z', { distinctId: 'customer-a', context: anonymous.context });
  assert.notEqual(identified.visitor, anonymous.visitor);
  assert.notEqual(identified.visit, anonymous.visit);
  assert.equal(identity('2026-10-13T09:02:00Z', { distinctId: 'customer-a', context: identified.context }).visitor, identified.visitor);
  assert.equal(identity('2026-10-13T09:03:00Z', { context: identified.context }).visitor, anonymous.visitor);
  assert.notEqual(identity('2026-10-13T09:02:00Z', { distinctId: ' customer-a ' }).visitor, identified.visitor);
});

test('basic identity is separate from consented and explicit keys; contexts never cross collection bases',()=>{
  const basic=identity('2026-10-13T09:50:00Z',{collectionBasis:'cookieless'}),consented=identity('2026-10-13T09:50:00Z');
  assert.notEqual(basic.visitor,consented.visitor);assert.notEqual(basic.visit,consented.visit);
  assert.deepEqual(identity('2026-10-13T10:10:00Z',{collectionBasis:'cookieless',context:consented.context}),identity('2026-10-13T10:10:00Z',{collectionBasis:'cookieless'}));
  assert.deepEqual(identity('2026-10-13T10:10:00Z',{context:basic.context}),identity('2026-10-13T10:10:00Z'));
  assert.equal(identity('2026-10-13T10:10:00Z',{collectionBasis:'cookieless',context:basic.context}).context,basic.context);
  assert.notEqual(identity('2026-11-01T00:00:00Z',{collectionBasis:'cookieless',context:basic.context}).visitor,basic.visitor);
  assert.notEqual(identity('2026-10-13T09:50:00Z',{collectionBasis:'cookieless',projectId:otherProject}).visitor,basic.visitor);
  assert.throws(()=>identity('2026-10-13T10:10:00Z',{collectionBasis:'cookieless',distinctId:'private-customer'}),InputError);
  // Explicit consent keeps the exact legacy formula, not merely a new stable hash.
  const legacy=createHmac('sha256',secret).update(JSON.stringify(['ten98.analytics.visitor.v1',projectId,'2026-10',base.ip,base.userAgent,null])).digest('hex');
  assert.equal(consented.visitor,legacy);assert.equal(identity('2026-10-13T09:50:00Z',{collectionBasis:'consent'}).visitor,legacy);
});

test('hourly visit IDs can span an hour through cache while retaining original issuance', () => {
  const initial = identity('2026-10-13T09:50:00Z');
  const continued = identity('2026-10-13T10:15:00Z', { context: initial.context });
  assert.equal(continued.visit, initial.visit);
  assert.equal(continued.context, initial.context);
  const boundary = identity('2026-10-13T10:20:00Z', { context: continued.context });
  assert.equal(boundary.context, initial.context);
  const expired = identity('2026-10-13T10:20:00.001Z', { context: continued.context });
  assert.equal(expired.visitor, initial.visitor);
  assert.notEqual(expired.visit, initial.visit);
  assert.equal(contextBody(expired.context).issued, Date.parse('2026-10-13T10:20:00.001Z'));
});

test('expired cache within one hour can produce the same visit, and reloads use the current hour', () => {
  const initial = identity('2026-10-13T10:00:00Z');
  const expired = identity('2026-10-13T10:30:00.001Z', { context: initial.context });
  assert.equal(expired.visit, initial.visit);
  assert.notEqual(expired.context, initial.context);
  assert.equal(identity('2026-10-13T10:59:00Z').visit, initial.visit);
  assert.notEqual(identity('2026-10-13T11:00:00Z').visit, initial.visit);
});

test('UTC month rotation invalidates even a young cached visitor and visit', () => {
  const initial = identity('2026-09-30T23:59:59Z');
  const nextMonth = identity('2026-10-01T00:00:00Z', { context: initial.context });
  assert.notEqual(nextMonth.visitor, initial.visitor);
  assert.notEqual(nextMonth.visit, initial.visit);
  assert.deepEqual(nextMonth, identity('2026-10-01T00:00:00Z'));
});

test('foreign, tampered, malformed or oversized contexts cannot select a visitor or visit', () => {
  const initial = identity('2026-10-13T09:50:00Z');
  const foreign = identity('2026-10-13T09:50:00Z', { projectId: otherProject });
  const body = contextBody(initial.context);
  const tamperedBody = Buffer.from(JSON.stringify({ ...body, visit: 'a'.repeat(64) })).toString('base64url');
  const expected = identity('2026-10-13T10:10:00Z');
  for (const context of [
    foreign.context, `${tamperedBody}.${initial.context.split('.')[1]}`,
    `${initial.context.slice(0, -1)}${initial.context.endsWith('0') ? '1' : '0'}`,
    '', 'bad.context', 'x'.repeat(1025), `${initial.context}.extra`,
    signFixture({ ...body, version: 2 }), signFixture({ ...body, unexpected: true }),
  ]) assert.deepEqual(identity('2026-10-13T10:10:00Z', { context }), expected);
});

test('validly signed future contexts and contexts from a different signing key are discarded', () => {
  const future = identity('2026-10-13T10:11:00Z');
  const expected = identity('2026-10-13T10:10:00Z');
  assert.deepEqual(identity('2026-10-13T10:10:00Z', { context: future.context }), expected);
  const initial = identity('2026-10-13T09:50:00Z', { secret: secret + '-old' });
  assert.deepEqual(identity('2026-10-13T10:10:00Z', { context: initial.context }), expected);
  const body = contextBody(expected.context);
  assert.deepEqual(identity('2026-10-13T10:10:00Z', { context: signFixture({ ...body, issued: Date.parse('2026-10-13T10:10:00.001Z') }) }), expected);
});

test('missing network or usable UA stays unmeasured even with a valid previous context', () => {
  const initial = identity('2026-10-13T09:00:00Z');
  for (const extra of [{ ip: null }, { ip: '' }, { userAgent: '' }, { userAgent: 'x'.repeat(1025) }]) {
    assert.equal(analyticsIdentity({ ...base, now: new Date('2026-10-13T09:01:00Z'), context: initial.context, ...extra }), null);
  }
  assert.ok(analyticsIdentity({ ...base, now: new Date('2026-10-13T09:01:00Z'), userAgent: 'x'.repeat(1024) }));
});

test('combined consent epoch changes independently for either native or destination policy', () => {
  const native = '00000000-0000-4000-8000-000000000003';
  const destination = '00000000-0000-4000-8000-000000000004';
  const first = trackingConsentEpoch(native, destination);
  assert.match(first, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  assert.equal(trackingConsentEpoch(native, destination), first);
  assert.notEqual(trackingConsentEpoch(otherProject, destination), first);
  assert.notEqual(trackingConsentEpoch(native, otherProject), first);
  assert.notEqual(trackingConsentEpoch(native, null), first);
});

test('path exclusions compare Unicode and encoded equivalents and fail closed on malformed escapes', () => {
  assert.equal(analyticsPathExcluded('/caf%C3%A9/order', ['/café']), true);
  assert.equal(analyticsPathExcluded('/café/order', ['/caf%C3%A9']), true);
  assert.equal(analyticsPathExcluded('/%70rivate/account', ['/private']), true);
  assert.equal(analyticsPathExcluded('/private%2Faccount', ['/private/account']), true);
  assert.equal(analyticsPathExcluded('/privately', ['/private']), true);
  assert.equal(analyticsPathExcluded('/public', ['/private']), false);
  for (const path of ['/public%zz', '/public%', '/public%C0%AF', '/public%ED%A0%80']) {
    assert.equal(analyticsPathExcluded(path, ['/private']), true);
    assert.equal(analyticsPathExcluded(path, []), false);
  }
  assert.equal(analyticsPathExcluded('/public', ['/invalid%']), true);
});

function apiClient(overrides: Record<string, unknown> = {}, inserted = true) {
  const writes: unknown[][] = [];
  const project = { id: projectId, origin: 'https://site.example', analytics_settings: {
    enabled: true, consentMode: 'builtin', captureReferrer: false, captureCampaigns: false,
    captureScreen: false, excludeBots: true, excludedPaths: [], ...overrides,
  } };
  const client = { async query(sql: string, values: unknown[] = []) {
    if (sql.startsWith('SELECT * FROM project')) return { rows: [project], rowCount: 1 };
    if (sql.startsWith('INSERT INTO event')) { writes.push(values); return { rows: [], rowCount: inserted ? 1 : 0 }; }
    throw new Error('Unexpected database operation in API observation');
  } } as unknown as PoolClient;
  return { client, writes };
}

test('API observations cannot impersonate a browser identity or retain disabled dimension data', async () => {
  const fixture = apiClient();
  const browser = identity('2026-10-13T10:00:00Z');
  const input = { eventId: randomUUID(), name: 'signup', url: 'https://site.example/welcome?private-query-sentinel#private-hash-sentinel',
    context: browser.context, properties: { plan: 'basic' }, dimensions: {
      distinctId: 'private-distinct-sentinel', referrer: 'https://private-referrer-sentinel.example/private',
      campaign: { source: 'private-campaign-sentinel' }, screen: { width: 1536, height: 864 }, language: 'en-us',
    } };
  const response = await insertApiObservation(fixture.client, projectId, input);
  assert.equal(response.accepted, true);
  assert.equal('context' in response, false);
  assert.equal(fixture.writes.length, 1);
  const values = fixture.writes[0];
  assert.equal(values[3], '/welcome');
  assert.equal(values[5], null);
  assert.equal(values[6], null);
  assert.deepEqual(JSON.parse(values[7] as string), { plan: { type: 'string', value: 'basic' } });
  assert.deepEqual(JSON.parse(values[8] as string), { language: 'en-US', origin: 'https://site.example' });
  assert.equal(values[9], 'api');
  assert.equal(values[10], 'observations-v2');
  assert.equal(values[12],null,'API ingestion never claims a browser collection basis.');
  const serialized = JSON.stringify(values);
  for (const sentinel of ['private-query-sentinel', 'private-hash-sentinel', 'private-distinct-sentinel', 'private-referrer-sentinel', 'private-campaign-sentinel', browser.context, base.ip, base.userAgent]) {
    assert.equal(serialized.includes(sentinel), false);
  }
  assert.equal(input.dimensions.distinctId, 'private-distinct-sentinel');
});

test('enabled dimension capture remains bounded and raw distinct ID is removed', async () => {
  const fixture = apiClient({ captureReferrer: true, captureCampaigns: true, captureScreen: true });
  await insertApiObservation(fixture.client, projectId, { eventId: randomUUID(), name: 'page_view', url: 'https://site.example/',
    dimensions: { referrer: 'https://referrer.example:8443/private?secret=1', campaign: { source: 'newsletter' }, screen: { width: 1000, height: 800 }, distinctId: 'private-distinct-sentinel' } });
  assert.deepEqual(JSON.parse(fixture.writes[0][8] as string), {
    origin: 'https://site.example', referrerHost: 'referrer.example', campaign: { source: 'newsletter' }, screenWidth: 1000, screenHeight: 800,
  });
});

test('disabled/excluded API observations write nothing, and duplicates return no context', async () => {
  for (const settings of [{ enabled: false }, { excludedPaths: ['/private'] }]) {
    const fixture = apiClient(settings);
    const response = await insertApiObservation(fixture.client, projectId, { eventId: randomUUID(), name: 'page_view', url: 'https://site.example/private' });
    assert.equal(response.accepted, false);
    assert.equal(fixture.writes.length, 0);
  }
  const fixture = apiClient({}, false);
  const response = await insertApiObservation(fixture.client, projectId, { eventId: randomUUID(), name: 'page_view', url: 'https://site.example/' });
  assert.deepEqual(response, { accepted: true, duplicate: true });
});

test('API observation normalization distinguishes omitted fields from explicit null', async () => {
  for (const fields of [{ properties: null }, { dimensions: null }]) {
    const fixture = apiClient();
    await assert.rejects(insertApiObservation(fixture.client, projectId, {
      eventId: randomUUID(), name: 'page_view', url: 'https://site.example/', ...fields,
    }), (error: unknown) => error instanceof InputError && error.status === 400);
    assert.equal(fixture.writes.length, 0);
  }
});
