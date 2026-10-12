import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/destinations.js', import.meta.url), 'utf8');
const siteKey = '11111111-1111-4111-8111-111111111111';
const epoch = '22222222-2222-4222-8222-222222222222';
const revision = '33333333-3333-4333-8333-333333333333';
const full = { analytics: true, advertising: true, adUserData: true, adPersonalization: true };
const none = { analytics: false, advertising: false, adUserData: false, adPersonalization: false };
const options = { siteKey, environment: 'live', acknowledgeReload: true };
const assets: Record<string, string> = { meta: '123', ga4: 'G-TEST1234', google_ads: 'AW-123', cloudflare: 'a'.repeat(32),
  tiktok: 'TESTABC12345', linkedin: '123', microsoft_ads: '123', pinterest: '123', snapchat: epoch, x: 'pixel1' };
const dynamic: Record<string, string> = { google_ads: 'label_1', linkedin: '12345', x: 'tw-pixel1-event1' };
function destination(provider: string, name = 'purchase') {
  return { provider, assetId: assets[provider], enabled: true, owner: 'managed', ownershipConfirmed: true,
    mappings: [{ event: name, ...(dynamic[provider] ? { target: dynamic[provider] } : {}) }] };
}
const purchase = () => ({ name: 'purchase', eventId: randomUUID(), url: 'https://site.example/shop?private=hidden#secret',
  properties: { value: '49.95', currency: 'USD', transactionId: 'order-1', itemId: 'item-1' } });

async function fixture(destinations: unknown[], settings: { saved?: boolean; privacy?: boolean; dnt?: string; failStorage?: boolean; pageAge?: number; consentMode?: 'builtin' | 'external' } = {}) {
  let now = Date.now(), nextTimer = 1, fetchFail = false, failStorage = !!settings.failStorage;
  const storage = new Map<string, string>(), actions: string[] = [], scripts: any[] = [], calls: any[][] = [], requests: any[] = [];
  const listeners: Record<string, Function> = {}, timers = new Map<number, { at: number; callback: Function; interval?: number }>();
  let config: any = { schemaVersion: 2, siteKey, environment: 'live', origin: 'https://site.example', revisionId: revision,
    consentEpoch: epoch, configuration: { destinations }, nativeTracking: { enabled: true, consentMode: settings.consentMode ?? 'external',
      captureReferrer: false, captureCampaigns: false, captureScreen: false, excludeBots: true, excludedPaths: [] } };
  const storageKey = `ten98:consent:v1:https://monitor.example:${siteKey}:live`;
  if (settings.saved) storage.set(storageKey, JSON.stringify({ epoch, choice: full, updatedAt: now - 1000, expiresAt: now + 86400000 }));
  class Clock extends Date { static now() { return now; } }
  function timer(callback: Function, delay: number, interval?: number) { const id = nextTimer++; timers.set(id, { at: now + delay, callback, interval }); return id; }
  function element(tag: string): any {
    return { tag, children: [], attributes: {}, style: {}, handlers: {}, removed: false, closed: false, textContent: '', checked: false, disabled: false,
      setAttribute(key: string, value: string) { this.attributes[key] = value; },
      appendChild(child: any) { this.children.push(child); return child; },
      addEventListener(name: string, fn: Function) { this.handlers[name] = fn; }, remove() { this.removed = true; }, focus() {}, showModal() {}, close() { this.closed = true; } };
  }
  const document: any = { createElement: element, createTextNode: (text: string) => ({ textContent: text }),
    querySelectorAll: () => scripts, body: element('body'), activeElement: { focus() {} },
    head: { appendChild(script: any) { scripts.push(script); return script; } } };
  Object.defineProperty(document, 'cookie', { get() { throw new Error('Cookie access forbidden'); } });
  const context: any = { document, navigator: { globalPrivacyControl: !!settings.privacy, doNotTrack: settings.dnt },
    location: { origin: 'https://site.example', pathname: '/shop', reload() { actions.push('reload'); }, replace(url: string) { actions.push(url); } },
    Date: Clock, URL, Intl, AbortController, crypto: { randomUUID }, performance: { timeOrigin: now - (settings.pageAge || 0) },
    setTimeout: (fn: Function, delay: number) => timer(fn, delay), clearTimeout: (id: number) => timers.delete(id),
    setInterval: (fn: Function, delay: number) => timer(fn, delay, delay),
    localStorage: { getItem: (key: string) => storage.get(key) ?? null,
      setItem(key: string, value: string) { actions.push('save'); if (failStorage) throw new Error('Storage blocked'); storage.set(key, value); },
      removeItem(key: string) { actions.push('remove'); if (failStorage) throw new Error('Storage blocked'); storage.delete(key); } },
    addEventListener: (name: string, fn: Function) => { listeners[name] = fn; },
    CustomEvent: class { type: string; detail: unknown; constructor(type: string, options: any) { this.type = type; this.detail = options.detail; } },
    dispatchEvent: (event: any) => { listeners[event.type]?.(event); },
    fetch: async (url: string, opts: any) => { requests.push({ url, opts }); if (fetchFail) throw new Error('Network unavailable');
      return { ok: true, headers: { get: () => null }, text: async () => JSON.stringify({ ...config, validUntil: new Date(now + 60000).toISOString() }) }; } };
  context.window = context;
  vm.createContext(context);
  const local = (value: unknown) => vm.runInContext(`JSON.parse(${JSON.stringify(JSON.stringify(value))})`, context);
  const site = local({ endpoint: 'https://monitor.example/api/collect', siteKey, environment: 'live' });
  context.__ten98FoundationHub = { sites: [site], api: { track() {} } }; context.ten98 = context.__ten98FoundationHub.api;
  const drain = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
  vm.runInContext(source, context); await drain();
  function event(value: unknown) { context.__ten98FoundationHub.destinationEvent(site, local(value)); }
  function grant(value = full, opts = options) { return context.ten98.consent(local(value), local(opts)); }
  function status(opts = options) { return JSON.parse(JSON.stringify(context.ten98.destinationStatus(local(opts)))); }
  async function load(script: any, fail = false) {
    if (fail) { script.onerror?.(); await drain(); return; }
    const spy = (name: string) => (...args: any[]) => calls.push([name, ...JSON.parse(JSON.stringify(args))]);
    if (script.src.includes('fbevents')) context.fbq.callMethod = spy('meta');
    if (script.src.includes('tiktok')) for (const method of ['page', 'track', 'grantConsent', 'revokeConsent']) context.ttq[method] = spy(`tiktok.${method}`);
    if (script.src.includes('licdn')) context.lintrk = spy('linkedin');
    if (script.src.includes('bat.bing')) context.UET = function (opts: any) { calls.push(['UET.init', JSON.parse(JSON.stringify(opts))]); return { push: spy('uet') }; };
    if (script.src.includes('pinimg')) context.pintrk = spy('pinterest');
    if (script.src.includes('scevent')) context.snaptr.handleRequest = spy('snapchat');
    if (script.src.includes('ads-twitter')) context.twq.exe = spy('x');
    script.onload?.(); await drain();
  }
  async function tick(ms: number) {
    const end = now + ms;
    while (true) {
      const item = [...timers.entries()].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!item) break;
      now = item[1].at; timers.delete(item[0]); if (item[1].interval) timers.set(item[0], { ...item[1], at: now + item[1].interval });
      item[1].callback(); await drain();
    }
    now = end; await drain();
  }
  return { context, site, local, storage, storageKey, actions, scripts, calls, requests, event, grant, status, load, tick, drain,
    fetchFailure: () => { fetchFail = true; }, storageFailure: () => { failStorage = true; }, changeConfig: (value: any) => { config = value; }, config: () => config, clock: () => now,
    storageEvent: (value: unknown) => listeners.storage({ key: storageKey, newValue: JSON.stringify(value) }), rerun: () => vm.runInContext(source, context) };
}

test('unknown consent discards history, grant requires acknowledgement, and duplicate installation is inert', async () => {
  const f = await fixture([destination('meta')]);
  f.event(purchase()); assert.equal(f.scripts.length, 0);
  assert.equal(f.grant(full, { ...options, acknowledgeReload: false }).ok, false);
  assert.equal(f.grant().ok, true); assert.equal(f.scripts.length, 0, 'A new grant must not replay old events.');
  f.rerun(); assert.equal(f.requests.length, 1);
  const event = purchase(); f.event(event); f.event(event); assert.equal(f.scripts.length, 1);
  await f.load(f.scripts[0]); assert.equal(f.calls.filter(c => c[1] === 'trackSingle').length, 1);
  assert.equal(f.status().routes[0].state, 'invoked');
  assert.equal(JSON.stringify(f.calls).includes('private=hidden'), false);
  assert.equal(f.requests[0].opts.credentials, 'omit'); assert.equal(f.requests[0].opts.referrerPolicy, 'no-referrer');
  assert.equal(f.requests[0].opts.redirect, 'error'); assert.equal(f.scripts[0].referrerPolicy, 'no-referrer');
});

test('all ten providers map original events using their bounded native contracts; Google shares one SDK', async () => {
  const configs = Object.keys(assets).map(p => destination(p, p === 'cloudflare' ? 'page_view' : 'purchase'));
  const f = await fixture(configs); f.grant(); const event = purchase(); f.event(event);
  f.event({ name: 'page_view', eventId: randomUUID(), url: 'https://site.example/path?q=secret' });
  assert.equal(f.scripts.length, 9);
  for (const script of f.scripts) await f.load(script);
  assert.equal(f.calls.find(c => c[1] === 'trackSingle')?.[3], 'Purchase');
  assert.equal(f.calls.find(c => c[0] === 'tiktok.track')?.[1], 'Purchase');
  assert.equal(f.calls.find(c => c[0] === 'linkedin')?.[2].conversion_id, 12345);
  assert.equal(f.calls.find(c => c[0] === 'uet')?.[2], 'purchase');
  assert.equal(f.calls.find(c => c[0] === 'pinterest' && c[1] === 'track')?.[2], 'checkout');
  assert.equal(f.calls.find(c => c[0] === 'snapchat' && c[1] === 'track')?.[2], 'PURCHASE');
  assert.equal(f.calls.find(c => c[0] === 'x' && c[1] === 'event')?.[2], 'tw-pixel1-event1');
  const google = Array.from(f.context.ten98DataLayer, (args: any) => Array.from(args)) as any[][];
  assert.equal(google.filter(c => c[0] === 'config').length, 2);
  assert.equal(google.filter(c => c[0] === 'event').length, 2);
  assert.equal(google.find(c => c[0] === 'event' && c[1] === 'conversion')?.[2].send_to, 'AW-123/label_1');
  const cf = f.scripts.find(s => s.src.includes('cloudflare'));
  assert.equal(cf.attributes.type, 'module'); assert.equal(JSON.parse(cf.attributes['data-cf-beacon']).spa, true);
  assert.equal(f.status().routes.find((r: any) => r.provider === 'cloudflare').state, 'ready');
  assert.equal(f.calls.find(c => c[0] === 'snapchat' && c[1] === 'track')?.[3].price, '49.95');
});

test('withdrawal persists denial before reload and ignores all later events', async () => {
  const f = await fixture([destination('meta')]); f.grant(); f.event(purchase()); await f.load(f.scripts[0]);
  const before = f.calls.length; const result = f.grant(none);
  assert.equal(result.reloadRequired, true); assert.deepEqual(f.actions.slice(-2), ['save', 'reload']);
  assert.equal(JSON.parse(f.storage.get(f.storageKey)!).choice.advertising, false);
  f.event(purchase()); assert.equal(f.calls.length, before + 1, 'Only the best-effort Meta revoke call was added.');
  assert.equal(f.status().ready, false); assert.equal(f.status().routes[0].state, 'reload_required');
});

test('storage failure never claims loaded SDKs stopped or restores a failed grant', async () => {
  const f = await fixture([destination('meta')]); f.grant(); f.event(purchase()); await f.load(f.scripts[0]); f.storageFailure();
  const result = f.grant(none); assert.equal(result.ok, false); assert.match(result.reason, /close this page/i);
  assert.equal(f.actions.includes('reload'), false, 'Do not reload into an old stored grant after both storage operations fail.');
  assert.ok(f.actions.includes('about:blank#ten98-consent-storage-unavailable'), 'Leave the executing SDK document if denial cannot persist.');
  assert.match(f.status().routes[0].reason, /Withdrawal not applied/);
  const blocked = await fixture([destination('meta', 'page_view')], { saved: true, failStorage: true });
  assert.equal(blocked.scripts.length, 0); assert.deepEqual(blocked.status().consent, none);
});

test('matching stored consent takes a fresh current-page observation and config revisions force fresh consent', async () => {
  const f = await fixture([destination('ga4', 'page_view')], { saved: true }); assert.equal(f.scripts.length, 1);
  const record = JSON.parse(f.storage.get(f.storageKey)!);
  assert.equal(record.updatedAt, f.clock() - 1000, 'Restoration must preserve the affirmative choice timestamp.');
  assert.equal(record.expiresAt, f.clock() + 86400000, 'Restoration must not renew consent expiry.');
  await f.load(f.scripts[0]); const google = Array.from(f.context.ten98DataLayer, (v: any) => Array.from(v)) as any[][];
  assert.equal(google.filter(c => c[0] === 'event').length, 1); assert.equal(google.find(c => c[0] === 'event')?.[2].page_location, 'https://site.example/shop');
  f.changeConfig({ ...f.config(), revisionId: randomUUID(), consentEpoch: randomUUID() }); await f.tick(30000);
  assert.equal(f.actions.filter(a => a === 'reload').length, 1); assert.deepEqual(f.status().consent, none);
});

test('consent written after this navigation began is not restored during asynchronous loader startup', async () => {
  const f = await fixture([destination('meta', 'page_view')], { saved: true, pageAge: 2000 });
  assert.equal(f.scripts.length, 0); assert.deepEqual(f.status().consent, none);
});

test('an open built-in dialog cannot authorize a changed publication or an external consent interface', async () => {
  for (const change of ['publication', 'external']) {
    const f = await fixture([destination('meta')], { consentMode: 'builtin' });
    assert.equal(f.context.ten98.consentPreferences(f.local(options)), true);
    const dialog = f.context.document.body.children.find((node: any) => node.tag === 'dialog');
    for (const label of dialog.children.filter((node: any) => node.tag === 'label')) label.children[0].checked = true;
    const staleSave = dialog.children.find((node: any) => node.textContent === 'Save choices').handlers.click;
    const next = { ...f.config() };
    if (change === 'publication') {
      next.revisionId = randomUUID(); next.consentEpoch = randomUUID();
      next.configuration = { destinations: [{ ...destination('meta'), assetId: '456' }] };
    } else next.nativeTracking = { ...next.nativeTracking, consentMode: 'external' };
    f.changeConfig(next); await f.tick(30000);
    assert.equal(dialog.closed, true); assert.equal(dialog.removed, true);
    staleSave(); f.event(purchase()); await f.drain();
    assert.deepEqual(f.status().consent, none, 'A callback from the old dialog must not grant the current configuration.');
    assert.equal(f.scripts.length, 0);
  }
});

test('GPC and DNT veto both new and restored grants before any SDK loads', async () => {
  for (const settings of [{ privacy: true }, { dnt: '1' }, { dnt: 'yes' }]) {
    const f = await fixture([destination('meta', 'page_view')], { ...settings, saved: true });
    f.grant(); f.event({ name: 'page_view', eventId: randomUUID(), url: 'https://site.example/' });
    assert.equal(f.scripts.length, 0); assert.deepEqual(f.status().consent, none);
  }
});

test('external ownership and foreign SDK globals are never taken over', async () => {
  const d = destination('meta'); d.owner = 'external';
  const f = await fixture([d]); f.grant(); f.event(purchase()); assert.equal(f.scripts.length, 0);
  const other = await fixture([destination('meta')]); const foreign = () => {}; other.context.fbq = foreign;
  other.grant(); other.event(purchase()); await other.drain(); assert.equal(other.scripts.length, 0); assert.equal(other.context.fbq, foreign);
  assert.equal(other.status().routes[0].state, 'blocked_or_failed');
});

test('invalid and unsupported event properties never initialize vendor SDKs', async () => {
  const f = await fixture([destination('meta'), destination('cloudflare', 'page_view')]); f.grant();
  for (const e of [{ ...purchase(), name: 'arbitrary' }, { ...purchase(), properties: { email: 'not-forwarded@example.test' } },
    { ...purchase(), properties: { value: '01', currency: 'USD', transactionId: 'x' } }, { ...purchase(), url: 'https://elsewhere.example/' },
    { ...purchase(), eventId: 'invalid' }, { ...purchase(), properties: { value: '1', currency: 'USD', transactionId: 'x\n' } }]) f.event(e);
  assert.equal(f.scripts.length, 0);
  f.event({ ...purchase(), name: 'refund' }); assert.equal(f.scripts.length, 0);
});

test('config expiry, failed loads and TTL drops never retry buffered events', async () => {
  const f = await fixture([destination('meta')]); f.grant(); f.event(purchase()); const script = f.scripts[0];
  await f.tick(10000); await f.load(script); assert.equal(f.calls.some(c => c[1] === 'trackSingle'), false);
  f.event(purchase()); assert.equal(f.scripts.length, 1); assert.equal(f.status().routes[0].state, 'blocked_or_failed');
  const active = await fixture([destination('meta')]); active.grant(); active.event(purchase()); await active.load(active.scripts[0]); active.fetchFailure();
  await active.tick(60000); assert.equal(active.status().ready, false); assert.equal(active.actions.filter(a => a === 'reload').length, 1);
});

test('readiness queue is capped, event IDs deduplicate, and storage expansion does not silently grant', async () => {
  const f = await fixture([destination('meta')]); f.grant(); for (let i = 0; i < 25; i++) f.event(purchase());
  await f.load(f.scripts[0]); assert.equal(f.calls.filter(c => c[1] === 'trackSingle').length, 20);
  const denied = await fixture([destination('meta')]);
  denied.storageEvent({ epoch, choice: full, updatedAt: Date.now(), expiresAt: Date.now() + 10000 });
  denied.event(purchase()); assert.equal(denied.scripts.length, 0);
  f.storageEvent({ epoch, choice: none, updatedAt: Date.now(), expiresAt: Date.now() + 10000 });
  assert.equal(f.status().ready, false); assert.equal(f.actions.includes('reload'), true);
});

test('public response strict shape and exact site origin are checked before grant', async () => {
  const f = await fixture([]); f.changeConfig({ ...f.config(), apiSecret: 'must-never-appear' }); await f.tick(30000);
  assert.equal(f.status().revisionId, revision, 'A failed refresh retains only the still-valid prior config.');
  f.changeConfig({ ...f.config(), origin: 'https://elsewhere.example' }); await f.tick(30000);
  assert.equal(f.status().ready, false);
});

test('a second environment cannot take over an already owned vendor SDK', async () => {
  const f = await fixture([destination('meta')]); f.grant(); f.event(purchase()); await f.load(f.scripts[0]);
  f.changeConfig({ ...f.config(), environment: 'test' });
  const second = f.local({ endpoint: 'https://monitor.example/api/collect', siteKey, environment: 'test' });
  f.context.__ten98FoundationHub.destinationInit(second); await f.drain();
  const testOptions = { ...options, environment: 'test' }; assert.equal(f.grant(full, testOptions).ok, true);
  f.context.__ten98FoundationHub.destinationEvent(second, f.local(purchase())); await f.drain();
  assert.equal(f.scripts.length, 1); assert.equal(f.status(testOptions).routes[0].state, 'blocked_or_failed');
});
