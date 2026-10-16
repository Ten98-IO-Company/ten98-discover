import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID, webcrypto } from 'node:crypto';
import vm from 'node:vm';
import { parseIdentifyInput } from '../src/server/identify-input.ts';

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
type IdentifyPayload = {type: 'identify'; siteKey: string; requestId: string; sentAt: string; url: string; properties: Record<string, unknown>; dimensions?: {distinctId?: string}; context?: string; consent: {analytics: true; epoch: string}};
type PerformancePayload = {type:'performance';siteKey:string;navigationId:string;url:string;metric:string;value:number;revision:number;dimensions:Record<string,unknown>;consent?:{analytics:true;epoch:string};collection?:{mode:'cookieless';epoch:string}};

function makeEnv(opts: { siteKey?: string | null; scriptSrc?: string | null; environment?: string; saved?: boolean;
  pageAge?: number; privacy?: boolean; dnt?: string; failStorage?: boolean; settings?: Record<string, unknown>;
  destinations?: unknown[]; deferCoordinator?: boolean; secondCollector?: boolean; collectionMode?: 'cookieless' | 'consent-first'; preference?: unknown; failRead?: boolean;
  trackerSource?: string; coordinatorSource?: string; pageUrl?: string; windowOrigin?: string;scriptNonce?:string;
  performanceObserver?:boolean;performanceAdapter?:'ready'|'delayed' } = {}) {
  const listeners = new Map<string, Array<(ev: any) => void>>(), documentListeners = new Map<string, Array<(ev: any) => void>>(), warnings: string[] = [], scripts: any[] = [];
  const fetchCalls: Array<{ url: string; options: any }> = [], payloads: Payload[] = [];
  const identifyPayloads: IdentifyPayload[] = [];
  const performancePayloads:PerformancePayload[]=[],performanceCallbacks:Array<(metric:unknown)=>void>=[];
  const historyCalls: Array<{ method: string; thisArg: unknown; args: unknown[] }> = [];
  const storage = new Map<string, string>(), timers = new Map<number, {fn: () => void; delay: number; interval: boolean}>();
  const storageCalls: string[] = [];
  const pending: Array<(result: unknown) => void> = [];
  let now = Date.now(), timerId = 0, coordinatorLoaded = false;
  class Clock extends Date { constructor(value?: string | number) { super(value === undefined ? now : value); } static now() { return now; } }
  const flags = { fetchOk: true, fetchReject: false, fetchThrows: false, hold: false,
    identifyStatus: 202, identifyResponse: {accepted: true, duplicate: false, context: 'identified-synthetic-context'} as unknown,
    collectionResponse: null as null | ((payload: Payload | IdentifyPayload, options: any) => any), config: {} as Record<string, unknown>,
    response: { accepted: true, context: 'signed-synthetic-context' }, historyThrows: false, historyResult: undefined as unknown };
  const pageUrl = new URL(opts.pageUrl ?? 'https://site.example/dashboard');
  const location = { protocol: pageUrl.protocol, origin: pageUrl.origin, pathname: pageUrl.pathname, search: pageUrl.search, hash: pageUrl.hash,
    get href() { return ['http:', 'https:'].includes(this.protocol) ? this.origin + this.pathname + this.search + this.hash : pageUrl.href; }, reload() {}, replace() {} };
  const native = (method: string) => function (this: unknown, ...args: unknown[]) {
    historyCalls.push({ method, thisArg: this, args });
    if (flags.historyThrows) throw new Error('native history failure');
    if (args[2] !== undefined && args[2] !== null) {
      const u = new URL(String(args[2]), location.href);
      location.protocol = u.protocol; location.origin = u.origin; location.pathname = u.pathname; location.search = u.search; location.hash = u.hash;
    }
    return flags.historyResult;
  };
  const history = { pushState: native('pushState'), replaceState: native('replaceState') };
  const settings = { enabled: true, consentMode: 'external', captureReferrer: false, captureCampaigns: false,
    captureScreen: false, excludeBots: true, excludedPaths: [], ...opts.settings };
  const response = () => new Response(JSON.stringify(flags.response), {status: flags.fetchOk ? 202 : 400});
  const document: any = { currentScript: null, referrer: 'https://referrer.example/path?secret=hidden#fragment',
    addEventListener(type: string, fn: (event: any) => void) { const list = documentListeners.get(type) ?? []; list.push(fn); documentListeners.set(type, list); },
    createElement: () => opts.performanceObserver?{remove(){}}:{}, querySelectorAll: () => scripts, head: { appendChild(script: any) { scripts.push(script); return script; } },
    get cookie(): never { throw new Error('document.cookie must not be touched'); } };
  const sandbox: any = { document, history, location, origin: opts.windowOrigin ?? pageUrl.origin, URL, Intl, Date: Clock, AbortController, TextEncoder, TextDecoder, ReadableStream,
    crypto: { randomUUID, getRandomValues: webcrypto.getRandomValues.bind(webcrypto) },
    navigator: { language: 'en-GB', globalPrivacyControl: !!opts.privacy, doNotTrack: opts.dnt },
    screen: { width: 1280, height: 720 }, performance: { timeOrigin: now - (opts.pageAge ?? 0) },
    console: { warn: (msg: unknown) => warnings.push(String(msg)) },
    setTimeout(fn: () => void, delay: number) { timers.set(++timerId, {fn, delay, interval: false}); return timerId; }, clearTimeout(id: number) { timers.delete(id); },
    setInterval(fn: () => void, delay: number) { timers.set(++timerId, {fn, delay, interval: true}); return timerId; },
    localStorage: { getItem: (key: string) => { storageCalls.push('read'); return storage.get(key) ?? null; },
      setItem(key: string, value: string) { storageCalls.push('write'); if (opts.failStorage) throw new Error('Storage blocked'); storage.set(key, value); },
      removeItem(key: string) { storageCalls.push('remove'); if (opts.failStorage) throw new Error('Storage blocked'); storage.delete(key); } },
    get sessionStorage(): never { throw new Error('sessionStorage must not be touched'); },
    addEventListener(type: string, fn: (event: any) => void) { const list = listeners.get(type) ?? []; list.push(fn); listeners.set(type, list); },
    dispatchEvent(event: any) { for (const fn of listeners.get(event.type) ?? []) fn(event); },
    CustomEvent: class { type: string; detail: unknown; constructor(type: string, options: any) { this.type = type; this.detail = options.detail; } },
    fetch(url: unknown, options: any) {
      fetchCalls.push({ url: String(url), options });
      if (String(url).endsWith('/api/tracking-config')) {
        const input = JSON.parse(options.body);
        return Promise.resolve({ ok: true, headers: { get: () => null }, text: async () => JSON.stringify({ schemaVersion: opts.collectionMode ? 3 : 2,
          siteKey: input.siteKey, environment: input.environment, origin: location.origin, revisionId: null,
          consentEpoch: EPOCH, validUntil: new Date(now + 60000).toISOString(), nativeTracking: {...settings, ...(opts.collectionMode ? {collectionMode: opts.collectionMode} : {})},
          configuration: { destinations: opts.destinations ?? [] }, ...(opts.destinations?.length ? { revisionId: SECOND_SITE } : {}), ...flags.config }) });
      }
      if (opts.secondCollector && String(url) === 'https://analytics-other.example.com/api/collect') assert.equal(new URL(String(url)).origin, 'https://analytics-other.example.com');
      else assert.equal(String(url), ENDPOINT, 'The VM must never make a third-party network call.');
      if (flags.fetchThrows) throw new Error('fetch exploded');
      const payload = JSON.parse(options.body);
      if (payload.type === 'identify') identifyPayloads.push(payload); else if(payload.type==='performance')performancePayloads.push(payload);else payloads.push(payload);
      if (flags.fetchReject) return Promise.reject(new Error('network down'));
      if (flags.collectionResponse) return flags.collectionResponse(payload, options);
      if (payload.type === 'identify') return Promise.resolve(new Response(JSON.stringify(flags.identifyResponse), {status: flags.identifyStatus}));
      return flags.hold ? new Promise(resolve => pending.push(resolve)) : Promise.resolve(response());
    } };
  sandbox.window = sandbox;
  if(opts.performanceObserver)sandbox.PerformanceObserver=class {};
  const context = vm.createContext(sandbox);
  const local = (value: unknown) => vm.runInContext(`JSON.parse(${JSON.stringify(JSON.stringify(value))})`, context);
  const storageKey = (key = SITE, environment = opts.environment ?? 'live') => `ten98:consent:v1:https://analytics.example.com:${key}:${environment}`;
  if (opts.saved) storage.set(storageKey(), JSON.stringify({ epoch: EPOCH, choice: ANALYTICS, updatedAt: now - 1000, expiresAt: now + 86400000 }));
  if (opts.preference !== undefined) storage.set(storageKey(), typeof opts.preference === 'string' ? opts.preference : JSON.stringify(opts.preference));
  if (opts.failRead) sandbox.localStorage.getItem = () => {throw new Error('Storage read blocked');};
  const setScript = (key: string | null, src: string | null, environment = opts.environment) => {
    document.currentScript = src === null ? null : { src,nonce:opts.scriptNonce,
      getAttribute: (attr: string) => attr === 'data-site-key' ? key : attr === 'data-environment' ? environment : null };
  };
  setScript('siteKey' in opts ? opts.siteKey ?? null : SITE, 'scriptSrc' in opts ? opts.scriptSrc ?? null : SCRIPT_SRC);
  const installPerformanceAdapter=()=>{assert.ok(sandbox.__ten98FoundationHub);sandbox.__ten98FoundationHub.startPerformance=Object.assign((callback:(metric:unknown)=>void)=>performanceCallbacks.push(callback),{protocolVersion:1});};
  const run = () => {
    vm.runInContext(opts.trackerSource ?? SRC, context, { filename: 'tracker.js' });
    if(opts.performanceAdapter==='ready'&&!sandbox.__ten98FoundationHub?.startPerformance)installPerformanceAdapter();
    if (!opts.deferCoordinator && !coordinatorLoaded && scripts.some(s => new URL(s.src).pathname === '/destinations.js')) {
      coordinatorLoaded = true; vm.runInContext(opts.coordinatorSource ?? COORDINATOR, context, { filename: 'destinations.js' });
    }
  };
  const drain = async () => { for (let i = 0; i < 24; i++) await Promise.resolve(); };
  const grant = async (value = ANALYTICS, key = SITE, environment = opts.environment ?? 'live') => {
    const result = sandbox.ten98.consent(local(value), local({ siteKey: key, environment, acknowledgeReload: true }));
    await drain(); return result;
  };
  const start = async () => { run(); await drain(); return grant(); };
  const dispatch = (type: string, event: any = {}) => sandbox.dispatchEvent({ ...event, type });
  return { sandbox, document, history, location, listeners, documentListeners, warnings, fetchCalls, payloads, identifyPayloads, historyCalls, scripts, local,
    storage, storageCalls, timers, storageKey, settings, flags, setScript, run, start, grant, dispatch, drain,performancePayloads,performanceCallbacks,
    emitPerformance(metric:unknown,index=0){const callback=performanceCallbacks[index];assert.ok(callback,'A real tracker adapter registration must exist before emitting a synthetic metric');callback(metric);},
    async loadPerformance(ready=true){const loaders=scripts.filter(script=>new URL(script.src).pathname==='/performance.js');assert.equal(loaders.length,1,'One shared optional adapter script');if(ready)installPerformanceAdapter();if(ready)loaders[0].onload();else loaders[0].onerror();await drain();},
    performanceCalls:()=>fetchCalls.filter(call=>call.url.endsWith('/api/collect')&&JSON.parse(call.options.body).type==='performance'),
    loadCoordinator() { opts.deferCoordinator = false; run(); }, advance(ms: number) { now += ms; },
    async runTimers(delay: number) { for (const [id, timer] of [...timers]) if (timer.delay === delay) { if (!timer.interval) timers.delete(id); timer.fn(); } await drain(); },
    complete: async () => { for (const resolve of pending.splice(0)) resolve(response()); await drain(); },
    collectCalls: () => fetchCalls.filter(c => c.url.endsWith('/api/collect')) };
}

function declaredElement(attributes: Record<string, string>) {
  return {
    getAttribute: (name: string) => Object.hasOwn(attributes, name) ? attributes[name] : null,
    getAttributeNames: () => Object.keys(attributes),
    get textContent(): never { return assert.fail('Declared events must not read page text.'); },
    get value(): never { return assert.fail('Declared events must not read form values.'); },
    get href(): never { return assert.fail('Declared events must not inspect or change navigation.'); },
  };
}

test('declared HTML clicks reuse native custom events once, including nested and dynamic targets, without reading page contents or delaying navigation', async () => {
  const e = makeEnv({collectionMode: 'cookieless'}); e.run(); e.run(); await e.drain();
  assert.equal(e.documentListeners.get('click')?.length, 1);
  const click = (target: unknown) => e.documentListeners.get('click')!.forEach(fn => fn({target,
    preventDefault() { assert.fail('Tracking must not delay a link or form.'); }}));
  const element = declaredElement({'data-ten98-event': 'signup', 'data-ten98-event-plan': 'starter',
    'data-ten98-event-empty': '', 'data-ten98-event-count': '2', 'data-unrelated': 'private'});
  click({closest: () => element}); await e.drain();
  assert.equal(e.payloads.length, 2); assert.equal(e.payloads[1].name, 'signup');
  assert.deepEqual(e.payloads[1].properties, {plan: 'starter', empty: '', count: '2'});
  assert.equal(e.payloads[1].url, 'https://site.example/dashboard');
  assert.equal(e.collectCalls()[1].options.keepalive, true);
  click({nodeType: 3, parentElement: {closest: () => declaredElement({'data-ten98-event': 'dynamic_action'})}});
  await e.drain(); assert.equal(e.payloads.at(-1)!.name, 'dynamic_action');
  const before = e.payloads.length;
  for (const target of [null, {}, {closest: () => null}]) assert.doesNotThrow(() => click(target));
  await e.drain(); assert.equal(e.payloads.length, before);
});

test('declared HTML events reject invalid names or entire oversized/unsafe property sets without truncation', async () => {
  const e = makeEnv({collectionMode: 'cookieless'}); e.run(); await e.drain();
  const bad: Record<string, string>[] = [
    {'data-ten98-event': ''}, {'data-ten98-event': 'page_view'}, {'data-ten98-event': 'signup\n'},
    {'data-ten98-event': 'signup', 'data-ten98-event-__proto__': 'unsafe'},
    {'data-ten98-event': 'signup', 'data-ten98-event-prototype': 'unsafe'},
    {'data-ten98-event': 'signup', 'data-ten98-event-constructor': 'unsafe'},
    {'data-ten98-event': 'signup', 'data-ten98-event-': 'unsafe'},
    {'data-ten98-event': 'signup', ['data-ten98-event-'+'x'.repeat(81)]: 'unsafe'},
    {'data-ten98-event': 'signup', 'data-ten98-event-plan': 'x'.repeat(1001)},
    {'data-ten98-event': 'signup', 'data-ten98-event-plan': '\ud800'},
    {'data-ten98-event': 'signup', 'data-ten98-event-plan': '\u0000'},
    {'data-ten98-event': 'signup', ...Object.fromEntries(Array.from({length: 51}, (_,i)=>['data-ten98-event-p'+i,'x']))},
    {'data-ten98-event': 'signup', ...Object.fromEntries(Array.from({length: 8}, (_,i)=>['data-ten98-event-p'+i,'x'.repeat(1000)]))},
    {'data-ten98-event': 'signup', ...Object.fromEntries(Array.from({length: 4}, (_,i)=>['data-ten98-event-p'+i,'🐎'.repeat(500)]))},
  ];
  const before=e.payloads.length;
  for(const attributes of bad) e.documentListeners.get('click')!.forEach(fn=>fn({target:{closest:()=>declaredElement(attributes)}}));
  await e.drain(); assert.equal(e.payloads.length,before);
});

test('declared attributes preserve supported boundary values and do not claim legacy declarations', async () => {
  const e=makeEnv({collectionMode:'cookieless'});e.run();await e.drain();
  const click=(attributes:Record<string,string>)=>e.documentListeners.get('click')!.forEach(fn=>fn({target:{closest:()=>declaredElement(attributes)}}));
  const properties=Object.fromEntries(Array.from({length:50},(_,i)=>['data-ten98-event-p'+i,'0']));
  click({'data-ten98-event':'a'.repeat(64),...properties});await e.drain();
  assert.equal(Object.keys(e.payloads.at(-1)!.properties as object).length,50);
  click({'data-ten98-event':'limits',['data-ten98-event-'+'x'.repeat(80)]:'x'.repeat(1000),'data-ten98-event-unicode':'🐎'.repeat(500)});
  await e.drain();assert.equal((e.payloads.at(-1)!.properties as Record<string,string>).unicode,'🐎'.repeat(500));
  const before=e.payloads.length;
  click({'data-umami-event':'legacy','data-umami-event-plan':'private'});await e.drain();assert.equal(e.payloads.length,before);
  click({'data-ten98-event':'native','data-umami-event':'legacy','data-umami-event-plan':'private'});await e.drain();
  assert.equal(e.payloads.at(-1)!.name,'native');assert.deepEqual(e.payloads.at(-1)!.properties,{});
});

test('declared clicks honor current collection gates, never queue blocked interactions, and keep advertiser consent separate', async () => {
  for(const options of [{collectionMode:'consent-first' as const},{collectionMode:'cookieless' as const,privacy:true},
    {collectionMode:'cookieless' as const,dnt:'1'},{collectionMode:'cookieless' as const,settings:{enabled:false}},
    {collectionMode:'cookieless' as const,settings:{excludedPaths:['/dashboard']}}]) {
    const e=makeEnv(options); e.run(); await e.drain();
    e.documentListeners.get('click')!.forEach(fn=>fn({target:{closest:()=>declaredElement({'data-ten98-event':'blocked_click'})}}));
    await e.drain(); assert.equal(e.payloads.length,0);
    if(options.collectionMode==='consent-first'){await e.grant();assert.equal(e.payloads.length,1);assert.equal(e.payloads[0].name,'page_view');}
  }
  const e=makeEnv({collectionMode:'cookieless',destinations:[meta]}); e.run(); await e.drain();
  e.documentListeners.get('click')!.forEach(fn=>fn({target:{closest:()=>declaredElement({'data-ten98-event':'sign_up'})}}));
  await e.drain(); assert.equal(e.payloads.at(-1)!.name,'sign_up');assert.equal(e.scripts.length,1,'Basic clicks cannot load a vendor SDK.');
  await e.grant(DENIED);const before=e.payloads.length;
  e.documentListeners.get('click')!.forEach(fn=>fn({target:{closest:()=>declaredElement({'data-ten98-event':'after_refusal'})}}));
  await e.drain(); assert.equal(e.payloads.length,before);
});

const meta = { provider: 'meta', assetId: '123', enabled: true, owner: 'managed', ownershipConfirmed: true,
  mappings: [{ event: 'page_view' }, { event: 'purchase' }] };

test('one header loads the actual coordinator once; consent takes a fresh native page observation without replay or vendor invocation', async () => {
  const e = makeEnv({ destinations: [meta] }); e.run(); e.run(); await e.drain();
  assert.equal(e.scripts.length, 1); assert.equal(e.scripts[0].src, 'https://analytics.example.com/destinations.js?v=3');
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

test('non-HTTP and opaque documents leave tracking globals, navigation and all work untouched', async () => {
  for (const opts of [{pageUrl: 'file:///C:/preview/index.html'}, {pageUrl: 'data:text/html,preview'}, {pageUrl: 'about:blank'},
    {pageUrl: 'blob:https://site.example/preview'}, {pageUrl: 'ftp://site.example/preview'}, {windowOrigin: 'null'}, {nullLocation: true}]) {
    for (const foreign of [false, true]) {
      const e = makeEnv({...opts, collectionMode: 'cookieless', destinations: [meta]});
      if ('nullLocation' in opts) e.location.origin = 'null';
      if (foreign) e.sandbox.ten98 = {track() { assert.fail('Foreign API must not be called.'); }};
      const globals = Object.keys(e.sandbox).sort(), api = e.sandbox.ten98, push = e.history.pushState, replace = e.history.replaceState;
      assert.doesNotThrow(() => { e.run(); e.run(); }); await e.drain(); await e.runTimers(30000);
      e.dispatch('popstate'); e.dispatch('pageshow', {persisted: true}); await e.drain();
      assert.deepEqual(Object.keys(e.sandbox).sort(), globals, JSON.stringify(opts)); assert.equal(e.sandbox.ten98, api);
      assert.equal(e.history.pushState, push); assert.equal(e.history.replaceState, replace); assert.equal(e.historyCalls.length, 0);
      assert.equal(e.listeners.size, 0); assert.equal(e.scripts.length, 0); assert.equal(e.fetchCalls.length, 0); assert.equal(e.timers.size, 0);
      assert.equal(e.storage.size, 0); assert.deepEqual(e.storageCalls, []); assert.deepEqual(e.warnings, []);
    }
  }
});

test('HTTPS and registered HTTP localhost documents still configure and collect basic analytics', async () => {
  for (const pageUrl of ['https://site.example/dashboard', 'http://localhost:4173/dashboard', 'http://127.0.0.1:4173/dashboard']) {
    const e = makeEnv({pageUrl, collectionMode: 'cookieless'}); e.run(); await e.drain();
    assert.equal(e.fetchCalls.filter(call => call.url.endsWith('/api/tracking-config')).length, 1);
    assert.equal(e.payloads.length, 1); assert.equal(e.payloads[0].url, pageUrl); assert.equal(e.scripts.length, 1);
    assert.equal(e.sandbox.ten98.destinationStatus(e.local({siteKey: SITE, environment: 'live'})).ready, true);
  }
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
  assert.deepEqual(Object.keys(record).sort(), ['basicOptOut', 'choice', 'epoch', 'expiresAt', 'updatedAt', 'version']);
  assert.equal(record.version, 2); assert.equal(record.basicOptOut, false);
  assert.equal(JSON.stringify(record).includes('signed-synthetic-context'), false);
  const blocked = makeEnv({ failStorage: true }); assert.equal((await blocked.start()).ok, false);
  blocked.sandbox.ten98.track('signup'); await blocked.drain(); assert.equal(blocked.collectCalls().length, 0);
});

const scope = (e: ReturnType<typeof makeEnv>, extra: Record<string, unknown> = {}) => e.local({siteKey: SITE, environment: 'live', ...extra});
const identify = (e: ReturnType<typeof makeEnv>, properties: unknown, id?: string, extra?: Record<string, unknown>) => id === undefined
  ? e.sandbox.ten98.identify(e.local(properties), scope(e, extra)) : e.sandbox.ten98.identify(id, e.local(properties), scope(e, extra));
const reply = (value: unknown, status = 202) => new Response(JSON.stringify(value), {status});

test('identify overloads snapshot typed input and consume only the top-level identity shortcut', async () => {
  const e = makeEnv(); await e.start();
  const values = {empty: '', zero: 0, off: false, nil: null, date: '2024-02-29T23:59:59.123456789+04:00', array: [1, '1', null, false, '2024-01-01T00:00:00Z'], nested: {id: 'caller metadata'}, 'a.b': 2};
  assert.equal((await identify(e, values)).status, 'accepted');
  assert.equal(e.identifyPayloads[0].dimensions, undefined); assert.deepEqual(e.identifyPayloads[0].properties, values);
  const normalized = parseIdentifyInput(e.identifyPayloads[0]);
  assert.deepEqual(normalized.properties.date, {type: 'date', value: '2024-02-29T19:59:59.123456789Z'});
  assert.deepEqual(normalized.properties['a\\.b'], {type: 'number', value: 2});
  const properties = e.local({id: 'account-A', plan: 'pro'});
  assert.equal((await e.sandbox.ten98.identify(properties, scope(e))).status, 'accepted');
  assert.equal(properties.id, 'account-A'); assert.deepEqual(e.identifyPayloads.at(-1)!.properties, {plan: 'pro'});
  assert.equal((await identify(e, {id: 'account-A'}, 'account-A')).status, 'accepted');
  assert.deepEqual(e.identifyPayloads.at(-1)!.properties, {});
  assert.equal((await identify(e, {}, 'account-B')).status, 'accepted');
  const count = e.identifyPayloads.length;
  assert.equal((await identify(e, {id: 'different'}, 'account-B')).status, 'invalid');
  for (const id of ['', 'x'.repeat(257), '\n', '\0', '\ud800']) assert.equal((await identify(e, {}, id)).status, 'invalid');
  const expressions = [
    '({x:undefined})', '({x:NaN})', '({x:Infinity})', '({x:1e15+1})', '({x:1n})', '({x:Symbol()})', '({x:()=>0})',
    '({x:new Date()})', '({x:[,]})', '({x:[{}]})', '({x:[[1]]})', '({x:Array(51).fill(0)})', '({x:Array(5).fill("x".repeat(1000))})',
    '({x:"x".repeat(1001)})', '({x:"\\ud800"})', '({x:"\\0"})', '({a:{b:{c:{d:{e:1}}}}})',
    'Object.fromEntries(Array.from({length:51},(_,i)=>["k"+i,i]))', 'Object.fromEntries(Array.from({length:7},(_,i)=>["k"+i,"x".repeat(1000)]))',
    '({["x".repeat(81)]:1})', '({constructor:1})', '({["__proto__"]:1})', '({prototype:1})',
    'Object.defineProperty({},"hidden",{value:1})', '({[Symbol()]:1})', '(()=>{const a={};a.self=a;return a})()',
    '({get id(){window.hooks++;return "bad"}})', '({get plan(){window.hooks++;return "bad"}})', '({toJSON(){window.hooks++;return {}}})',
    '({x:Object.assign([1],{extra:2})})', '({x:Object.defineProperty([1],"0",{get(){window.hooks++;return 1}})})',
  ];
  e.sandbox.hooks = 0;
  for (const expression of expressions) assert.equal((await e.sandbox.ten98.identify(vm.runInContext(expression, e.sandbox), scope(e))).status, 'invalid', expression);
  assert.equal(e.sandbox.hooks, 0); assert.equal(e.identifyPayloads.length, count);
  assert.equal((await identify(e, Object.fromEntries(Array.from({length: 50}, (_, i) => ['k' + i, i])))).status, 'accepted');
  const nullObject = vm.runInContext('Object.assign(Object.create(null), {empty:"", n:1e15})', e.sandbox);
  assert.equal((await e.sandbox.ten98.identify(nullObject, scope(e))).status, 'accepted');
  e.sandbox.ten98.track('after_invalid'); await e.drain(); assert.equal(e.payloads.at(-1)!.dimensions.distinctId, 'account-B');
});

test('identify never queues or assigns identity before a live native consent gate', async () => {
  const loading = makeEnv({deferCoordinator: true}); loading.run();
  assert.equal((await identify(loading, {plan: 'discard'}, 'discard-id')).status, 'not_sent');
  loading.loadCoordinator();
  assert.equal((await identify(loading, {}, 'discard-id')).status, 'not_sent');
  await loading.drain(); await loading.grant();
  assert.equal(loading.identifyPayloads.length, 0); assert.equal(loading.payloads[0].dimensions.distinctId, undefined);
  for (const opts of [{}, {privacy: true}, {dnt: 'yes'}, {settings: {enabled: false}}, {environment: 'test'}, {settings: {excludedPaths: ['/private']}}]) {
    const e = makeEnv(opts); e.run(); await e.drain();
    if ('settings' in opts && opts.settings?.excludedPaths) e.location.pathname = '/%70rivate/child';
    if (Object.keys(opts).length) await e.grant();
    const count = e.collectCalls().length;
    const result = await identify(e, {plan: 'discard'}, 'discard-id', {environment: 'environment' in opts ? opts.environment : 'live'});
    assert.equal(result.status, 'not_sent', JSON.stringify(opts)); assert.equal(e.collectCalls().length, count); assert.equal(e.identifyPayloads.length, 0);
    if (!('environment' in opts)) {
      e.sandbox.navigator.globalPrivacyControl = false; e.sandbox.navigator.doNotTrack = undefined; e.settings.enabled = true; e.location.pathname = '/public';
      await e.runTimers(30000); await e.grant(); e.sandbox.ten98.track('after_gate'); await e.drain();
      assert.equal(e.payloads.at(-1)!.dimensions.distinctId, undefined); assert.equal(e.identifyPayloads.length, 0);
    }
  }
  const malformed = makeEnv({settings: {excludedPaths: ['/private']}}); await malformed.start(); malformed.location.pathname = '/bad%ZZ';
  assert.equal((await identify(malformed, {}, 'discard-id')).status, 'not_sent');
  malformed.location.pathname = '/public'; malformed.sandbox.ten98.track('after_bad_path'); await malformed.drain(); assert.equal(malformed.payloads.at(-1)!.dimensions.distinctId, undefined);
});

test('identify is native-only and selects future identity synchronously', async () => {
  const e = makeEnv({destinations: [meta]}); e.run(); await e.drain(); await e.grant({analytics: true, advertising: true, adUserData: true, adPersonalization: true});
  e.location.search = '?email=hidden'; e.location.hash = '#hidden';
  const promise = identify(e, {plan: 'profile-sentinel'}, 'identifier-sentinel');
  e.sandbox.ten98.track('purchase', e.local({value: '1.25', currency: 'USD', transactionId: 'order'}));
  assert.equal((await promise).status, 'accepted'); await e.drain();
  assert.equal(e.identifyPayloads.length, 1); assert.equal(e.payloads.length, 2); assert.equal(e.payloads[1].dimensions.distinctId, 'identifier-sentinel');
  assert.deepEqual(e.payloads[1].properties, {value: '1.25', currency: 'USD', transactionId: 'order'});
  assert.equal(e.identifyPayloads[0].url, 'https://site.example/dashboard'); assert.equal(e.scripts.length, 2, 'Only the explicit purchase initializes its mapped vendor.');
  e.scripts[1].onload(); await e.drain();
  assert.equal(JSON.stringify(e.sandbox.fbq.queue).includes('identifier-sentinel'), false); assert.equal(JSON.stringify(e.sandbox.fbq.queue).includes('profile-sentinel'), false);
  const scripts = e.scripts.length, vendorCalls = e.sandbox.fbq.queue.length, events = e.payloads.length;
  await identify(e, {plan: 'next'}); await identify(e, {}, 'identifier-sentinel');
  assert.equal(e.scripts.length, scripts); assert.equal(e.sandbox.fbq.queue.length, vendorCalls); assert.equal(e.payloads.length, events);
  assert.equal(e.identifyPayloads.at(-1)!.dimensions?.distinctId, 'identifier-sentinel');
  const call = e.collectCalls().find(c => JSON.parse(c.options.body).type === 'identify')!;
  for (const [key, value] of Object.entries({method: 'POST', credentials: 'omit', referrerPolicy: 'no-referrer', mode: 'cors', cache: 'no-store', redirect: 'error'})) assert.equal(call.options[key], value);
  const held: Array<() => void> = [], signals: AbortSignal[] = [];
  e.flags.collectionResponse = (_payload, options) => { signals.push(options.signal); return new Promise(resolve => held.push(() => resolve(reply({accepted: true, duplicate: false})))); };
  const a = identify(e, {}, 'identifier-sentinel'); await e.drain(); const b = identify(e, {same: true}, 'identifier-sentinel'); await e.drain();
  assert.equal(signals.some(signal => signal.aborted), false); held.forEach(resolve => resolve()); await Promise.all([a, b]);
});

test('identify and reset resolve one site without cross-site identity or consent changes', async () => {
  const e = makeEnv({secondCollector: true}); await e.start(); await identify(e, {}, 'primary');
  e.setScript(SECOND_SITE, SCRIPT_SRC); e.run(); await e.drain(); await e.grant(ANALYTICS, SECOND_SITE); await identify(e, {}, 'secondary', {siteKey: SECOND_SITE});
  e.setScript(SITE, 'https://analytics-other.example.com/tracker.js'); e.run(); await e.drain();
  assert.equal(e.sandbox.ten98.consent(e.local(ANALYTICS), scope(e, {collectorOrigin: 'https://analytics-other.example.com', acknowledgeReload: true})).ok, true); await e.drain();
  await identify(e, {}, 'other-origin', {collectorOrigin: 'https://analytics-other.example.com'});
  const count = e.identifyPayloads.length;
  for (const options of [undefined, {}, {siteKey: SITE}, {siteKey: SITE, environment: 'live'}, {siteKey: SITE, environment: 'live', collectorOrigin: 'https://missing.example'}]) {
    assert.equal((await e.sandbox.ten98.identify(e.local({}), options === undefined ? undefined : e.local(options))).status, 'not_sent');
  }
  assert.equal(e.identifyPayloads.length, count); assert.equal(e.sandbox.ten98.resetIdentity(scope(e)).ok, false);
  assert.equal(e.sandbox.ten98.resetIdentity(scope(e, {collectorOrigin: 'https://analytics.example.com'})).ok, true);
  e.sandbox.ten98.track('scoped'); await e.drain();
  const last = e.collectCalls().slice(-3).map(call => ({origin: new URL(call.url).origin, payload: JSON.parse(call.options.body)}));
  assert.equal(last.find(x => x.origin === 'https://analytics.example.com' && x.payload.siteKey === SITE)!.payload.dimensions.distinctId, undefined);
  assert.equal(last.find(x => x.payload.siteKey === SECOND_SITE)!.payload.dimensions.distinctId, 'secondary');
  assert.equal(last.find(x => x.origin === 'https://analytics-other.example.com')!.payload.dimensions.distinctId, 'other-origin');
  const test = makeEnv({environment: 'test'}); await test.start(); assert.equal((await identify(test, {}, 'test-id', {environment: 'test'})).status, 'not_sent');
  e.advance(60001); assert.equal(e.sandbox.ten98.resetIdentity(scope(e, {siteKey: SECOND_SITE})).ok, true);
});

test('identity generations reject late event and identify bodies across A to B to A', async () => {
  for (const kind of ['event', 'identify']) for (const phase of ['headers', 'body']) {
    const e = makeEnv(); await e.start(); await identify(e, {}, 'A');
    let release!: () => void, signal!: AbortSignal, cancelled = false;
    const stale = {accepted: true, duplicate: false, context: 'stale-' + kind + '-' + phase};
    e.flags.collectionResponse = (_payload, options) => {
      signal = options.signal;
      return phase === 'headers' ? new Promise(resolve => { release = () => resolve(reply(stale)); })
        : new Response(new ReadableStream({start(controller) { release = () => { if (!cancelled) { controller.enqueue(new TextEncoder().encode(JSON.stringify(stale))); controller.close(); } }; }, cancel() { cancelled = true; }}), {status: 202});
    };
    const pending = kind === 'identify' ? identify(e, {old: true}) : (e.sandbox.ten98.track('old'), null); await e.drain();
    e.flags.collectionResponse = null;
    await identify(e, {}, 'B'); await identify(e, {}, 'A');
    assert.equal(signal.aborted, true); release(); await e.drain(); if (pending) assert.equal((await pending).status, 'unknown');
    if (phase === 'body') assert.equal(cancelled, true, kind + ' cancels its deferred response body');
    e.sandbox.ten98.track('after_race'); await e.drain();
    assert.equal(e.payloads.at(-1)!.dimensions.distinctId, 'A'); assert.equal(e.payloads.at(-1)!.context, 'identified-synthetic-context', kind + '/' + phase);
  }
  const queued = makeEnv(); await queued.start(); const count = queued.collectCalls().length;
  const pending = identify(queued, {}, 'queued'); queued.sandbox.ten98.resetIdentity(scope(queued));
  assert.equal((await pending).status, 'not_sent'); assert.equal(queued.collectCalls().length, count);
  queued.sandbox.ten98.track('after_cancel'); await queued.drain(); assert.equal(queued.payloads.at(-1)!.dimensions.distinctId, undefined);
});

test('withdrawal expiry and privacy clear native identity while valid refresh preserves it', async () => {
  for (const action of ['reset', 'withdraw', 'cross-tab', 'storage-failure', 'configuration-expiry', 'consent-expiry', 'epoch', 'privacy']) {
    const options = {failStorage: false}, e = makeEnv(options); await e.start(); await identify(e, {}, 'old-id');
    const releases: Array<() => void> = [];
    e.flags.collectionResponse = () => {
      let cancelled = false;
      return new Response(new ReadableStream({start(controller) { releases.push(() => { if (!cancelled) { controller.enqueue(new TextEncoder().encode(JSON.stringify({accepted: true, duplicate: false, context: 'stale-cleanup'}))); controller.close(); } }); }, cancel() { cancelled = true; }}), {status: 202});
    };
    e.sandbox.ten98.track('held_event'); const pending = identify(e, {old: true}); await e.drain();
    if (action === 'reset') e.sandbox.ten98.resetIdentity(scope(e));
    if (action === 'withdraw') await e.grant(DENIED);
    if (action === 'cross-tab') e.dispatch('storage', {key: e.storageKey(), newValue: JSON.stringify({epoch: EPOCH, choice: DENIED, expiresAt: Date.now() + 86400000})});
    if (action === 'storage-failure') { options.failStorage = true; await e.grant(DENIED); options.failStorage = false; }
    if (action === 'configuration-expiry') { e.advance(60001); e.sandbox.ten98.track('expired'); await e.runTimers(30000); }
    if (action === 'consent-expiry') { e.advance(181 * 86400000); await e.runTimers(30000); }
    if (action === 'epoch') { e.flags.config = {consentEpoch: SECOND_SITE}; await e.runTimers(30000); }
    if (action === 'privacy') { e.sandbox.navigator.globalPrivacyControl = true; e.sandbox.ten98.track('privacy'); e.sandbox.navigator.globalPrivacyControl = false; }
    releases.forEach(resolve => resolve()); await e.drain(); assert.equal((await pending).status, 'unknown', action);
    e.flags.collectionResponse = null; await e.grant(); e.sandbox.ten98.track('after_cleanup'); await e.drain();
    assert.equal(e.payloads.at(-1)!.dimensions.distinctId, undefined, action); assert.notEqual(e.payloads.at(-1)!.context, 'stale-cleanup', action);
    await identify(e, {}, 'new-id'); await e.runTimers(30000); e.sandbox.ten98.track('same_config'); await e.drain(); assert.equal(e.payloads.at(-1)!.dimensions.distinctId, 'new-id', action);
    const count = e.payloads.length; e.dispatch('pagehide', {persisted: true}); e.dispatch('pageshow', {persisted: true}); e.dispatch('pageshow', {persisted: true}); await e.drain(); assert.equal(e.payloads.length, count + 1);
  }
});

test('identify outcomes distinguish validation expiry policy denial and uncertainty', async () => {
  const cases: Array<[number, unknown, string]> = [
    [202, {accepted: true, duplicate: false}, 'accepted'], [202, {accepted: true, duplicate: true}, 'accepted'],
    [202, {accepted: false, reason: 'identity_unavailable'}, 'identity_unavailable'],
    [202, {accepted: false, reason: 'collection_disabled'}, 'rejected'], [202, {accepted: false, reason: 'consent_required'}, 'rejected'],
    [400, {error: 'generic', reason: 'request_expired'}, 'expired'], [400, {error: 'generic future/invalid'}, 'invalid'], [409, {error: 'generic conflict'}, 'invalid'],
    [503, {error: 'generic'}, 'unknown'], [200, {accepted: true, duplicate: false}, 'unknown'], [202, null, 'unknown'],
    [202, {accepted: true}, 'unknown'], [202, {accepted: true, duplicate: true, context: 'unexpected'}, 'unknown'],
    [202, {accepted: true, duplicate: false, context: 1}, 'unknown'], [202, {accepted: true, duplicate: false, context: 'x'.repeat(1025)}, 'unknown'],
    [202, {accepted: true, duplicate: false, extra: 'secret-sentinel'}, 'unknown'], [202, {accepted: false, reason: 'unknown'}, 'unknown'],
  ];
  const e = makeEnv(); await e.start();
  for (const [status, body, expected] of cases) {
    e.flags.identifyStatus = status; e.flags.identifyResponse = body;
    const result = await identify(e, {plan: 'secret-sentinel'}, 'explicit-intent'); assert.equal(result.status, expected, JSON.stringify(body));
    if (expected === 'expired') assert.equal(result.reason, 'request_expired');
    assert.match(result.requestId, UUID_RE); assert.equal(new Date(result.sentAt).toISOString(), result.sentAt);
    assert.equal(JSON.stringify(result).includes('secret-sentinel'), false); assert.equal(JSON.stringify(result).includes('explicit-intent'), false);
    e.sandbox.ten98.track('after_outcome'); await e.drain(); assert.equal(e.payloads.at(-1)!.dimensions.distinctId, 'explicit-intent');
  }
  for (const text of ['{', 'x'.repeat(2049)]) { e.flags.collectionResponse = () => new Response(text, {status: 202}); assert.equal((await identify(e, {})).status, 'unknown'); }
  e.flags.collectionResponse = null;
  e.flags.fetchReject = true; assert.equal((await identify(e, {})).status, 'unknown'); e.flags.fetchReject = false;
  e.flags.fetchThrows = true; assert.equal((await identify(e, {})).status, 'unknown'); e.flags.fetchThrows = false;
  assert.equal(JSON.stringify(e.warnings).includes('secret-sentinel'), false);
});

test('identify keeps immutable request identity and never retries an unknown outcome', async () => {
  const e = makeEnv(); await e.start();
  e.flags.collectionResponse = () => new Promise(() => {});
  const properties = e.local({plan: 'original', tags: [1, false]});
  const pending = e.sandbox.ten98.identify('fixed-id', properties, scope(e)); properties.plan = 'mutated'; properties.tags.push('mutated'); await e.drain();
  const call = e.collectCalls().at(-1)!, exactBody = call.options.body, body = JSON.parse(exactBody);
  assert.deepEqual(body.properties, {plan: 'original', tags: [1, false]}); assert.match(body.requestId, UUID_RE); assert.equal(new Date(body.sentAt).toISOString(), body.sentAt);
  await e.runTimers(5000); const result = await pending; assert.equal(result.status, 'unknown'); assert.equal(result.requestId, body.requestId); assert.equal(result.sentAt, body.sentAt);
  const count = e.identifyPayloads.length; await e.runTimers(30000); await e.runTimers(5000); await e.drain();
  assert.equal(e.identifyPayloads.length, count); assert.equal(call.options.body, exactBody);
  e.flags.collectionResponse = null; await e.grant(DENIED); await e.grant(); assert.equal(e.identifyPayloads.length, count);
  const next = await identify(e, {plan: 'intentional update'}, 'fixed-id'); assert.equal(next.status, 'accepted'); assert.notEqual(next.requestId, body.requestId);
});

test('identify shares the native in-flight bound and leaves only consent in storage', async () => {
  const e = makeEnv(); await e.start(); await identify(e, {}, 'stable-id');
  const held: Array<() => void> = [];
  e.flags.collectionResponse = () => new Promise(resolve => held.push(() => resolve(reply({accepted: true, duplicate: false}))));
  const pending: Array<Promise<any>> = [];
  for (let i = 0; i < 10; i++) { e.sandbox.ten98.track('held'); pending.push(identify(e, {index: i})); }
  await e.drain(); assert.equal(held.length, 20);
  const count = e.collectCalls().length, blocked = await identify(e, {}, 'blocked-id'); assert.equal(blocked.status, 'not_sent'); assert.equal(blocked.reason, 'busy'); assert.equal(e.collectCalls().length, count);
  held.shift()!(); await e.drain(); e.sandbox.ten98.track('after_capacity'); await e.drain(); assert.equal(e.payloads.at(-1)!.dimensions.distinctId, 'stable-id');
  e.sandbox.ten98.resetIdentity(scope(e)); held.forEach(resolve => resolve()); await Promise.all(pending); await e.drain();
  e.flags.collectionResponse = null; assert.equal((await identify(e, {plan: 'profile-sentinel'}, 'identifier-sentinel')).status, 'accepted');
  assert.equal(e.storage.size, 1); assert.deepEqual(Object.keys(JSON.parse(e.storage.get(e.storageKey())!)).sort(), ['basicOptOut', 'choice', 'epoch', 'expiresAt', 'updatedAt', 'version']);
  assert.equal(JSON.stringify([...e.storage]).includes('sentinel'), false); assert.equal(JSON.stringify(e.warnings).includes('sentinel'), false);
  for (const primitive of ['crypto', 'TextEncoder', 'TextDecoder', 'ReadableStream', 'AbortController', 'fetch']) {
    const missing = makeEnv(); await missing.start(); missing.sandbox[primitive] = undefined;
    assert.equal((await identify(missing, {}, 'discard')).status, 'not_sent', primitive); assert.doesNotThrow(() => missing.history.pushState({}, '', '/safe')); await missing.drain();
    assert.equal(missing.identifyPayloads.length, 0);
  }
});

test('cookieless configuration starts exactly one basic observation without consent or persistent identity', async () => {
  const e = makeEnv({collectionMode: 'cookieless', destinations: [meta]}); e.run(); e.run(); await e.drain();
  assert.equal(e.payloads.length, 1); const payload = e.payloads[0] as any;
  assert.deepEqual(payload.collection, {mode: 'cookieless', epoch: EPOCH}); assert.equal(payload.consent, undefined);
  assert.equal(payload.dimensions.distinctId, undefined); assert.equal(e.storage.size, 0); assert.equal(e.scripts.length, 1);
  assert.equal((await identify(e, {plan: 'never-profile'}, 'never-identity')).status, 'not_sent'); assert.equal(e.identifyPayloads.length, 0);
  e.sandbox.ten98.track('feature_used', e.local({plan: 'free', nested: {enabled: true}})); await e.drain();
  assert.deepEqual(e.payloads.at(-1)!.properties, {plan: 'free', nested: {enabled: true}});
  e.history.pushState({}, '', '/next?secret=1#hidden'); e.history.replaceState({}, '', '/next'); await e.drain();
  assert.equal(e.payloads.filter(p => p.name === 'page_view').length, 2);
  e.dispatch('pageshow', {persisted: false}); e.dispatch('pageshow', {persisted: true}); e.dispatch('pageshow', {persisted: true}); await e.drain();
  assert.equal(e.payloads.filter(p => p.name === 'page_view').length, 3);
  assert.equal(JSON.stringify(e.payloads).includes('secret'), false); assert.equal(e.storage.size, 0);
});

test('a grant clears basic context and never doubles an attempted basic pageview, including uncertain receipts', async () => {
  for (const outcome of ['accepted', 'pending', 'rejected']) {
    const e = makeEnv({collectionMode: 'cookieless'}); e.flags.hold = outcome === 'pending'; e.flags.fetchReject = outcome === 'rejected';
    e.run(); await e.drain(); const original = e.collectCalls()[0].options.signal;
    e.flags.fetchReject = false; await e.grant(); assert.equal(e.payloads.length, 1, outcome); assert.equal(original.aborted, outcome === 'pending');
    await e.complete(); e.flags.hold = false; e.sandbox.ten98.track('after_grant'); await e.drain();
    const next = e.payloads.at(-1) as any; assert.equal(next.collection, undefined); assert.deepEqual(next.consent, {analytics: true, epoch: EPOCH}); assert.equal(next.context, undefined);
    assert.equal((await identify(e, {plan: 'explicit'}, 'explicit')).status, 'accepted');
  }
});

test('explicit refusal survives expiry and publication; a basic-only reset grants no richer permission', async () => {
  const now = Date.now(), old = {epoch: SECOND_SITE, choice: DENIED, updatedAt: now - 200 * 86400000, expiresAt: now - 21 * 86400000};
  const e = makeEnv({collectionMode: 'cookieless', preference: old}); e.run(); await e.drain(); assert.equal(e.payloads.length, 0);
  e.flags.config = {consentEpoch: SECOND_SITE}; await e.runTimers(30000); assert.equal(e.payloads.length, 0);
  assert.equal(e.sandbox.ten98.setAnalyticsOptOut(false, scope(e)).ok, true); await e.drain();
  assert.equal(e.payloads.length, 1); assert.equal((e.payloads[0] as any).consent, undefined); assert.equal((await identify(e, {}, 'forbidden')).status, 'not_sent');
  const record = JSON.parse(e.storage.get(e.storageKey())!); assert.equal(record.basicOptOut, false); assert.deepEqual(record.choice, DENIED);
  e.history.pushState({}, '', '/later'); await e.grant(DENIED); await e.drain(); const count = e.payloads.length;
  e.flags.config = {consentEpoch: EPOCH}; await e.runTimers(30000); e.sandbox.ten98.track('refused'); await e.drain(); assert.equal(e.payloads.length, count);
  assert.equal(JSON.parse(e.storage.get(e.storageKey())!).basicOptOut, true);
});

test('malformed or unreadable preferences block first basic collection; first-load unknown preferences write nothing', async () => {
  for (const opts of [{failRead: true}, {preference: ''}, {preference: 'null'}, {preference: '{'}, {preference: {version: 2, basicOptOut: false}}, {preference: {epoch: EPOCH, choice: DENIED, updatedAt: 1, expiresAt: 2, extra: true}}]) {
    const e = makeEnv({collectionMode: 'cookieless', ...opts}); e.run(); await e.drain(); e.sandbox.ten98.track('blocked'); await e.drain(); assert.equal(e.payloads.length, 0);
  }
  const e = makeEnv({collectionMode: 'cookieless'}); e.run(); await e.drain(); await e.runTimers(30000); assert.equal(e.storage.size, 0); assert.equal(e.payloads.length, 1);
  e.advance(60001); e.sandbox.ten98.track('expired'); await e.drain(); assert.equal(e.payloads.length, 1);
  assert.equal(JSON.parse(e.storage.get(e.storageKey())!).basicOptOut, false, 'Automatic invalidation must not invent an explicit refusal.');
});

test('publication does not recount an already dispatched page but can first observe a newly allowed page', async () => {
  for(const collectionMode of ['cookieless','consent-first'] as const) {
    const e=makeEnv({collectionMode});e.run();await e.drain();
    e.flags.config={consentEpoch:SECOND_SITE,nativeTracking:{enabled:true,consentMode:'external',captureReferrer:false,captureCampaigns:false,captureScreen:false,excludeBots:true,excludedPaths:[],collectionMode:'cookieless'}};
    await e.runTimers(30000);assert.equal(e.payloads.length,1,collectionMode);
  }
});

test('changing only basic opt-out never revokes or renews existing grants', async () => {
  const e=makeEnv({collectionMode:'cookieless'});e.run();await e.drain();await e.grant();
  const before=e.storage.get(e.storageKey());
  assert.equal(e.sandbox.ten98.setAnalyticsOptOut(false,scope(e)).ok,true);
  assert.equal(e.storage.get(e.storageKey()),before);
  assert.equal((await identify(e,{plan:'retained'},'retained')).status,'accepted');
  const now=Date.now(),choice={analytics:false,advertising:true,adUserData:true,adPersonalization:true};
  for(const expired of [false,true]) {
    const until=now+(expired?-1000:10000),f=makeEnv({collectionMode:'cookieless',preference:{version:2,basicOptOut:true,epoch:EPOCH,choice,updatedAt:now-10000,expiresAt:until}});
    f.run();await f.drain();f.advance(expired?0:10001);
    assert.equal(f.sandbox.ten98.setAnalyticsOptOut(false,scope(f,{acknowledgeReload:true})).ok,true);
    const saved=JSON.parse(f.storage.get(f.storageKey())!);assert.deepEqual(saved.choice,DENIED,'Expired purposes cannot be revived by clearing a basic refusal.');
  }
  const valid=makeEnv({collectionMode:'cookieless',preference:{version:2,basicOptOut:true,epoch:EPOCH,choice,updatedAt:now-1000,expiresAt:now+10000}});
  valid.run();await valid.drain();assert.equal(valid.sandbox.ten98.setAnalyticsOptOut(false,scope(valid,{acknowledgeReload:true})).ok,true);
  const saved=JSON.parse(valid.storage.get(valid.storageKey())!);assert.deepEqual(saved.choice,choice);assert.equal(saved.expiresAt,now+10000,'A valid grant keeps its original expiry.');
});

test('cross-tab opt-out revokes only its scoped basic stream and cannot restore enhanced grants', async () => {
  const e = makeEnv({collectionMode: 'cookieless'}); e.run(); await e.drain();
  e.setScript(SECOND_SITE, SCRIPT_SRC); e.run(); await e.drain(); assert.equal(e.payloads.length, 2);
  e.flags.hold = true; e.sandbox.ten98.track('pending'); await e.drain(); const requests = e.collectCalls().slice(-2);
  const now = Date.now(), refusal = {version: 2, basicOptOut: true, epoch: EPOCH, choice: DENIED, updatedAt: now, expiresAt: now + 10000};
  e.dispatch('storage', {key: e.storageKey(), newValue: JSON.stringify(refusal)});
  assert.equal(requests[0].options.signal.aborted, true); assert.equal(requests[1].options.signal.aborted, false);
  await e.complete(); e.flags.hold = false; e.sandbox.ten98.track('after_refusal'); await e.drain(); assert.equal(e.payloads.at(-1)!.siteKey, SECOND_SITE);
  const count = e.payloads.length; e.dispatch('storage', {key: e.storageKey(), newValue: JSON.stringify({...refusal, basicOptOut: false, choice: ANALYTICS})});
  assert.equal((await identify(e, {}, 'no-cross-tab-grant')).status, 'not_sent'); e.dispatch('storage', {key: null, newValue: null});
  e.sandbox.ten98.track('after_removal'); await e.drain(); assert.equal(e.payloads.length, count);
});

test('each browser privacy source vetoes cookieless events without granting or loading a vendor', async () => {
  for (const source of ['gpc', 'navigator', 'window', 'ms']) {
    const e = makeEnv({collectionMode: 'cookieless', destinations: [meta]});
    if (source === 'gpc') e.sandbox.navigator.globalPrivacyControl = true;
    else if (source === 'window') e.sandbox.doNotTrack = '1';
    else e.sandbox.navigator[source === 'ms' ? 'msDoNotTrack' : 'doNotTrack'] = 'yes';
    e.run(); await e.drain(); assert.equal(e.payloads.length, 0); assert.equal(e.scripts.length, 1);
    assert.equal(e.sandbox.ten98.setAnalyticsOptOut(false, scope(e)).ok, true); await e.grant(); assert.equal(e.payloads.length, 0);
  }
});

test('basic permission checks currently installed hook versions rather than a shared mutable stamp', async () => {
  const e = makeEnv({collectionMode: 'cookieless'}); e.run(); await e.drain(); const count = e.payloads.length;
  e.sandbox.__ten98FoundationHub.protocolVersion = 3;
  const current = e.sandbox.__ten98FoundationHub.nativeEvent; e.sandbox.__ten98FoundationHub.nativeEvent = () => {throw new Error('Legacy sender must not run');};
  e.sandbox.ten98.track('mixed'); await e.drain(); assert.equal(e.payloads.length, count);
  e.sandbox.__ten98FoundationHub.nativeEvent = current; e.sandbox.__ten98FoundationHub.nativeAllowed = () => true;
  e.sandbox.ten98.track('old_coordinator'); await e.drain(); assert.equal(e.payloads.length, count);
});

test('a synchronous external-CMP grant on readiness observes the current page only once', async () => {
  for (const collectionMode of ['cookieless', 'consent-first'] as const) {
    const e = makeEnv({collectionMode});
    e.sandbox.addEventListener('ten98:destinations-ready', () => e.sandbox.ten98.consent(e.local(ANALYTICS), scope(e, {acknowledgeReload: true})));
    e.run(); await e.drain(); assert.equal(e.payloads.length, 1, collectionMode);
    assert.equal((e.payloads[0] as any).collection, undefined, 'The known-undispatched basic attempt is replaced by one explicitly granted observation.');
    assert.equal(e.payloads[0].consent.analytics, true);
  }
});

test('malformed stored preferences are not overwritten by automatic invalidation, and privacy aborts basic work', async () => {
  const e = makeEnv({collectionMode: 'cookieless', preference: '{'}); e.run(); await e.drain(); e.advance(60001);
  e.sandbox.ten98.track('expired'); await e.drain(); assert.equal(e.storage.get(e.storageKey()), '{'); assert.equal(e.payloads.length, 0);
  const basic = makeEnv({collectionMode: 'cookieless'}); basic.flags.hold = true; basic.run(); await basic.drain();
  const signal = basic.collectCalls()[0].options.signal; basic.sandbox.navigator.globalPrivacyControl = true; basic.sandbox.ten98.track('veto');
  assert.equal(signal.aborted, true); await basic.complete(); assert.equal(basic.payloads.length, 1);
  basic.sandbox.ten98.setAnalyticsOptOut(false, scope(basic)); assert.equal(basic.storage.has(basic.storageKey()), false, 'Clearing an already-clear basic refusal writes no invented choice; privacy still vetoes collection.');
});

test('native responses enforce a streaming UTF-8 byte limit and cancel unread bytes for both request types', async () => {
  for (const kind of ['event', 'identify']) for (const mode of ['overflow', 'malformed', 'truncated', 'read-error', 'decoder-unavailable', 'exact-limit', 'split-valid']) {
    const e = makeEnv(); await e.start(); await identify(e, {}, 'stable');
    const valid = JSON.stringify({accepted: true, duplicate: false, context: 'bounded-é'}), encoder = new TextEncoder();
    const oversized = encoder.encode(JSON.stringify({accepted: true, duplicate: false, context: 'é'.repeat(1024)}));
    assert.ok(oversized.length > 2048 && new TextDecoder().decode(oversized).length < 2048, 'The overflow fixture distinguishes bytes from JS text length.');
    const split = encoder.encode(valid), unicode = split.indexOf(0xc3);
    const chunks = mode === 'overflow' ? [oversized.slice(0, 2000), oversized.slice(2000), new Uint8Array(1_000_000)]
      : mode === 'malformed' ? [new Uint8Array([0xc3, 0x28]), new Uint8Array(1_000_000)]
      : mode === 'truncated' ? [new Uint8Array([0xc3])]
      : mode === 'exact-limit' ? [encoder.encode(valid + ' '.repeat(2048 - encoder.encode(valid).length))]
      : [split.slice(0, unicode + 1), split.slice(unicode + 1)];
    let pulls = 0, cancels = 0;
    const stream = new ReadableStream<Uint8Array>({pull(controller) { const index = pulls++; if (mode === 'read-error') { controller.error(new Error('read failed')); return; } if (index < chunks.length) controller.enqueue(chunks[index]); else controller.close(); }, cancel() { cancels++; }}, {highWaterMark: 0});
    e.flags.collectionResponse = () => { if (mode === 'decoder-unavailable') e.sandbox.TextDecoder = undefined; return new Response(stream, {status: 202}); };
    const success = ['exact-limit', 'split-valid'].includes(mode);
    if (kind === 'identify') assert.equal((await identify(e, {})).status, success ? 'accepted' : 'unknown', mode);
    else { e.sandbox.ten98.track('bounded_response'); await e.drain(); }
    assert.equal(stream.locked, false, kind + '/' + mode + ' releases its reader');
    if (mode === 'overflow' || mode === 'malformed') { assert.equal(cancels, 1); assert.equal(pulls, mode === 'overflow' ? 2 : 1, 'Unread tail must never be pulled.'); }
    if (mode === 'decoder-unavailable') { assert.equal(cancels, 1); assert.equal(pulls, 0, 'A decoder lost after dispatch cancels without consuming the body.'); }
    e.sandbox.TextDecoder = TextDecoder;
    e.flags.collectionResponse = null; e.sandbox.ten98.track('after_stream'); await e.drain();
    assert.equal(e.payloads.at(-1)!.context, success ? 'bounded-é' : 'identified-synthetic-context', kind + '/' + mode);
  }
  const missing = makeEnv(); await missing.start(); let fallbackReads = 0;
  missing.flags.collectionResponse = () => ({status: 202, text() { fallbackReads++; return Promise.resolve('{"accepted":true,"duplicate":false}'); }});
  assert.equal((await identify(missing, {}, 'intent')).status, 'unknown'); assert.equal(fallbackReads, 0, 'No unbounded response.text fallback is allowed.');
});

// P40 additive tracker protocol checks. Metrics and adapter callbacks are explicit
// synthetic inputs; this VM does not run the embedded web-vitals implementation.
test('performance public configuration keeps optional true false and absent distinct and rejects a wrong-type flag', async () => {
  for(const flag of [undefined,false,true]){
    const e=makeEnv({performanceObserver:true,performanceAdapter:'ready',settings:flag===undefined?{}:{capturePerformance:flag}});
    assert.equal((await e.start()).ok,true);assert.equal(e.payloads.length,1,'A valid optional setting must not disable ordinary analytics');
    assert.equal(e.performanceCallbacks.length,flag===true?1:0);assert.equal(e.performancePayloads.length,0,'Starting observers does not invent a measurement');
  }
  for(const flag of ['true',1,null,{},[]]){
    const e=makeEnv({performanceObserver:true,performanceAdapter:'ready',settings:{capturePerformance:flag}});e.run();await e.drain();
    assert.equal((await e.grant()).ok,false,'Wrong-type config must stay unavailable');assert.equal(e.collectCalls().length,0);assert.equal(e.performanceCallbacks.length,0);
  }
});

test('five bounded performance metrics send only their anonymous native payload and never invoke advertising', async () => {
  const e=makeEnv({performanceObserver:true,performanceAdapter:'ready',destinations:[meta],pageUrl:'https://site.example/dashboard?utm_source=campaign-secret#fragment-secret',settings:{capturePerformance:true,captureScreen:true,captureCampaigns:true,captureReferrer:true}});
  await e.start();assert.equal(e.performanceCallbacks.length,1);await identify(e,{plan:'profile-secret'},'identifier-secret');
  assert.equal(e.performancePayloads.length,0);e.dispatch('pageshow',{persisted:true,timeStamp:1000});await e.drain();
  const values:[string,number][]=[['LCP',2500],['INP',200],['CLS',0],['FCP',1800],['TTFB',0]];
  for(const[name,value]of values)e.emitPerformance({name,value,navigationType:'back-forward-cache',navigationStartTime:1000,navigationURL:'https://private.example/?raw-secret',entries:[{text:'private DOM secret'}]});
  await e.drain();assert.equal(e.performancePayloads.length,5);assert.deepEqual(e.performancePayloads.map(payload=>payload.metric),['lcp','inp','cls','fcp','ttfb']);assert.deepEqual(e.performancePayloads.map(payload=>payload.value),[2500,200,0,1800,0]);assert.deepEqual(e.performancePayloads.map(payload=>payload.revision),[1,2,3,4,5]);
  const nav=e.performancePayloads[0].navigationId;assert.match(nav,UUID_RE);
  for(const payload of e.performancePayloads){assert.equal(payload.navigationId,nav);assert.equal(payload.siteKey,SITE);assert.equal(payload.url,'https://site.example/dashboard');assert.deepEqual(payload.consent,{analytics:true,epoch:EPOCH});assert.equal(payload.collection,undefined);assert.deepEqual(payload.dimensions,{screen:{width:1280,height:720}});assert.deepEqual(Object.keys(payload).sort(),['consent','dimensions','metric','navigationId','revision','siteKey','type','url','value']);}
  assert.doesNotMatch(JSON.stringify(e.performancePayloads),/identifier-secret|profile-secret|campaign-secret|fragment-secret|raw-secret|private DOM|referrer|language|context/);
  for(const call of e.performanceCalls()){assert.equal(call.options.credentials,'omit');assert.equal(call.options.referrerPolicy,'no-referrer');assert.equal(call.options.redirect,'error');assert.equal(call.options.keepalive,true);assert.equal(call.url,ENDPOINT);}
  assert.equal(e.scripts.some(script=>/facebook|tiktok|googletagmanager/.test(script.src)),false,'An analytics grant must not load an advertising SDK');
  const before=e.performancePayloads.length;
  for(const metric of [null,{}, {name:'OTHER',value:1},{name:3,value:1},{name:'LCP',value:'2'},{name:'CLS',value:-1},{name:'LCP',value:NaN},{name:'LCP',value:Infinity},{name:'CLS',value:1000.01},{name:'LCP',value:3600001}])e.emitPerformance(metric===null?null:{navigationType:'back-forward-cache',navigationStartTime:1000,...metric});
  await e.drain();assert.equal(e.performancePayloads.length,before,'Unknown or out-of-bound metrics must not create a request');
  for(const[name,value]of [['CLS',1000],['LCP',3600000]] as const)e.emitPerformance({name,value,navigationType:'back-forward-cache',navigationStartTime:1000});
  await e.drain();assert.deepEqual(e.performancePayloads.slice(-2).map(payload=>payload.value),[1000,3600000],'Inclusive legal metric ceilings remain accepted');
});

test('performance requires current collection permission browser support and privacy gates without queued event replay', async () => {
  const noGrant=makeEnv({performanceObserver:true,performanceAdapter:'ready',settings:{capturePerformance:true}});noGrant.run();await noGrant.drain();assert.equal(noGrant.performanceCallbacks.length,0);assert.equal(noGrant.collectCalls().length,0);
  noGrant.sandbox.ten98.track('before_permission');await noGrant.drain();assert.equal(noGrant.performanceCallbacks.length,0);await noGrant.grant();assert.equal(noGrant.performanceCallbacks.length,1);assert.equal(noGrant.performancePayloads.length,0,'A grant cannot synthesize earlier samples');
  for(const options of [{privacy:true},{dnt:'1'},{dnt:'yes'},{environment:'test'},{settings:{enabled:false}},{settings:{excludedPaths:['/dashboard']}},{performanceObserver:false}]){
    const e=makeEnv({performanceObserver:true,performanceAdapter:'ready',...options,settings:{capturePerformance:true,...options.settings}});await e.start();assert.equal(e.performanceCallbacks.length,0);assert.equal(e.performancePayloads.length,0);assert.equal(e.scripts.some(script=>new URL(script.src).pathname==='/performance.js'),false);
  }
  const basic=makeEnv({collectionMode:'cookieless',performanceObserver:true,performanceAdapter:'ready',settings:{capturePerformance:true}});basic.run();await basic.drain();assert.equal(basic.performanceCallbacks.length,1);basic.emitPerformance({name:'TTFB',value:0});await basic.drain();assert.deepEqual(basic.performancePayloads[0].collection,{mode:'cookieless',epoch:EPOCH});assert.equal(basic.performancePayloads[0].consent,undefined);assert.equal(basic.storage.size,0);
  basic.sandbox.navigator.globalPrivacyControl=true;const sent=basic.performancePayloads.length;basic.emitPerformance({name:'LCP',value:1});await basic.drain();assert.equal(basic.performancePayloads.length,sent);basic.sandbox.navigator.globalPrivacyControl=false;basic.emitPerformance({name:'LCP',value:2});await basic.drain();assert.equal(basic.performancePayloads.length,sent,'Clearing a privacy flag cannot reactivate a stopped document capture');
});

test('duplicate and multi-site initialization registers one performance callback per authorized site with one shared loader', async () => {
  const e=makeEnv({performanceObserver:true,performanceAdapter:'delayed',secondCollector:true,settings:{capturePerformance:true}});await e.start();e.run();e.run();await e.drain();assert.equal(e.performanceCallbacks.length,0);
  e.setScript(SECOND_SITE,SCRIPT_SRC);e.run();await e.drain();await e.grant(ANALYTICS,SECOND_SITE);assert.equal(e.scripts.filter(script=>new URL(script.src).pathname==='/performance.js').length,1);
  await e.loadPerformance();assert.equal(e.performanceCallbacks.length,2);await e.loadPerformance();assert.equal(e.performanceCallbacks.length,2,'A duplicate onload cannot register observers twice');
  e.emitPerformance({name:'LCP',value:1},0);e.emitPerformance({name:'LCP',value:2},1);await e.drain();assert.deepEqual(e.performancePayloads.map(payload=>payload.siteKey),[SITE,SECOND_SITE]);assert.notEqual(e.performancePayloads[0].navigationId,e.performancePayloads[1].navigationId);
  await e.grant(DENIED,SECOND_SITE);e.emitPerformance({name:'LCP',value:3},0);e.emitPerformance({name:'LCP',value:4},1);await e.drain();assert.deepEqual(e.performancePayloads.slice(2).map(payload=>payload.siteKey),[SITE]);
  e.setScript(SITE,'https://analytics-other.example.com/tracker.js');e.run();await e.drain();assert.equal(e.sandbox.ten98.consent(e.local(ANALYTICS),scope(e,{collectorOrigin:'https://analytics-other.example.com',acknowledgeReload:true})).ok,true);await e.drain();assert.equal(e.performanceCallbacks.length,3);
  e.emitPerformance({name:'LCP',value:5},2);await e.drain();assert.equal(e.performanceCalls().at(-1)!.url,'https://analytics-other.example.com/api/collect');assert.equal(e.scripts.filter(script=>new URL(script.src).pathname==='/performance.js').length,1);for(const name of ['pageshow','pagehide','popstate'])assert.equal(e.listeners.get(name)!.length,1);
});

test('SPA transitions prohibit late first document metrics while query and hash changes preserve a live capture', async () => {
  const late=makeEnv({performanceObserver:true,performanceAdapter:'ready',settings:{capturePerformance:true}});late.run();await late.drain();late.history.pushState({},'','/allowed?private=1#fragment');await late.grant();assert.equal(late.payloads.length,1);assert.equal(late.payloads[0].url,'https://site.example/allowed');assert.equal(late.performanceCallbacks.length,0,'First permission after a pathname change cannot attribute old navigation entries to the new page');
  const excluded=makeEnv({collectionMode:'cookieless',performanceObserver:true,performanceAdapter:'ready',pageUrl:'https://site.example/excluded',settings:{capturePerformance:true,excludedPaths:['/excluded']}});excluded.run();await excluded.drain();assert.equal(excluded.collectCalls().length,0);excluded.history.pushState({},'','/allowed');await excluded.drain();assert.equal(excluded.payloads.length,1);assert.equal(excluded.performanceCallbacks.length,0,'An initially excluded document cannot leak its load into an allowed SPA path');
  const e=makeEnv({performanceObserver:true,performanceAdapter:'ready',settings:{capturePerformance:true}});await e.start();e.emitPerformance({name:'LCP',value:1});await e.drain();const nav=e.performancePayloads[0].navigationId;
  e.history.pushState({},'','/dashboard?utm_source=private#secret');e.history.replaceState({},'','/dashboard?other=1');e.dispatch('popstate');e.emitPerformance({name:'LCP',value:2});await e.drain();assert.equal(e.performancePayloads.length,2);assert.equal(e.performancePayloads[1].navigationId,nav);assert.equal(e.payloads.length,1);
  e.flags.hold=true;e.emitPerformance({name:'CLS',value:0.1});await e.drain();const signal=e.performanceCalls().at(-1)!.options.signal;e.history.pushState({},'','/next');assert.equal(signal.aborted,true);e.flags.hold=false;await e.complete();
  const sent=e.performancePayloads.length;e.emitPerformance({name:'CLS',value:0.2});e.history.replaceState({},'','/dashboard');e.emitPerformance({name:'LCP',value:3});await e.drain();assert.equal(e.performancePayloads.length,sent);assert.equal(e.performanceCallbacks.length,1,'SPA back-to-origin must not register a second document observer');
});

test('current identity reset withdrawal privacy expiry and epoch stop performance until a genuinely eligible bfcache restore', async () => {
  for(const action of ['reset','identify','withdraw','opt-out','privacy','configuration-expiry','epoch']){
    const e=makeEnv({performanceObserver:true,performanceAdapter:'ready',settings:{capturePerformance:true}});await e.start();e.emitPerformance({name:'LCP',value:1});await e.drain();const nav=e.performancePayloads[0].navigationId;
    e.flags.hold=true;e.emitPerformance({name:'LCP',value:2});await e.drain();const signal=e.performanceCalls().at(-1)!.options.signal;e.flags.hold=false;
    if(action==='reset')assert.equal(e.sandbox.ten98.resetIdentity(scope(e)).ok,true);
    if(action==='identify')assert.equal((await identify(e,{plan:'private'},'changed-identity')).status,'accepted');
    if(action==='withdraw')await e.grant(DENIED);
    if(action==='opt-out')assert.equal(e.sandbox.ten98.setAnalyticsOptOut(true,scope(e,{acknowledgeReload:true})).ok,true);
    if(action==='privacy'){e.sandbox.navigator.globalPrivacyControl=true;e.emitPerformance({name:'CLS',value:0.2});e.sandbox.navigator.globalPrivacyControl=false;}
    if(action==='configuration-expiry'){e.advance(60001);e.sandbox.ten98.track('trigger_expiry');await e.runTimers(30000);}
    if(action==='epoch'){e.flags.config={consentEpoch:SECOND_SITE};await e.runTimers(30000);}
    assert.equal(signal.aborted,true,action+' aborts an owned performance request');await e.complete();const count=e.performancePayloads.length;e.emitPerformance({name:'LCP',value:3});await e.drain();assert.equal(e.performancePayloads.length,count,action);
    if(action==='opt-out')assert.equal(e.sandbox.ten98.setAnalyticsOptOut(false,scope(e,{acknowledgeReload:true})).ok,true);
    await e.grant();e.emitPerformance({name:'LCP',value:4});await e.drain();assert.equal(e.performancePayloads.length,count,'Fresh permission does not replay stopped original-document samples: '+action);
    e.dispatch('pagehide',{persisted:true});e.dispatch('pageshow',{persisted:true,timeStamp:2000});await e.drain();assert.equal(e.performancePayloads.length,count,'Restore alone fabricates no measurement');
    e.emitPerformance({name:'LCP',value:5,navigationType:'back-forward-cache',navigationStartTime:2000});await e.drain();assert.equal(e.performancePayloads.length,count+1,action+' preserves its existing registration for fresh authorized restore');assert.notEqual(e.performancePayloads.at(-1)!.navigationId,nav);assert.deepEqual(e.performancePayloads.at(-1)!.consent,{analytics:true,epoch:action==='epoch'?SECOND_SITE:EPOCH});assert.equal(e.performanceCallbacks.length,1);
    await e.grant(DENIED);e.dispatch('pagehide',{persisted:true});e.dispatch('pageshow',{persisted:true,timeStamp:3000});e.emitPerformance({name:'LCP',value:6,navigationType:'back-forward-cache',navigationStartTime:3000});await e.drain();assert.equal(e.performancePayloads.length,count+1,'A current refusal cannot be overridden by restoration: '+action);
  }
});

test('started bfcache captures use a fresh UUID and accept only vendor callbacks from that exact native restore window', async () => {
  const e=makeEnv({performanceObserver:true,performanceAdapter:'ready',settings:{capturePerformance:true}});await e.start();e.emitPerformance({name:'LCP',value:1,navigationType:'navigate',navigationStartTime:0});await e.drain();const original=e.performancePayloads[0].navigationId;
  e.dispatch('pageshow',{persisted:false,timeStamp:99});e.emitPerformance({name:'LCP',value:2,navigationType:'navigate',navigationStartTime:0});await e.drain();assert.equal(e.performancePayloads[1].navigationId,original);
  e.dispatch('pageshow',{persisted:true,timeStamp:100});await e.drain();const count=e.performancePayloads.length;assert.equal(count,2,'pageshow is not a metric');
  for(const metric of [{name:'CLS',value:0,navigationType:'navigate',navigationStartTime:0},{name:'LCP',value:3,navigationType:'back-forward-cache',navigationStartTime:99},{name:'LCP',value:3,navigationType:'soft-navigation',navigationStartTime:100},{name:'LCP',value:3}])e.emitPerformance(metric);
  await e.drain();assert.equal(e.performancePayloads.length,count,'Queued original and foreign-window callbacks cannot be relabeled by a mutable capture');e.emitPerformance({name:'LCP',value:4,navigationType:'back-forward-cache',navigationStartTime:100});await e.drain();const restored=e.performancePayloads.at(-1)!;assert.notEqual(restored.navigationId,original);assert.equal(restored.revision,1);
  e.dispatch('pageshow',{persisted:true,timeStamp:101});e.emitPerformance({name:'LCP',value:5,navigationType:'back-forward-cache',navigationStartTime:101});await e.drain();assert.equal(e.performancePayloads.length,count+1,'Duplicate pageshow does not change the active native window');
  e.dispatch('pagehide',{persisted:true});e.dispatch('pageshow',{persisted:true,timeStamp:200});e.emitPerformance({name:'CLS',value:0.1,navigationType:'back-forward-cache',navigationStartTime:100});await e.drain();assert.equal(e.performancePayloads.length,count+1);e.emitPerformance({name:'CLS',value:0,navigationType:'back-forward-cache',navigationStartTime:200});await e.drain();assert.equal(e.performancePayloads.length,count+2);assert.notEqual(e.performancePayloads.at(-1)!.navigationId,restored.navigationId);assert.equal(e.performancePayloads.at(-1)!.revision,1);assert.equal(e.performanceCallbacks.length,1,'Fresh restores reuse the one original adapter registration');
});

test('pending performance loader resolution before and after restore never duplicates setup or reconstructs missed samples', async () => {
  const before=makeEnv({performanceObserver:true,performanceAdapter:'delayed',settings:{capturePerformance:true}});await before.start();assert.equal(before.performanceCallbacks.length,0);await before.loadPerformance();assert.equal(before.performanceCallbacks.length,1);before.emitPerformance({name:'LCP',value:1});await before.drain();before.dispatch('pageshow',{persisted:true,timeStamp:500});await before.drain();assert.equal(before.performancePayloads.length,1);before.emitPerformance({name:'LCP',value:2,navigationType:'back-forward-cache',navigationStartTime:500});await before.drain();assert.equal(before.performancePayloads.length,2);await before.loadPerformance();assert.equal(before.performanceCallbacks.length,1);
  for(const transition of ['restore-before-load','inactive-before-load','loader-error','loader-timeout']){
    const e=makeEnv({performanceObserver:true,performanceAdapter:'delayed',settings:{capturePerformance:true}});await e.start();assert.equal(e.performanceCallbacks.length,0);
    if(transition==='restore-before-load')e.dispatch('pageshow',{persisted:true,timeStamp:600});
    if(transition==='inactive-before-load'){await e.grant(DENIED);await e.grant();}
    if(transition==='loader-error')await e.loadPerformance(false);
    if(transition==='loader-timeout')await e.runTimers(5000);
    await e.loadPerformance();assert.equal(e.performanceCallbacks.length,0,transition+' must not initialize buffered original-navigation data after the capture became ineligible');e.dispatch('pagehide',{persisted:true});e.dispatch('pageshow',{persisted:true,timeStamp:700});await e.drain();assert.equal(e.performanceCallbacks.length,0);assert.equal(e.performancePayloads.length,0,'No callback means no invented metric');assert.equal(e.scripts.filter(script=>new URL(script.src).pathname==='/performance.js').length,1,'Failed or missed adapter load is not implicitly retried');
  }
});

test('tracker propagates a nonempty CSP nonce to both local loaders without inventing an absent or empty nonce', async () => {
  for(const nonce of [undefined,'','trusted-document-nonce']){
    const e=makeEnv({scriptNonce:nonce,performanceObserver:true,performanceAdapter:'delayed',settings:{capturePerformance:true}});await e.start();
    const coordinator=e.scripts.filter(script=>new URL(script.src).pathname==='/destinations.js'),performance=e.scripts.filter(script=>new URL(script.src).pathname==='/performance.js');assert.equal(coordinator.length,1);assert.equal(performance.length,1);
    for(const loader of [...coordinator,...performance]){assert.equal(loader.nonce,nonce||undefined);assert.equal(new URL(loader.src).origin,'https://analytics.example.com');assert.equal(loader.referrerPolicy,'no-referrer');assert.equal(loader.crossOrigin,undefined,'Nonce propagation must not broaden script CORS');}
    await e.loadPerformance();assert.equal(e.performanceCallbacks.length,1);assert.equal(e.performancePayloads.length,0,'Loading with a nonce does not fabricate a metric');
  }
});
