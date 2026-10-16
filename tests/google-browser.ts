import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdir } from 'node:fs/promises';
import { getConfig } from '../src/server/config.ts';
import { getDatabase, closeDatabase } from '../src/server/db.ts';
import { handleApi } from '../src/server/api.ts';
import { withGoogleTransportForTests } from '../src/server/google-http.ts';
import { runRetentionBatch } from '../src/server/retention.ts';
import { createWorkspace } from '../src/server/teams.ts';
import { runGoogleChecks } from './google-integration.ts';
import { runGoogleGa4Checks } from './google-ga4-integration.ts';

// Production client/SSR assets, actual API functions, PostgreSQL and queue worker;
// only Google HTTP endpoints and the Google consent page are synthetic fixtures.
// The loopback front server keeps transport injection outside production code.
assert.equal(process.env.TEN98_INTEGRATION_TEST, '1');
assert.ok(process.env.PLAYWRIGHT_MODULE, 'Supply an installed Playwright module URL.');
const config = getConfig(), origin = new URL(config.appUrl);
assert.ok(['localhost','127.0.0.1'].includes(origin.hostname));
const appPort = Number(origin.port), ssrPort = Number(process.env.GOOGLE_BROWSER_SSR_PORT ?? appPort + 1);
assert.ok(appPort > 1024 && ssrPort > 1024 && ssrPort !== appPort);
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE!);
let browser: any;
try {
  await runGoogleChecks(async fixture => {
    const decoy = await createWorkspace(fixture.userId, { name: 'Decoy workspace' });
    await getDatabase().pool.query("UPDATE workspace SET created_at=now()-interval '1 day' WHERE id=$1", [decoy.workspace.id]);
    const ssr = spawn(process.execPath, ['.output/server/index.mjs'], { env: { ...process.env, PORT: String(ssrPort), HOST: '127.0.0.1' }, windowsHide: true, stdio: 'ignore' });
    const front = createServer(async (incoming, outgoing) => {
      try {
        const headers = new Headers();
        for (const [name, value] of Object.entries(incoming.headers)) if (value !== undefined && !['host','connection','content-length','accept-encoding'].includes(name)) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
        let response: Response;
        if (incoming.url?.startsWith('/api/')) {
          const chunks: Buffer[] = []; let size = 0;
          for await (const part of incoming) { size += part.length; if (size > 1_048_576) throw new Error('Fixture request too large.'); chunks.push(part); }
          response = await withGoogleTransportForTests(fixture.transport, () => handleApi(new Request(config.appUrl + incoming.url, { method: incoming.method, headers, ...(!['GET','HEAD'].includes(incoming.method!) ? { body: Buffer.concat(chunks) } : {}) })));
        } else response = await fetch(`http://127.0.0.1:${ssrPort}${incoming.url}`, { headers, redirect: 'manual' });
        outgoing.statusCode = response.status;
        response.headers.forEach((value, name) => { if (!['set-cookie','content-encoding','content-length','transfer-encoding'].includes(name)) outgoing.setHeader(name, value); });
        const cookies = response.headers.getSetCookie(); if (cookies.length) outgoing.setHeader('set-cookie', cookies);
        outgoing.end(Buffer.from(await response.arrayBuffer()));
      } catch { outgoing.statusCode = 500; outgoing.end('Local fixture request failed.'); }
    });
    let releaseTarget: (() => void) | undefined;
    try {
      for (let n = 0; n < 100; n++) { try { if ((await fetch(`http://127.0.0.1:${ssrPort}/`)).ok) break; } catch {} await delay(100); if (n === 99) throw new Error('Production SSR fixture did not start.'); }
      await new Promise<void>((resolve, reject) => { front.once('error', reject); front.listen(appPort, '127.0.0.1', resolve); });
      await getDatabase().pool.query("UPDATE installation SET claimed=true WHERE id='instance'");
      browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL ?? 'msedge', headless: true });
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      let external = 0, pageErrors = 0;
      await context.route('**/*', async (route: any) => {
        const url = new URL(route.request().url());
        if (url.origin === 'https://accounts.google.com') return route.fulfill({ status: 302, headers: { location: fixture.authorize(url.href) }, body: '' });
        if (url.origin !== config.appUrl) { external++; return route.abort(); }
        return route.continue();
      });
      const page = await context.newPage(); page.setDefaultTimeout(15000); page.on('pageerror', () => pageErrors++);
      await page.goto(config.appUrl);
      await page.getByLabel('Email', { exact: true }).fill(fixture.email);
      await page.getByLabel('Password', { exact: true }).fill(fixture.password);
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await page.getByLabel('Workspace', { exact: true }).selectOption(fixture.workspaceId);
      await page.getByRole('heading', { name: 'Web analytics', exact: true }).waitFor();
      async function navigation() { const toggle = page.getByRole('button', { name: /^(Menu|Close menu)$/ }); if (await toggle.isVisible() && await toggle.getAttribute('aria-expanded') === 'false') await toggle.click(); }
      async function section(name: string) { await navigation(); await page.getByRole('navigation', { name: 'Project sections', exact: true }).getByRole('link', { name, exact: true }).click(); }
      async function settings(name: string) {
        await navigation();
        const target = page.locator('#app-navigation').getByRole('link', { name, exact: true, includeHidden: true });
        await target.waitFor({ state: 'attached' });
        for (const disclosure of await target.locator('xpath=ancestor::details').all()) {
          if (await disclosure.getAttribute('open') === null) await disclosure.locator(':scope > summary').click();
        }
        await target.click();
      }
      await settings('Google app setup');
      assert.equal(await page.getByLabel('Client secret', { exact: true }).inputValue(), '');
      assert.equal(await page.getByLabel(/Callback URI/).inputValue(), `${config.appUrl}/api/google/callback`);
      await section('Google reports');
      assert.equal(await page.getByLabel('Connection name', { exact: true }).isVisible(), false, 'Existing reports take priority over adding another connection.');
      await page.getByText('Add a Google connection', { exact: true }).click();
      await page.getByLabel('Connection name', { exact: true }).fill('Browser Search Console');
      await page.getByRole('button', { name: 'Connect to Google', exact: true }).click();
      await page.getByRole('heading', { name: 'Google reports', exact: true }).waitFor();
      await page.getByText('Browser Search Console', { exact: true }).waitFor();
      await page.getByRole('status').filter({ hasText: 'Google authorization returned.' }).waitFor();
      assert.equal(await page.getByRole('alert').filter({ hasText: 'Google authorization returned.' }).count(), 0, 'A successful return must not be announced as an error.');
      assert.equal(new URL(page.url()).hash, '', 'OAuth state/code/target fragment must be cleared from browser history.');
      assert.equal(await page.getByLabel('Workspace', { exact: true }).inputValue(), fixture.workspaceId, 'Callback must select its authorized workspace, not the first membership.');
      assert.equal(await page.getByRole('navigation', { name: 'Projects', exact: true }).getByRole('link', { name: 'Google imports fixture', exact: true }).getAttribute('aria-current'), 'page');
      const connection = page.locator('section').filter({ has: page.getByText('Browser Search Console', { exact: true }) }).last();
      await connection.getByRole('button', { name: 'Load available properties', exact: true }).click();
      await connection.getByRole('radio', { name: /sc-domain:example.test/ }).check();
      await connection.getByRole('button', { name: 'Use this property', exact: true }).click();
      await connection.getByLabel('Start date', { exact: true }).fill('2024-03-01');
      await connection.getByLabel('End date', { exact: true }).fill('2024-03-01');
      await connection.getByRole('button', { name: 'Import report snapshot', exact: true }).click();
      for (let n = 0; n < 40; n++) {
        await page.getByRole('button', { name: 'Refresh status', exact: true }).click();
        if (await connection.getByText(/Completed.*1 recorded rows/).count()) break;
        await delay(250);
      }
      await connection.getByText(/Completed.*1 recorded rows/).waitFor();
      await connection.getByRole('button', { name: 'View snapshot', exact: true }).click();
      await connection.getByRole('table').waitFor();
      assert.match(await connection.getByRole('table').innerText(), /2024-03-01/);
      const receipt = (await getDatabase().pool.query(`SELECT i.id FROM google_import i JOIN google_connection c ON c.id=i.connection_id WHERE c.project_id=$1 AND c.name='Browser Search Console'`, [fixture.projectId])).rows[0];
      await getDatabase().pool.query("UPDATE google_import SET completed_at=now()-interval '400 days' WHERE id=$1", [receipt.id]);
      await runRetentionBatch(fixture.projectId);
      await page.getByRole('button', { name: 'Refresh status', exact: true }).click();
      await connection.getByText(/original report rows are unavailable/).waitFor();
      assert.equal(await connection.getByRole('table').count(), 0, 'Refresh must clear data that expired while open.');
      await mkdir('private/google-browser', { recursive: true });
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({ path: 'private/google-browser/desktop.png', fullPage: true });
      await page.setViewportSize({ width: 360, height: 800 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.screenshot({ path: 'private/google-browser/mobile.png', fullPage: true });
      await page.setViewportSize({ width: 320, height: 800 });
      await page.evaluate(() => { document.documentElement.dir = 'rtl'; document.documentElement.style.zoom = '2'; });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'Google forms and the shared header must contain narrow RTL layouts at 200% CSS zoom.');
      await page.evaluate(() => { document.documentElement.dir = 'ltr'; document.documentElement.style.zoom = ''; });
      await page.setViewportSize({ width: 360, height: 800 });
      page.once('dialog', (dialog: any) => dialog.accept());
      await connection.getByRole('button', { name: 'Disconnect', exact: true }).click();
      await page.getByText('Disconnected. Google access was not revoked.', { exact: true }).waitFor();
      let targetStarted: () => void = () => {};
      const started = new Promise<void>(resolve => { targetStarted = resolve; });
      const held = new Promise<void>(resolve => { releaseTarget = resolve; });
      const targetPath = `**/api/workspaces/${fixture.workspaceId}/projects`;
      const holdTarget = async (route: any) => { const response = await route.fetch(); targetStarted(); await held; await route.fulfill({ response }); };
      await context.route(targetPath, holdTarget);
      await page.goto('about:blank');
      await page.goto(`${config.appUrl}/#google=connected&google-project=${fixture.projectId}&google-workspace=${fixture.workspaceId}`);
      await Promise.race([started, delay(15000).then(() => { throw new Error('Callback project request did not start.'); })]);
      await settings('Account security');
      releaseTarget?.();
      await page.getByRole('heading', { name: 'Account', exact: true }).waitFor();
      await context.unroute(targetPath, holdTarget);
      await delay(150);
      assert.equal(await page.getByRole('heading', { name: 'Google reports', exact: true }).count(), 0, 'Delayed callback project loading must not override newer account navigation.');
      await settings('Data retention');
      await page.getByRole('button',{name:'Preview cleanup',exact:true}).click();
      await page.getByText('0 keyword results eligible.',{exact:true}).waitFor();
      await page.getByText(/finished Google imports eligible/).waitFor();
      await page.getByText(/used quote metadata and charge evidence remain as receipts/).waitFor();
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
      await page.screenshot({path:'private/google-browser/retention-mobile.png',fullPage:true});
      await page.setViewportSize({width:1280,height:900});await page.screenshot({path:'private/google-browser/retention-desktop.png',fullPage:true});
      await page.getByRole('button',{name:'Cancel preview',exact:true}).click();
      const unavailablePath=`**/api/workspaces/${fixture.workspaceId}/retention/preview`;
      await context.route(unavailablePath,async(route:any)=>{const response=await route.fetch();const json=await response.json();await route.fulfill({response,json:{...json,keywordEstimate:{status:'unavailable',results:null,atLeast:false}}});},{times:1});
      await page.getByRole('button',{name:'Preview cleanup',exact:true}).click();await page.getByText('Keyword result estimate unavailable.',{exact:true}).waitFor();
      assert.equal(await page.getByText('0 keyword results eligible.',{exact:true}).count(),0);
      console.log('PASS actual retention UI separates Google/keyword counts and unavailable estimates at mobile and desktop widths');
      await page.goto(`${config.appUrl}/#google=failed`);
      await page.getByRole('alert').filter({ hasText: 'Google reporting could not be connected.' }).waitFor();
      assert.equal(external, 0); assert.equal(pageErrors, 0);
      console.log('PASS production Google UI with real local API, PKCE callback, worker import, retention expiry, local disconnect, mobile bounds and zero external requests');
      // New GA4 positives use real native imports; no successful API body is intercepted or rewritten.
      await runGoogleGa4Checks(async ga4=>{
        const gaContext=await browser.newContext({viewport:{width:1280,height:900}});let gaExternal=0,gaErrors=0;
        try{
          await gaContext.route('**/*',(route:any)=>{if(new URL(route.request().url()).origin!==config.appUrl){gaExternal++;return route.abort();}return route.continue();});
          const gaPage=await gaContext.newPage();gaPage.setDefaultTimeout(15000);gaPage.on('pageerror',()=>gaErrors++);await gaPage.goto(config.appUrl);await gaPage.getByLabel('Email',{exact:true}).fill(ga4.email);await gaPage.getByLabel('Password',{exact:true}).fill(ga4.password);await gaPage.getByRole('button',{name:'Sign in',exact:true}).click();await gaPage.getByRole('heading',{name:'Web analytics',exact:true}).waitFor();
          assert.equal(await gaPage.getByLabel('Workspace',{exact:true}).inputValue(),ga4.workspaceId);const menu=gaPage.getByRole('button',{name:/^(Menu|Close menu)$/});if(await menu.isVisible()&&await menu.getAttribute('aria-expanded')==='false')await menu.click();await gaPage.getByRole('navigation',{name:'Project sections',exact:true}).getByRole('link',{name:'Google reports',exact:true}).click();
          const source=gaPage.locator('section.google-connection').filter({has:gaPage.getByRole('heading',{name:'GA4 report inventory',exact:true})});await source.getByLabel('Report',{exact:true}).waitFor();
          for(const [report,label,column]of [['ga4_pages','Pages and screens','Page path and screen class'],['ga4_acquisition','Traffic acquisition','Session campaign'],['ga4_key_events','Key events','Is key event']]){
            await source.getByLabel('Report',{exact:true}).selectOption(report);await source.getByLabel('Start date',{exact:true}).fill('2024-03-01');await source.getByLabel('End date',{exact:true}).fill('2024-03-01');
            const queued=gaPage.waitForResponse((response:any)=>new URL(response.url()).pathname===`/api/projects/${ga4.projectId}/google/connections/${ga4.connectionId}/imports`&&response.request().method()==='POST').then(async(response:any)=>{assert.equal(response.status(),202);return response.json();});
            await source.getByRole('button',{name:'Import report snapshot',exact:true}).click();const receipt=await queued;assert.equal(receipt.import.report,report);await ga4.complete(receipt.import.id);await gaPage.getByRole('button',{name:'Refresh status',exact:true}).click();await source.locator('.google-imports li').first().getByText(/Completed/).waitFor();
            const captured=gaPage.waitForResponse((response:any)=>new URL(response.url()).pathname===`/api/projects/${ga4.projectId}/google/imports/${receipt.import.id}`).then(async(response:any)=>{assert.equal(response.status(),200);const bytes=await response.body();assert.ok(bytes.length<=2097152);return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));});await source.locator('.google-imports li').first().getByRole('button',{name:'View snapshot',exact:true}).click();const native=await captured;
            assert.equal(native.import.id,receipt.import.id);assert.equal(native.import.report,report);assert.deepEqual(native.rows,ga4.snapshots[report].rows);assert.equal(native.source.timeZone,'America/New_York');assert.equal(native.source.currencyCode,'AED');await source.getByRole('heading',{name:label,exact:true}).waitFor();await source.getByRole('columnheader',{name:column,exact:true}).waitFor();await source.getByRole('cell',{name:'AED -9007199254740993.1250',exact:true}).waitFor();assert.equal(await source.getByText(/no whole-range user total is calculated/).count(),1);
          }
          await gaPage.setViewportSize({width:320,height:900});assert.equal(await gaPage.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await gaPage.screenshot({path:'private/google-browser/ga4-320-ltr.png',fullPage:true});await gaPage.evaluate(()=>{document.documentElement.dir='rtl';document.body.style.zoom='2';});assert.equal(await gaPage.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await source.getByLabel('Report',{exact:true}).focus();await gaPage.keyboard.press('Tab');assert.notEqual(await gaPage.evaluate(()=>document.activeElement?.tagName),'BODY');await gaPage.screenshot({path:'private/google-browser/ga4-320-rtl-body-zoom200.png',fullPage:true});assert.equal(gaExternal,0);assert.equal(gaErrors,0);
          console.log('PASS GA4 three explicit imports with actual native rows, scoped readable tables/exact currency,320RTL/bodyCSSzoom200 and keyboard traversal');
        }finally{await gaContext.close();}
      });
    } finally {
      releaseTarget?.();
      await browser?.close(); browser = undefined;
      if (front.listening) await new Promise<void>(resolve => front.close(() => resolve()));
      ssr.kill(); await new Promise<void>(resolve => { if (ssr.exitCode !== null) resolve(); else ssr.once('exit', () => resolve()); });
    }
  });
} catch (error) { console.error('Google browser acceptance failed; credentials remain private.'); console.error(error instanceof Error ? error.message.replace(/https?:\/\/\S+/g, '[local URL]') : 'Unknown error'); process.exitCode = 1; }
finally { await browser?.close(); await closeDatabase(); }
