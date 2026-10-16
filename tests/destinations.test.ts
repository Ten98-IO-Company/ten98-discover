import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CANONICAL_EVENTS,
  catalog,
  parseDestinationConfiguration,
  parseDestinationEvent,
  previewConfiguration,
  type CanonicalEvent,
} from '../src/server/destinations.ts';

const ASSETS: Record<string, string> = {
  meta: '123456789012345',
  ga4: 'G-ABC123XYZ9',
  google_ads: 'AW-123456789',
  cloudflare: '0123456789abcdef0123456789abcdef',
  tiktok: 'C4T4L0GEXAMPLE1',
  linkedin: '123456',
  microsoft_ads: '98765432',
  pinterest: '76543210',
  snapchat: '123e4567-e89b-12d3-a456-426614174000',
  x: 'pixel123',
};

function destination(provider: string, overrides: Record<string, unknown> = {}) {
  return {
    provider,
    assetId: ASSETS[provider],
    enabled: true,
    owner: 'managed',
    ownershipConfirmed: true,
    mappings: [] as unknown[],
    ...overrides,
  };
}

function configOf(...destinations: unknown[]) {
  return {destinations};
}

const NO_CONSENT = {analytics: false, advertising: false, adUserData: false, adPersonalization: false};
const FULL_CONSENT = {analytics: true, advertising: true, adUserData: true, adPersonalization: true};
const PURCHASE_PROPS = {value: '99.99', currency: 'USD', transactionId: 'txn-secret-1'};

function assert400(fn: () => unknown) {
  assert.throws(fn, (error: unknown) => {
    const e = error as {status?: number; message?: string};
    return e?.status === 400 && typeof e?.message === 'string' && e.message.length > 0;
  });
}

test('catalog lists all ten providers with events, purposes and notes', () => {
  assert.equal(catalog.length, 10);
  for (const provider of ['meta', 'ga4', 'google_ads', 'cloudflare', 'tiktok', 'linkedin', 'microsoft_ads', 'pinterest', 'snapchat', 'x']) {
    const entry = catalog.find(c => c.provider === provider);
    assert.ok(entry, provider);
    assert.ok(entry.assetPattern.length > 0);
    assert.ok(entry.purposes.length > 0);
    assert.ok(entry.notes.length > 0);
    assert.ok(entry.events.length > 0);
  }
  assert.deepEqual(catalog.find(c => c.provider === 'cloudflare')!.events.map(e => e.event), ['page_view']);
  assert.equal(catalog.find(c => c.provider === 'ga4')!.events.length, 8);
  assert.ok(!catalog.find(c => c.provider === 'meta')!.events.some(e => e.event === 'refund'));
  assert.ok(catalog.find(c => c.provider === 'google_ads')!.events.every(e => e.targetRequired && e.target === 'conversion'));
  assert.equal(catalog.find(c => c.provider === 'tiktok')!.events.find(e => e.event === 'purchase')!.target, 'Purchase');
  assert.equal(catalog.find(c => c.provider === 'tiktok')!.events.find(e => e.event === 'generate_lead')!.target, 'Lead');
  assert.equal(catalog.find(c => c.provider === 'pinterest')!.events.find(e => e.event === 'purchase')!.target, 'checkout');
  assert.equal(catalog.find(c => c.provider === 'snapchat')!.events.find(e => e.event === 'begin_checkout')!.target, 'START_CHECKOUT');
});

test('fixed preset mapping parses and rejects user-supplied targets', () => {
  const ok = parseDestinationConfiguration(configOf(destination('meta', {mappings: [{event: 'purchase'}]})));
  assert.equal(ok.destinations[0].mappings[0].event, 'purchase');
  assert400(() => parseDestinationConfiguration(configOf(destination('meta', {mappings: [{event: 'purchase', target: 'CustomEvent'}]}))));
  assert400(() => parseDestinationConfiguration(configOf(destination('cloudflare', {mappings: [{event: 'page_view', target: 'track'}]}))));
});

test('fixed presets reject unsupported events and custom events', () => {
  assert400(() => parseDestinationConfiguration(configOf(destination('meta', {mappings: [{event: 'refund'}]}))));
  assert400(() => parseDestinationConfiguration(configOf(destination('cloudflare', {mappings: [{event: 'sign_up'}]}))));
  assert400(() => parseDestinationConfiguration(configOf(destination('cloudflare', {mappings: [{event: 'refund'}]}))));
  assert400(() => parseDestinationConfiguration(configOf(destination('snapchat', {mappings: [{event: 'generate_lead'}]}))));
  assert400(() => parseDestinationConfiguration(configOf(destination('x', {mappings: [{event: 'refund', target: 'tw-pixel123-refund'}]}))));
  assert400(() => parseDestinationConfiguration(configOf(destination('meta', {mappings: [{event: 'my_custom_event'}]}))));
});

test('google_ads requires a safe conversion label target', () => {
  assert400(() => parseDestinationConfiguration(configOf(destination('google_ads', {mappings: [{event: 'purchase'}]}))));
  assert400(() => parseDestinationConfiguration(configOf(destination('google_ads', {mappings: [{event: 'purchase', target: 'bad label!'}]}))));
  assert400(() => parseDestinationConfiguration(configOf(destination('google_ads', {mappings: [{event: 'purchase', target: '<script>alert(1)</script>'}]}))));
  assert400(() => parseDestinationConfiguration(configOf(destination('google_ads', {mappings: [{event: 'page_view', target: 'label'}]}))));
  const ok = parseDestinationConfiguration(configOf(destination('google_ads', {mappings: [{event: 'purchase', target: 'abc-DEF_0123'}]})));
  assert.equal(ok.destinations[0].mappings[0].target, 'abc-DEF_0123');
});

test('linkedin requires a positive safe-integer conversion rule id', () => {
  for (const target of ['0', '000', '9007199254740993', '12 34', 'abc', '-5']) {
    assert400(() => parseDestinationConfiguration(configOf(destination('linkedin', {mappings: [{event: 'generate_lead', target}]}))));
  }
  assert400(() => parseDestinationConfiguration(configOf(destination('linkedin', {mappings: [{event: 'page_view', target: '12345'}]}))));
  assert.ok(parseDestinationConfiguration(configOf(destination('linkedin', {mappings: [{event: 'generate_lead', target: '987654321'}]}))));
});

test('x target must be tw-<assetId>-<event> on the same asset', () => {
  assert400(() => parseDestinationConfiguration(configOf(destination('x', {mappings: [{event: 'purchase', target: 'tw-other456-purchase'}]}))));
  assert400(() => parseDestinationConfiguration(configOf(destination('x', {mappings: [{event: 'purchase', target: 'tw-pixel123-<script>'}]}))));
  assert400(() => parseDestinationConfiguration(configOf(destination('x', {mappings: [{event: 'purchase', target: 'Purchase'}]}))));
  assert400(() => parseDestinationConfiguration(configOf(destination('x', {mappings: [{event: 'purchase'}]}))));
  assert.ok(parseDestinationConfiguration(configOf(destination('x', {mappings: [{event: 'purchase', target: 'tw-pixel123-purchase'}]}))));
});

test('structure limits, uniqueness and strict objects', () => {
  assert400(() => parseDestinationConfiguration(configOf(destination('meta'), destination('meta', {assetId: '999'}))));
  assert400(() => parseDestinationConfiguration(configOf(destination('meta', {mappings: [{event: 'page_view'}, {event: 'page_view'}]}))));
  assert400(() => parseDestinationConfiguration(configOf(...Array.from({length: 11}, (_, i) => destination('meta', {assetId: String(i + 1)})))));
  assert400(() => parseDestinationConfiguration({destinations: [], extra: true}));
  assert400(() => parseDestinationConfiguration(configOf({...destination('meta'), apiSecret: 'shhh'})));
  assert400(() => parseDestinationConfiguration(configOf(destination('meta', {mappings: [{event: 'page_view', secret: 'x'}]}))));
  assert400(() => parseDestinationConfiguration({destinations: 'nope'}));
  assert.equal(parseDestinationConfiguration(configOf()).destinations.length, 0);
});

test('public configuration served by /api/tracking-config admits only public identifiers for every provider', () => {
  // getPublicDestinations serves this parse verbatim (src/server/destinations.ts:542), so every admitted field is public: refuse
  // credential-shaped fields on every provider and pin the field set, so a credential or server-side key cannot be admitted unnoticed.
  for (const c of catalog) for (const key of ['accessToken', 'serverKey']) assert400(() => parseDestinationConfiguration(configOf(destination(c.provider, {[key]: 'live-secret-value'}))));
  const target: Record<string, (event: CanonicalEvent) => string> = {google_ads: e => `label_${e}`, linkedin: e => String(CANONICAL_EVENTS.indexOf(e) + 1), x: e => `tw-pixel123-${e.replace(/_/g, '')}`};
  const mappings = (provider: string, events: {event: CanonicalEvent}[]) => events.map(({event}) => ({event, ...(target[provider] ? {target: target[provider](event)} : {})}));
  const served = parseDestinationConfiguration(configOf(...catalog.map(c => destination(c.provider, {mappings: mappings(c.provider, c.events)}))));
  assert.deepEqual(Object.keys(served), ['destinations']);
  for (const {provider, events} of catalog) {
    const d = served.destinations.find(x => x.provider === provider)!;
    assert.deepEqual(Object.keys(d).sort(), ['assetId', 'enabled', 'mappings', 'owner', 'ownershipConfirmed', 'provider'], provider);
    assert.equal(d.assetId, ASSETS[provider]);
    assert.deepEqual(d.mappings, mappings(provider, events), provider);
  }
});

test('asset id formats are strict and whitespace-free', () => {
  assert400(() => parseDestinationConfiguration(configOf(destination('ga4', {assetId: 'g-abc123'}))));
  assert400(() => parseDestinationConfiguration(configOf(destination('snapchat', {assetId: 'not-a-uuid'}))));
  assert400(() => parseDestinationConfiguration(configOf(destination('meta', {assetId: '123 456'}))));
  assert400(() => parseDestinationConfiguration(configOf(destination('meta', {assetId: '123\n456'}))));
  assert400(() => parseDestinationConfiguration(configOf(destination('cloudflare', {assetId: 'z'.repeat(32)}))));
  assert400(() => parseDestinationConfiguration(configOf(destination('linkedin', {assetId: '0'}))));
  assert400(() => parseDestinationConfiguration(configOf(destination('tiktok', {assetId: 'short'}))));
});

test('validation errors are friendly and never echo input', () => {
  try {
    parseDestinationConfiguration(configOf(destination('meta', {assetId: 'SECRET<script>'})));
    assert.fail('should have thrown');
  } catch (error) {
    const e = error as {status: number; message: string};
    assert.equal(e.status, 400);
    assert.ok(!e.message.includes('SECRET'), e.message);
    assert.ok(!e.message.includes('<script>'), e.message);
  }
});

test('event properties are strict, safe and paired', () => {
  assert400(() => parseDestinationEvent({name: 'page_view', properties: {email: 'a@b.c'}}));
  assert400(() => parseDestinationEvent({name: 'page_view', properties: {script: '<script>alert(1)</script>'}}));
  assert400(() => parseDestinationEvent({name: 'page_view', properties: {nested: {a: 1}}}));
  assert400(() => parseDestinationEvent({name: 'page_view', properties: {url: 'https://evil.example'}}));
  assert400(() => parseDestinationEvent({name: 'page_view', properties: {value: 'abc', currency: 'USD'}}));
  assert400(() => parseDestinationEvent({name: 'page_view', properties: {value: '1.1234567', currency: 'USD'}}));
  assert400(() => parseDestinationEvent({name: 'page_view', properties: {value: '2000000', currency: 'USD'}}));
  assert400(() => parseDestinationEvent({name: 'page_view', properties: {value: '-1', currency: 'USD'}}));
  assert400(() => parseDestinationEvent({name: 'page_view', properties: {value: '10', currency: 'usd'}}));
  assert400(() => parseDestinationEvent({name: 'page_view', properties: {value: '10', currency: 'XXX'}}));
  assert400(() => parseDestinationEvent({name: 'page_view', properties: {value: '10', currency: 'XTS'}}));
  assert400(() => parseDestinationEvent({name: 'page_view', properties: {value: '10', currency: 'ZZZ'}}));
  assert400(() => parseDestinationEvent({name: 'page_view', properties: {value: '10'}}));
  assert400(() => parseDestinationEvent({name: 'page_view', properties: {currency: 'USD'}}));
  assert400(() => parseDestinationEvent({name: 'page_view', properties: {transactionId: 'has space'}}));
  assert400(() => parseDestinationEvent({name: 'page_view', properties: {itemId: 'x'.repeat(129)}}));
  assert400(() => parseDestinationEvent({name: 'page_view', unexpected: true}));
  const ok = parseDestinationEvent({name: 'view_item', properties: {value: '0.000001', currency: 'EUR', itemId: 'sku:1-2_3.4'}});
  assert.equal(ok.name, 'view_item');
});

test('purchase and refund require value, currency and transactionId', () => {
  assert400(() => parseDestinationEvent({name: 'purchase'}));
  assert400(() => parseDestinationEvent({name: 'purchase', properties: {value: '10', currency: 'USD'}}));
  assert400(() => parseDestinationEvent({name: 'purchase', properties: {transactionId: 't1'}}));
  assert400(() => parseDestinationEvent({name: 'refund', properties: {transactionId: 't1'}}));
  assert.ok(parseDestinationEvent({name: 'purchase', properties: PURCHASE_PROPS}));
  assert.ok(parseDestinationEvent({name: 'refund', properties: PURCHASE_PROPS}));
});

test('preview would_invoke returns preset target and field names only', () => {
  const result = previewConfiguration(
    configOf(destination('meta', {mappings: [{event: 'purchase'}]})),
    {name: 'purchase', properties: PURCHASE_PROPS},
    {...NO_CONSENT, advertising: true},
  );
  assert.equal(result.dryRun, true);
  assert.equal(result.event, 'purchase');
  assert.equal(result.routes.length, 1);
  const route = result.routes[0];
  assert.equal(route.status, 'would_invoke');
  assert.equal(route.target, 'Purchase');
  assert.deepEqual(route.fields, ['currency', 'transactionId', 'value']);
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes('99.99'));
  assert.ok(!serialized.includes('txn-secret-1'));
});

test('preview dry-run statuses: consent_blocked, external, disabled, unsupported', () => {
  const purchase = {name: 'purchase', properties: PURCHASE_PROPS};
  const blocked = previewConfiguration(configOf(destination('meta', {mappings: [{event: 'purchase'}]})), purchase, NO_CONSENT);
  assert.equal(blocked.routes[0].status, 'consent_blocked');
  assert.equal(blocked.routes[0].target, null);
  const external = previewConfiguration(configOf(destination('meta', {owner: 'external', ownershipConfirmed: false, mappings: [{event: 'purchase'}]})), purchase, FULL_CONSENT);
  assert.equal(external.routes[0].status, 'external');
  const disabled = previewConfiguration(configOf(destination('meta', {enabled: false, mappings: [{event: 'purchase'}]})), purchase, FULL_CONSENT);
  assert.equal(disabled.routes[0].status, 'disabled');
  const unsupported = previewConfiguration(configOf(destination('meta', {mappings: [{event: 'purchase'}]})), {name: 'refund', properties: PURCHASE_PROPS}, FULL_CONSENT);
  assert.equal(unsupported.routes[0].status, 'unsupported');
  const unmapped = previewConfiguration(configOf(destination('meta', {mappings: []})), {name: 'page_view'}, FULL_CONSENT);
  assert.equal(unmapped.routes[0].status, 'unsupported');
});

test('google consent purposes are enforced independently', () => {
  const purchase = {name: 'purchase', properties: PURCHASE_PROPS};
  const ads = configOf(destination('google_ads', {mappings: [{event: 'purchase', target: 'label-1'}]}));
  assert.equal(previewConfiguration(ads, purchase, {...NO_CONSENT, advertising: true}).routes[0].status, 'consent_blocked');
  assert.equal(previewConfiguration(ads, purchase, {...NO_CONSENT, advertising: true, adUserData: true}).routes[0].status, 'would_invoke');
  const ga4 = configOf(destination('ga4', {mappings: [{event: 'page_view'}]}));
  assert.equal(previewConfiguration(ga4, {name: 'page_view'}, {...NO_CONSENT, advertising: true, adUserData: true}).routes[0].status, 'consent_blocked');
  assert.equal(previewConfiguration(ga4, {name: 'page_view'}, {...NO_CONSENT, analytics: true}).routes[0].status, 'would_invoke');
});

test('cloudflare routes page_view to sdk_pageview only', () => {
  const result = previewConfiguration(
    configOf(destination('cloudflare', {mappings: [{event: 'page_view'}]})),
    {name: 'page_view'},
    {...NO_CONSENT, analytics: true},
  );
  assert.equal(result.routes[0].status, 'would_invoke');
  assert.equal(result.routes[0].target, 'sdk_pageview');
});

test('dynamic targets appear as route targets', () => {
  const result = previewConfiguration(
    configOf(
      destination('google_ads', {mappings: [{event: 'purchase', target: 'lbl_1-2'}]}),
      destination('x', {mappings: [{event: 'purchase', target: 'tw-pixel123-purchase'}]}),
    ),
    {name: 'purchase', properties: PURCHASE_PROPS},
    {...NO_CONSENT, advertising: true, adUserData: true},
  );
  assert.equal(result.routes.length, 2);
  assert.equal(result.routes[0].target, 'lbl_1-2');
  assert.equal(result.routes[1].target, 'tw-pixel123-purchase');
});

test('full identifiers reject trailing newlines and money is canonical decimal text', () => {
  for (const provider of Object.keys(ASSETS)) {
    assert400(() => parseDestinationConfiguration(configOf(destination(provider, {assetId: `${ASSETS[provider]}\n`}))));
  }
  for (const [provider, target] of [['google_ads', 'label\n'], ['linkedin', '123\n'], ['x', 'tw-pixel123-buy\n']]) {
    assert400(() => parseDestinationConfiguration(configOf(destination(provider, {mappings: [{event: 'purchase', target}]}))));
  }
  for (const value of ['01', '00.50', '1e2', '1\n', '1000000.000001']) {
    assert400(() => parseDestinationEvent({name: 'purchase', properties: {...PURCHASE_PROPS, value}}));
  }
  for (const key of ['transactionId', 'itemId']) {
    assert400(() => parseDestinationEvent({name: 'purchase', properties: {...PURCHASE_PROPS, [key]: 'id\n'}}));
  }
  assert.ok(parseDestinationEvent({name: 'purchase', properties: {...PURCHASE_PROPS, value: '1000000.000000'}}));
});

test('consent requires all four explicit boolean purposes', () => {
  for (const consent of [undefined, null, {}, {analytics: true}, {...NO_CONSENT, advertising: 'true'}, {...NO_CONSENT, extra: false}]) {
    assert400(() => previewConfiguration(configOf(), {name: 'page_view'}, consent));
  }
});
