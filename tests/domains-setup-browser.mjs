// TEN98_DOMAINS_SETUP_BROWSER=1 PLAYWRIGHT_MODULE=/installed/playwright/index.mjs node tests/domains-setup-browser.mjs
// Real component + native router, synthetic intercepted API only. No database/DNS/provider requests.
import assert from 'node:assert/strict';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash, randomBytes} from 'node:crypto';
import {createServer as createNetServer} from 'node:net';
import {createServer} from 'vite';
import {launchChromium} from './helpers/playwright.mjs';

assert.equal(process.env.TEN98_DOMAINS_SETUP_BROWSER, '1');
assert.ok(process.env.PLAYWRIGHT_MODULE);
const first = '20000000-0000-4000-8000-000000000001', second = '20000000-0000-4000-8000-000000000002', workspace = '10000000-0000-4000-8000-000000000001';
const canonicalId = '40000000-0000-4000-8000-000000000001';
const state = (project = first) => ({project: {id: project, origin: project === first ? 'https://ten98.example:8443' : 'https://other.example', canonicalHost: project === first ? 'ten98.example' : 'other.example', canonicalVerifiable: true}, domains: [{id: canonicalId, hostname: project === first ? 'ten98.example' : 'other.example', role: 'canonical', expectedTargetHost: null, status: 'unverified', createdAt: new Date().toISOString(), verifiedAt: null, challengeExpiresAt: null}], limit: 50});
let models, readStatus, verifyStatus, ambiguous, failReads, held, holdNext, holdChallenge, nextId, proofNumber;
const reads = [], writes = [], external = [], errors = [], releases = [];
function reset() { models = new Map([[first, state()], [second, state(second)]]); readStatus = 200; verifyStatus = 200; ambiguous = false; failReads = false; held = null; holdNext = false; holdChallenge = false; nextId = 2; proofNumber = 0; }
reset();
const publicFiles = ['src/components/DomainsPanel.tsx', 'src/routes/index.tsx', 'src/styles.css', 'tests/domains-setup-browser-fixture.tsx', 'tests/domains-setup-browser.mjs', 'tests/domain-collection-browser.ts', 'tests/domain-redirect-browser.ts', 'src/server/domains.ts', 'src/server/collection-origins.ts'];
const hashes = async () => Object.fromEntries(await Promise.all(publicFiles.map(async path => [path, createHash('sha256').update(await readFile(path)).digest('hex')])));
const before = await hashes(), evidence = resolve('private/domain-setup/run-' + randomBytes(5).toString('hex'));
await mkdir(evidence, {recursive: true});
const entry = 'tests/domains-setup-browser-fixture.tsx';
const server = await createServer({configFile: false, root: process.cwd(), cacheDir: evidence + '/vite-cache', appType: 'custom', optimizeDeps: {entries: [entry]}, server: {host: '127.0.0.1', port: 0, strictPort: true, hmr: false}});
server.middlewares.use((req, res, next) => { if (req.url?.split('?')[0] !== '/') return next(); res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Domain setup fixture</title><div id="root"></div><script type="module" src="/' + entry + '"></script></html>'); });
let browser, page, port, stage = 'startup', groups = 0;
try {
  await server.listen();
  const address = server.httpServer.address(); assert.equal(address.address, '127.0.0.1');
  port = address.port;
  const origin = 'http://127.0.0.1:' + address.port;
  browser = await launchChromium();
  const context = await browser.newContext({viewport: {width: 1440, height: 1000}, serviceWorkers: 'block'});
  await context.addInitScript(() => { Object.defineProperty(navigator, 'clipboard', {configurable: true, value: {writeText: async () => { throw new Error('Synthetic clipboard denial'); }}}); });
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin) { external.push(url.origin); return route.abort(); }
    if (!url.pathname.startsWith('/api/')) return route.continue();
    const match = url.pathname.match(/^\/api\/projects\/([^/]+)\/domains(?:\/([^/]+)\/(challenge|verify|revoke|remove|update|redirect-checks))?$/);
    assert.ok(match, 'No unrelated API request'); const [, project, id, action] = match, model = models.get(project); assert.ok(model);
    const send = (body, status = 200) => route.fulfill({status, contentType: 'application/json', body: JSON.stringify(body)}).catch(() => {});
    if (request.method() === 'GET') {
      reads.push(url.pathname);
      if (holdNext) { holdNext = false; const body = structuredClone(model); await new Promise(release => { held = release; releases.push(release); }); return send(body); }
      if (readStatus !== 200 || failReads) return send({error: 'Synthetic domain read unavailable'}, failReads ? 503 : readStatus);
      if (action === 'redirect-checks') return send({domainId: id, eligible: model.domains.find(row => row.id === id)?.status === 'verified', checks: [], nextAllowedAt: null});
      return send(model);
    }
    assert.equal(request.method(), 'POST'); const body = request.postDataJSON(); writes.push({project, id, action, body});
    const row = model.domains.find(value => value.id === id);
    if (!action) {
      if (body.hostname.includes('://') || body.hostname.includes('/')) return send({error: 'Enter a public hostname only, without a scheme or path.'}, 400);
      model.domains.push({id: '40000000-0000-4000-8000-' + String(nextId++).padStart(12, '0'), hostname: body.hostname, role: body.role, expectedTargetHost: body.role === 'redirect_alias' ? body.expectedTargetHost ?? model.project.canonicalHost : null, status: 'unverified', createdAt: new Date().toISOString(), verifiedAt: null, challengeExpiresAt: null}); return send(model, 201);
    }
    assert.ok(row);
    if (action === 'challenge') { row.status = 'pending'; row.verifiedAt = null; row.challengeExpiresAt = new Date(Date.now() + 86400000).toISOString(); if (ambiguous) return send({error: 'Synthetic unknown write outcome'}, 500); const result = structuredClone({state: model, challenge: {domainId: id, name: '_ten98-challenge.' + row.hostname, type: 'TXT', value: 'synthetic-proof-' + (++proofNumber), expiresAt: row.challengeExpiresAt}}); if (holdChallenge) { holdChallenge = false; await new Promise(release => { held = release; releases.push(release); }); } return send(result); }
    if (action === 'verify') { if (verifyStatus === 409) row.status = 'expired'; if (verifyStatus !== 200) return send({error: 'Synthetic DNS verification refused'}, verifyStatus); row.status = 'verified'; row.verifiedAt = new Date().toISOString(); row.challengeExpiresAt = null; return send(model); }
    if (action === 'revoke') { row.status = 'revoked'; row.verifiedAt = null; row.challengeExpiresAt = null; return send(model); }
    if (action === 'remove') { model.domains = model.domains.filter(value => value !== row); return send(model); }
    if (action === 'update') { row.role = body.role; row.expectedTargetHost = body.expectedTargetHost ?? null; return send(model); }
    throw new Error('Unexpected synthetic mutation ' + action);
  });
  page = await context.newPage(); page.setDefaultTimeout(8000); page.on('pageerror', error => errors.push(error.message)); page.on('dialog', dialog => dialog.accept());
  const fresh = async () => { await page.goto(origin + '/?workspace=' + workspace + '&project=' + first + '&view=domains'); await page.getByRole('heading', {name: 'Your website', exact: true}).waitFor(); };
  const website = () => page.getByRole('region', {name: 'Your website', exact: true});
  const proof = () => page.getByRole('region', {name: 'One-time DNS proof', exact: true});
  const row = host => page.getByRole('row').filter({has: page.getByText(host, {exact: true})});
  const openAdd = async () => { const details = page.locator('.domain-add'); if (!(await details.getAttribute('open'))) await details.locator('summary').click(); return page.getByRole('form', {name: 'Add a domain', exact: true}); };
  const add = async (host, role = 'serving') => { const form = await openAdd(); await form.getByLabel('Hostname', {exact: true}).fill(host); await form.getByLabel('Purpose', {exact: true}).selectOption(role); await form.getByRole('button', {name: 'Add domain', exact: true}).click(); await row(host).waitFor(); };
  const settled = async () => { await page.getByText('Updating domain settings…', {exact: true}).waitFor({state: 'hidden'}); };

  stage = 'canonical origin and optional ownership'; await fresh();
  assert.match(await website().innerText(), /https:\/\/ten98\.example:8443/); assert.match(await website().innerText(), /Collection origin\s+Origin allowed/); assert.match(await website().innerText(), /Not verified — optional for the canonical origin/);
  assert.equal(await page.getByRole('form', {name: 'Add a domain'}).isVisible(), false); assert.equal(writes.length, 0);
  await website().getByRole('button', {name: 'Install tracker', exact: true}).click(); await page.getByRole('heading', {name: 'Tracker installation', exact: true}).waitFor();
  assert.equal(new URL(page.url()).searchParams.get('workspace'), workspace); assert.equal(new URL(page.url()).searchParams.get('project'), first); assert.equal(new URL(page.url()).searchParams.get('view'), 'installation'); groups++;
  console.log('PASS canonical unverified is an allowed exact origin, privacy caveat, optional setup and native-router installation scope.');

  stage = 'serving setup and visible one-time proof'; await fresh(); await add('www.ten98.example');
  assert.match(await row('www.ten98.example').innerText(), /Verify ownership first/); assert.equal(await row('www.ten98.example').evaluate(node => node === document.activeElement), true); assert.equal(await page.locator('.domain-add').getAttribute('open'), null);
  const beforeChallenge = writes.length; await row('www.ten98.example').getByRole('button', {name: 'Create DNS proof', exact: true}).click(); await proof().waitFor(); await settled(); assert.equal(writes.length, beforeChallenge + 1);
  assert.match(await proof().getByRole('heading').innerText(), /www.ten98.example/); assert.equal(await proof().getByRole('heading').evaluate(node => node === document.activeElement), true); assert.equal(await proof().evaluate(node => node.closest('details:not([open])') === null), true);
  assert.equal(await proof().evaluate(node => node.getBoundingClientRect().top < document.querySelector('.domain-add').getBoundingClientRect().top), true);
  await proof().getByRole('button', {name: 'Copy value', exact: true}).click(); await page.getByRole('alert').getByText('Automatic copy failed.', {exact: false}).waitFor();
  assert.equal(await page.getByLabel('Record value', {exact: true}).evaluate(node => node === document.activeElement && node.selectionStart === 0 && node.selectionEnd === node.value.length), true);
  assert.equal(await page.evaluate(() => JSON.stringify(localStorage).includes('synthetic-proof-')), false); assert.equal(page.url().includes('synthetic-proof-'), false); groups++;
  console.log('PASS explicit serving setup, new-row focus, proof immediately visible/focused and clipboard fallback without persistent proof storage.');

  stage = 'DNS propagation and recoverable lookup failure';
  for (const status of [422, 503]) { verifyStatus = status; await proof().getByRole('button', {name: 'Check DNS proof', exact: true}).click(); await settled(); await page.getByRole('alert').waitFor(); assert.equal(await proof().isVisible(), true); assert.equal(await proof().getByRole('button', {name: 'Check DNS proof', exact: true}).isEnabled(), true); assert.match(await row('www.ten98.example').innerText(), /Verify ownership first/); }
  verifyStatus = 200; await proof().getByRole('button', {name: 'Check DNS proof', exact: true}).click(); await settled(); assert.equal(await proof().count(), 0); assert.match(await row('www.ten98.example').innerText(), /Origin allowed/); groups++;
  console.log('PASS422 propagation and503 lookup retries retain the one-time proof; successful verification changes eligibility only.');

  stage = 'redirect-only and local project'; await add('old.ten98.example', 'redirect_alias');
  assert.match(await row('old.ten98.example').innerText(), /Not allowed by this alias/); await row('old.ten98.example').getByRole('button', {name: 'Create DNS proof', exact: true}).click(); await proof().waitFor(); await proof().getByRole('button', {name: 'Check DNS proof', exact: true}).click(); await settled(); assert.match(await row('old.ten98.example').innerText(), /Not allowed by this alias/);
  await row('old.ten98.example').getByText('HTTP redirect checks', {exact: true}).click(); await row('old.ten98.example').getByText('No redirect checks have been run.', {exact: true}).waitFor(); assert.equal(writes.some(write => write.action === 'redirect-checks'), false);
  models.get(first).project = {...models.get(first).project, origin: 'http://localhost:4321', canonicalHost: 'localhost', canonicalVerifiable: false}; models.get(first).domains = [];
  await fresh(); assert.match(await website().innerText(), /http:\/\/localhost:4321/); assert.match(await website().innerText(), /Origin allowed/); assert.equal(await website().getByRole('button', {name: 'Verify DNS ownership', exact: true}).count(), 0); groups++;
  console.log('PASS verified aliases never enable collection or auto-check; local project origin remains allowed without DNS proof.');

  stage = 'stale refresh and unknown mutation'; reset(); await fresh(); await website().getByRole('button', {name: 'Verify DNS ownership', exact: true}).click(); await proof().waitFor(); failReads = true;
  await page.getByRole('button', {name: 'Refresh', exact: true}).click(); await page.getByText('These are the last loaded settings.', {exact: false}).waitFor(); assert.equal(await proof().count(), 0); assert.equal(await website().getByRole('button', {name: 'Install tracker', exact: true}).isDisabled(), true); assert.equal(await page.getByRole('button', {name: 'Refresh', exact: true}).isEnabled(), true);
  failReads = false; await page.getByRole('button', {name: 'Refresh', exact: true}).click(); await website().getByRole('button', {name: 'Install tracker', exact: true}).waitFor(); await page.getByText('These are the last loaded settings.', {exact: false}).waitFor({state: 'hidden'});
  await website().getByText('Manage DNS ownership', {exact: true}).click(); ambiguous = true; await website().getByRole('button', {name: 'Replace DNS proof', exact: true}).click(); await page.getByRole('dialog', {name: 'Replace the DNS proof for ten98.example?', exact: true}).getByRole('button', {name: 'Replace DNS proof', exact: true}).click(); await page.getByText('These are the last loaded settings.', {exact: false}).waitFor(); assert.equal(await proof().count(), 0); assert.equal(await website().getByRole('button', {name: 'Replace DNS proof', exact: true}).isDisabled(), true); groups++;
  console.log('PASS failed refresh and ambiguous writes disable stale actions and purge one-time proof while Refresh remains available.');

  stage = 'proof expiry and project/account race'; reset(); await fresh(); await website().getByRole('button', {name: 'Verify DNS ownership', exact: true}).click(); await proof().waitFor(); verifyStatus = 409; await proof().getByRole('button', {name: 'Check DNS proof', exact: true}).click(); await settled(); assert.equal(await proof().count(), 0); await page.getByRole('alert').getByText('The list has been refreshed.', {exact: false}).waitFor();
  verifyStatus = 200; await website().getByRole('button', {name: 'Verify DNS ownership', exact: true}).click(); await proof().waitFor(); holdNext = true; await page.getByRole('button', {name: 'Refresh', exact: true}).click(); await page.waitForFunction(() => document.body.innerText.includes('Refreshing domains.'));
  const holdDeadline = Date.now() + 8000; while (!held && Date.now() < holdDeadline) await new Promise(done => setTimeout(done, 10)); assert.ok(held, 'Synthetic held read began'); assert.equal(await proof().count(), 0); await page.getByRole('link', {name: 'Other project', exact: true}).click(); await website().getByText('https://other.example', {exact: true}).waitFor(); held(); await new Promise(done => setTimeout(done, 50)); assert.equal(await page.getByText('https://ten98.example:8443', {exact: true}).count(), 0); assert.equal(await proof().count(), 0);
  held = null; holdChallenge = true; await website().getByRole('button', {name: 'Verify DNS ownership', exact: true}).click(); const challengeDeadline = Date.now() + 8000; while (!held && Date.now() < challengeDeadline) await new Promise(done => setTimeout(done, 10)); assert.ok(held, 'Synthetic held challenge began'); await page.getByRole('link', {name: 'First project', exact: true}).click(); await website().getByText('https://ten98.example:8443', {exact: true}).waitFor(); held(); await new Promise(done => setTimeout(done, 50)); assert.equal(await proof().count(), 0);
  reset(); await fresh(); await website().getByRole('button', {name: 'Verify DNS ownership', exact: true}).click(); await proof().waitFor(); await page.getByRole('button', {name: 'Change account', exact: true}).click(); await proof().waitFor({state: 'hidden'}); groups++;
  console.log('PASS expired proof recovery, departed-project delayed reads/challenges and account-change proof purge.');

  stage = 'responsive keyboard and access loss'; reset(); await fresh(); await add('a-very-long-but-valid-serving-domain.ten98.example'); await add('old.ten98.example', 'redirect_alias');
  const layout = [];
  for (const width of [1440, 320]) for (const direction of ['ltr', 'rtl']) { await page.setViewportSize({width, height: 1000}); await page.evaluate(value => document.documentElement.dir = value, direction); await page.evaluate(() => new Promise(requestAnimationFrame)); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), width + direction + ' document bounds'); const boxes = await page.locator('.domains-panel, .domain-table tbody tr').evaluateAll(nodes => nodes.map(node => { const box = node.getBoundingClientRect(), style = getComputedStyle(node); return {left: box.left, right: box.right, background: style.backgroundColor, border: style.borderInlineStartColor}; })); assert.ok(boxes.every(box => box.left >= 0 && box.right <= width), width + direction + ' physical panel and row bounds'); layout.push({width, direction, boxes}); assert.equal(await row('old.ten98.example').count(), 1); await page.screenshot({path: resolve(evidence, 'domains-' + width + '-' + direction + '.png'), fullPage: true}); }
  await writeFile(resolve(evidence, 'layout.json'), JSON.stringify(layout, null, 2));
  const summary = page.locator('.domain-add > summary'); await summary.focus(); await page.keyboard.press('Enter'); assert.equal(await page.getByRole('form', {name: 'Add a domain', exact: true}).isVisible(), true); await page.keyboard.press('Space'); assert.equal(await page.getByRole('form', {name: 'Add a domain', exact: true}).isVisible(), false);
  await row('old.ten98.example').getByRole('button', {name: 'Create DNS proof', exact: true}).click(); await proof().waitFor(); verifyStatus = 403; await proof().getByRole('button', {name: 'Check DNS proof', exact: true}).click(); await page.getByRole('alert').waitFor(); assert.equal(await website().count(), 0); assert.equal(await proof().count(), 0); assert.equal(await row('old.ten98.example').count(), 0);
  verifyStatus = 200; await fresh(); await page.getByRole('button', {name: 'Become viewer', exact: true}).click(); await page.getByRole('heading', {name: 'Domain management unavailable for this role', exact: true}).waitFor(); assert.equal(await website().count(), 0);
  await fresh(); await website().getByRole('button', {name: 'Verify DNS ownership', exact: true}).click(); await proof().waitFor(); verifyStatus = 401; await proof().getByRole('button', {name: 'Check DNS proof', exact: true}).click(); await page.getByRole('heading', {name: 'Fixture signed out', exact: true}).waitFor(); assert.equal(await website().count(), 0); assert.equal(await proof().count(), 0); groups++;
  console.log('PASS320 LTR/RTL compact semantic rows, keyboard disclosure and403/viewer/401 protected-state purge.');

  assert.deepEqual(errors, []); assert.deepEqual(external, []); assert.deepEqual(await hashes(), before);
  await writeFile(resolve(evidence, 'acceptance.json'), JSON.stringify({groups, sourceHashes: before, reads: reads.length, syntheticWrites: writes.length, external, errors, scope: 'component + native router, intercepted synthetic API; no backend acceptance claimed'}, null, 2));
  console.log('PASS domain setup focused acceptance: ' + groups + ' groups; evidence ' + evidence);
} catch (error) {
  await writeFile(resolve(evidence, 'failure.json'), JSON.stringify({stage, error: String(error), errors, external, reads: reads.slice(-10), body: await page?.locator('body').innerText()}, null, 2));
  await page?.screenshot({path: resolve(evidence, 'failure.png'), fullPage: true}); throw error;
} finally {
  for (const release of releases) release();
  await browser?.close(); await server.close();
  assert.equal(server.httpServer?.listening, false);
  if (port) {
    const probe = createNetServer();
    await new Promise((done, reject) => { probe.once('error', reject); probe.listen(port, '127.0.0.1', done); });
    await new Promise((done, reject) => probe.close(error => error ? reject(error) : done()));
  }
  await writeFile(resolve(evidence, 'cleanup.json'), JSON.stringify({serverClosed: !server.httpServer?.listening, browserClosed: !browser?.isConnected(), port, portReusable: !!port, external}, null, 2));
}
