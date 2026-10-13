// Opt-in production-shell check. Reuse a private synthetic navigation session;
// fixture event/job writes never reach the server. No direct DB/provider access.
import assert from 'node:assert/strict';
import {readFile, mkdir} from 'node:fs/promises';
import {isAbsolute, relative, resolve, sep} from 'node:path';
import {pathToFileURL} from 'node:url';

assert.equal(process.env.TEN98_SHELL_FLOW_BROWSER, '1', 'Explicit isolated-shell opt-in required.');
assert.ok(process.env.PLAYWRIGHT_MODULE, 'Supply the existing Playwright module.');
const privateRoot = resolve('private');
const fixturePath = resolve(process.env.TEN98_SHELL_FIXTURE ?? 'private/navigation-browser/review.json');
const insidePrivate = path => !isAbsolute(relative(privateRoot, path)) && !relative(privateRoot, path).split(sep).includes('..');
assert.ok(insidePrivate(fixturePath), 'Use a private synthetic navigation artifact.');
const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
assert.equal(fixture.synthetic, true);
const entry = new URL(fixture.url), origin = entry.origin;
assert.equal(entry.protocol, 'http:');
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(entry.hostname));
assert.ok(entry.port && !['3012', '55500'].includes(entry.port), 'Preserved preview/DB ports are forbidden.');
assert.ok(entry.username === '' && entry.password === '' && entry.hash === '', 'Fixture URL must not contain credentials or fragments.');
if (process.env.APP_URL) assert.equal(new URL(process.env.APP_URL).origin, origin);
const workspace = entry.searchParams.get('workspace'), project = entry.searchParams.get('project');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
assert.match(workspace ?? '', uuid); assert.match(project ?? '', uuid);
assert.equal(typeof fixture.state, 'string');
const statePath = resolve(fixture.state);
assert.ok(insidePrivate(statePath), 'Authentication state must remain in private artifacts.');
const moduleUrl = process.env.PLAYWRIGHT_MODULE.startsWith('file:') ? process.env.PLAYWRIGHT_MODULE : pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href;
const {chromium} = await import(moduleUrl);
const evidence = resolve('private/shell-flow-browser');
const website = 'https://' + 'source-'.repeat(8) + 'fixture.example.test';
const publicKey = 'synthetic-shell-public-key';
const retainedFrom = '2026-10-01T00:00:00.000Z';
const observedAt = '2026-10-14T06:07:08.000Z';
const rows = [
  {id:'shell-event-1', eventName:'pageview', origin:website, path:'/pricing/' + 'long-segment-'.repeat(16), receivedAt:observedAt},
  {id:'shell-event-2', eventName:'signup', origin:website, path:'/signup', receivedAt:'2026-10-13T12:13:14.000Z'},
];
const empty = {events:[], total:0, retainedFrom:null};
const populated = {events:rows, total:7, retainedFrom};
const jobRows = [
  {id:'shell-job-1', status:'completed', createdAt:observedAt, completedAt:observedAt, error:null},
  {id:'shell-job-2', status:'failed', createdAt:observedAt, completedAt:observedAt, error:'Synthetic worker diagnostic failure.'},
];
const href = view => origin + '/?' + new URLSearchParams({workspace, project, view});
let browser, page, stage = 'startup';
let role = 'viewer', longNames = false;
let eventReply = {body:empty}, jobReply = {body:{jobs:jobRows}};
let holdEvents = false, holdJobs = false, holdCheck = false;
let heldEvents, heldJobs, heldCheck;
let eventHeldResolve, jobHeldResolve, checkHeldResolve;
const calls = {events:0, jobs:0, check:0}, unexpected = [], errors = [], responsiveFindings = [];
const json = (route, reply) => route.fulfill({status:reply.status ?? 200, contentType:'application/json', body:JSON.stringify(reply.body)});

try {
  browser = await chromium.launch({headless:true, channel:process.env.PLAYWRIGHT_CHANNEL ?? 'msedge'});
  const context = await browser.newContext({storageState:statePath, viewport:{width:1440,height:900}, locale:'en-US', timezoneId:'UTC', serviceWorkers:'block'});
  await context.addInitScript(() => {
    window.__shellClipboardWrites = [];
    window.__shellClipboardFailure = false;
    Object.defineProperty(navigator, 'clipboard', {configurable:true, value:{writeText:async text => {
      if (window.__shellClipboardFailure) throw new DOMException('Synthetic clipboard denial', 'NotAllowedError');
      window.__shellClipboardWrites.push(text);
    }}});
  });
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname, method = request.method();
    if (url.origin !== origin) { unexpected.push('external request blocked'); return route.abort(); }
    if (!path.startsWith('/api/')) {
      if (method === 'GET') return route.continue();
      unexpected.push('non-GET asset blocked'); return route.abort();
    }
    // These three reads retain the existing authenticated synthetic scope. Only
    // display values/role are overlaid; this check does not prove server RBAC.
    if (method === 'GET' && ['/api/status', '/api/me', `/api/workspaces/${workspace}/projects`].includes(path)) {
      const response = await route.fetch({maxRedirects:0});
      assert.equal(response.status(), 200, 'Synthetic navigation authentication must still be valid.');
      const body = await response.json();
      if (path === '/api/status') { assert.equal(body.configured, true); body.appUrl = origin; }
      if (path === '/api/me') {
        const selected = body.workspaces.find(item => item.id === workspace);
        assert.ok(selected, 'Synthetic account retains selected workspace access.');
        selected.role = role;
        selected.name = longNames ? 'Workspace-' + 'long-name-'.repeat(12) : 'Shell fixture workspace';
      }
      if (path.endsWith('/projects')) {
        const selected = body.projects.find(item => item.id === project);
        assert.ok(selected, 'Synthetic project remains available.');
        Object.assign(selected, {name:longNames ? 'Project-' + 'long-name-'.repeat(12) : 'Shell fixture project', origin:website, publicKey, eventCount:41, lastEventAt:null, retainedFrom:null});
      }
      return json(route, {body});
    }
    if (path === `/api/projects/${project}/events` && method === 'GET') {
      calls.events++;
      if (holdEvents) { assert.equal(heldEvents, undefined); heldEvents = {route, reply:structuredClone(eventReply)}; eventHeldResolve(); return; }
      return json(route, eventReply);
    }
    if (path === `/api/projects/${project}/jobs` && method === 'GET') {
      calls.jobs++;
      if (holdJobs) { assert.equal(heldJobs, undefined); heldJobs = {route, reply:structuredClone(jobReply)}; jobHeldResolve(); return; }
      return json(route, jobReply);
    }
    if (path === `/api/projects/${project}/check-worker` && method === 'POST') {
      calls.check++;
      assert.equal(role, 'owner', 'Viewer must not expose the worker mutation.');
      const body = request.postDataJSON();
      assert.deepEqual(Object.keys(body), ['requestId']); assert.match(body.requestId, uuid);
      if (holdCheck) { assert.equal(heldCheck, undefined); heldCheck = {route, reply:{body:{}}}; checkHeldResolve(); return; }
      return json(route, {body:{}});
    }
    unexpected.push(method + ' unexpected API blocked');
    return route.abort();
  });
  page = await context.newPage(); page.setDefaultTimeout(12000);
  page.on('pageerror', () => errors.push('page error'));
  const main = page.getByRole('main', {name:'Main content', exact:true});
  const button = name => main.getByRole('button', {name, exact:true});
  const heading = name => main.getByRole('heading', {name, exact:true, level:1});
  const eventPanel = () => main.locator('section[aria-labelledby="ev-h"]');
  const eventRegion = () => main.getByRole('region', {name:'Retained event rows', exact:true});
  const snippetRegion = () => main.locator('pre[role="region"][aria-label="Tracking snippet"][tabindex="0"]');
  const diagnostics = () => main.locator('details').filter({has:page.locator('summary', {hasText:/^Background worker diagnostics$/})});
  const count = async expected => assert.equal((await eventPanel().locator('.big-num').innerText()).trim(), String(expected), 'Retained count stays exact.');
  const fmt = value => page.evaluate(value => new Date(value).toLocaleString(), value);
  const fit = async label => {
    const sizes = await page.evaluate(() => ({document:document.documentElement.scrollWidth, viewport:innerWidth}));
    if (sizes.document > sizes.viewport + 1) responsiveFindings.push(`${label}: document ${sizes.document}px exceeds viewport ${sizes.viewport}px.`);
  };
  const compactScope = async label => {
    const size = await main.locator('.app-bar').evaluate(bar => {
      const bounds = bar.getBoundingClientRect(), workspace = bar.querySelector('.breadcrumbs > span:first-child');
      const workspaceBox = workspace.getBoundingClientRect();
      return {height:bounds.height, workspaceLines:workspaceBox.height / parseFloat(getComputedStyle(workspace).lineHeight), contained:[bar.querySelector('.breadcrumbs'), bar.querySelector('.preview-badge')].every(element => {
        const box = element.getBoundingClientRect(); return box.top >= bounds.top - 1 && box.bottom <= bounds.bottom + 1;
      })};
    });
    // Four readable workspace lines and a separate badge fit comfortably within
    // 160px; a narrow vertical name column cannot consume the results viewport.
    if (size.height > 160 || size.workspaceLines > 4.1 || !size.contained) responsiveFindings.push(`${label}: scope header ${size.height}px, workspace ${size.workspaceLines.toFixed(1)} lines, content contained=${size.contained}.`);
  };
  const capture = async name => { await mkdir(evidence, {recursive:true}); await page.screenshot({path:resolve(evidence, name + '.png'), fullPage:true}); };
  const open = async view => {
    const reads = [page.waitForResponse(response => new URL(response.url()).pathname === `/api/projects/${project}/jobs`)];
    if (!holdEvents) reads.push(page.waitForResponse(response => new URL(response.url()).pathname === `/api/projects/${project}/events`));
    await Promise.all([page.goto(href(view)), ...reads]);
    await heading(view === 'events' ? 'Recent events' : 'Install tracker').waitFor();
  };
  const release = async held => { assert.ok(held, 'Expected a held synthetic request.'); await json(held.route, held.reply); };

  stage = 'skip link, compact header and empty state';
  await open('events'); await main.getByText('No retained events available.', {exact:true}).waitFor();
  await page.keyboard.press('Tab');
  const skip = page.getByRole('link', {name:'Skip to main content', exact:true});
  assert.equal(await skip.evaluate(element => element === document.activeElement), true, 'First Tab reaches skip link.');
  const skipBox = await skip.boundingBox(); assert.ok(skipBox && skipBox.y >= 0 && skipBox.height >= 44);
  assert.notEqual(await skip.evaluate(element => getComputedStyle(element).outlineStyle), 'none');
  const originalUrl = page.url();
  await page.keyboard.press('Enter');
  assert.equal(await main.evaluate(element => element === document.activeElement), true);
  assert.equal(page.url(), originalUrl);
  for (const modifier of ['Control', 'Meta']) {
    await skip.focus(); await skip.click({modifiers:[modifier]});
    assert.equal(page.url(), originalUrl, 'Modified skip activation cannot change identity fragment.');
    assert.equal(await main.evaluate(element => element === document.activeElement), true);
    assert.equal(context.pages().length, 1);
  }
  assert.equal(await main.getByRole('alert').count(), 0);
  assert.equal(await main.locator('h1').count(), 1);
  assert.equal(await main.getByRole('heading', {name:'Retained events', level:2, exact:true}).count(), 1);
  assert.equal(await main.getByText('No retained events available.', {exact:true}).count(), 1);
  assert.equal(await main.getByText('Events currently retained', {exact:true}).count(), 0);
  assert.equal(await main.locator('.proj-head > p.dim').count(), 0);
  assert.equal(await main.locator('.project-origin').innerText(), website);
  assert.equal(await main.getByText('Development preview', {exact:true}).count(), 1);
  assert.equal(await page.locator('.app-footer').count(), 0);
  await count(0); await capture('events-empty-1440');
  console.log('PASS shell: keyboard skip/hash preservation, one header/empty message and truthful preview status.');

  stage = 'event loading, retained rows, refresh and failure';
  const eventRequestStarted = new Promise(resolve => { eventHeldResolve = resolve; });
  eventReply = {body:populated}; holdEvents = true;
  await open('events'); await main.getByText('Loading events…', {exact:true}).waitFor();
  await eventRequestStarted;
  await count(41);
  assert.equal(await main.getByText('No retained events available.', {exact:true}).count(), 0);
  assert.equal(await eventPanel().getAttribute('aria-busy'), 'true');
  assert.equal(await button('Refreshing…').isDisabled(), true);
  await capture('events-loading');
  holdEvents = false; await release(heldEvents); heldEvents = undefined;
  await eventRegion().waitFor(); await count(7);
  assert.equal(await eventRegion().getAttribute('tabindex'), '0');
  assert.equal(await eventRegion().locator('table').getAttribute('aria-labelledby'), 'ev-h');
  assert.deepEqual(await eventRegion().locator('thead th').allTextContents(), ['Event','Origin','Path','Received']);
  assert.deepEqual(await eventRegion().locator('tbody tr').first().locator('td').allTextContents(), ['pageview',website,rows[0].path,await fmt(observedAt)]);
  assert.equal(await main.getByText(`History before ${await fmt(retainedFrom)} is unavailable after retention. This is not a lifetime total.`, {exact:true}).isVisible(), true);
  assert.equal(await main.getByText(`Last retained event received ${await fmt(observedAt)}`, {exact:true}).isVisible(), true);
  assert.equal(await main.getByText('Showing the latest 2 of 7 persisted events.', {exact:true}).isVisible(), true);
  await capture('events-populated');
  eventReply = {status:503, body:{error:'Synthetic event read unavailable.'}};
  await button('Refresh events').click(); await main.getByRole('alert').filter({hasText:'Synthetic event read unavailable.'}).waitFor();
  await count(7); assert.equal(await eventRegion().locator('tbody tr').count(), 2);
  await open('events'); await main.getByRole('alert').filter({hasText:'Synthetic event read unavailable.'}).waitFor();
  await count(41); assert.equal(await eventRegion().count(), 0);
  assert.equal(await main.getByText('No retained events available.', {exact:true}).count(), 0);
  await capture('events-error');
  eventReply = {body:empty}; await button('Refresh events').click();
  await main.getByText('No retained events available.', {exact:true}).waitFor(); await count(0);
  assert.equal(await main.getByRole('alert').count(), 0);
  console.log('PASS shell: loading is distinct from empty/error; retained counts, rows, timestamps and refresh recovery survive.');

  stage = 'installation snippet, clipboard recovery and scoped native link';
  await open('installation'); await snippetRegion().waitFor();
  const expectedSnippet = `<script defer src="${origin}/tracker.js" data-site-key="${publicKey}" referrerpolicy="no-referrer"></script>`;
  assert.equal(await snippetRegion().getAttribute('tabindex'), '0');
  assert.equal(await snippetRegion().locator('code').textContent(), expectedSnippet);
  assert.equal(await main.getByRole('heading', {name:'Tracking snippet', level:2, exact:true}).count(), 1);
  assert.equal(await main.locator('.proj-head > p.dim').count(), 0);
  await button('Copy snippet').click(); await main.getByText('Copied to clipboard.', {exact:true}).waitFor();
  assert.deepEqual(await page.evaluate(() => window.__shellClipboardWrites), [expectedSnippet]);
  await page.evaluate(() => { window.__shellClipboardFailure = true; });
  await button('Copy snippet').click();
  await main.getByRole('alert').filter({hasText:'Copy failed — select the snippet text above and copy it manually.'}).waitFor();
  assert.equal(await snippetRegion().locator('code').textContent(), expectedSnippet);
  await snippetRegion().locator('code').selectText();
  assert.equal(await page.evaluate(() => getSelection().toString()), expectedSnippet);
  const consent = main.getByText(/Earlier activity is discarded\./);
  assert.equal(await consent.isVisible(), true);
  assert.match(await consent.innerText(), /analytics consent.*localhost URL.*public HTTPS address/);
  assert.equal(await consent.locator('xpath=ancestor::details').count(), 0);
  const help = main.locator('details').filter({has:page.locator('summary', {hasText:/^Custom events and collection details$/})});
  assert.equal(await help.evaluate(element => element.open), false);
  assert.equal(await help.locator('summary').evaluate(element => getComputedStyle(element).display), 'list-item', 'Installation help retains its native disclosure marker.');
  const beforeHelp = {...calls}; await help.locator('summary').focus(); await page.keyboard.press('Enter');
  assert.match(await help.innerText(), /window\.ten98\.track\('signup', \{plan: 'starter'\}\)/);
  assert.match(await help.innerText(), /avoid personal data.*queries and fragments.*Vendor tags/);
  assert.deepEqual(calls, beforeHelp, 'Opening help starts no requests.');
  await help.locator('summary').click();
  const eventsLink = main.getByRole('link', {name:'View recent events', exact:true});
  const destination = new URL(await eventsLink.getAttribute('href'), origin);
  assert.equal(destination.origin, origin);
  assert.deepEqual(Object.fromEntries(destination.searchParams), {workspace, project, view:'events'});
  const installUrl = page.url(), opened = context.waitForEvent('page');
  await eventsLink.click({modifiers:['Control']});
  const tab = await opened; tab.setDefaultTimeout(12000);
  await tab.getByRole('heading', {name:'Recent events', level:1, exact:true}).waitFor();
  assert.equal(page.url(), installUrl); assert.equal(new URL(tab.url()).search, destination.search); await tab.close();
  await capture('installation-1440');
  await eventsLink.click(); await heading('Recent events').waitFor();
  assert.equal(new URL(page.url()).search, destination.search);
  assert.equal(await main.evaluate(element => element === document.activeElement), true);
  assert.equal(calls.check, 0, 'Copy/help/navigation do not start worker jobs.');
  console.log('PASS shell: exact snippet/copy fallback, visible consent/localhost limits and scoped normal/new-tab events links.');

  stage = 'worker diagnostics roles, busy state and errors';
  await open('installation'); await snippetRegion().waitFor();
  assert.equal(await diagnostics().evaluate(element => element.open), false);
  const beforeDiagnostics = {...calls}; await diagnostics().locator('summary').click();
  await main.getByText('Synthetic worker diagnostic failure.', {exact:true}).waitFor();
  assert.deepEqual(calls, beforeDiagnostics, 'Opening diagnostics starts no work.');
  assert.equal(await button('Run worker check').count(), 0);
  assert.equal(await main.locator('.jobs li').count(), 2);
  const jobRequestStarted = new Promise(resolve => { jobHeldResolve = resolve; });
  holdJobs = true; await button('Refresh status').click(); await jobRequestStarted;
  assert.equal(await button('Refreshing…').isDisabled(), true);
  assert.equal(await diagnostics().getAttribute('aria-busy'), 'true');
  holdJobs = false; await release(heldJobs); heldJobs = undefined;
  await button('Refresh status').waitFor();
  jobReply = {status:503, body:{error:'Synthetic worker status unavailable.'}};
  await button('Refresh status').click(); await main.getByRole('alert').filter({hasText:'Synthetic worker status unavailable.'}).waitFor();
  assert.equal(await main.locator('.jobs li').count(), 2);
  jobReply = {body:{jobs:jobRows}}; role = 'owner'; await open('installation');
  await diagnostics().locator('summary').click(); await button('Run worker check').waitFor();
  const checkRequestStarted = new Promise(resolve => { checkHeldResolve = resolve; });
  holdCheck = true; const checksBefore = calls.check; await button('Run worker check').click(); await checkRequestStarted;
  assert.equal(await button('Starting…').isDisabled(), true);
  assert.equal(await diagnostics().getAttribute('aria-busy'), 'true');
  assert.equal(calls.check, checksBefore + 1);
  holdCheck = false; await release(heldCheck); heldCheck = undefined;
  await button('Run worker check').waitFor(); assert.equal(await button('Run worker check').isEnabled(), true);
  assert.equal(calls.check, checksBefore + 1);
  role = 'viewer';
  console.log('PASS shell: separate worker evidence, viewer/owner display gates and exact explicit/busy/recovery controls (synthetic POST).');

  stage = 'responsive reflow, scroll regions, long names, RTL and forced colors';
  eventReply = {body:populated};
  for (const width of [320,360,768,1440]) {
    await page.setViewportSize({width,height:900});
    for (const view of ['events','installation']) {
      await open(view); const region = view === 'events' ? eventRegion() : snippetRegion(); await region.waitFor();
      await fit(view + ' ' + width);
      if (view === 'events') {
        const beforeSkip = page.url(); await page.keyboard.press('Tab');
        assert.equal(await skip.evaluate(element => element === document.activeElement), true, 'First Tab reaches skip at every viewport.');
        await page.keyboard.press('Enter');
        assert.equal(await main.evaluate(element => element === document.activeElement), true); assert.equal(page.url(), beforeSkip);
      }
      assert.equal(await region.getAttribute('tabindex'), '0');
      if (width <= 360) {
        for (const control of await main.locator('button, a.btn, details > summary').all()) {
          if (!await control.isVisible()) continue;
          const box = await control.boundingBox();
          if (!box || box.height < 44) responsiveFindings.push(`${view} ${width}: ${(await control.innerText()).trim()} touch target is ${box?.height ?? 'missing'}px; requires at least 44px.`);
        }
        if (view === 'events') for (const cell of await region.locator('tbody tr > td:first-child').all()) {
          const lines = await cell.evaluate(element => {
            const range = document.createRange(); range.selectNodeContents(element);
            return [...range.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0).length;
          });
          if (lines !== 1) responsiveFindings.push(`events ${width}: ${await cell.innerText()} event name wraps across ${lines} lines.`);
        }
        await region.focus(); await page.keyboard.press('ArrowRight');
        await page.waitForFunction(name => document.querySelector(`[role="region"][aria-label="${name}"]`).scrollLeft > 0, view === 'events' ? 'Retained event rows' : 'Tracking snippet');
      }
      await capture(view + '-' + width);
    }
  }
  longNames = true;
  for (const width of [320,768,1440]) {
    await page.setViewportSize({width,height:900}); await open('events'); await eventRegion().waitFor(); await fit('Long scope names ' + width); await compactScope('Long scope names ' + width);
    await page.evaluate(() => { document.documentElement.dir = 'rtl'; }); await fit('RTL long scope names ' + width); await compactScope('RTL long scope names ' + width);
    assert.equal(await main.getByText('Development preview', {exact:true}).isVisible(), true);
    await capture('events-long-scope-rtl-' + width);
  }
  longNames = false; await page.setViewportSize({width:1440,height:900}); await open('installation'); await snippetRegion().waitFor();
  // CSS layout zoom exercises 200% reflow; this is not a browser-chrome zoom claim.
  await page.evaluate(() => { document.documentElement.style.zoom = '2'; }); await fit('200% CSS layout zoom');
  assert.equal(await button('Copy snippet').isVisible(), true); await capture('installation-layout-zoom-200');
  await page.evaluate(() => { document.documentElement.style.zoom = ''; });
  await page.emulateMedia({forcedColors:'active', reducedMotion:'reduce'});
  await skip.focus(); assert.notEqual(await skip.evaluate(element => getComputedStyle(element).outlineStyle), 'none');
  await page.keyboard.press('Enter'); assert.equal(await main.evaluate(element => element === document.activeElement), true);
  await fit('Forced colors'); await capture('installation-forced-colors');
  assert.deepEqual(unexpected, []); assert.deepEqual(errors, []);
  assert.deepEqual(responsiveFindings, [], 'Responsive findings: ' + responsiveFindings.join(' '));
  console.log('PASS shell: 320/360/768/1440 reflow, keyboard scroll, long-name/RTL, 200% CSS layout zoom and forced-colors checks.');
} catch (error) {
  const location = /shell-flow-browser\.mjs:\d+:\d+/.exec(error?.stack ?? '')?.[0] ?? '';
  console.error(`FAIL shell flow at ${stage}: ${error instanceof Error ? error.name : 'Error'} ${location}. Private authentication and payloads are not printed.`);
  if (error instanceof assert.AssertionError && !error.generatedMessage) console.error(error.message);
  process.exitCode = 1;
} finally {
  for (const held of [heldEvents, heldJobs, heldCheck]) if (held) await held.route.abort().catch(() => {});
  await browser?.close();
}
