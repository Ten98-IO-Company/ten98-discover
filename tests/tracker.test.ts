import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SRC = readFileSync(new URL('../public/tracker.js', import.meta.url), 'utf8');
const SCRIPT_SRC = 'https://analytics.example.com/tracker.js';
const ENDPOINT = 'https://analytics.example.com/api/collect';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

type Payload = { name: string; eventId: string; siteKey: string; url: string };

function makeEnv(opts: { siteKey?: string | null; scriptSrc?: string | null; environment?: string } = {}) {
  const siteKey = 'siteKey' in opts ? opts.siteKey : 'site-a';
  const scriptSrc = 'scriptSrc' in opts ? opts.scriptSrc : SCRIPT_SRC;

  const listeners = new Map<string, Array<(ev: any) => void>>();
  const warnings: string[] = [];
  const fetchCalls: Array<{ url: string; options: any }> = [];
  const payloads: Payload[] = [];
  const historyCalls: Array<{ method: string; thisArg: unknown; args: unknown[] }> = [];
  const injectedScripts: any[] = [];
  const flags = {
    fetchOk: true,
    fetchReject: false,
    fetchThrows: false,
    historyThrows: false,
    historyResult: undefined as unknown,
  };
  const location = { origin: 'https://site.example', pathname: '/dashboard', search: '', hash: '' };

  const native = (method: string) =>
    function (this: unknown, ...args: unknown[]) {
      historyCalls.push({ method, thisArg: this, args });
      if (flags.historyThrows) throw new Error('native history failure');
      const raw = args[2];
      if (raw !== undefined && raw !== null) {
        const u = new URL(String(raw), location.origin + location.pathname);
        location.origin = u.origin;
        location.pathname = u.pathname;
        location.search = u.search;
        location.hash = u.hash;
      }
      return flags.historyResult;
    };

  const history = { pushState: native('pushState'), replaceState: native('replaceState') };

  let counter = 0;
  const crypto = {
    getRandomValues(arr: Uint8Array): Uint8Array {
      counter += 1; // deterministic but unique per call
      for (let i = 0; i < arr.length; i++) arr[i] = (counter * 31 + i * 7) & 0xff;
      return arr;
    },
  };

  const fetchImpl = (url: unknown, options: any): Promise<{ ok: boolean }> => {
    fetchCalls.push({ url: String(url), options });
    if (flags.fetchThrows) throw new Error('fetch exploded');
    payloads.push(JSON.parse(options.body));
    if (flags.fetchReject) return Promise.reject(new Error('network down'));
    return Promise.resolve({ ok: flags.fetchOk });
  };

  const document: any = {
    currentScript: null,
    createElement() { return {}; },
    head: { appendChild(script: unknown) { injectedScripts.push(script); } },
    get cookie(): string {
      throw new Error('document.cookie must not be touched');
    },
  };

  const windowObj: any = {
    addEventListener(type: string, fn: (ev: any) => void) {
      const list = listeners.get(type) ?? [];
      list.push(fn);
      listeners.set(type, list);
    },
    removeEventListener() {},
    get localStorage(): unknown {
      throw new Error('localStorage must not be touched');
    },
    get sessionStorage(): unknown {
      throw new Error('sessionStorage must not be touched');
    },
  };

  const sandbox: Record<string, unknown> = {
    window: windowObj,
    document,
    history,
    location,
    crypto,
    fetch: fetchImpl,
    console: { warn: (msg: unknown) => warnings.push(String(msg)) },
    URL,
  };
  const context = vm.createContext(sandbox);

  const setScript = (key: string | null, src: string | null) => {
    document.currentScript =
      src === null
        ? null
        : { src, getAttribute: (attr: string) => (attr === 'data-site-key' ? key : attr === 'data-environment' ? opts.environment : null) };
  };
  setScript(siteKey ?? null, scriptSrc ?? null);

  const run = () => vm.runInContext(SRC, context, { filename: 'tracker.js' });
  const dispatch = (type: string, event: any) => {
    for (const fn of listeners.get(type) ?? []) fn(event);
  };

  return { sandbox, windowObj, document, history, location, listeners, warnings, fetchCalls, payloads, historyCalls, injectedScripts, flags, setScript, run, dispatch };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('one header loads the destination manager once and forwards sanitized URLs without changing collector properties', () => {
  const env = makeEnv(); env.run(); env.run();
  assert.equal(env.injectedScripts.length, 1);
  assert.equal(env.injectedScripts[0].src, 'https://analytics.example.com/destinations.js');
  assert.equal(env.injectedScripts[0].referrerPolicy, 'no-referrer');
  const forwarded: any[] = [];
  env.windowObj.__ten98FoundationHub.destinationEvent = (site: unknown, event: unknown) => forwarded.push({site,event});
  env.location.search = '?email=private'; env.location.hash = '#private';
  const properties = {value:'19.95',currency:'USD',transactionId:'order-1'};
  env.windowObj.ten98.track('purchase', properties);
  assert.equal(forwarded.length, 1); assert.equal(forwarded[0].event.url, 'https://site.example/dashboard');
  assert.equal(forwarded[0].event.eventId, env.payloads.at(-1)!.eventId);
  assert.equal(forwarded[0].event.properties, properties);
  assert.ok(!('properties' in env.payloads.at(-1)!));
  env.flags.fetchThrows = true;
  env.windowObj.ten98.track('sign_up');
  assert.equal(forwarded.length, 2, 'Collector failure must not disable independently consent-gated destinations.');
});

test('test environment can exercise destination hooks without contaminating native analytics', () => {
  const env = makeEnv({environment:'test'}); env.run();
  assert.equal(env.fetchCalls.length, 0); assert.equal(env.injectedScripts.length, 1);
  assert.equal(env.windowObj.__ten98FoundationHub.sites[0].environment, 'test');
  let calls = 0; env.windowObj.__ten98FoundationHub.destinationEvent = () => calls++;
  env.windowObj.ten98.track('sign_up');
  assert.equal(calls, 1); assert.equal(env.fetchCalls.length, 0);
  const invalid = makeEnv({environment:'invalid'}); invalid.run();
  assert.equal(invalid.fetchCalls.length, 0); assert.equal(invalid.injectedScripts.length, 0);
});

test('initial page_view payload and fetch options', () => {
  const env = makeEnv();
  env.run();
  assert.equal(env.fetchCalls.length, 1);
  const call = env.fetchCalls[0];
  assert.equal(call.url, ENDPOINT);
  assert.equal(call.options.method, 'POST');
  assert.equal(call.options.credentials, 'omit');
  assert.equal(call.options.referrerPolicy, 'no-referrer');
  assert.equal(call.options.mode, 'cors');
  assert.equal(call.options.keepalive, true);
  assert.equal(call.options.headers['Content-Type'], 'application/json');
  const p = env.payloads[0];
  assert.deepEqual(Object.keys(p).sort(), ['eventId', 'name', 'siteKey', 'url']);
  assert.equal(p.name, 'page_view');
  assert.equal(p.siteKey, 'site-a');
  assert.equal(p.url, 'https://site.example/dashboard');
  assert.match(p.eventId, UUID_RE);
});

test('pushState/replaceState: path change sends, query/hash-only and duplicates are suppressed', () => {
  const env = makeEnv();
  env.run();
  assert.equal(env.payloads.length, 1);

  env.history.pushState({}, '', '/dashboard?x=1'); // query only
  env.history.pushState({}, '', '/dashboard#frag'); // hash only
  env.history.pushState({}, '', '/dashboard'); // duplicate same path
  assert.equal(env.payloads.length, 1);

  env.history.pushState({}, '', '/settings?a=1#top'); // new path: payload url excludes query/hash
  assert.equal(env.payloads.length, 2);
  assert.equal(env.payloads[1].name, 'page_view');
  assert.equal(env.payloads[1].url, 'https://site.example/settings');

  env.history.replaceState({}, '', '/settings'); // same path
  assert.equal(env.payloads.length, 2);
  env.history.replaceState({}, '', '/profile'); // new path
  assert.equal(env.payloads.length, 3);
  assert.equal(env.payloads[2].url, 'https://site.example/profile');
});

test('popstate back/forward records page_view on path change only', () => {
  const env = makeEnv();
  env.run();
  env.history.pushState({}, '', '/a');
  env.history.pushState({}, '', '/b');
  assert.equal(env.payloads.length, 3);

  env.location.pathname = '/a'; // back
  env.dispatch('popstate', { state: null });
  assert.equal(env.payloads.length, 4);
  assert.equal(env.payloads[3].url, 'https://site.example/a');

  env.location.pathname = '/b'; // forward
  env.dispatch('popstate', { state: null });
  assert.equal(env.payloads.length, 5);

  env.location.search = '?z=1'; // same path, query only
  env.dispatch('popstate', { state: null });
  assert.equal(env.payloads.length, 5);
});

test('bfcache: exactly one restored page_view per restoration, ordinary pageshow is a no-op', () => {
  const env = makeEnv();
  env.run();
  env.dispatch('pageshow', { persisted: false }); // ordinary pageshow after initial
  assert.equal(env.payloads.length, 1);

  env.dispatch('pageshow', { persisted: true }); // restored from bfcache (same path)
  assert.equal(env.payloads.length, 2);
  assert.equal(env.payloads[1].name, 'page_view');
  assert.equal(env.payloads[1].url, 'https://site.example/dashboard');

  env.dispatch('pageshow', { persisted: true }); // duplicate persisted pageshow, same restoration
  assert.equal(env.payloads.length, 2);

  env.dispatch('pagehide', { persisted: true }); // cached again
  env.dispatch('pageshow', { persisted: true }); // next restoration
  assert.equal(env.payloads.length, 3);
});

test('repeated init with the same site key never doubles sends or listeners', () => {
  const env = makeEnv();
  env.run();
  env.run();
  env.run();
  assert.equal(env.payloads.length, 1);
  assert.equal(env.listeners.get('popstate')!.length, 1);
  assert.equal(env.listeners.get('pageshow')!.length, 1);
  assert.equal(env.listeners.get('pagehide')!.length, 1);

  env.history.pushState({}, '', '/once');
  assert.equal(env.payloads.length, 2);
  assert.equal(env.payloads.filter((p) => p.url.endsWith('/once')).length, 1);
});

test('multiple site keys share one hub and fan out', () => {
  const env = makeEnv();
  env.run();
  env.setScript('site-b', SCRIPT_SRC);
  env.run();
  assert.deepEqual(env.payloads.map((p) => p.siteKey), ['site-a', 'site-b']);

  env.history.pushState({}, '', '/multi');
  assert.equal(env.payloads.length, 4);
  const fanned = env.payloads.slice(2);
  assert.deepEqual(fanned.map((p) => p.siteKey).sort(), ['site-a', 'site-b']);
  assert.ok(fanned.every((p) => p.url === 'https://site.example/multi'));
  assert.equal(env.listeners.get('popstate')!.length, 1); // no double listeners
});

test('custom events: valid names tracked, invalid/reserved/non-string rejected', () => {
  const env = makeEnv();
  env.run();
  const track = env.windowObj.ten98.track;
  assert.equal(typeof track, 'function');
  env.payloads.length = 0;

  track('signup');
  track('a-b_c.d:e9');
  track('a'.repeat(64)); // max length
  assert.equal(env.payloads.length, 3);
  assert.equal(env.payloads[0].name, 'signup');
  assert.equal(env.payloads[1].name, 'a-b_c.d:e9');
  assert.deepEqual(Object.keys(env.payloads[0]).sort(), ['eventId', 'name', 'siteKey', 'url']);
  assert.equal(env.payloads[0].url, 'https://site.example/dashboard');
  assert.match(env.payloads[0].eventId, UUID_RE);

  for (const bad of ['', '1abc', '_lead', 'has space', 'a/b', 'a?b', 'a#b', 'a'.repeat(65), 'page_view', 'signup\n', 'signup\r']) track(bad);
  for (const bad of [123, null, undefined, {}, ['x'], true]) track(bad);
  assert.equal(env.payloads.length, 3);
});

test('every event carries a fresh UUIDv4', () => {
  const env = makeEnv();
  env.run();
  env.history.pushState({}, '', '/two');
  env.windowObj.ten98.track('signup');
  const ids = env.payloads.map((p) => p.eventId);
  assert.equal(ids.length, 3);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) assert.match(id, UUID_RE);
});

test('native history exceptions propagate untouched and record nothing', () => {
  const env = makeEnv();
  env.run();
  env.flags.historyThrows = true;
  assert.throws(() => env.history.pushState({}, '', '/boom'), /^Error: native history failure$/);
  assert.equal(env.payloads.length, 1);
  assert.equal(env.location.pathname, '/dashboard');

  env.flags.historyThrows = false;
  env.history.pushState({}, '', '/fine');
  assert.equal(env.payloads.length, 2);
});

test('patched history preserves this, arguments and return value', () => {
  const env = makeEnv();
  env.run();
  env.flags.historyResult = 'native-return';
  const customThis = { marker: 'custom-this' };
  const state = { deep: [1, 2, 3] };

  const ret = env.history.pushState.call(customThis, state, 'title', '/bound?x=1');
  assert.equal(ret, 'native-return');
  const call = env.historyCalls.at(-1)!;
  assert.equal(call.thisArg, customThis);
  assert.deepEqual(call.args, [state, 'title', '/bound?x=1']);
  assert.equal(env.payloads.at(-1)!.url, 'https://site.example/bound');

  env.history.replaceState(state, '', '/r2');
  assert.equal(env.historyCalls.at(-1)!.thisArg, env.history);
  assert.deepEqual(env.historyCalls.at(-1)!.args, [state, '', '/r2']);
});

test('rejected, not-ok and synchronously throwing fetch never break the host', async () => {
  const env = makeEnv();
  env.flags.fetchReject = true;
  assert.doesNotThrow(() => env.run());
  await tick();
  assert.equal(env.warnings.length, 1);

  env.flags.fetchReject = false;
  env.flags.fetchOk = false;
  env.history.pushState({}, '', '/warn');
  await tick();
  assert.equal(env.warnings.length, 2);

  env.flags.fetchOk = true;
  env.flags.fetchThrows = true;
  assert.doesNotThrow(() => env.history.pushState({}, '', '/still-fine'));
  assert.equal(env.location.pathname, '/still-fine');
  assert.equal(env.fetchCalls.length, 3);
  assert.equal(env.payloads.length, 2); // throwing fetch aborted before body parsing
});

test('missing crypto never breaks the host page', () => {
  const env = makeEnv();
  env.sandbox.crypto = undefined;
  assert.doesNotThrow(() => env.run());
  assert.equal(env.fetchCalls.length, 0);
  assert.equal(typeof env.windowObj.ten98.track, 'function');
  assert.doesNotThrow(() => env.history.pushState({}, '', '/x'));
  assert.doesNotThrow(() => env.windowObj.ten98.track('signup'));
  assert.equal(env.fetchCalls.length, 0);
  assert.equal(env.location.pathname, '/x');
});

test('a broken host console does not turn rejected requests into unhandled rejections', async () => {
  const env = makeEnv();
  env.sandbox.console = { warn() { throw new Error('host console failed'); } };
  env.flags.fetchReject = true;
  env.run();
  await tick();
  env.flags.fetchReject = false;
  env.flags.fetchOk = false;
  env.history.pushState({}, '', '/with-broken-console');
  await tick();
  assert.equal(env.payloads.length, 2);
});

test('invalid collector URL, missing currentScript or missing site key are silent no-ops', () => {
  const badUrl = makeEnv({ scriptSrc: 'not a url' });
  assert.doesNotThrow(() => badUrl.run());
  assert.equal(badUrl.fetchCalls.length, 0);
  assert.equal(badUrl.windowObj.ten98, undefined);

  const noScript = makeEnv({ scriptSrc: null });
  assert.doesNotThrow(() => noScript.run());
  assert.equal(noScript.fetchCalls.length, 0);

  const noKey = makeEnv({ siteKey: null });
  assert.doesNotThrow(() => noKey.run());
  assert.equal(noKey.fetchCalls.length, 0);
});

test('foreign window.ten98 is never overwritten', () => {
  const env = makeEnv();
  const foreign = { track: () => { throw new Error('foreign track must not be called'); } };
  env.windowObj.ten98 = foreign;
  env.run();
  assert.equal(env.windowObj.ten98, foreign);
  assert.equal(env.payloads.length, 1); // page tracking itself still works
  env.history.pushState({}, '', '/foreign');
  assert.equal(env.payloads.length, 2);
});

test('a non-writable history method preserves initial, custom, and remaining navigation tracking', () => {
  const env = makeEnv();
  const originalPush = env.history.pushState;
  Object.defineProperty(env.history, 'pushState', { writable: false });
  env.run();
  env.run();
  assert.equal(env.history.pushState, originalPush);
  assert.equal(env.payloads.length, 1);
  env.windowObj.ten98.track('signup');
  env.history.replaceState({}, '', '/replace-still-works');
  assert.equal(env.payloads.length, 3);
  assert.equal(env.listeners.get('popstate')!.length, 1);
});

test('tracker never touches cookies or storage (fake getters throw on access)', () => {
  const env = makeEnv();
  assert.throws(() => env.document.cookie, /cookie/);
  assert.throws(() => env.windowObj.localStorage, /localStorage/);
  env.run();
  env.history.pushState({}, '', '/clean');
  env.location.pathname = '/back';
  env.dispatch('popstate', { state: null });
  env.windowObj.ten98.track('signup');
  assert.equal(env.payloads.length, 4); // full flow completed without touching cookie/storage
});
