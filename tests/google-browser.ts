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
      await connection.getByText('Import a snapshot', { exact: true }).click();
      const sourceChoice = page.getByLabel('Google source', { exact: true });
      const selectedSource = await sourceChoice.inputValue();
      const otherSources = await sourceChoice.locator('option').evaluateAll((options: HTMLOptionElement[]) => options.map(option => option.value));
      const otherSource = otherSources.find((id: string) => id !== selectedSource);
      assert.ok(otherSource, 'The native fixture must provide another actual connection.');
      const importBodies: unknown[] = [];
      const importPath = '**/api/projects/' + fixture.projectId + '/google/connections/' + selectedSource + '/imports';
      const unknownImport = async (route: any) => {
        importBodies.push(route.request().postDataJSON());
        const response = await route.fetch();
        assert.equal(response.status(), 202, 'Both the original and same-request retry use actual native admission.');
        if (importBodies.length === 1) await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Synthetic lost import acknowledgement' }) });
        else await route.fulfill({ response });
      };
      await context.route(importPath, unknownImport);
      await connection.getByLabel('Start date', { exact: true }).fill('2024-03-01');
      await connection.getByLabel('End date', { exact: true }).fill('2024-03-01');
      await connection.getByRole('button', { name: 'Import report snapshot', exact: true }).click();
      await connection.getByRole('alert').filter({ hasText: 'The result could not be confirmed.' }).waitFor();
      await connection.getByText('Import a snapshot', { exact: true }).click();
      assert.equal(await connection.getByRole('alert').isVisible(), true, 'An uncertain import remains visible outside the collapsed tools.');
      let selectionRequests = 0;
      const watchSelection = (request: any) => { if (new URL(request.url()).pathname.startsWith('/api/projects/' + fixture.projectId + '/google')) selectionRequests++; };
      page.on('request', watchSelection);
      await sourceChoice.selectOption(otherSource!);
      assert.equal(selectionRequests, 0, 'Choosing another source must not load or refresh anything.');
      assert.equal(await connection.isVisible(), false);
      assert.equal(await connection.count(), 1, 'Switching sources must keep the original connection mounted.');
      await sourceChoice.focus(); await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(() => document.activeElement?.closest('.google-source-panel[hidden]') === null), true, 'Keyboard navigation must skip hidden connections.');
      const otherConnection = page.locator('.google-source-panel:not([hidden]) section.google-connection');
      const otherSnapshot = otherConnection.getByLabel('Snapshot', { exact: true });
      const snapshotIds = await otherSnapshot.locator('option').evaluateAll((options: HTMLOptionElement[]) => options.map(option => option.value));
      assert.ok(snapshotIds.length > 1, 'Use the native fixture’s distinct stored receipts.');
      await otherConnection.getByRole('button', { name: 'View snapshot', exact: true }).click();
      await otherConnection.getByRole('region', { name: /^Snapshot:/ }).waitFor();
      const loadedReceipt = await otherSnapshot.inputValue();
      const loadedHeading = await otherConnection.getByRole('heading', { name: /^Snapshot:/ }).innerText();
      assert.equal(selectionRequests, 1, 'Only the explicit View action reads the retained snapshot, including on a disconnected source.');
      await otherSnapshot.selectOption(snapshotIds.find((id: string) => id !== loadedReceipt)!);
      assert.equal(selectionRequests, 1, 'Changing a snapshot draft must not fetch a different report.');
      assert.equal(await otherConnection.getByRole('heading', { name: /^Snapshot:/ }).innerText(), loadedHeading);
      await otherConnection.getByText(/The selection above has changed/).waitFor();
      await sourceChoice.selectOption(selectedSource);
      assert.equal(selectionRequests, 1, 'Returning to the original source must preserve its local attempt without requests.');
      page.off('request', watchSelection);
      await connection.getByText('Import a snapshot', { exact: true }).click();
      assert.equal(await connection.getByLabel('Start date', { exact: true }).inputValue(), '2024-03-01');
      assert.equal(await connection.getByLabel('End date', { exact: true }).inputValue(), '2024-03-01');
      await connection.getByRole('button', { name: 'Import report snapshot', exact: true }).click();
      await connection.getByRole('status').filter({ hasText: 'Import queued.' }).waitFor();
      assert.equal(importBodies.length, 2);
      assert.deepEqual(importBodies[1], importBodies[0], 'An uncertain import retry after switching sources must preserve the identical request ID and body.');
      await context.unroute(importPath, unknownImport);
      assert.equal(await sourceChoice.inputValue(), selectedSource, 'Overview refresh preserves explicit source selection.');
      for (let n = 0; n < 40; n++) {
        await page.getByRole('button', { name: 'Refresh status', exact: true }).click();
        if (await connection.locator('.google-snapshot-choice').getByText(/Completed.*1 recorded rows/).count()) break;
        await delay(250);
      }
      await connection.locator('.google-snapshot-choice').getByText(/Completed.*1 recorded rows/).waitFor();
      await connection.getByRole('button', { name: 'View snapshot', exact: true }).click();
      await connection.getByRole('table').waitFor();
      assert.match(await connection.getByRole('table').innerText(), /2024-03-01/);
      const resultHeading = connection.getByRole('heading', { name: /^Snapshot:/ });
      assert.equal(await resultHeading.evaluate((el: HTMLElement) => el === document.activeElement), true, 'Explicit View success focuses its actual result heading.');
      assert.equal(await connection.evaluate((el: HTMLElement) => !!(el.querySelector('.google-snapshot')!.compareDocumentPosition(el.querySelector('.google-imports')!) & Node.DOCUMENT_POSITION_FOLLOWING)), true, 'Actual results precede import history in document order.');
      assert.equal(await connection.getByText('Import history', { exact: true }).evaluate((el: HTMLElement) => (el.parentElement as HTMLDetailsElement).open), false, 'Viewing data must not require opening history.');
      await connection.getByText('Import a snapshot', { exact: true }).click();
      const receipt = (await getDatabase().pool.query(`SELECT i.id FROM google_import i JOIN google_connection c ON c.id=i.connection_id WHERE c.project_id=$1 AND c.name='Browser Search Console'`, [fixture.projectId])).rows[0];
      assert.equal(await connection.getByLabel('Snapshot', { exact: true }).inputValue(), receipt.id);
      const originalResultText = await connection.getByRole('region', { name: /^Snapshot:/ }).innerText();
      const originalReceipt = (await getDatabase().pool.query('SELECT md5(to_jsonb(i)::text) AS digest FROM google_import i WHERE id=$1', [receipt.id])).rows[0].digest;
      // Temporary FAILED native receipts only; no provider page, queue job or successful API rewrite.
      const evictionFixtures = await getDatabase().pool.query<{ id: string; request_id: string }>(`WITH native_clock AS MATERIALIZED (
        SELECT GREATEST(clock_timestamp(), i.created_at + interval '1 microsecond') AS stamp FROM google_import i WHERE i.id=$1 AND i.connection_id=$2 AND i.project_id=$3)
        INSERT INTO google_import(id,connection_id,project_id,user_id,request_id,connection_revision,app_revision,report,date_from,date_to,status,source,diagnostic,created_at,completed_at)
        SELECT gen_random_uuid(),i.connection_id,i.project_id,i.user_id,gen_random_uuid(),i.connection_revision,i.app_revision,i.report,i.date_from,i.date_to,'failed',i.source,
          'Synthetic failed receipt for overview eviction regression.',c.stamp,c.stamp FROM google_import i CROSS JOIN native_clock c CROSS JOIN generate_series(1,20)
        WHERE i.id=$1 AND i.connection_id=$2 AND i.project_id=$3 RETURNING id,request_id`, [receipt.id, selectedSource, fixture.projectId]);
      const evictionIds = evictionFixtures.rows.map(row => row.id);
      try {
        assert.equal(evictionIds.length, 20); assert.equal(new Set(evictionIds).size, 20); assert.equal(new Set(evictionFixtures.rows.map(row => row.request_id)).size, 20); assert.equal(evictionIds.includes(receipt.id), false);
        assert.equal((await getDatabase().pool.query('SELECT count(*)::int AS n FROM google_import_page WHERE import_id=ANY($1::uuid[])', [evictionIds])).rows[0].n, 0);
        assert.equal((await getDatabase().pool.query('SELECT count(*)::int AS n FROM pgboss.job WHERE id=ANY($1::uuid[])', [evictionIds])).rows[0].n, 0);
        const evictedOverview = page.waitForResponse((response: any) => new URL(response.url()).pathname === `/api/projects/${fixture.projectId}/google` && response.request().method() === 'GET').then(async (response: any) => { assert.equal(response.status(), 200); return response.json(); });
        await page.getByRole('button', { name: 'Refresh status', exact: true }).click();
        const overview = await evictedOverview, imported = overview.connections.find((item: any) => item.id === selectedSource).imports;
        assert.equal(imported.length, 20); assert.deepEqual(new Set(imported.map((item: any) => item.id)), new Set(evictionIds)); assert.ok(imported.every((item: any) => item.status === 'failed'));
        await connection.getByRole('region', { name: /^Snapshot:/ }).waitFor({ state: 'detached' });
        assert.equal(await connection.getByRole('table').count(), 0, 'A successful overview that omits the loaded receipt clears its rows and whole result.');
        assert.equal(await connection.locator('.google-snapshot').count(), 0, 'Old quality and pagination leave with the unverified result.');
        assert.equal(await connection.getByRole('button', { name: 'Load more rows', exact: true }).count(), 0);
        assert.equal(await connection.getByText(/Report data expired/).count(), 0, 'Missing from the bounded overview does not prove expiry.');
      } finally {
        const removed = await getDatabase().pool.query('DELETE FROM google_import WHERE project_id=$1 AND connection_id=$2 AND id=ANY($3::uuid[])', [fixture.projectId, selectedSource, evictionIds]);
        assert.equal(removed.rowCount, evictionIds.length, 'Remove only the exact temporary failed receipt IDs.');
      }
      assert.equal((await getDatabase().pool.query('SELECT md5(to_jsonb(i)::text) AS digest FROM google_import i WHERE id=$1', [receipt.id])).rows[0].digest, originalReceipt);
      await page.getByRole('button', { name: 'Refresh status', exact: true }).click();
      await connection.getByLabel('Snapshot', { exact: true }).selectOption(receipt.id);
      const recoveredSnapshot = page.waitForResponse((response: any) => new URL(response.url()).pathname === `/api/projects/${fixture.projectId}/google/imports/${receipt.id}` && response.request().method() === 'GET').then(async (response: any) => { assert.equal(response.status(), 200); return response.json(); });
      await connection.getByRole('button', { name: 'View snapshot', exact: true }).click();
      const recovered = await recoveredSnapshot; assert.equal(recovered.import.id, receipt.id); assert.equal(recovered.import.dataStatus, 'available');
      await connection.getByRole('table').waitFor(); assert.equal(await connection.getByRole('region', { name: /^Snapshot:/ }).innerText(), originalResultText, 'Explicit View recovers the same genuine original result before the unchanged expiry check.');
      await getDatabase().pool.query("UPDATE google_import SET completed_at=now()-interval '400 days' WHERE id=$1", [receipt.id]);
      await runRetentionBatch(fixture.projectId);
      await page.getByRole('button', { name: 'Refresh status', exact: true }).click();
      await connection.getByText(/original report rows are unavailable/).waitFor();
      assert.equal(await connection.getByRole('table').count(), 0, 'Refresh must clear data that expired while open.');
      assert.equal(await page.getByRole('button', { name: 'Refresh status', exact: true }).evaluate((el: HTMLElement) => el === document.activeElement), true, 'Refresh must not steal focus for an updated receipt.');
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
      await connection.getByText('Connection details', { exact: true }).click();
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
    } finally {
      releaseTarget?.();
      await browser?.close(); browser = undefined;
      if (front.listening) await new Promise<void>(resolve => front.close(() => resolve()));
      ssr.kill(); await new Promise<void>(resolve => { if (ssr.exitCode !== null) resolve(); else ssr.once('exit', () => resolve()); });
    }
  });
} catch (error) { console.error('Google browser acceptance failed; credentials remain private.'); console.error(error instanceof Error ? error.message.replace(/https?:\/\/\S+/g, '[local URL]') : 'Unknown error'); process.exitCode = 1; }
finally { await browser?.close(); await closeDatabase(); }
