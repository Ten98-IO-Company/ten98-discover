// Closed-loop UI evidence only; native authorization and live Cloudflare acceptance are separate gates.
import assert from 'node:assert/strict';
import {mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {createServer} from 'vite';
import {launchChromium, setViewport} from './helpers/playwright.mjs';
import {cloudflareConnectionCheck, cloudflareConnectionSave, cloudflareConnectionDisconnect, type CloudflareConnectionMetadata} from '../src/lib/cloudflare-connections.ts';
// Playwright is supplied externally; describe only this fixture's exercised browser boundary.
type Locator = {getByRole(role: string, options?: {name?: string; exact?: boolean}): Locator; fill(value: string): Promise<void>; inputValue(): Promise<string>; press(key: string): Promise<void>; focus(): Promise<void>; click(): Promise<void>; count(): Promise<number>; isDisabled(): Promise<boolean>; getAttribute(name: string): Promise<string | null>; textContent(): Promise<string | null>; waitFor(options?: {state: 'hidden' | 'visible'}): Promise<void>};
type Dialog = {dismiss(): Promise<void>; accept(): Promise<void>};
type Page = {setDefaultTimeout(timeout: number): void; on(event: 'pageerror', callback: (error: Error) => void): void; once(event: 'dialog', callback: (dialog: Dialog) => Promise<void>): void; goto(url: string): Promise<unknown>; getByRole(role: string, options?: {name?: string; exact?: boolean}): Locator; getByText(text: string, options?: {exact: boolean}): Locator; getByLabel(text: string, options?: {exact: boolean}): Locator; evaluate<R>(callback: () => R | Promise<R>): Promise<R>; waitForFunction(callback: () => boolean): Promise<unknown>; waitForTimeout(milliseconds: number): Promise<void>; screenshot(options: {path: string; timeout?: number}): Promise<unknown>; isClosed(): boolean; keyboard: {press(key: string): Promise<void>}};
type Route = {request(): {url(): string; method(): string; postData(): string | null; postDataJSON(): unknown}; abort(): Promise<void>; continue(): Promise<void>; fulfill(options: {status: number; contentType: string; body: string}): Promise<void>};
type BrowserContext = {newPage(): Promise<Page>; route(pattern: string, callback: (route: Route) => Promise<void>): Promise<void>; close(): Promise<void>};
type Browser = {newContext(options: {viewport: {width: number; height: number}; serviceWorkers: 'block'; reducedMotion: 'reduce'}): Promise<BrowserContext>; close(): Promise<void>};
assert.equal(process.env.TEN98_CLOUDFLARE_BROWSER, '1'); assert.ok(process.env.PLAYWRIGHT_MODULE);
const P = '20000000-0000-4000-8000-000000000001', C = '50000000-0000-4000-8000-000000000001', stamp = '2026-11-06T05:00:00.000Z', B = '/api/projects/' + P + '/cloudflare/connections';
type Role = 'owner' | 'admin' | 'editor' | 'viewer';
type Mode = 'lost' | 'missing' | 'wrong-id' | 'wrong-revision' | 'conflict' | 'denied' | null;
let role: Role = 'owner', records: CloudflareConnectionMetadata[] = [], mode: Mode = null, readFailure: number | null = null, checkFailure: number | null = null;
let vault = true, empty = false, hold = false, held: {route: Route; revision: number} | null = null, requests = 0, contexts = 0, origin = '';
// launch/fresh initialize these before scenarios; cleanup also handles an early launch failure.
let browser!: Browser, context!: BrowserContext, page!: Page;
let writes: {path: string; body: string}[] = [], reads = 0, checks = 0;
let checkOverride: Record<string, unknown> = {};
const errors: string[] = [], unexpected: string[] = [], receipts = new Map<string, {requestId: string; operation: string; connectionId: string; revision: number}>();
const artifacts = resolve(process.env.TEN98_CLOUDFLARE_ARTIFACTS ?? resolve(tmpdir(), 'ten98-cloudflare-connections-browser')); mkdirSync(artifacts, {recursive: true});
const fixture = 'tests/cloudflare-connections-browser-fixture.tsx';
const server = await createServer({configFile: false, envDir: false, root: process.cwd(), cacheDir: resolve(artifacts, 'vite-cache'), appType: 'custom', resolve: {dedupe: ['react', 'react-dom']}, optimizeDeps: {entries: [fixture], include: ['react', 'react-dom/client', 'react/jsx-runtime', '@tanstack/react-router', '@ten98/ui']}, server: {host: '127.0.0.1', port: 0, strictPort: true, hmr: false}});
server.middlewares.use((req, res, next) => { if (req.url?.split('?')[0] !== '/') return next(); res.setHeader('content-type', 'text/html'); res.end('<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Synthetic Cloudflare connections</title><div id="root"></div><script type="module" src="/' + fixture + '"></script></html>'); });
const watchdog = setTimeout(() => process.exit(124), 120000); watchdog.unref();
const deadline = setTimeout(() => { void Promise.allSettled([context?.close(), browser?.close(), server.close()]).finally(() => process.exit(1)); }, 110000); deadline.unref();
const button = (name: string) => page.getByRole('button', {name, exact: true}), field = (name: string) => page.getByLabel(name, {exact: true});
const json = (route: Route, body: unknown, status = 200) => route.fulfill({status, contentType: 'application/json', body: JSON.stringify(body)});
const frame = () => page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
function saved(): CloudflareConnectionMetadata { return {id: C, accountId: 'a'.repeat(32), name: 'Example account', revision: 1, state: 'configured', createdAt: stamp, updatedAt: stamp, revokedAt: null}; }
function response() { return {projectId: P, role, vaultConfigured: vault, connections: records}; }
function heldCheck(): {route: Route; revision: number} { assert.ok(held); return held; }
function checked(revision: number) { return {projectId: P, connectionId: C, accountId: 'a'.repeat(32), revision, checkedAt: stamp,
  sites: empty ? [] : [{site_tag: 'b'.repeat(32), rules: [{host: 'example.test'}]}], capabilities: {enabled: !empty, availableFields: ['example_field'], maxPageSize: empty ? 0 : 100, maxNumberOfFields: 20, notOlderThan: 1000, maxDuration: empty ? 0 : 1000}}; }
async function fresh(nextRole: Role = 'owner', initial: CloudflareConnectionMetadata[] = []) {
  await context?.close(); role = nextRole; records = structuredClone(initial); mode = null; readFailure = null; checkFailure = null; checkOverride = {}; vault = true; empty = false; hold = false; held = null; writes = []; reads = 0; checks = 0; receipts.clear(); assert.ok(++contexts <= 24);
  context = await browser.newContext({viewport: {width: 1280, height: 1000}, serviceWorkers: 'block', reducedMotion: 'reduce'});
  await context.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url()), path = url.pathname;
    if (url.origin !== origin) { unexpected.push(url.href); return route.abort(); } if (!path.startsWith('/api/')) return req.method() === 'GET' ? route.continue() : route.abort();
    assert.ok(++requests <= 100);
    if (req.method() === 'GET' && path === B) { reads++; return readFailure ? json(route, {error: 'Do not display synthetic-secret.'}, readFailure) : json(route, response()); }
    if (req.method() === 'POST' && path === B + '/check') {
      checks++; const body = cloudflareConnectionCheck.parse(req.postDataJSON()); assert.equal(body.connectionId, C);
      if (hold) { held = {route, revision: body.expectedRevision}; return; }
      return checkFailure ? json(route, {error: 'Do not display synthetic-secret.'}, checkFailure) : json(route, {...checked(body.expectedRevision), ...checkOverride});
    }
    if (req.method() === 'POST' && (path === B || path === B + '/disconnect')) {
      const posted = req.postData(); assert.ok(posted); writes.push({path, body: posted});
      if (mode === 'denied' || mode === 'conflict') return json(route, {error: 'Do not display synthetic-secret.'}, mode === 'denied' ? 403 : 409);
      const operation = path.endsWith('/disconnect') ? 'disconnect' : 'save', saveBody = operation === 'save' ? cloudflareConnectionSave.parse(req.postDataJSON()) : null;
      const body = saveBody ?? cloudflareConnectionDisconnect.parse(req.postDataJSON()); let ack = receipts.get(body.requestId);
      if (!ack) {
        const prior = records[0]; assert.equal(body.expectedRevision, prior?.revision ?? 0);
        const row: CloudflareConnectionMetadata = {...(prior ?? saved()), name: saveBody?.name ?? prior!.name, revision: body.expectedRevision + 1, state: operation === 'disconnect' ? 'disconnected' : 'configured', revokedAt: operation === 'disconnect' ? stamp : null};
        records = [row]; ack = {requestId: body.requestId, operation, connectionId: C, revision: row.revision}; receipts.set(body.requestId, ack);
      }
      if (mode === 'lost') return route.abort();
      return json(route, {...response(), ...(mode === 'missing' ? {} : {ack: {...ack, ...(mode === 'wrong-id' ? {requestId: '60000000-0000-4000-8000-000000000001'} : {}), ...(mode === 'wrong-revision' ? {revision: ack.revision + 1} : {})}})});
    }
    unexpected.push(path); return json(route, {error: 'Unexpected synthetic endpoint'}, 404);
  });
  page = await context.newPage(); page.setDefaultTimeout(5000); page.on('pageerror', (cause: Error) => errors.push(cause.message)); await page.goto(origin); await page.getByRole('heading', {name: 'Cloudflare Web Analytics', exact: true}).waitFor(); await button('Refresh connections').waitFor(); await frame();
  await page.waitForFunction(() => !Array.from(document.querySelectorAll('button')).find(button => button.textContent === 'Refresh connections')?.disabled);
}
async function fill() { await field('Connection name').fill('Example account'); await field('Account ID').fill('a'.repeat(32)); await field('API token').fill('synthetic-secret'); }
async function accessChecked() { await page.getByText('Access checked. Reporting data is not imported yet.', {exact: true}).waitFor(); assert.equal(await field('API token').inputValue(), ''); }
async function disconnect() { await button('Disconnect account').click(); await page.getByRole('dialog', {name: 'Disconnect Cloudflare account?', exact: true}).getByRole('button', {name: 'Disconnect account', exact: true}).click(); }
try {
  await server.listen(); const address = server.httpServer?.address(); assert.ok(address && typeof address === 'object'); assert.equal(address.address, '127.0.0.1'); origin = 'http://127.0.0.1:' + address.port;
  await server.environments.client.transformRequest('/' + fixture); await server.environments.client.waitForRequestsIdle(); const optimizer = server.environments.client.depsOptimizer; assert.ok(optimizer); await optimizer.scanProcessing; await Promise.all(Object.values(optimizer.metadata.discovered).map(item => item.processing)); browser = await launchChromium();
  await fresh(); assert.equal(reads, 1); assert.equal(checks, 0); assert.equal(writes.length, 0); assert.equal(await field('API token').getAttribute('type'), 'password'); assert.equal(await field('API token').getAttribute('data-rrweb-mask'), 'true');
  await fill(); const help = page.getByRole('link', {name: 'Create a Cloudflare API token', exact: true}); assert.equal(await help.getAttribute('href'), 'https://dash.cloudflare.com/profile/api-tokens'); assert.equal(await help.getAttribute('target'), '_blank'); assert.equal(await help.getAttribute('rel'), 'noopener noreferrer'); assert.equal(await help.getAttribute('aria-disabled'), null); await field('API token').press('Enter'); await accessChecked(); assert.equal(writes.length, 1); assert.equal(checks, 1);
  await button('Refresh connections').click(); await frame(); assert.equal(checks, 1);
  await disconnect(); await page.getByText('Connection disconnected.', {exact: true}).waitFor(); assert.equal(checks, 1);
  await button('Reconnect account').click(); assert.equal(await field('Account ID').isDisabled(), true); await field('API token').fill('synthetic-secret'); await button('Save token and check access').click(); await accessChecked(); assert.equal(checks, 2); assert.equal(JSON.parse(writes[2].body).expectedRevision, 2);
  console.log('PASS one-click acknowledged save/check, masked/cleared secret, metadata-only refresh and disconnect/reconnect');
  for (const mismatch of ['lost', 'missing', 'wrong-id', 'wrong-revision'] as const) {
    await fresh(); await fill(); mode = mismatch; await button('Connect account').click(); await button('Retry same request').waitFor(); assert.equal(checks, 0); assert.equal(await field('API token').inputValue(), ''); assert.equal(await field('API token').isDisabled(), true); assert.equal(await button('Refresh connections').isDisabled(), true);
    const original = writes[0].body; mode = null; await button('Retry same request').click(); await accessChecked(); assert.equal(writes[1].body, original); assert.equal(checks, 1);
  }
  await fresh(); await fill(); mode = 'lost'; await button('Connect account').click(); await button('Retry same request').waitFor(); const original = writes[0].body; records = [{...records[0], revision: 3}]; mode = null; await button('Retry same request').click(); await page.getByText('Original request confirmed. Showing the latest connection; check access explicitly.', {exact: true}).waitFor(); assert.equal(writes[1].body, original); assert.equal(checks, 0); await button('Check access').click(); await accessChecked();
  await fresh('owner', [saved()]); mode = 'lost'; await disconnect(); await button('Retry same request').waitFor(); const removal = writes[0].body; mode = null; await button('Retry same request').click(); await page.getByText('Connection disconnected.', {exact: true}).waitFor(); assert.equal(writes[1].body, removal); assert.equal(checks, 0);
  console.log('PASS immutable ambiguous save/disconnect retries and no implicit check of a later revision');
  await fresh(); await fill(); checkFailure = 502; await button('Connect account').click(); await page.getByText('Check failed. Connection saved.', {exact: true}).waitFor(); assert.equal(await button('Retry same request').count(), 0); assert.equal(await page.getByText('Do not display synthetic-secret.', {exact: true}).count(), 0); checkFailure = null; empty = true; await button('Check access').click(); await accessChecked(); await page.getByText('No Web Analytics sites returned. This does not indicate zero traffic.', {exact: true}).waitFor(); await page.getByText('Analytics capability disabled for this account.', {exact: true}).waitFor(); assert.equal(writes.length, 1);
  for (const nextRole of ['admin', 'editor', 'viewer'] as const) { await fresh(nextRole, [saved()]); assert.equal(await field('API token').count(), 0); assert.equal(await button('Check access').count(), 0); assert.equal(await button('Disconnect account').count(), 0); assert.equal(checks, 0); }
  await fresh('owner', [saved()]); await button('Check access').click(); await accessChecked(); role = 'viewer'; await button('Refresh connections').click(); await field('API token').waitFor({state: 'hidden'}); assert.equal(await page.getByText('Access checked', {exact: true}).count(), 0);
  console.log('PASS configured check failure, explicit retry, honest empty/disabled capability and authoritative member-only metadata');
  for (const status of [401, 403, 404]) { await fresh('owner', [saved()]); readFailure = status; await button('Refresh connections').click(); if (status === 401) await page.getByRole('heading', {name: 'Fixture signed out'}).waitFor(); else await page.getByText('Cloudflare connections are no longer available.', {exact: true}).waitFor(); assert.equal(await field('API token').count(), 0); assert.equal(await page.getByText('Example account', {exact: true}).count(), 0); }
  await fresh('owner', [saved()]); hold = true; await button('Check access').click(); await page.getByText('Checking access…', {exact: true}).waitFor(); await page.waitForTimeout(50); const stale = heldCheck(); await page.evaluate(() => window.cloudflareFixture.user('30000000-0000-4000-8000-000000000002')); await page.waitForFunction(() => !document.body.textContent?.includes('Checking access…')); await json(stale.route, checked(stale.revision)).catch(() => {}); await frame(); assert.equal(await page.getByText('Access checked', {exact: true}).count(), 0);
  await fresh(); await fill(); mode = 'conflict'; await button('Connect account').click(); await button('Reload latest connections').waitFor(); assert.equal(await button('Connect account').isDisabled(), true); await button('Reload latest connections').click(); await page.getByRole('dialog', {name: 'Discard connection edits and refresh?', exact: true}).getByRole('button', {name: 'Refresh connections', exact: true}).click(); await field('Connection name').waitFor(); await frame(); assert.equal(await field('Connection name').inputValue(), ''); assert.equal(checks, 0);
  console.log('PASS authorization purge, identity-bound stale-response rejection and conflict reload');
  await fresh('owner', [saved()]);
  for (const override of [{projectId: '20000000-0000-4000-8000-000000000002'}, {connectionId: '50000000-0000-4000-8000-000000000002'}, {revision: 9}, {accountId: 'b'.repeat(32)}]) {
    checkOverride = override; await button('Check access').click(); await page.getByText('Check failed. Connection saved.', {exact: true}).waitFor(); assert.equal(await page.getByText('Access checked', {exact: true}).count(), 0);
  }
  await fresh(); await fill(); mode = 'lost'; await button('Connect account').click(); await button('Retry same request').waitFor(); await button('Leave fixture').click(); await frame(); assert.equal(await page.getByRole('heading', {name: 'Fixture destination'}).count(), 0);
  assert.equal(await page.evaluate(() => JSON.stringify([localStorage, sessionStorage]).includes('synthetic-secret')), false);
  mode = 'denied'; await button('Retry same request').click(); await page.getByText('Cloudflare connections are no longer available.', {exact: true}).waitFor(); assert.equal(await button('Retry same request').count(), 0); assert.equal(await field('API token').count(), 0);
  await fresh('owner', [saved()]); hold = true; await button('Check access').click(); await page.getByText('Checking access…', {exact: true}).waitFor(); await button('Leave fixture').click(); await page.getByRole('heading', {name: 'Fixture destination'}).waitFor();
  await fresh(); await fill(); page.once('dialog', dialog => dialog.dismiss()); await button('Leave fixture').click(); await frame(); assert.equal(await field('API token').inputValue(), 'synthetic-secret'); page.once('dialog', dialog => dialog.accept()); await button('Leave fixture').click(); await page.getByRole('heading', {name: 'Fixture destination'}).waitFor();
  console.log('PASS mismatched check identity/revision/account withheld, pending navigation blocked, write denial purges receipt and read-only check navigation allowed');
  await fresh('owner', [{...saved(), name: 'Long'.repeat(30)}]); await button('About required permissions').focus(); await page.getByRole('tooltip').waitFor(); assert.equal(await page.getByRole('tooltip').textContent(), 'Account Analytics: Read reads the account’s available analytics fields. Account Settings: Read lists its Web Analytics sites.'); await page.keyboard.press('Escape'); await page.screenshot({path: resolve(artifacts, 'cloudflare-desktop.png')});
  await setViewport(page, {width: 320, height: 900}); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), '320px page must not overflow'); await page.screenshot({path: resolve(artifacts, 'cloudflare-320.png')});
  vault = false; await button('Refresh connections').click(); await page.getByText('Credential storage is unavailable. Contact your instance operator before connecting an account.', {exact: true}).waitFor(); assert.equal(await button('Connect account').isDisabled(), true);
  assert.deepEqual(errors, []); assert.deepEqual(unexpected, []); console.log(`PASS keyboard help, 320px layout, disabled vault; ${requests}/100 requests, ${contexts}/24 contexts, zero external calls/page errors; captures ${artifacts}`);
} catch (cause) { if (page && !page.isClosed()) await page.screenshot({path: resolve(artifacts, 'failure.png'), timeout: 1000}).catch(() => {}); throw cause; }
finally { clearTimeout(deadline); await context?.close(); await browser?.close(); await server.close(); clearTimeout(watchdog); console.log('CLEANUP owned browser and loopback Vite stopped'); }
