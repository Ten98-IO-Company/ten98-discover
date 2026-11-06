import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createServer} from 'vite';
import {launchChromium} from './helpers/playwright.mjs';
// Playwright is supplied externally; type only the browser surface exercised here.
type Locator = {getByRole(role: string, options?: {name?: string; exact?: boolean}): Locator; locator(selector: string): Locator; filter(options: {has?: Locator; hasText?: string | RegExp}): Locator; click(): Promise<void>; check(): Promise<void>; count(): Promise<number>; isVisible(): Promise<boolean>; isDisabled(): Promise<boolean>; isEnabled(): Promise<boolean>; getAttribute(name: string): Promise<string | null>; waitFor(options?: {state: 'visible' | 'hidden'}): Promise<void>; evaluate<R>(callback: (node: HTMLElement) => R | Promise<R>): Promise<R>};
type Response = {url(): string};
type Page = {setDefaultTimeout(timeout: number): void; addInitScript<A = void>(callback: (arg: A) => void, arg?: A): Promise<void>; on(event: 'pageerror', callback: (error: Error) => void): void; goto(url: string): Promise<unknown>; url(): string; locator(selector: string): Locator; getByRole(role: string, options?: {name?: string; exact?: boolean}): Locator; getByText(text: string, options?: {exact: boolean}): Locator; evaluate<R, A = void>(callback: (arg: A) => R | Promise<R>, arg?: A): Promise<R>; waitForFunction<A = void>(callback: (arg: A) => unknown, arg?: A): Promise<unknown>; waitForLoadState(state: 'networkidle', options: {timeout: number}): Promise<void>; waitForTimeout(timeout: number): Promise<void>; waitForResponse(callback: (response: Response) => boolean): Promise<Response>; screenshot(options: {path: string; fullPage?: boolean}): Promise<unknown>; clock: {install(): Promise<void>; runFor(milliseconds: number): Promise<void>}};
type Route = {request(): {url(): string; method(): string; postDataJSON(): unknown}; abort(reason?: string): Promise<void>; continue(): Promise<void>; fulfill(response: {status: number; headers: Record<string, string>; body: string}): Promise<void>};
type BrowserContext = {newPage(): Promise<Page>; route(pattern: string, callback: (route: Route) => Promise<void>): Promise<void>; unrouteAll(options: {behavior: 'wait'}): Promise<void>};
type Browser = {newContext(options: {serviceWorkers: 'block'; viewport: {width: number; height: number}}): Promise<BrowserContext>; contexts(): BrowserContext[]; close(): Promise<void>};
type RequestRecord = {path: string; method: string; body: unknown; search: string};
type Fixture = Window['recommendationsControllerFixture'];
assert.equal(process.env.TEN98_AI_RECOMMENDATIONS_BROWSER, '1');
const server = await createServer({configFile: false, envDir: false, root: process.cwd(), cacheDir: 'private/ai-recommendations-controller-cache', appType: 'custom', resolve: {dedupe: ['react', 'react-dom']}, optimizeDeps: {include: ['react', 'react-dom', 'react-dom/client', 'react/jsx-dev-runtime', '@ten98/ui', 'zod']}, server: {host: '127.0.0.1', port: 0, strictPort: true, hmr: false}});
server.middlewares.use((req, res, next) => {if (req.url !== '/') return next(); res.setHeader('content-type', 'text/html'); res.end('<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/tests/ai-recommendations-browser-fixture.tsx"></script></html>');});
let browser: Browser | undefined, context: BrowserContext | undefined, activeRoutes = 0;
const timeoutRoutes: Route[] = [];
async function drainRoutes() {
  const expiresAt = Date.now() + 5000;
  while (activeRoutes) {
    assert.ok(Date.now() < expiresAt, `${activeRoutes} request handlers did not finish before cleanup.`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
const deadline = setTimeout(() => {void browser?.close(); void server.close(); process.exitCode = 1;}, 120000);
try {
  await server.listen(); const address = server.httpServer?.address(); assert(address && typeof address !== 'string'); const origin = 'http://127.0.0.1:' + address.port;
  const launched: Browser = await launchChromium(); browser = launched; context = await launched.newContext({serviceWorkers: 'block', viewport: {width: 1280, height: 900}}); const page = await context.newPage(); page.setDefaultTimeout(5000);
  const scenario = process.env.TEN98_AI_RECOMMENDATIONS_SCENARIO ?? 'flows';
  const parentScenario = scenario === 'parent-retry' || scenario === 'parent-default-retry';
  if (parentScenario) await page.addInitScript(defaultScope => {window.recommendationsParentFixture = true; window.recommendationsDefaultScopeFixture = defaultScope;}, scenario === 'parent-default-retry');
  if (scenario === 'read-failures') await page.addInitScript(() => {
    // Retain the browser's real timeout signal/error; only shorten its wait.
    const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);
    AbortSignal.timeout = milliseconds => nativeTimeout(milliseconds === 45000 ? 300 : milliseconds);
  });
  const requests: RequestRecord[] = [], errors: string[] = [], outbound: string[] = [], held: (() => Promise<void>)[] = []; let mode = scenario === 'races' ? 'hold-detail' : 'normal', holdRemaining = 1, lostStart = false, detailStatus: Fixture['data']['detail']['run']['status'] = 'completed', generation = 0;
  page.on('pageerror', error => errors.push(error.message));
  await context.route('**/*', async route => {
    activeRoutes++;
    try {await (async () => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin) {outbound.push(request.url()); return route.abort();}
    if (!url.pathname.startsWith('/api/')) return route.continue();
    const body = request.postDataJSON(), path = url.pathname, projectId = path.split('/')[3]; requests.push({path, method: request.method(), body, search: url.search});
    if (requests.length > 100) return route.abort();
    const data = await page.evaluate(() => window.recommendationsControllerFixture.data);
    const respond = (value: unknown, status = 200) => {const text = JSON.stringify(value); return route.fulfill({status, headers: {'content-type': 'application/json', 'content-length': String(Buffer.byteLength(text))}, body: text});};
    if (mode === 'read-timeout' && (path.endsWith('/source') || path.endsWith('/openrouter-models'))) {timeoutRoutes.push(route); return;}
    if (mode === 'read-network' && (path.endsWith('/source') || path.endsWith('/openrouter-models'))) return route.abort('failed');
    if (['401', '403', '404'].includes(mode) && path.endsWith('/ai-opportunities')) return respond({error: 'Access unavailable'}, Number(mode));
    if (path.endsWith('/source')) {
      if (mode === 'source-malformed') return respond({...data.source, prompts: 'invalid'});
      if (mode === 'read-incomplete') {const text = JSON.stringify(data.source); return route.fulfill({status: 200, headers: {'content-type': 'application/json', 'content-length': String(Buffer.byteLength(text) + 10)}, body: text});}
      if (mode === 'source-failure') return respond({error: 'Current source failed'}, 500);
      if (mode === 'foreign') return respond({...data.source, projectId: '20000000-0000-4000-8000-000000000001'});
      return respond({...data.source, projectId, expectedSource: {...data.source.expectedSource, projectId, scope: body, contextRevision: generation + 1}});
    }
    if (path.endsWith('/openrouter-models')) return respond({role: 'owner', catalog: data.catalog});
    if (path.endsWith('/prepare')) {assert(body && typeof body === 'object' && 'requestId' in body && 'model' in body); return respond({...data.preparation, requestId: body.requestId, route: {...data.preparation.route, model: body.model}});}
    if (path.endsWith('/runs') && request.method() === 'POST') {
      if (mode === 'lost-start' && !lostStart) {lostStart = true; return route.abort('failed');}
      return respond({runId: data.detail.run.id, replayed: lostStart}, 202);
    }
    if (/\/(cancel|recover)$/.test(path)) {detailStatus = path.endsWith('/cancel') ? 'cancelled' : 'uncertain'; return respond({runId: path.split('/').at(-2), replayed: false});}
    if (/\/runs\/[^/]+$/.test(path)) {
      const id = path.split('/').at(-1);
      if (mode === 'hold-detail' && holdRemaining-- > 0) {const report = data.detail.run.report; assert(report); return new Promise<void>(done => held.push(async () => {try {await respond({...data.detail, projectId, run: {...data.detail.run, id, report: {...report, opportunities: report.opportunities.map(value => ({...value, title: 'Stale held recommendation'}))}}});} catch {} finally {done();}}));}
      if (mode === 'missing-detail') return respond({error: 'Not found'}, 404);
      return respond({...data.detail, projectId, run: {...data.detail.run, id, status: detailStatus, available: detailStatus === 'completed', canRecover: detailStatus === 'uncertain', report: detailStatus === 'completed' ? data.detail.run.report : null}});
    }
    if (path.endsWith('/ai-opportunities')) return respond({...data.history, projectId, connections: data.history.connections.map(value => ({...value, revision: generation + 1})), nextCursor: url.search ? null : 'page-two'});
    return respond({error: 'Unexpected route'}, 500);
    })();} finally {activeRoutes--;}
  });
  await page.goto(origin);
  const button = (name: string) => page.getByRole('button', {name, exact: true});
  const patch = (value: Parameters<Fixture['patch']>[0]) => page.evaluate(value => window.recommendationsControllerFixture.patch(value), value);
  const initial = await page.evaluate(() => window.recommendationsControllerFixture.initial);
  const saved = () => page.getByRole('heading', {name: '1. Saved recommendation', exact: true});
  const history = () => page.locator('details').filter({has: page.locator('summary').filter({hasText: /^Previous reports$/})});
  const openHistory = async () => {if (!await history().evaluate(node => (node as HTMLDetailsElement).open)) await history().locator('summary').click();};
  const refresh = async () => {await openHistory(); await button('Refresh reports').click();};
  const remount = async () => {generation++; await patch({...initial, userId: 'synthetic-user-' + generation});};
  if (parentScenario) {
    await saved().waitFor();
    const originalQuery = new URL(page.url()).searchParams.get('aiInsightsQuery');
    assert.equal(originalQuery === null, scenario === 'parent-default-retry');
    await page.getByRole('navigation', {name: 'API model reports', exact: true}).waitFor();
    await page.locator('summary').filter({hasText: /^Recommendation model and connection$/}).click();
    await page.getByRole('checkbox', {name: 'Synthetic model · openai/gpt-4.1', exact: true}).check();
    mode = 'lost-start'; const before = requests.length; await button('Run recommendations').click();
    await button('Retry same request').waitFor();
    await page.getByText('This action could not be confirmed.', {exact: false}).waitFor();
    const starts = () => requests.slice(before).filter(value => value.path.endsWith('/runs') && value.method === 'POST');
    assert.equal(starts().length, 1); const originalBody = starts()[0].body;
    await button('Creation (1)').click();
    await page.waitForFunction(() => new URL(location.href).searchParams.get('aiRecommendationsCategory') === 'creation');
    await saved().waitFor();
    assert.equal(await button('Retry same request').count(), 1, 'Parent category navigation must retain the original retry identity.');
    assert.equal(new URL(page.url()).searchParams.get('aiInsightsQuery'), originalQuery, 'Category selection must preserve the existing scope query representation.');
    await openHistory(); await history().getByRole('button').filter({hasText: '5 Nov 2026'}).click();
    await page.waitForFunction(() => new URL(location.href).searchParams.get('aiRecommendationsRun') === '10000000-0000-4000-8000-000000000007');
    await saved().waitFor();
    assert.equal(await button('Retry same request').count(), 1, 'Parent report navigation must retain the original retry identity.');
    assert.equal(new URL(page.url()).searchParams.get('aiInsightsQuery'), originalQuery, 'Report selection must preserve the existing scope query representation.');
    await button('Retry same request').click(); await page.waitForFunction(() => !document.body.textContent!.includes('Unconfirmed request'));
    // Clearing the retry precedes the selection effect's final detail/history reads.
    await page.waitForLoadState('networkidle', {timeout: 5000});
    await page.getByText('Loading selected report…', {exact: true}).waitFor({state: 'hidden'});
    await page.getByText('Loading report history…', {exact: true}).waitFor({state: 'hidden'});
    await saved().waitFor();
    await drainRoutes();
    assert.equal(starts().length, 2); assert.deepEqual(starts()[1].body, originalBody);
    assert.equal(requests.slice(before).filter(value => value.path.endsWith('/prepare') && value.method === 'POST').length, 1);
    assert.equal(new URL(page.url()).searchParams.get('aiRecommendationsRun'), initial.selectedRunId);
    assert.equal(new URL(page.url()).searchParams.get('aiRecommendationsCategory'), 'creation');
    assert.equal(new URL(page.url()).searchParams.get('aiInsightsQuery'), originalQuery);
    assert.equal(requests.some(value => value.path.includes('/prompt-insights')), false);
    console.log(`PASS actual AIInsightsPanel ${scenario} keeps lost-start retry identity across category and selected-report navigation; one prepare, identical start body/ID, original scope query preserved; ${requests.length} intercepted API requests.`);
  } else if (scenario === 'read-failures') {
    await saved().waitFor();
    const href = await page.locator('a').filter({hasText: 'Settings › Connections'}).getAttribute('href');
    assert(href);
    const navigation = await page.evaluate(href => window.recommendationsControllerFixture.parseConnectionsHref(href), href);
    mode = 'read-timeout'; await refresh();
    await page.waitForFunction(() => document.body.textContent!.includes('Model metadata unavailable') || document.body.textContent!.includes('The response could not be verified.'));
    const findings = [];
    if (!await saved().isVisible()) findings.push('Native read timeout purged the selected saved report.');
    if (!await page.getByText('Current source unavailable', {exact: true}).count()) findings.push('Missing independent source-timeout state.');
    if (!await page.getByText('Model metadata unavailable', {exact: true}).count()) findings.push('Missing independent catalog-timeout state.');
    if (navigation.view !== 'providers' || navigation.workspace !== initial.workspaceId || navigation.project !== initial.projectId || navigation.provider !== 'openrouter') findings.push('Connections href does not resolve to the native provider settings route.');
    assert.deepEqual(findings, []); assert.equal(await button('Run recommendations').isDisabled(), true);
    for (const failure of ['read-network', 'read-incomplete']) {
      mode = failure; await refresh(); await page.getByText('Current source unavailable', {exact: true}).waitFor();
      assert.equal(await saved().isVisible(), true); assert.equal(await button('Run recommendations').isDisabled(), true);
    }
    mode = 'source-malformed'; await refresh(); await page.getByText('The response could not be verified. Reopen the project to continue.', {exact: true}).waitFor(); assert.equal(await saved().count(), 0);
    mode = 'foreign'; await remount(); await page.getByText('The response could not be verified. Reopen the project to continue.', {exact: true}).waitFor(); assert.equal(await saved().count(), 0);
    console.log(`PASS native modelApi source/catalog timeouts, network and incomplete reads preserve saved reports; malformed/foreign DTOs purge; Connections href parses to scoped providers/openrouter; ${requests.length} intercepted API requests.`);
  } else if (scenario === 'races') {
    for (let i = 0; !held.length && i < 50; i++) await page.waitForTimeout(20);
    assert.equal(held.length, 1);
    const projectB = '20000000-0000-4000-8000-000000000001';
    await patch({projectId: projectB}); await saved().waitFor();
    await patch({projectId: initial.projectId}); await saved().waitFor();
    await held.shift()!(); assert.equal(await page.getByText('Stale held recommendation', {exact: false}).count(), 0);
    holdRemaining = 1; await refresh();
    for (let i = 0; !held.length && i < 50; i++) await page.waitForTimeout(20);
    assert.equal(held.length, 1);
    const anotherRun = '10000000-0000-4000-8000-000000000007';
    await patch({selectedRunId: anotherRun}); await saved().waitFor(); await held.shift()!();
    assert.equal(await page.getByText('Stale held recommendation', {exact: false}).count(), 0);
    mode = 'normal'; detailStatus = 'queued'; await page.clock.install(); await remount(); await button('Cancel queued request').waitFor();
    const details = () => requests.filter(value => /\/runs\/[^/]+$/.test(value.path) && value.method === 'GET').length;
    const started = details();
    for (let i = 0; i < 29; i++) {
      const response = page.waitForResponse(response => /\/runs\/[^/]+$/.test(new URL(response.url()).pathname));
      await page.clock.runFor(2000); await response; await page.waitForTimeout(10);
    }
    await page.getByText('Automatic status checks paused. Refresh reports to continue.', {exact: true}).waitFor();
    assert.equal(details() - started, 29);
    const stopped = details(); await page.clock.runFor(120000); assert.equal(details(), stopped);
    await patch({selectedRunId: null}); await page.clock.runFor(120000); assert.equal(details(), stopped);
    assert.equal(requests.filter(value => value.method === 'POST' && !value.path.endsWith('/source')).length, 0);
    console.log(`PASS project A/B/A and selected A/B held-response isolation; exactly 30 GET status reads, bounded polling and cleanup, no automatic mutations; ${requests.length} intercepted API requests.`);
  } else {
  await saved().waitFor(); assert.equal(requests.filter(value => /\/(prepare|runs|cancel|recover)$/.test(value.path) && value.method === 'POST').length, 0);
  mode = 'source-failure'; await refresh(); await page.getByText('Current source unavailable', {exact: true}).waitFor(); assert.equal(await saved().isVisible(), true); assert.equal(await button('Run recommendations').isDisabled(), true);
  mode = 'normal'; generation++; await patch({scope: {...initial.scope, tag: 'changed'}}); await saved().waitFor(); await page.locator('summary').filter({hasText: /^Saved report scope$/}).click(); await page.getByText('Tag: All tags', {exact: false}).waitFor();
  await page.locator('summary').filter({hasText: /^Recommendation model and connection$/}).click();
  await page.getByRole('checkbox', {name: 'Synthetic model · openai/gpt-4.1', exact: true}).check();
  await button('Run recommendations').waitFor({state: 'visible'}); assert.equal(await button('Run recommendations').isEnabled(), true);
  mode = 'lost-start'; const before = requests.length;
  await button('Run recommendations').evaluate(node => {node.click(); node.click();});
  await page.getByText('This action could not be confirmed.', {exact: false}).waitFor();
  assert.equal(await button('Model and source').isDisabled(), true, 'An unconfirmed request cannot jump to disabled settings.');
  assert.equal(await button('Retry same request').evaluate(node => {
    const report = document.querySelector('article');
    return Boolean(report && (node.compareDocumentPosition(report) & Node.DOCUMENT_POSITION_FOLLOWING));
  }), true, 'Original-request recovery remains before the retained report.');
  const actions = () => requests.slice(before).filter(value => /\/(prepare|runs)$/.test(value.path) && value.method === 'POST');
  assert.equal(actions().filter(value => value.path.endsWith('/prepare')).length, 1); assert.equal(actions().filter(value => value.path.endsWith('/runs')).length, 1);
  await button('Retry same request').click(); await saved().waitFor();
  await page.waitForFunction(() => !document.body.textContent!.includes('Unconfirmed request'));
  assert.equal(actions().filter(value => value.path.endsWith('/prepare')).length, 1); const starts = actions().filter(value => value.path.endsWith('/runs')); assert.equal(starts.length, 2); assert.deepEqual(starts[0].body, starts[1].body);
  mode = 'normal'; await openHistory(); await button('More reports').click(); await button('Previous report page').waitFor(); await button('Previous report page').click(); await button('More reports').waitFor(); assert.ok(requests.some(value => value.search === '?cursor=page-two'));
  detailStatus = 'queued'; await refresh(); await button('Cancel queued request').waitFor(); await button('Cancel queued request').click(); await page.getByText('Cancelled. This request did not produce a completed report.', {exact: true}).waitFor();
  detailStatus = 'uncertain'; await refresh(); await button('Check original request').waitFor(); const recoverBefore = requests.length; await button('Check original request').click(); await page.waitForFunction(() => !document.body.textContent!.includes('Unconfirmed request')); const recovery = requests.slice(recoverBefore).filter(value => value.method === 'POST' && !value.path.endsWith('/source')); assert.equal(recovery.length, 1); assert.equal(recovery[0].path, `/api/projects/${initial.projectId}/ai-opportunities/runs/${initial.selectedRunId}/recover`);
  detailStatus = 'completed'; mode = 'missing-detail'; await refresh(); await page.getByText('The selected report was not found. Choose another saved report.', {exact: true}).waitFor(); assert.equal(await saved().count(), 0);
  mode = 'foreign'; await remount(); await page.getByText('The response could not be verified. Reopen the project to continue.', {exact: true}).waitFor(); assert.equal(await saved().count(), 0); assert.equal(await button('Run recommendations').isDisabled(), true);
  for (const status of ['401', '403', '404']) {mode = status; await remount(); await page.getByText('Access unavailable', {exact: true}).waitFor(); assert.equal(await saved().count(), 0); assert.equal(await button('Run recommendations').isDisabled(), true);}
  assert.equal(await page.evaluate(() => window.recommendationsControllerFixture.unauthorized()), 1);
  mode = 'normal'; await remount(); await saved().waitFor();
  await mkdir(resolve('private/ai-recommendations-controller-evidence'), {recursive: true}); await page.screenshot({path: resolve('private/ai-recommendations-controller-evidence/controller.png'), fullPage: true});
  assert.deepEqual(errors, []); assert.deepEqual(outbound, []); assert.ok(requests.length <= 100); assert.equal(browser.contexts().length, 1);
  console.log(`PASS controller source/history isolation, saved scope, double-Run latch, lost-start same-ID retry, pagination/back, cancel, original recovery, missing detail and foreign/auth/project purges; ${requests.length} intercepted API requests, one context, zero external requests.`);
  }
  assert.deepEqual(errors, []); assert.deepEqual(outbound, []); assert.ok(requests.length <= 100); assert.equal(browser.contexts().length, 1);
} finally {
  try {
    // Native fetch abort does not finish Playwright's deliberately unanswered route.
    for (const route of timeoutRoutes) await route.abort('failed');
    await drainRoutes(); await context?.unrouteAll({behavior: 'wait'});
  }
  finally {await browser?.close(); await server.close(); clearTimeout(deadline);}
}
