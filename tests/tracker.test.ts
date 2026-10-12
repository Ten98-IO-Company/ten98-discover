import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID, webcrypto } from 'node:crypto';
import vm from 'node:vm';

const SRC = readFileSync(new URL('../public/tracker.js', import.meta.url), 'utf8');
const COORDINATOR = readFileSync(new URL('../public/destinations.js', import.meta.url), 'utf8');
const SITE = '11111111-1111-4111-8111-111111111111';
const SECOND_SITE = '22222222-2222-4222-8222-222222222222';
const EPOCH = '33333333-3333-4333-8333-333333333333';
const SCRIPT_SRC = 'https://analytics.example.com/tracker.js';
const ENDPOINT = 'https://analytics.example.com/api/collect';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DENIED = { analytics: false, advertising: false, adUserData: false, adPersonalization: false };
const ANALYTICS = { ...DENIED, analytics: true };
type Payload = { name: string; eventId: string; siteKey: string; url: string; properties?: unknown;
  context?: string; consent: { analytics: boolean; epoch: string }; dimensions: Record<string, unknown> };

function makeEnv(opts: { siteKey?: string | null; scriptSrc?: string | null; environment?: string; saved?: boolean;
  pageAge?: number; privacy?: boolean; dnt?: string; failStorage?: boolean; settings?: Record<string, unknown>;
  destinations?: unknown[] } = {}) {
  const listeners = new Map<string, Array<(ev: any) => void>>(), warnings: string[] = [], scripts: any[] = [];
  const fetchCalls: Array<{ url: string; options: any }> = [], payloads: Payload[] = [];
  const historyCalls: Array<{ method: string; thisArg: unknown; args: unknown[] }> = [];
  const storage = new Map<string, string>(), timers = new Map<number, () => void>();
  const pending: Array<(result: unknown) => void> = [];
  const now = Date.now(); let timerId = 0, coordinatorLoaded = false;
  const flags = { fetchOk: true, fetchReject: false, fetchThrows: false, hold: false,
    response: { accepted: true, context: 'signed-synthetic-context' }, historyThrows: false, historyResult: undefined as unknown };
  const location = { origin: 'https://site.example', pathname: '/dashboard', search: '', hash: '',
    get href() { return this.origin + this.pathname + this.search + this.hash; }, reload() {}, replace() {} };
  const native = (method: string) => function (this: unknown, ...args: unknown[]) {
    historyCalls.push({ method, thisArg: this, args });
    if (flags.historyThrows) throw new Error('native history failure');
    if (args[2] !== undefined && args[2] !== null) {
      const u = new URL(String(args[2]), location.href);
      location.origin = u.origin; location.pathname = u.pathname; location.search = u.search; location.hash = u.hash;
    }
    return flags.historyResult;
  };
  const history = { pushState: native('pushState'), replaceState: native('replaceState') };
  const settings = { enabled: true, consentMode: 'external', captureReferrer: false, captureCampaigns: false,
    captureScreen: false, excludeBots: true, excludedPaths: [], ...opts.settings };
  const response = () => ({ ok: flags.fetchOk, text: async () => JSON.stringify(flags.response) });
  const document: any = { currentScript: null, referrer: 'https://referrer.example/path?secret=hidden#fragment',
    createElement: () => ({}), querySelectorAll: () => scripts, head: { appendChild(script: any) { scripts.push(script); return script; } },
    get cookie(): never { throw new Error('document.cookie must not be touched'); } };
  const sandbox: any = { document, history, location, URL, Intl, Date, AbortController, TextEncoder,
    crypto: { randomUUID, getRandomValues: webcrypto.getRandomValues.bind(webcrypto) },
    navigator: { language: 'en-GB', globalPrivacyControl: !!opts.privacy, doNotTrack: opts.dnt },
    screen: { width: 1280, height: 720 }, performance: { timeOrigin: now - (opts.pageAge ?? 0) },
    console: { warn: (msg: unknown) => warnings.push(String(msg)) },
    setTimeout(fn: () => void) { timers.set(++timerId, fn); return timerId; }, clearTimeout(id: number) { timers.delete(id); },
    setInterval(fn: () => void) { timers.set(++timerId, fn); return timerId; },
    localStorage: { getItem: (key: string) => storage.get(key) ?? null,
      setItem(key: string, value: string) { if (opts.failStorage) throw new Error('Storage blocked'); storage.set(key, value); },
      removeItem(key: string) { if (opts.failStorage) throw new Error('Storage blocked'); storage.delete(key); } },
    get sessionStorage(): never { throw new Error('sessionStorage must not be touched'); },
    addEventListener(type: string, fn: (event: any) => void) { const list = listeners.get(type) ?? []; list.push(fn); listeners.set(type, list); },
    dispatchEvent(event: any) { for (const fn of listeners.get(event.type) ?? []) fn(event); },
    CustomEvent: class { type: string; detail: unknown; constructor(type: string, options: any) { this.type = type; this.detail = options.detail; } },
    fetch(url: unknown, options: any) {
      fetchCalls.push({ url: String(url), options });
      if (String(url).endsWith('/api/tracking-config')) {
        const input = JSON.parse(options.body);
        return Promise.resolve({ ok: true, headers: { get: () => null }, text: async () => JSON.stringify({ schemaVersion: 2,
          siteKey: input.siteKey, environment: input.environment, origin: 'https://site.example', revisionId: null,
          consentEpoch: EPOCH, validUntil: new Date(Date.now() + 60000).toISOString(), nativeTracking: settings,
          configuration: { destinations: opts.destinations ?? [] }, ...(opts.destinations?.length ? { revisionId: SECOND_SITE } : {}) }) });
      }
      assert.equal(String(url), ENDPOINT, 'The VM must never make a third-party network call.');
      if (flags.fetchThrows) throw new Error('fetch exploded');
      payloads.push(JSON.parse(options.body));
      if (flags.fetchReject) return Promise.reject(new Error('network down'));
      return flags.hold ? new Promise(resolve => pending.push(resolve)) : Promise.resolve(response());
    } };
  sandbox.window = sandbox;
  const context = vm.createContext(sandbox);
  const local = (value: unknown) => vm.runInContext(`JSON.parse(${JSON.stringify(JSON.stringify(value))})`, context);
  const storageKey = (key = SITE, environment = opts.environment ?? 'live') => `ten98:consent:v1:https://analytics.example.com:${key}:${environment}`;
  if (opts.saved) storage.set(storageKey(), JSON.stringify({ epoch: EPOCH, choice: ANALYTICS, updatedAt: now - 1000, expiresAt: now + 86400000 }));
  const setScript = (key: string | null, src: string | null, environment = opts.environment) => {
    document.currentScript = src === null ? null : { src,
      getAttribute: (attr: string) => attr === 'data-site-key' ? key : attr === 'data-environment' ? environment : null };
  };
  setScript('siteKey' in opts ? opts.siteKey ?? null : SITE, 'scriptSrc' in opts ? opts.scriptSrc ?? null : SCRIPT_SRC);
  const run = () => {
    vm.runInContext(SRC, context, { filename: 'tracker.js' });
    if (!coordinatorLoaded && scripts.some(s => s.src.endsWith('/destinations.js'))) {
      coordinatorLoaded = true; vm.runInContext(COORDINATOR, context, { filename: 'destinations.js' });
    }
  };
  const drain = async () => { for (let i = 0; i < 24; i++) await Promise.resolve(); };
  const grant = async (value = ANALYTICS, key = SITE, environment = opts.environment ?? 'live') => {
    const result = sandbox.ten98.consent(local(value), local({ siteKey: key, environment, acknowledgeReload: true }));
    await drain(); return result;
  };
  const start = async () => { run(); await drain(); return grant(); };
  const dispatch = (type: string, event: any = {}) => sandbox.dispatchEvent({ ...event, type });
  return { sandbox, document, history, location, listeners, warnings, fetchCalls, payloads, historyCalls, scripts,
    storage, storageKey, settings, flags, setScript, run, start, grant, dispatch, drain,
    complete: async () => { for (const resolve of pending.splice(0)) resolve(response()); await drain(); },
    collectCalls: () => fetchCalls.filter(c => c.url.endsWith('/api/collect')) };
}

const meta = { provider: 'meta', assetId: '123', enabled: true, owner: 'managed', ownershipConfirmed: true,
  mappings: [{ event: 'page_view' }, { event: 'purchase' }] };

test('one header loads the actual coordinator once; consent takes a fresh native page observation without replay or vendor invocation', async () => {
  const e = makeEnv({ destinations: [meta] }); e.run(); e.run(); await e.drain();
  assert.equal(e.scripts.length, 1); assert.equal(e.scripts[0].src, 'https://analytics.example.com/destinations.js');
  assert.equal(e.scripts[0].referrerPolicy, 'no-referrer');
  e.history.pushState({}, '', '/before?private=1#secret');
  e.sandbox.ten98.track('purchase', { value: '19.95', currency: 'USD', transactionId: 'private-order' });
  e.history.pushState({}, '', '/current?private=2#secret'); await e.drain();
  assert.equal(e.collectCalls().length, 0); assert.equal(e.payloads.length, 0); assert.equal(e.scripts.length, 1);
  assert.equal((await e.grant({ analytics: true, advertising: true, adUserData: true, adPersonalization: true })).ok, true);
  assert.equal(e.payloads.length, 1); assert.equal(e.payloads[0].name, 'page_view');
  assert.equal(e.payloads[0].url, 'https://site.example/current'); assert.equal(e.payloads[0].properties, undefined);
  assert.equal(e.scripts.length, 1, 'A new grant observes the current page only in native analytics.');
  assert.equal(JSON.stringify(e.payloads).includes('private'), false);
  await e.grant({ analytics: true, advertising: true, adUserData: true, adPersonalization: true });
  assert.equal(e.payloads.length, 1, 'Repeating an unchanged grant does not duplicate the observation.');
});

test('native requests use a revocable credential-free transport and only the consent epoch', async () => {
  const e = makeEnv(); await e.start(); const call = e.collectCalls()[0], p = e.payloads[0];
  assert.equal(call.url, ENDPOINT);
  for (const [key, value] of Object.entries({ method: 'POST', credentials: 'omit', referrerPolicy: 'no-referrer', mode: 'cors', cache: 'no-store', redirect: 'error' })) assert.equal(call.options[key], value);
  assert.ok(call.options.signal instanceof AbortSignal); assert.equal(call.options.headers['Content-Type'], 'application/json');
  assert.deepEqual(Object.keys(p).sort(), ['consent', 'dimensions', 'eventId', 'name', 'siteKey', 'url']);
  assert.deepEqual(p.consent, { analytics: true, epoch: EPOCH }); assert.deepEqual(p.dimensions, { language: 'en-GB' });
  assert.equal(p.siteKey, SITE); assert.match(p.eventId, UUID_RE);
});

test('test environments and disabled native tracking make no collector requests after grant', async () => {
  for (const opts of [{ environment: 'test' }, { settings: { enabled: false } }]) {
    const e = makeEnv(opts); await e.start(); e.history.pushState({}, '', '/next'); e.sandbox.ten98.track('signup'); await e.drain();
    assert.equal(e.collectCalls().length, 0); assert.equal(e.scripts.length, 1);
  }
  const vendors = makeEnv({ environment: 'test', destinations: [meta] }); vendors.run(); await vendors.drain();
  await vendors.grant({ analytics: true, advertising: true, adUserData: true, adPersonalization: true });
  // Construct vendor properties in the browser realm, as a real host application does.
  vm.runInContext("ten98.track('purchase', {value:'1.25',currency:'USD',transactionId:'test-order'})", vendors.sandbox);
  await vendors.drain(); assert.equal(vendors.scripts.length, 2, 'Test mode still exercises explicitly granted vendor routing.');
  assert.equal(vendors.collectCalls().length, 0);
  const invalid = makeEnv({ environment: 'invalid' }); invalid.run(); assert.equal(invalid.fetchCalls.length, 0); assert.equal(invalid.scripts.length, 0);
});

test('restored consent takes one fresh observation, but a grant written after navigation began is never restored', async () => {
  const e = makeEnv({ saved: true }); e.run(); await e.drain(); assert.equal(e.payloads.length, 1);
  assert.equal(e.payloads[0].url, 'https://site.example/dashboard'); assert.equal(e.payloads[0].context, undefined);
  const stale = makeEnv({ saved: true, pageAge: 2000 }); stale.run(); await stale.drain(); assert.equal(stale.collectCalls().length, 0);
  const privacy = makeEnv({ saved: true, privacy: true }); privacy.run(); await privacy.drain(); await privacy.grant(); assert.equal(privacy.collectCalls().length, 0);
  for (const dnt of ['1', 'yes']) { const e = makeEnv({ saved: true, dnt }); e.run(); await e.drain(); await e.grant(); assert.equal(e.collectCalls().length, 0); }
});

test('withdrawal aborts outstanding requests, clears context, and rejects late identity responses', async () => {
  const e = makeEnv(); await e.start(); e.flags.hold = true; e.sandbox.ten98.track('signup'); await e.drain();
  assert.equal(e.payloads.at(-1)!.context, 'signed-synthetic-context'); const inflight = e.collectCalls().at(-1)!.options.signal;
  await e.grant(DENIED); assert.equal(inflight.aborted, true); await e.complete();
  e.sandbox.ten98.track('after_withdrawal'); e.history.pushState({}, '', '/denied'); await e.drain(); assert.equal(e.payloads.length, 2);
  e.flags.hold = false; await e.grant(); assert.equal(e.payloads.length, 3); assert.equal(e.payloads.at(-1)!.context, undefined);
  assert.equal(e.payloads.at(-1)!.url, 'https://site.example/denied');
});

test('properties are native-only unless they meet each vendor contract; dimensions obey capture switches', async () => {
  const e = makeEnv({ destinations: [meta] }); await e.start();
  const properties = { plan: 'free', nested: { enabled: true }, amount: 1.125, tags: ['one', false] };
  e.location.search = '?utm_source=private-source&email=hidden'; e.location.hash = '#hidden';
  e.sandbox.ten98.track('feature_used', properties); await e.drain();
  assert.deepEqual(e.payloads.at(-1)!.properties, properties); assert.deepEqual(e.payloads.at(-1)!.dimensions, { language: 'en-GB' });
  assert.equal(e.scripts.length, 1); assert.equal(e.payloads.at(-1)!.url, 'https://site.example/dashboard');
  const enabled = makeEnv({ settings: { captureReferrer: true, captureScreen: true, captureCampaigns: true } });
  enabled.location.search = '?utm_source=newsletter&utm_medium=email&utm_campaign=launch&utm_term=term&utm_content=card&email=secret';
  await enabled.start(); assert.deepEqual(enabled.payloads[0].dimensions, { language: 'en-GB', referrer: 'https://referrer.example',
    screen: { width: 1280, height: 720 }, campaign: { source: 'newsletter', medium: 'email', campaign: 'launch', term: 'term', content: 'card' } });
  assert.equal(JSON.stringify(enabled.payloads).includes('secret'), false);
});

test('encoded and Unicode excluded prefixes cannot bypass native privacy; malformed paths fail closed', async () => {
  for (const path of ['/private', '/%70rivate/orders', '/private%2Forders', '/秘密/orders', '/%E7%A7%98%E5%AF%86/orders', '/bad%ZZ']) {
    const e = makeEnv({ settings: { excludedPaths: ['/private', '/秘密'] } }); e.location.pathname = path; await e.start();
    e.sandbox.ten98.track('signup'); await e.drain(); assert.equal(e.collectCalls().length, 0, path);
    e.history.pushState({}, '', '/public'); await e.drain(); assert.equal(e.payloads.length, 1, 'A later public page can be observed.');
  }
});

test('pushState/replaceState ignore query/hash-only moves and duplicates but preserve path observations', async () => {
  const e = makeEnv(); await e.start();
  for (const url of ['/dashboard?x=1', '/dashboard#frag', '/dashboard']) e.history.pushState({}, '', url);
  await e.drain(); assert.equal(e.payloads.length, 1);
  e.history.pushState({}, '', '/settings?a=1#top'); e.history.replaceState({}, '', '/settings'); e.history.replaceState({}, '', '/profile');
  await e.drain(); assert.deepEqual(e.payloads.map(p => p.url), ['https://site.example/dashboard', 'https://site.example/settings', 'https://site.example/profile']);
});

test('popstate observes back/forward path changes only', async () => {
  const e = makeEnv(); await e.start(); e.history.pushState({}, '', '/a'); e.history.pushState({}, '', '/b'); await e.drain();
  e.location.pathname = '/a'; e.dispatch('popstate'); e.location.pathname = '/b'; e.dispatch('popstate');
  e.location.search = '?z=1'; e.dispatch('popstate'); await e.drain();
  assert.deepEqual(e.payloads.map(p => new URL(p.url).pathname), ['/dashboard', '/a', '/b', '/a', '/b']);
});

test('bfcache observes one fresh page per restoration; ordinary pageshow does not duplicate', async () => {
  const e = makeEnv(); await e.start(); e.dispatch('pageshow', { persisted: false }); await e.drain(); assert.equal(e.payloads.length, 1);
  e.dispatch('pageshow', { persisted: true }); e.dispatch('pageshow', { persisted: true }); await e.drain(); assert.equal(e.payloads.length, 2);
  e.dispatch('pagehide', { persisted: true }); e.dispatch('pageshow', { persisted: true }); await e.drain(); assert.equal(e.payloads.length, 3);
});

test('duplicate initialization never doubles sends or listeners; multiple sites have independent consent', async () => {
  const e = makeEnv(); await e.start(); e.run(); e.run(); await e.drain(); assert.equal(e.payloads.length, 1);
  for (const name of ['popstate', 'pageshow', 'pagehide']) assert.equal(e.listeners.get(name)!.length, 1);
  e.setScript(SECOND_SITE, SCRIPT_SRC); e.run(); await e.drain(); assert.equal(e.payloads.length, 1);
  await e.grant(ANALYTICS, SECOND_SITE); assert.deepEqual(e.payloads.map(p => p.siteKey), [SITE, SECOND_SITE]);
  e.history.pushState({}, '', '/multi'); await e.drain();
  assert.deepEqual(e.payloads.slice(2).map(p => p.siteKey).sort(), [SITE, SECOND_SITE]);
  await e.grant(DENIED, SECOND_SITE); e.sandbox.ten98.track('signup'); await e.drain(); assert.equal(e.payloads.length, 5); assert.equal(e.payloads.at(-1)!.siteKey, SITE);
});

test('valid custom names survive the coordinator; invalid, reserved, non-string names are discarded and UUIDs are fresh', async () => {
  const e = makeEnv(); await e.start(); const track = e.sandbox.ten98.track;
  for (const name of ['signup', 'a-b_c.d:e9', 'a'.repeat(64)]) track(name);
  for (const bad of ['', '1abc', '_lead', 'has space', 'a/b', 'a?b', 'a#b', 'a'.repeat(65), 'page_view', 'signup\n', 'signup\r', 123, null, undefined, {}, ['x'], true]) track(bad);
  await e.drain(); assert.deepEqual(e.payloads.map(p => p.name), ['page_view', 'signup', 'a-b_c.d:e9', 'a'.repeat(64)]);
  const ids = e.payloads.map(p => p.eventId); assert.equal(new Set(ids).size, ids.length); ids.forEach(id => assert.match(id, UUID_RE));
});

test('native history exceptions, this binding, arguments and return values survive instrumentation', async () => {
  const e = makeEnv(); await e.start(); e.flags.historyThrows = true;
  assert.throws(() => e.history.pushState({}, '', '/boom'), /^Error: native history failure$/); await e.drain(); assert.equal(e.payloads.length, 1);
  e.flags.historyThrows = false; e.flags.historyResult = 'native-return'; const customThis = {}, state = { deep: [1, 2] };
  assert.equal(e.history.pushState.call(customThis, state, 'title', '/bound?x=1'), 'native-return'); await e.drain();
  assert.equal(e.historyCalls.at(-1)!.thisArg, customThis); assert.deepEqual(e.historyCalls.at(-1)!.args, [state, 'title', '/bound?x=1']);
  assert.equal(e.payloads.at(-1)!.url, 'https://site.example/bound');
  e.history.replaceState(state, '', '/replace'); assert.equal(e.historyCalls.at(-1)!.thisArg, e.history);
});

test('rejected, not-ok and synchronously throwing collector fetches never break the host or retry', async () => {
  const e = makeEnv(); e.run(); await e.drain(); e.flags.fetchReject = true; await e.grant(); assert.equal(e.warnings.length, 1);
  e.flags.fetchReject = false; e.flags.fetchOk = false; e.history.pushState({}, '', '/warn'); await e.drain(); assert.equal(e.warnings.length, 2);
  e.flags.fetchOk = true; e.flags.fetchThrows = true; assert.doesNotThrow(() => e.history.pushState({}, '', '/still-fine')); await e.drain();
  assert.equal(e.location.pathname, '/still-fine'); assert.equal(e.collectCalls().length, 3); assert.equal(e.warnings.length, 3);
  assert.equal(JSON.stringify(e.warnings).includes('/still-fine'), false);
});

test('broken host console and missing crypto cannot break navigation', async () => {
  const e = makeEnv(); e.sandbox.console = { warn() { throw new Error('host console failed'); } }; e.flags.fetchReject = true;
  await e.start(); e.history.pushState({}, '', '/next'); await e.drain(); assert.equal(e.payloads.length, 2);
  const missing = makeEnv(); missing.sandbox.crypto = undefined; assert.doesNotThrow(() => missing.run()); await missing.drain();
  assert.equal((await missing.grant()).ok, true, 'An unavailable optional fresh-page observation must not break the consent API.');
  assert.doesNotThrow(() => missing.history.pushState({}, '', '/no-crypto')); assert.doesNotThrow(() => missing.sandbox.ten98.track('signup'));
  await missing.drain(); assert.equal(missing.collectCalls().length, 0); assert.equal(missing.location.pathname, '/no-crypto');
  const insecure = makeEnv(); delete insecure.sandbox.crypto.randomUUID;
  assert.equal((await insecure.start()).ok, true, 'Plain HTTP can expose getRandomValues without randomUUID.');
  insecure.sandbox.ten98.track('signup'); await insecure.drain(); assert.equal(insecure.payloads.length, 1);
  assert.equal(insecure.payloads[0].name, 'signup');
});

test('invalid collector URL, current script, site key or foreign API leaves collection disabled', async () => {
  for (const opts of [{ scriptSrc: 'not a url' }, { scriptSrc: null }, { siteKey: null }, { siteKey: 'invalid' }]) {
    const e = makeEnv(opts); assert.doesNotThrow(() => e.run()); await e.drain(); assert.equal(e.fetchCalls.length, 0);
  }
  const e = makeEnv(); const foreign = { track() { throw new Error('foreign track must not be called'); } }; e.sandbox.ten98 = foreign;
  e.run(); e.history.pushState({}, '', '/foreign'); await e.drain(); assert.equal(e.sandbox.ten98, foreign);
  assert.equal(e.scripts.length, 0); assert.equal(e.fetchCalls.length, 0);
});

test('a frozen history method still permits custom events and remaining navigation methods', async () => {
  const e = makeEnv(); const original = e.history.pushState; Object.defineProperty(e.history, 'pushState', { writable: false });
  await e.start(); e.run(); assert.equal(e.history.pushState, original); e.sandbox.ten98.track('signup'); e.history.replaceState({}, '', '/replace');
  await e.drain(); assert.equal(e.payloads.length, 3); assert.equal(e.listeners.get('popstate')!.length, 1);
});

test('only consent is persisted; cookies and session storage stay untouched, and blocked consent storage fails closed', async () => {
  const e = makeEnv(); assert.throws(() => e.document.cookie, /cookie/); assert.throws(() => e.sandbox.sessionStorage, /sessionStorage/);
  await e.start(); e.history.pushState({}, '', '/clean'); e.sandbox.ten98.track('signup'); await e.drain(); assert.equal(e.payloads.length, 3);
  assert.equal(e.storage.size, 1); const record = JSON.parse(e.storage.get(e.storageKey())!);
  assert.deepEqual(Object.keys(record).sort(), ['choice', 'epoch', 'expiresAt', 'updatedAt']);
  assert.equal(JSON.stringify(record).includes('signed-synthetic-context'), false);
  const blocked = makeEnv({ failStorage: true }); assert.equal((await blocked.start()).ok, false);
  blocked.sandbox.ten98.track('signup'); await blocked.drain(); assert.equal(blocked.collectCalls().length, 0);
});
