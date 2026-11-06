import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createServer} from 'vite';
import {launchChromium, setViewport} from './helpers/playwright.mjs';
// Playwright is supplied externally; type only the browser surface exercised here.
type Locator = {getByRole(role: string, options?: {name?: string; exact?: boolean}): Locator; locator(selector: string): Locator; filter(options: {has?: Locator; hasText?: string | RegExp}): Locator; first(): Locator; focus(): Promise<void>; click(): Promise<void>; count(): Promise<number>; isVisible(): Promise<boolean>; isDisabled(): Promise<boolean>; getAttribute(name: string): Promise<string | null>; innerText(): Promise<string>; waitFor(): Promise<void>; evaluate<R>(callback: (node: HTMLElement) => R | Promise<R>): Promise<R>};
type Page = {setDefaultTimeout(timeout: number): void; on(event: 'pageerror', callback: (error: Error) => void): void; goto(url: string): Promise<unknown>; locator(selector: string): Locator; getByRole(role: string, options?: {name?: string; exact?: boolean}): Locator; getByText(text: string, options?: {exact: boolean}): Locator; evaluate<R, A = void>(callback: (arg: A) => R | Promise<R>, arg?: A): Promise<R>; screenshot(options: {path: string; fullPage?: boolean}): Promise<unknown>; keyboard: {press(key: string): Promise<void>}};
type Route = {request(): {url(): string; method(): string; resourceType(): string}; abort(): Promise<void>; continue(): Promise<void>};
type BrowserContext = {newPage(): Promise<Page>; route(pattern: string, callback: (route: Route) => Promise<void>): Promise<void>};
type Browser = {newContext(options: {serviceWorkers: 'block'; viewport: {width: number; height: number}}): Promise<BrowserContext>; contexts(): BrowserContext[]; close(): Promise<void>};
type Fixture = Window['aiRecommendationsFixture'];
declare global {interface Window {fixtureExecuted?: boolean}}
assert.equal(process.env.TEN98_AI_RECOMMENDATIONS_VIEW_BROWSER, '1');
const server = await createServer({configFile: false, envDir: false, root: process.cwd(), cacheDir: 'private/ai-recommendations-view-vite-cache', appType: 'custom', resolve: {dedupe: ['react', 'react-dom']}, optimizeDeps: {include: ['react', 'react-dom', 'react-dom/client', 'react/jsx-dev-runtime', '@ten98/ui']}, server: {host: '127.0.0.1', port: 0, strictPort: true, hmr: false}});
server.middlewares.use((req, res, next) => {if (req.url !== '/') return next(); res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Recommendations synthetic acceptance</title><div id="root"></div><script type="module" src="/tests/ai-recommendations-view-fixture.tsx"></script></html>');});
let browser: Browser | undefined;
const deadline = setTimeout(() => {void browser?.close(); void server.close(); process.exitCode = 1;}, 120000);
try {
  await server.listen();
  const address = server.httpServer?.address(); assert(address && typeof address !== 'string'); const origin = 'http://127.0.0.1:' + address.port;
  const launched: Browser = await launchChromium(); browser = launched;
  const context = await launched.newContext({viewport: {width: 1280, height: 720}, serviceWorkers: 'block'});
  const page = await context.newPage(); page.setDefaultTimeout(5000);
  const errors: string[] = [], outbound: string[] = []; let requests = 0;
  page.on('pageerror', error => errors.push(error.message));
  await context.route('**/*', route => {
    const request = route.request(), url = new URL(request.url()); requests++;
    if (requests > 100 || url.origin !== origin || request.method() !== 'GET' || ['fetch', 'xhr'].includes(request.resourceType()) || url.pathname.startsWith('/api/')) {outbound.push(url.pathname); return route.abort();}
    return route.continue();
  });
  await page.goto(origin);
  const button = (name: string) => page.getByRole('button', {name, exact: true});
  const patch = (value: Parameters<Fixture['patch']>[0]) => page.evaluate(value => window.aiRecommendationsFixture.patch(value), value);
  const reset = () => page.evaluate(() => window.aiRecommendationsFixture.reset());
  const calls = () => page.evaluate(() => window.aiRecommendationsFixture.calls());
  const initial = await page.evaluate(() => window.aiRecommendationsFixture.initial);
  const {detail, history: initialHistory, source: initialSource} = initial;
  assert(detail && initialHistory && initialSource);
  const initialRun = detail.run, initialReport = initialRun.report, initialEvidence = initialRun.savedEvidence;
  assert(initialReport && initialEvidence);
  const run = (value: Partial<typeof initialRun>) => patch({detail: {...detail, run: {...initialRun, ...value}}});
  await page.getByRole('heading', {name: 'Recommendations', exact: true}).waitFor();
  const firstCardTop = await page.locator('article').first().evaluate(node => node.getBoundingClientRect().top);
  const regressions = firstCardTop > 560 ? [`First recommendation starts at ${firstCardTop}px; expected at or above 560px.`] : [];
  for (const status of ['queued', 'running', 'uncertain', 'failed', 'cancelled'] as const) {
    await run({status, available: false, report: null, savedEvidence: null});
    if (await page.getByText('Report evidence unavailable or expired', {exact: true}).count()) regressions.push(`${status} incorrectly reports expired evidence.`);
  }
  await reset();
  assert.deepEqual(regressions, []);
  await mkdir(resolve('private/ai-recommendations-view-evidence'), {recursive: true});
  await page.screenshot({path: resolve('private/ai-recommendations-view-evidence/1280-720-initial.png')});
  const history = () => page.locator('details').filter({has: page.locator('summary').filter({hasText: /^Previous reports$/})});
  const scope = () => page.locator('details').filter({has: page.locator('summary').filter({hasText: /^Saved report scope$/})});
  assert.equal(await history().evaluate(node => (node as HTMLDetailsElement).open), false);
  assert.equal(await scope().evaluate(node => (node as HTMLDetailsElement).open), false);
  assert.equal(await button('Refresh reports').isVisible(), false);
  await history().locator('summary').focus(); await page.keyboard.press('Enter');
  await button('Refresh reports').focus(); await page.keyboard.press('Enter'); assert.equal((await calls()).at(-1)!.action, 'reload');
  const previousReport = history().getByRole('button').filter({hasText: 'example/previous'});
  await previousReport.focus(); await page.keyboard.press('Enter'); assert.deepEqual((await calls()).at(-1), {action: 'select', value: initialHistory.runs[1].id}); assert.equal(await page.locator('article').count(), 0);
  const currentReport = history().getByRole('button').filter({hasText: 'example/model'});
  await currentReport.focus(); await page.keyboard.press('Enter'); assert.deepEqual((await calls()).at(-1), {action: 'select', value: initial.selectedRunId}); assert.equal(await page.locator('article').count(), 4);
  assert.equal(await history().evaluate(node => (node as HTMLDetailsElement).open), false);
  await scope().locator('summary').focus(); await page.keyboard.press('Enter'); await page.getByText('Whole-word matching.', {exact: false}).waitFor();
  const visibleText = await page.locator('main').innerText();
  for (const raw of ['T00:00:00.000000Z', 'unicode-boundary-v1', initialEvidence.prompts[0].versionId]) assert.equal(visibleText.includes(raw), false);
  await scope().locator('summary').focus(); await page.keyboard.press('Enter');
  assert.equal(await button('Run recommendations').count(), 1);
  await button('Run recommendations').focus(); await page.keyboard.press('Enter'); assert.equal((await calls()).at(-1)!.action, 'run');
  await button('Creation (1)').focus(); await page.keyboard.press('Enter'); assert.equal(await button('Creation (1)').getAttribute('aria-pressed'), 'true'); assert.equal(await page.locator('article').count(), 1);
  const disclosure = page.locator('summary').filter({hasText: 'Related prompts (1)'}).first(); await disclosure.focus(); await page.keyboard.press('Enter'); await page.getByText('Original retained prompt', {exact: true}).waitFor();
  await page.getByText('Saved prompt version', {exact: true}).first().waitFor();
  await page.locator('summary').filter({hasText: 'Your citations (1)'}).first().click();
  const link = page.getByRole('link', {name: 'Retained page', exact: true}); assert.equal(await link.getAttribute('href'), 'https://example.com/retained'); assert.equal(await link.getAttribute('target'), '_blank'); assert.equal(await link.getAttribute('rel'), 'noopener noreferrer');
  assert.equal(await page.locator('main img,main script').count(), 0); assert.equal(await page.evaluate(() => window.fixtureExecuted), undefined);
  await reset();
  await patch({sourceError: 'Source request failed.', historyError: 'History request failed.', runError: 'New request failed.'});
  for (const title of ['Current source unavailable', 'Report history could not load', 'Recommendations could not start']) await page.getByText(title, {exact: true}).waitFor();
  assert.equal(await page.locator('article').count(), 4); assert.equal(await button('Run recommendations').isDisabled(), true);
  await reset(); await patch({source: null}); await page.getByText('Current answer source unavailable', {exact: true}).waitFor(); assert.equal(await page.locator('article').count(), 4); assert.equal(await button('Run recommendations').isDisabled(), true);
  await reset(); await patch({source: {...initialSource, availability: 'insufficient-evidence'}}); await page.getByText('No eligible retained answers', {exact: true}).waitFor(); assert.equal(await page.locator('article').count(), 4);
  await run({report: {...initialReport, opportunities: []}}); await page.getByText('No recommendations in this completed report', {exact: true}).waitFor();
  await run({available: false}); await page.getByText('Report evidence unavailable or expired', {exact: true}).waitFor(); assert.equal(await page.locator('article').count(), 0); assert.equal(await page.getByRole('link').count(), 0);
  await run({savedEvidence: null}); await page.getByText('Report evidence unavailable', {exact: true}).waitFor();
  for (const status of ['queued', 'running', 'uncertain', 'failed', 'cancelled'] as const) {await run({status, report: null, canRecover: status === 'uncertain'}); assert.equal(await page.locator('article').count(), 0); await page.locator('p[role="status"]').filter({hasText: status === 'uncertain' ? 'Outcome unknown' : status[0].toUpperCase() + status.slice(1)}).waitFor();}
  await run({status: 'queued', report: null}); await button('Cancel queued request').click(); assert.equal((await calls()).at(-1)!.action, 'cancel');
  await run({status: 'uncertain', report: null, canRecover: true}); await button('Check original request').click(); assert.equal((await calls()).at(-1)!.action, 'recover');
  await reset(); await patch({history: {...initialHistory, runs: []}, detail: null}); await page.getByText('No saved reports yet.', {exact: false}).waitFor();
  await reset(); await patch({history: null}); assert.equal(await page.locator('article').count(), 0); assert.equal(await button('Run recommendations').isDisabled(), true);
  await reset(); await run({savedEvidence: {...initialEvidence, prompts: [], citations: [{...initialEvidence.citations[0], url: 'javascript:alert(1)'}]}});
  await page.locator('summary').filter({hasText: 'Related prompts (1)'}).first().click(); await page.getByText('Related prompt evidence unavailable.', {exact: true}).first().waitFor();
  await page.locator('summary').filter({hasText: 'Your citations (1)'}).first().click(); await page.getByText('Retained citation evidence unavailable.', {exact: true}).first().waitFor(); assert.equal(await page.getByRole('link').count(), 0);
  await run({savedEvidence: {...initialEvidence, citations: []}}); await page.locator('summary').filter({hasText: 'Other retained evidence (1)'}).first().click(); await page.getByText('Retained citation evidence unavailable.', {exact: true}).first().waitFor();
  await reset(); await patch({history: {...initialHistory, role: 'viewer', canPrepare: false}, canRun: true}); assert.equal(await button('Run recommendations').isDisabled(), true);
  await reset(); await patch({running: true}); assert.equal(await button('Run recommendations').isDisabled(), true); assert.equal(await page.locator('article').count(), 4);
  await reset(); await mkdir(resolve('private/ai-recommendations-view-evidence'), {recursive: true});
  for (const width of [320, 768, 1280]) {
    await setViewport(page, {width, height: 1000});
    for (const scale of [100, 200]) {
      await page.evaluate(value => {document.documentElement.style.fontSize = value + '%';}, scale);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `No overflow at ${width}/${scale}`);
      await button('Social (1)').focus(); await page.keyboard.press('Enter'); assert.equal(await button('Social (1)').getAttribute('aria-pressed'), 'true');
      await button('All (4)').click();
      await page.screenshot({path: resolve('private/ai-recommendations-view-evidence', `${width}-${scale}.png`), fullPage: true});
    }
  }
  assert.deepEqual(errors, []); assert.deepEqual(outbound, []); assert.ok(requests <= 100); assert.equal(browser.contexts().length, 1);
  console.log(`PASS first recommendation at ${firstCardTop}px in 1280x720; pending states never imply expiry; keyboard history/reselection, formatted dates, safe evidence, error separation, 320/768/1280 at 100/200% text; ${requests} local requests, one context, zero external requests.`);
} finally {clearTimeout(deadline); await browser?.close(); await server.close();}
