import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import type {AddressInfo} from 'node:net';
import {randomUUID, randomBytes} from 'node:crypto';
import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {hashPassword} from 'better-auth/crypto';
import {getConfig} from '../src/server/config.ts';
import {assertSchema, closeDatabase, getDatabase} from '../src/server/db.ts';
import {createWorkspace} from '../src/server/teams.ts';
import {saveAnalyticsSettings} from '../src/server/native-analytics.ts';
import {getDestinations, saveDestinationsDraft, publishDestinations} from '../src/server/destinations.ts';

// Optional real-browser acceptance; no browser dependency belongs in production.
assert.equal(process.env.TEN98_INTEGRATION_TEST, '1', 'Use an isolated local browser fixture.');
const config = getConfig(), local = ['localhost', '127.0.0.1', '[::1]'];
assert.ok(local.includes(new URL(config.appUrl).hostname) && local.includes(new URL(config.databaseUrl).hostname));
assert.ok(process.env.PLAYWRIGHT_MODULE, 'Supply an installed Playwright module URL.');
const {chromium} = await import(process.env.PLAYWRIGHT_MODULE!);
const siteKey = randomUUID(), projectId = randomUUID();
const fixture = createServer((request, response) => {
  if (request.url === '/favicon.ico') { response.writeHead(204); response.end(); return; }
  response.writeHead(200, {'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store'});
  response.end(`<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Local consent fixture</title><body><h1>Local consent fixture</h1><p>Only synthetic local traffic is used.</p><script defer src="${config.appUrl}/tracker.js" data-site-key="${siteKey}"></script></body></html>`);
});
await new Promise<void>((resolve, reject) => { fixture.once('error', reject); fixture.listen(0, '127.0.0.1', resolve); });
const fixtureOrigin = `http://127.0.0.1:${(fixture.address() as AddressInfo).port}`;
let browser: any, releaseHeld: (() => void) | undefined;
try {
  await assertSchema();
  const {pool} = getDatabase(), userId = randomUUID(), email = `${randomUUID()}@native-browser.integration.test`, password = randomBytes(24).toString('base64url');
  await pool.query('INSERT INTO "user"(id,name,email) VALUES($1,$2,$3)', [userId, 'Native browser reviewer', email]);
  await pool.query('INSERT INTO account(id,"accountId","providerId","userId",password) VALUES($1,$2,$3,$2,$4)', [randomUUID(), userId, 'credential', await hashPassword(password)]);
  const {workspace} = await createWorkspace(userId, {name: 'Native browser sandbox'});
  await pool.query('INSERT INTO project(id,workspace_id,name,origin,public_key) VALUES($1,$2,$3,$4,$5)', [projectId, workspace.id, 'Native consent sandbox', fixtureOrigin, siteKey]);
  await saveAnalyticsSettings(projectId, userId, {revision: 1, settings: {enabled: true, consentMode: 'builtin', captureReferrer: false,
    captureCampaigns: false, captureScreen: false, excludeBots: false, excludedPaths: ['/private']}});
  const destination = (assetId: string) => ({provider: 'meta', assetId, enabled: true, owner: 'managed', ownershipConfirmed: true, mappings: [{event: 'page_view'}]});
  async function publish(assetId: string) {
    const current = await getDestinations(projectId, userId, 'live');
    const draft = await saveDestinationsDraft(projectId, userId, 'live', {expectedVersion: current.draftVersion, configuration: {destinations: [destination(assetId)]}});
    await publishDestinations(projectId, userId, 'live', {expectedVersion: draft.draftVersion});
  }
  await publish('123');
  browser = await chromium.launch({channel: process.env.PLAYWRIGHT_CHANNEL ?? 'msedge', headless: true});
  const context = await browser.newContext();
  const outbound: string[] = [], events: any[] = [];
  const blockExternal = async (route: any) => {
    const url = new URL(route.request().url());
    if (![config.appUrl, fixtureOrigin].includes(url.origin)) { outbound.push(url.hostname); await route.abort(); }
    else await route.continue();
  };
  await context.route('**/*', blockExternal);
  const signIn = await context.request.post(`${config.appUrl}/api/auth/sign-in/email`, {headers: {origin: config.appUrl}, data: {email, password}});
  assert.equal(signIn.status(), 200);
  assert.ok((await context.cookies(config.appUrl)).some((cookie: any) => cookie.name.includes('session_token')));
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  await page.clock.install();
  page.on('request', (request: any) => {
    if (request.url() === `${config.appUrl}/api/collect`) {
      assert.equal(request.headers()['cookie'], undefined);
      events.push(request.postDataJSON());
    }
  });
  const preferences = () => page.getByRole('button', {name: `Tracking preferences for ${config.appUrl}`, exact: true});
  const dialog = () => page.getByRole('dialog', {name: 'Tracking preferences', exact: true});
  async function grant(all = false) {
    await preferences().click();
    await dialog().getByRole('checkbox', {name: 'Analytics', exact: true}).check();
    if (all) for (const name of ['Advertising', 'Ad user data', 'Ad personalization']) await dialog().getByRole('checkbox', {name, exact: true}).check();
    const receipt = page.waitForResponse((response: any) => response.url() === `${config.appUrl}/api/collect` && response.request().method() === 'POST');
    await dialog().getByRole('button', {name: 'Save choices', exact: true}).click();
    assert.equal((await (await receipt).json()).accepted, true);
  }
  const count = async () => Number((await pool.query('SELECT count(*) FROM event WHERE project_id=$1', [projectId])).rows[0].count);
  await page.goto(`${fixtureOrigin}/before?private=hidden#secret`, {waitUntil: 'networkidle'});
  await preferences().waitFor();
  await page.evaluate(() => {
    history.pushState({}, '', '/old');
    (window as any).ten98.track('before_grant', {private: 'never-replayed'});
    history.pushState({}, '', '/current?secret=hidden#secret');
  });
  assert.equal(events.length, 0); assert.equal(await count(), 0); assert.equal(outbound.length, 0);
  await grant(true);
  assert.equal(events.length, 1); assert.equal(await count(), 1);
  assert.equal(events[0].name, 'page_view'); assert.equal(events[0].url, `${fixtureOrigin}/current`);
  assert.equal(events[0].properties, undefined); assert.equal(events[0].context, undefined); assert.equal(outbound.length, 0, 'A new grant must not start a vendor SDK.');

  let held = false;
  const arrived = new Promise<void>(resolve => {
    void page.route(`${config.appUrl}/api/collect`, async (route: any) => {
      if (!held) { await route.continue(); return; }
      resolve(); await new Promise<void>(done => { releaseHeld = done; });
      await route.continue().catch(() => {});
    });
  });
  held = true;
  await page.evaluate(() => (window as any).ten98.track('pending_event'));
  await arrived;
  assert.equal(typeof events.at(-1).context, 'string');
  const aborted = page.waitForEvent('requestfailed', {predicate: (request: any) => request.url() === `${config.appUrl}/api/collect`});
  await preferences().click(); await dialog().getByRole('button', {name: 'Deny all', exact: true}).click();
  await aborted; releaseHeld?.(); held = false;
  await page.evaluate(() => { history.pushState({}, '', '/denied'); (window as any).ten98.track('withdrawn_event'); });
  assert.equal(events.length, 2); assert.equal(await count(), 1);
  await grant();
  assert.equal(events.at(-1).url, `${fixtureOrigin}/denied`); assert.equal(events.at(-1).context, undefined);
  assert.equal(await count(), 2);

  await preferences().click();
  const oldSave = await dialog().getByRole('button', {name: 'Save choices', exact: true}).elementHandle();
  for (const name of ['Advertising', 'Ad user data', 'Ad personalization']) await dialog().getByRole('checkbox', {name, exact: true}).check();
  await publish('456');
  const refreshed = page.waitForResponse((response: any) => response.url() === `${config.appUrl}/api/tracking-config` && response.request().method() === 'POST');
  await page.clock.fastForward(30001); await refreshed;
  await dialog().waitFor({state: 'hidden'});
  await oldSave.evaluate((button: HTMLButtonElement) => button.click());
  await page.evaluate(() => (window as any).ten98.track('stale_dialog_event'));
  assert.equal(events.length, 3); assert.equal(await count(), 2); assert.equal(outbound.length, 0);

  const mobile = await context.newPage(); await mobile.setViewportSize({width: 360, height: 740});
  await mobile.goto(`${fixtureOrigin}/mobile`, {waitUntil: 'networkidle'});
  await mobile.getByRole('button', {name: `Tracking preferences for ${config.appUrl}`, exact: true}).click();
  const mobileDialog = mobile.getByRole('dialog', {name: 'Tracking preferences', exact: true});
  await mobileDialog.waitFor();
  const size = await mobile.evaluate(() => { const dialog = document.querySelector('dialog')!; const box = dialog.getBoundingClientRect(); return {width: innerWidth, height: innerHeight, scroll: document.documentElement.scrollWidth, left: box.left, right: box.right, top: box.top, bottom: box.bottom, overflow: getComputedStyle(dialog).overflowY, targets: [...dialog.querySelectorAll('label,button')].map(node => node.getBoundingClientRect().height)}; });
  assert.ok(size.scroll <= size.width && size.left >= 0 && size.right <= size.width && size.top >= 0 && size.bottom <= size.height, 'The embedded dialog must fit a 360px viewport.');
  assert.equal(size.overflow, 'auto'); assert.ok(size.targets.every((height: number) => height >= 44));
  if (process.env.BROWSER_ARTIFACT_DIR) { await mkdir(process.env.BROWSER_ARTIFACT_DIR, {recursive: true}); await mobile.screenshot({path: join(process.env.BROWSER_ARTIFACT_DIR, 'native-consent-mobile.png'), fullPage: true}); }
  await mobileDialog.getByRole('button', {name: 'Deny all', exact: true}).click();
  assert.equal(outbound.length, 0); assert.equal(await count(), 2);

  const unmeasuredId = randomUUID();
  await pool.query('INSERT INTO project(id,workspace_id,name,origin,public_key) VALUES($1,$2,$3,$4,$5)', [unmeasuredId, workspace.id, 'Unmeasured native sandbox', 'https://unmeasured.integration.test', randomUUID()]);
  await pool.query('INSERT INTO event(id,project_id,event_name,path) VALUES($1,$2,$3,$4)', [randomUUID(), unmeasuredId, 'page_view', '/legacy']);
  const dashboard = await context.newPage(); dashboard.setDefaultTimeout(15000);
  async function navigation(target:any) {
    const toggle=target.getByRole('button',{name:/^(Menu|Close menu)$/});
    if(await toggle.isVisible()&&await toggle.getAttribute('aria-expanded')==='false') await toggle.click();
  }
  async function selectProject(target:any,name:string) {
    await navigation(target);await target.getByRole('navigation',{name:'Projects',exact:true}).getByRole('link',{name,exact:true}).click();
  }
  async function section(target:any,name:string) {
    await navigation(target);await target.getByRole('navigation',{name:'Project sections',exact:true}).getByRole('link',{name,exact:true}).click();
  }
  await dashboard.goto(config.appUrl, {waitUntil: 'networkidle'});
  await dashboard.getByRole('heading',{name:'Web analytics',level:1,exact:true}).waitFor();
  assert.equal(await dashboard.getByRole('navigation',{name:'Projects',exact:true}).getByRole('link',{name:'Unmeasured native sandbox',exact:true}).getAttribute('aria-current'),'page','Initial loading must open the first listed project when no newer navigation was requested.');
  await selectProject(dashboard,'Native consent sandbox');
  const metric = (name: string) => dashboard.locator('.analytics-stat').filter({has: dashboard.getByText(name, {exact: true})}).locator('p');
  await metric('Estimated visitors').filter({hasText: /^1$/}).waitFor();
  assert.equal(await metric('Page views').textContent(), '2'); assert.equal(await metric('Visits').textContent(), '1');
  await dashboard.setViewportSize({width: 360, height: 740});
  async function capture(name: string) {
    assert.equal(await dashboard.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'The dashboard must not overflow horizontally on mobile.');
    const boxes = await dashboard.locator('.analytics-stat').evaluateAll((nodes: HTMLElement[]) => nodes.map(node => { const box = node.getBoundingClientRect(); return {left: box.left, right: box.right, width: innerWidth}; }));
    assert.ok(boxes.every((box: any) => box.left >= 0 && box.right <= box.width));
    if (process.env.BROWSER_ARTIFACT_DIR) await dashboard.screenshot({path: join(process.env.BROWSER_ARTIFACT_DIR, name), fullPage: true});
  }
  await capture('native-metrics-known-mobile.png');
  await selectProject(dashboard,'Unmeasured native sandbox');
  await metric('Estimated visitors').filter({hasText: /^Unavailable$/}).waitFor();
  for (const name of ['Visits', 'Bounce rate', 'Average observed visit']) assert.equal(await metric(name).textContent(), 'Unavailable');
  assert.equal(await metric('Page views').textContent(), '1');
  await capture('native-metrics-unavailable-mobile.png');
  await selectProject(dashboard,'Native consent sandbox');
  await section(dashboard,'Collection and privacy');
  const settingsPanel = dashboard.locator('section.card').filter({has: dashboard.getByRole('heading', {name: 'Collection and privacy', exact: true})});
  const paths = settingsPanel.getByRole('textbox', {name: 'Excluded path prefixes'}), save = settingsPanel.getByRole('button', {name: 'Save changes', exact: true});
  await paths.waitFor(); assert.equal(await save.isDisabled(), true); assert.equal(await paths.inputValue(), '/private');
  await paths.fill('/valid\nbad'); assert.equal(await save.isDisabled(), true);
  await paths.fill('/private\n/secret'); await settingsPanel.getByRole('button', {name: 'Cancel changes', exact: true}).click();
  assert.equal(await paths.inputValue(), '/private');
  await settingsPanel.getByRole('checkbox', {name: 'Screen dimensions', exact: true}).check();
  await save.click(); await settingsPanel.getByText(/Previous consent no longer matches/).waitFor();
  const saved = dashboard.waitForResponse((res: any) => res.url().endsWith(`/api/projects/${projectId}/analytics-settings`) && res.request().method() === 'POST');
  await save.click(); assert.equal((await saved).status(), 200); await settingsPanel.getByText('Settings saved.', {exact: true}).waitFor();
  await settingsPanel.getByRole('checkbox', {name: 'Referrer hostname', exact: true}).check();
  const current = (await pool.query('SELECT analytics_revision,analytics_settings FROM project WHERE id=$1', [projectId])).rows[0];
  await saveAnalyticsSettings(projectId, userId, {revision: current.analytics_revision, settings: {...current.analytics_settings, captureCampaigns: true}});
  await save.click();
  const conflict = dashboard.waitForResponse((res: any) => res.url().endsWith(`/api/projects/${projectId}/analytics-settings`) && res.request().method() === 'POST');
  await save.click(); assert.equal((await conflict).status(), 409);
  await settingsPanel.getByText(/These settings were changed elsewhere/).waitFor();
  assert.equal(await settingsPanel.getByRole('checkbox', {name: 'Referrer hostname', exact: true}).isChecked(), true);
  await settingsPanel.getByRole('button', {name: 'Reload saved settings', exact: true}).click();
  await settingsPanel.getByRole('checkbox', {name: 'Campaign parameters', exact: true}).filter({visible: true}).waitFor();
  await dashboard.waitForFunction(() => { const input = [...document.querySelectorAll('label')].find(label => label.textContent?.trim() === 'Campaign parameters')?.querySelector('input'); return input?.checked === true && !input.disabled; });
  assert.equal(await settingsPanel.getByRole('checkbox', {name: 'Referrer hostname', exact: true}).isChecked(), false);
  await settingsPanel.getByRole('checkbox', {name: 'Referrer hostname', exact: true}).check(); await save.click();
  await paths.fill('invalid'); assert.equal(await save.isDisabled(), true, 'Confirmation must revalidate fields edited while it is visible.');
  await settingsPanel.getByRole('button', {name: 'Keep editing', exact: true}).click(); await settingsPanel.getByRole('button', {name: 'Cancel changes', exact: true}).click();
  await capture('native-settings-mobile.png');

  const viewerId = randomUUID(), viewerEmail = `${randomUUID()}@native-viewer.integration.test`, viewerPassword = randomBytes(24).toString('base64url');
  await pool.query('INSERT INTO "user"(id,name,email) VALUES($1,$2,$3)', [viewerId, 'Native browser viewer', viewerEmail]);
  await pool.query('INSERT INTO account(id,"accountId","providerId","userId",password) VALUES($1,$2,$3,$2,$4)', [randomUUID(), viewerId, 'credential', await hashPassword(viewerPassword)]);
  await pool.query('INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,$3)', [workspace.id, viewerId, 'viewer']);
  const viewerContext = await browser.newContext(); await viewerContext.route('**/*', blockExternal);
  assert.equal((await viewerContext.request.post(`${config.appUrl}/api/auth/sign-in/email`, {headers: {origin: config.appUrl}, data: {email: viewerEmail, password: viewerPassword}})).status(), 200);
  const viewer = await viewerContext.newPage(); await viewer.goto(config.appUrl, {waitUntil: 'networkidle'});
  await selectProject(viewer,'Native consent sandbox');await section(viewer,'Collection and privacy');
  await viewer.getByText('You can view these settings; only owners and admins can change them.', {exact: true}).waitFor();
  assert.equal(await viewer.getByRole('checkbox', {name: 'Enable native analytics', exact: true}).isDisabled(), true);
  assert.equal(await viewer.getByRole('button', {name: 'Save changes', exact: true}).isDisabled(), true);
  await pool.query('DELETE FROM membership WHERE workspace_id=$1 AND user_id=$2', [workspace.id, viewerId]);
  await viewer.getByRole('button', {name: 'Reload settings', exact: true}).click();
  await viewer.getByText('Analytics settings are not available for this project.', {exact: true}).waitFor();
  assert.equal(await viewer.getByRole('textbox', {name: 'Excluded path prefixes'}).count(), 0);
  assert.equal(outbound.length, 0);
  console.log('PASS Edge: fresh consent/no replay, credential-free native requests, withdrawal abort/context reset, stale dialog rejection,44px mobile dialog targets, known/unavailable metric cards, settings save and409 draft recovery, invalid confirmation guards, viewer read-only and membership-removal clearing; no external requests.');
} finally {
  releaseHeld?.(); await browser?.close(); fixture.closeAllConnections();
  await new Promise<void>(resolve => fixture.close(() => resolve())); await closeDatabase();
}
