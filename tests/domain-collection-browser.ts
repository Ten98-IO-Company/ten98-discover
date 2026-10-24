import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { hashPassword } from 'better-auth/crypto';
import { getConfig } from '../src/server/config.ts';
import { assertSchema, closeDatabase, getDatabase } from '../src/server/db.ts';
import { createWorkspace } from '../src/server/teams.ts';
import { addDomain, issueDomainChallenge, verifyDomain } from '../src/server/domains.ts';
import { saveAnalyticsSettings } from '../src/server/native-analytics.ts';
import {launchChromium} from './helpers/playwright.mjs';

// Actual production app + tracker + loader, with synthetic HTTPS documents and
// transport forwarded only to the loopback app. No public DNS or vendor traffic.
assert.equal(process.env.TEN98_INTEGRATION_TEST, '1');
const config = getConfig();
for (const value of [config.appUrl, config.databaseUrl]) assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(new URL(value).hostname));
assert.ok(process.env.PLAYWRIGHT_MODULE, 'Supply an installed Playwright module URL.');
const canonical = 'https://canonical.example.com', serving = 'https://serving.example.com', collector = 'https://collector.example.com';
const siteKey = randomUUID(), projectId = randomUUID(), userId = randomUUID();
let browser: any;
let stage = 'fixture setup';
try {
  await assertSchema();
  const { pool } = getDatabase();
  assert.equal((await pool.query("SELECT claimed FROM installation WHERE id='instance'")).rows[0].claimed, true, 'Run after installation setup in an isolated database.');
  const email = `${userId}@domain-browser.integration.test`, password = randomBytes(24).toString('base64url');
  await pool.query('INSERT INTO "user"(id,name,email) VALUES($1,$2,$3)', [userId, 'Domain browser reviewer', email]);
  await pool.query('INSERT INTO account(id,"accountId","providerId","userId",password) VALUES($1,$2,$3,$2,$4)', [randomUUID(), userId, 'credential', await hashPassword(password)]);
  const { workspace } = await createWorkspace(userId, { name: 'Domain browser sandbox' });
  await pool.query('INSERT INTO project(id,workspace_id,name,origin,public_key,analytics_settings) VALUES($1,$2,$3,$4,$5,$6)', [projectId, workspace.id, 'Serving browser sandbox', canonical, siteKey, {enabled:true,consentMode:'builtin',collectionMode:'consent-first',captureReferrer:false,captureCampaigns:false,captureScreen:false,excludeBots:true,excludedPaths:[]}]);
  await saveAnalyticsSettings(projectId, userId, { revision: 1, settings: { enabled: true, consentMode: 'builtin', captureReferrer: false,
    captureCampaigns: false, captureScreen: false, excludeBots: false, excludedPaths: [] } });
  const registered = await addDomain(projectId, userId, { hostname: 'serving.example.com', role: 'serving' });
  const domain = registered.domains.find(row => row.hostname === 'serving.example.com')!;
  const proof = await issueDomainChallenge(projectId, userId, domain.id, {});
  await verifyDomain(projectId, userId, domain.id, {}, async name => { assert.equal(name, proof.challenge.name); return [[proof.challenge.value]]; });
  browser = await launchChromium();
  const context = await browser.newContext();
  const blocked: string[] = [], pageErrors: string[] = [], events: any[] = [];
  await context.route('**/*', async (route: any) => {
    const request = route.request(), url = new URL(request.url());
    if ([canonical, serving].includes(url.origin)) {
      if (url.pathname === '/favicon.ico') { await route.fulfill({ status: 204 }); return; }
      await route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Serving fixture</title><body><h1>Serving fixture</h1><script defer src="${collector}/tracker.js" data-site-key="${siteKey}"></script></body></html>` });
    } else if (url.origin === collector) {
      assert.ok(['/tracker.js', '/destinations.js', '/tracking-consent.css', '/api/collect', '/api/tracking-config'].includes(url.pathname));
      const headers = { ...request.headers() };
      delete headers.host;
      // The browser's real Origin is preserved through this local transport shim.
      const response = await route.fetch({ url: config.appUrl + url.pathname, headers, maxRedirects: 0 });
      await route.fulfill({ response });
    } else if (url.origin === config.appUrl) await route.continue();
    else { blocked.push(url.hostname); await route.abort(); }
  });
  const login = await context.request.post(`${config.appUrl}/api/auth/sign-in/email`, { headers: { origin: config.appUrl }, data: { email, password } });
  assert.equal(login.status(), 200);
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', (error: Error) => { pageErrors.push(error.name); });
  page.on('request', (request: any) => {
    if (request.url() === `${collector}/api/collect` && request.method() === 'POST') {
      assert.equal(request.headers().cookie, undefined);
      events.push(request.postDataJSON());
    }
  });
  await page.clock.install();
  const preferences = () => page.getByRole('button', { name: `Tracking preferences for ${collector}`, exact: true });
  const dialog = () => page.getByRole('dialog', { name: 'Tracking preferences', exact: true });
  async function grant() {
    await preferences().click();
    await dialog().getByRole('checkbox', { name: 'Analytics', exact: true }).check();
    const receipt = page.waitForResponse((response: any) => response.url() === `${collector}/api/collect` && response.request().method() === 'POST');
    await dialog().getByRole('button', { name: 'Save choices', exact: true }).click();
    const response = await receipt;
    assert.equal(response.status(), 202);
    assert.equal((await response.json()).accepted, true);
  }
  const count = async () => Number((await pool.query('SELECT count(*) FROM event WHERE project_id=$1', [projectId])).rows[0].count);
  stage = 'serving consent and native provenance';
  await page.goto(`${serving}/landing?private-query=hidden#private-fragment`, { waitUntil: 'networkidle' });
  await preferences().waitFor();
  assert.equal(await count(), 0); assert.equal(events.length, 0);
  await grant();
  assert.equal(await count(), 1); assert.equal(events[0].url, `${serving}/landing`);
  assert.equal(events[0].dimensions?.origin, undefined, 'Origin must be added by the authorized server, not trusted from the tracker.');
  const observed = (await pool.query('SELECT path,dimensions FROM event WHERE project_id=$1', [projectId])).rows[0];
  assert.equal(observed.path, '/landing'); assert.equal(observed.dimensions.origin, serving);
  stage = 'canonical consent and dashboard';
  await page.goto(`${canonical}/home`, { waitUntil: 'networkidle' });
  await grant(); assert.equal(await count(), 2);
  const dashboard = await context.newPage();
  dashboard.setDefaultTimeout(15000);
  dashboard.on('pageerror', (error: Error) => { pageErrors.push(error.name); });
  await dashboard.goto(config.appUrl, { waitUntil: 'networkidle' });
  // Report pages are tabs in a section's strip and settings pages are Settings sections; either opens from the sidebar first.
  async function section(name: string, tab: string) {
    const main = dashboard.getByRole('main', { name: 'Main content', exact: true });
    const tabs = main.getByRole('navigation', { name: name === 'Settings' ? 'Settings sections' : `${name} pages`, exact: true });
    if (!await tabs.isVisible()) {
      const toggle = dashboard.getByRole('button', { name: /^(Menu|Close menu)$/ });
      if (await toggle.isVisible() && await toggle.getAttribute('aria-expanded') === 'false') await toggle.click();
      const sidebar = dashboard.locator('aside.t98-shell-sidebar');
      await (name === 'Settings' ? sidebar.getByRole('link', { name: 'Settings', exact: true }) : sidebar.getByRole('navigation', { name: 'Sections', exact: true }).getByRole('link', { name, exact: true })).click();
    }
    await tabs.getByRole('link', { name: tab, exact: true }).click();
  }
  await dashboard.getByRole('heading', { name: 'Overview', exact: true, level: 1 }).waitFor();
  await section('Overview', 'Explore');
  const explore = dashboard.getByRole('region', { name: 'Explore', exact: true });
  // Explorer filters live in the Explore filters dialog; Apply filters closes it.
  const filters = dashboard.getByRole('dialog', { name: 'Explore filters', exact: true });
  const editFilters = async () => { if (!await filters.isVisible()) await explore.getByRole('button', { name: 'Edit filters', exact: true }).click(); return filters; };
  await (await editFilters()).getByLabel('Group by', { exact: true }).selectOption('origin');
  await (await editFilters()).getByRole('button', { name: 'Apply filters', exact: true }).click();
  const table = explore.getByRole('table', { name: 'Breakdown data', exact: true });
  await table.getByRole('rowheader', { name: serving, exact: true }).waitFor();
  assert.equal(await table.getByRole('rowheader', { name: canonical, exact: true }).count(), 1);
  await (await editFilters()).getByText('More filters', { exact: true }).click();
  await (await editFilters()).getByLabel('Enable Origin', { exact: true }).check();
  await (await editFilters()).getByLabel('Origin equals', { exact: true }).fill(serving);
  await (await editFilters()).getByRole('button', { name: 'Apply filters', exact: true }).click();
  await table.getByRole('cell', { name: serving, exact: true }).waitFor();
  assert.equal(await table.getByRole('cell', { name: canonical, exact: true }).count(), 0);
  const downloadEvent = dashboard.waitForEvent('download');
  await explore.getByRole('button', { name: 'Download CSV', exact: true }).click();
  const download = await downloadEvent, stream = await download.createReadStream();
  let csv = ''; for await (const chunk of stream) csv += chunk.toString();
  assert.ok(csv.includes(serving)); assert.equal(csv.includes(canonical), false);
  await dashboard.setViewportSize({ width: 360, height: 740 });
  assert.equal(await dashboard.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  if (process.env.BROWSER_ARTIFACT_DIR) {
    await mkdir(process.env.BROWSER_ARTIFACT_DIR, { recursive: true });
    await dashboard.screenshot({ path: join(process.env.BROWSER_ARTIFACT_DIR, 'serving-origin-mobile.png'), fullPage: true });
  }
  await section('Overview', 'Latest events');
  await dashboard.getByRole('columnheader', { name: 'Origin', exact: true }).waitFor();
  assert.equal(await dashboard.getByRole('cell', { name: serving, exact: true }).count(), 1);
  assert.equal(await dashboard.getByRole('cell', { name: canonical, exact: true }).count(), 1);
  stage = 'UI revocation and live consent reset';
  await section('Settings', 'Domains');
  await dashboard.getByRole('heading', { name: 'Domains and aliases', exact: true }).waitFor();
  await dashboard.getByText(/Verified serving domains can use this project/).waitFor();
  const row = dashboard.getByRole('row').filter({ has: dashboard.getByText('serving.example.com', { exact: true }) });
  const revoked = dashboard.waitForResponse((response: any) => response.url().endsWith(`/domains/${domain.id}/revoke`) && response.request().method() === 'POST');
  await row.getByRole('button', { name: 'Revoke proof', exact: true }).click();
  const confirmation = dashboard.getByRole('dialog', { name: 'Revoke the proof for serving.example.com?', exact: true });
  assert.match(await confirmation.innerText(), /stops accepting collection immediately/);
  await confirmation.getByRole('button', { name: 'Revoke proof', exact: true }).click();
  assert.equal((await revoked).status(), 200);
  const refreshed = page.waitForResponse((response: any) => response.url() === `${collector}/api/tracking-config` && response.request().method() === 'POST');
  await page.clock.fastForward(30001); await refreshed;
  await page.evaluate(() => (window as any).ten98.track('stale_consent'));
  assert.equal(await count(), 2);
  await preferences().click(); assert.equal(await dialog().getByRole('checkbox', { name: 'Analytics', exact: true }).isChecked(), false);
  await dialog().getByRole('button', { name: 'Cancel', exact: true }).click();
  await grant(); assert.equal(await count(), 3);
  const revokedPage = await context.newPage();
  revokedPage.setDefaultTimeout(15000);
  revokedPage.on('pageerror', (error: Error) => { pageErrors.push(error.name); });
  const denied = revokedPage.waitForResponse((response: any) => response.url() === `${collector}/api/tracking-config` && response.request().method() === 'POST');
  await revokedPage.goto(`${serving}/revoked`, { waitUntil: 'domcontentloaded' });
  // A shared synthetic host may still be valid for another fixture project:
  // global CORS rejects unknown hosts, while the project gate rejects known hosts.
  assert.ok([403, 404].includes((await denied).status()));
  await revokedPage.evaluate(() => (window as any).ten98.track('revoked_domain'));
  assert.equal(await count(), 3);
  assert.equal(blocked.length, 0); assert.deepEqual(pageErrors, []);
  console.log('PASS production Edge serving/canonical consent, trusted origin, exact Explore + CSV, recent origins, mobile layout and UI revocation/consent reset; zero external traffic');
} catch (error) {
  console.error(`FAIL serving-domain browser stage: ${stage}; ${error instanceof Error ? error.name : 'Error'}. Fixture credentials are redacted.`);
  if (stage !== 'fixture setup' && error instanceof Error) console.error(error.stack);
  process.exitCode = 1;
} finally {
  await browser?.close();
  await closeDatabase();
}
