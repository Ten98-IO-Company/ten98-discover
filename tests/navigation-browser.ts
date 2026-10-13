import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { hashPassword } from 'better-auth/crypto'
import { getConfig } from '../src/server/config.ts'
import { assertSchema, closeDatabase, getDatabase } from '../src/server/db.ts'
import { createWorkspace } from '../src/server/teams.ts'

// Optional real production-client/API check, using only an isolated local database.
assert.equal(process.env.TEN98_INTEGRATION_TEST, '1')
assert.ok(process.env.PLAYWRIGHT_MODULE)
const config = getConfig()
for (const url of [config.appUrl, config.databaseUrl]) assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname))
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE!)
let browser: any, page: any
const releases: (() => void)[] = []
try {
  await assertSchema()
  const { pool } = getDatabase(), password = randomBytes(24).toString('base64url')
  async function actor(name: string) {
    const id = randomUUID(), email = `${id}@navigation.integration.test`
    await pool.query('INSERT INTO "user"(id,name,email) VALUES($1,$2,$3)', [id, name, email])
    await pool.query('INSERT INTO account(id,"accountId","providerId","userId",password) VALUES($1,$2,\'credential\',$2,$3)', [randomUUID(), id, await hashPassword(password)])
    return { id, email }
  }
  const owner = await actor('Navigation owner'), other = await actor('Other navigation account')
  const a = (await createWorkspace(owner.id, { name: 'Navigation Alpha' })).workspace
  const b = (await createWorkspace(other.id, { name: 'Navigation Beta' })).workspace
  const foreign = (await createWorkspace(other.id, { name: 'Unavailable workspace' })).workspace
  await pool.query("INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,'viewer')", [b.id, owner.id])
  async function project(workspace: string, name: string) {
    const id = randomUUID()
    await pool.query('INSERT INTO project(id,workspace_id,name,origin,public_key) VALUES($1,$2,$3,$4,$5)', [id, workspace, name, `https://${id}.integration.test`, randomUUID()])
    return id
  }
  const a1 = await project(a.id, 'Alpha one'), a2 = await project(a.id, 'Alpha two'), b1 = await project(b.id, 'Beta one'), foreignProject = await project(foreign.id, 'Unavailable project')
  await pool.query("UPDATE installation SET claimed=true WHERE id='instance'")
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL ?? 'msedge', headless: true })
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  let external = 0, errors = 0
  const requests: string[] = []
  await context.route('**/*', (route: any) => {
    const url = new URL(route.request().url())
    if (url.origin !== config.appUrl) { external++; return route.abort() }
    requests.push(url.pathname)
    return route.continue()
  })
  page = await context.newPage(); page.setDefaultTimeout(15000); page.on('pageerror', () => errors++)
  const href = (workspace: string, project: string, view: string) => `${config.appUrl}/?${new URLSearchParams({ workspace, ...(project ? { project } : {}), view })}`
  async function auth(email: string) {
    const response = await context.request.post(`${config.appUrl}/api/auth/sign-in/email`, { headers: { origin: config.appUrl }, data: { email, password } })
    assert.equal(response.status(), 200)
  }
  async function heading(name: string) { await page.getByRole('heading', { name: name === 'Account security' ? 'Account' : name, exact: true }).first().waitFor() }
  async function menu() {
    const button = page.getByRole('button', { name: /^(Menu|Close menu)$/ })
    if (await button.isVisible() && await button.getAttribute('aria-expanded') === 'false') await button.click()
  }
  async function link(name: string) {
    await menu()
    const target = page.getByRole('link', { name, exact: true })
    if (!await target.isVisible()) await page.getByText('Workspace settings', { exact: true }).click()
    await target.click()
  }
  async function selected(workspace: string, project: string | null, view: string) {
    await page.waitForFunction(({ workspace, project, view }: any) => {
      const p = new URLSearchParams(location.search)
      return p.get('workspace') === workspace && p.get('project') === project && p.get('view') === view
    }, { workspace, project, view })
  }
  async function hold(pattern: string, responseStatus?: number) {
    let release!: () => void, started!: () => void
    const waiting = new Promise<void>(resolve => { release = resolve }), began = new Promise<void>(resolve => { started = resolve })
    releases.push(release)
    const handler = async (route: any) => {
      const response = await route.fetch(); started(); await waiting
      if (responseStatus) await route.fulfill({ status: responseStatus, contentType: 'application/json', body: JSON.stringify({ error: 'Synthetic expired earlier session.' }) })
      else await route.fulfill({ response })
    }
    await context.route(pattern, handler)
    return { began, release, remove: () => context.unroute(pattern, handler) }
  }

  await auth(owner.email)
  await page.goto(href(a.id, a2, 'events')); await heading('Recent events')
  await selected(a.id, a2, 'events'); await page.reload(); await heading('Recent events'); await selected(a.id, a2, 'events')
  await page.goto(href(a.id, a2, 'events') + '&invite=synthetic&token=synthetic&returnTo=https%3A%2F%2Fexample.test')
  await heading('Recent events'); await selected(a.id, a2, 'events')
  assert.deepEqual([...new URL(page.url()).searchParams.keys()].sort(), ['project', 'view', 'workspace'])
  await link('Context'); await heading('Project context')
  await link('Account security'); await heading('Account security')
  await page.goBack(); await heading('Project context'); await selected(a.id, a2, 'context')
  await page.goBack(); await heading('Recent events')
  await page.goForward(); await heading('Project context')
  console.log('PASS navigation: authenticated deep link, reload and Back/Forward preserve context.')

  const original = page.url()
  const opened = context.waitForEvent('page')
  await page.getByRole('link', { name: 'Recent events', exact: true }).click({ modifiers: ['Control'] })
  const tab = await opened; await tab.getByRole('heading', { name: 'Recent events', exact: true, level: 1 }).waitFor()
  assert.equal(page.url(), original); assert.equal(new URL(tab.url()).searchParams.get('project'), a2); await tab.close()
  await link('+ New project'); await heading('Create a new project'); await selected(a.id, null, 'new-project')
  await page.reload(); await heading('Create a new project'); await selected(a.id, null, 'new-project')
  console.log('PASS navigation: native new-tab links and explicit New project survive reload.')

  requests.length = 0
  await page.goto(href(a.id, foreignProject, 'events')); await heading('Recent events')
  assert.notEqual(new URL(page.url()).searchParams.get('project'), foreignProject)
  assert.equal(requests.some(path => path.startsWith(`/api/projects/${foreignProject}/`)), false)
  await link('Context'); await heading('Project context')
  assert.equal(await page.getByRole('alert').filter({ hasText: 'That project is no longer available' }).count(), 0)
  await page.goto(href(foreign.id, foreignProject, 'events')); await heading('Recent events')
  assert.notEqual(new URL(page.url()).searchParams.get('workspace'), foreign.id)
  assert.equal(requests.includes(`/api/workspaces/${foreign.id}/projects`), false)
  await page.goto(href(b.id, b1, 'providers')); await heading('Web analytics'); await selected(b.id, b1, 'project')
  await page.goto(href(b.id, b1, 'retention')); await page.getByRole('heading', { name: /retention/i }).first().waitFor(); await selected(b.id, b1, 'retention')
  await page.goto(href(a.id, a1, 'google-app')); await heading('Web analytics')
  await page.goto(href(a.id, a1, 'meta-app')); await heading('Web analytics')
  await page.goto(`${config.appUrl}/?workspace=${a.id}&workspace=${foreign.id}&project=${foreignProject}&view=security&view=providers&invite=do-not-store`)
  await heading('Web analytics'); assert.equal(new URL(page.url()).searchParams.has('invite'), false)
  assert.equal(new URL(page.url()).searchParams.getAll('workspace').length, 1)
  console.log('PASS navigation: malformed, foreign and forbidden targets canonicalize before protected panels mount.')

  const failedProjects = `**/api/workspaces/${a.id}/projects`
  const unavailable = (route: any) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Synthetic project list unavailable.' }) })
  await context.route(failedProjects, unavailable)
  await page.goto(href(a.id, '', 'project')); await page.getByRole('button', { name: 'Retry projects', exact: true }).waitFor()
  assert.equal(await page.getByRole('button', { name: 'Create project', exact: true }).count(), 0, 'A failed list is not evidence of an empty workspace.')
  assert.equal(await page.getByRole('heading', { name: 'Connect your first website', exact: true }).count(), 0)
  await context.unroute(failedProjects, unavailable); await page.getByRole('button', { name: 'Retry projects', exact: true }).click(); await heading('Web analytics')
  console.log('PASS navigation: failed project discovery preserves its retry state without inventing an empty workspace.')

  await page.goto(href(a.id, a1, 'events')); await heading('Recent events')
  const slowWorkspace = await hold(`**/api/workspaces/${b.id}/projects`)
  await page.getByLabel('Workspace', { exact: true }).selectOption(b.id); await slowWorkspace.began
  await link('Account security'); await heading('Account security')
  slowWorkspace.release(); await slowWorkspace.remove(); await delay(150)
  await heading('Account security'); assert.equal(new URL(page.url()).searchParams.get('view'), 'security')
  await page.goBack(); await heading('Web analytics'); await selected(b.id, b1, 'project')
  console.log('PASS navigation: a delayed workspace load cannot replace newer Account navigation.')

  await page.goto(href(a.id, '', 'new-project')); await heading('Create a new project')
  const create = await hold(`**/api/workspaces/${a.id}/projects`)
  await page.getByLabel('Project name', { exact: true }).fill('Created while navigating')
  await page.getByLabel('Website origin', { exact: true }).fill('https://created.navigation.test')
  await page.getByRole('button', { name: 'Create project', exact: true }).click(); await create.began
  await link('Account security'); await heading('Account security'); create.release(); await create.remove(); await delay(200)
  await heading('Account security'); assert.equal(new URL(page.url()).searchParams.get('view'), 'security')
  assert.equal((await pool.query('SELECT count(*) FROM project WHERE workspace_id=$1 AND name=$2', [a.id, 'Created while navigating'])).rows[0].count, '1')
  console.log('PASS navigation: committed project creation remains saved without stealing a newer page.')

  await page.goto(href(a.id, '', 'new-project')); await heading('Create a new project')
  const roundTrip = await hold(`**/api/workspaces/${a.id}/projects`)
  await page.getByLabel('Project name', { exact: true }).fill('Earlier identical navigation')
  await page.getByLabel('Website origin', { exact: true }).fill('https://round-trip.navigation.test')
  await page.getByRole('button', { name: 'Create project', exact: true }).click(); await roundTrip.began
  await link('Account security'); await heading('Account security'); await link('+ New project'); await heading('Create a new project')
  roundTrip.release(); await roundTrip.remove(); await delay(150)
  await heading('Create a new project'); await selected(a.id, null, 'new-project')
  console.log('PASS navigation: returning to the same URL does not revive an earlier mutation intent.')

  await page.goto(href(b.id, b1, 'workspace')); await heading('Create workspace')
  const membership = await hold('**/api/me')
  await page.getByLabel('Workspace name', { exact: true }).fill('Created workspace while navigating')
  await page.getByRole('button', { name: 'Create workspace', exact: true }).click(); await membership.began
  await link('Account security'); await heading('Account security'); membership.release(); await membership.remove(); await delay(150)
  await heading('Account security'); assert.equal(new URL(page.url()).searchParams.get('workspace'), b.id)
  assert.equal(new URL(page.url()).searchParams.get('view'), 'security')
  console.log('PASS navigation: workspace creation/membership refresh preserves newer valid viewer navigation.')

  for (const family of ['google','meta']) {
    const fragment=`#${family}=connected&${family}-project=${a2}&${family}-workspace=${a.id}`
    const callback = await hold(`**/api/workspaces/${a.id}/projects`)
    await page.goto(href(b.id, b1, 'events')+fragment); await callback.began
    await link('Account security'); await heading('Account security'); callback.release(); await callback.remove(); await delay(150)
    await heading('Account security'); assert.equal(new URL(page.url()).hash, '')
    await page.goto(href(b.id, b1, 'events')+fragment)
    await heading(family==='meta'?'Meta ads':'Google reports'); await selected(a.id, a2, family); assert.equal(new URL(page.url()).hash, '')
    await page.goto(href(a.id, a1, 'events')+fragment+'&oidc-factor=1')
    await heading('Recent events'); await page.getByRole('alert').filter({ hasText: 'invalid or ambiguous' }).waitFor()
    assert.equal(new URL(page.url()).hash, '')
  }
  console.log('PASS navigation: callback has one-shot priority, yields to user intent, and rejects mixed fragments.')

  await page.goto(href(a.id, '', 'new-project')); await heading('Create a new project')
  const oldSession = await hold(`**/api/workspaces/${a.id}/projects`, 401)
  await page.getByLabel('Project name', { exact: true }).fill('Old session response')
  await page.getByLabel('Website origin', { exact: true }).fill('https://old-session.navigation.test')
  await page.getByRole('button', { name: 'Create project', exact: true }).click(); await oldSession.began
  await page.getByRole('button', { name: 'Sign out', exact: true }).click()
  await page.getByLabel('Email', { exact: true }).fill(other.email); await page.getByLabel('Password', { exact: true }).fill(password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click(); await heading('Web analytics')
  oldSession.release(); await oldSession.remove(); await delay(150); await heading('Web analytics')
  assert.equal(await page.getByRole('link', { name: 'Alpha one', exact: true }).count(), 0)
  console.log('PASS navigation: late 401 from an earlier session cannot sign out the new account.')

  await page.setViewportSize({ width: 360, height: 800 }); await link('Recent events'); await heading('Recent events')
  assert.equal(await page.getByRole('button', { name: 'Menu', exact: true }).getAttribute('aria-expanded'), 'false')
  await menu()
  const mobileOpened = context.waitForEvent('page')
  await page.getByRole('link', { name: 'Recent events', exact: true }).click({ modifiers: ['Control'] })
  const mobileTab = await mobileOpened; await mobileTab.getByRole('heading', { name: 'Recent events', exact: true, level: 1 }).waitFor()
  assert.equal(await page.getByRole('button', { name: 'Close menu', exact: true }).getAttribute('aria-expanded'), 'true', 'Opening another tab must not navigate or close this tab menu.')
  await mobileTab.close()
  await page.getByRole('link', { name: 'Recent events', exact: true }).click()
  assert.equal(await page.getByRole('button', { name: 'Menu', exact: true }).getAttribute('aria-expanded'), 'false', 'Choosing the current URL still closes mobile navigation.')
  await page.waitForFunction(() => document.activeElement?.tagName === 'MAIN')
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  await mkdir('private/navigation-browser', { recursive: true }); await page.screenshot({ path: 'private/navigation-browser/mobile.png', fullPage: true })
  assert.equal(external, 0); assert.equal(errors, 0)
  console.log('PASS navigation: mobile menu closes, layout fits, and no external request or page exception occurs.')

  assert.equal((await context.request.post(`${config.appUrl}/api/auth/sign-out`, { headers: { origin: config.appUrl }, data: {} })).status(), 200)
  await page.goto(href(a.id, a1, 'events') + '#oidc-factor=1'); await heading('Verify your sign-in')
  assert.equal(new URL(page.url()).hash, '')
  await page.getByRole('button', { name: 'Back to sign in', exact: true }).click()
  await page.getByLabel('Email', { exact: true }).fill(owner.email); await page.getByLabel('Password', { exact: true }).fill(password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click(); await heading('Recent events'); await selected(a.id, a1, 'events')
  const proof = randomUUID()
  await page.goto(href(a.id, a1, 'events') + '#oidc-proof=' + proof); await selected(a.id, a1, 'identity')
  assert.equal(new URL(page.url()).hash, '')
  assert.equal(await page.evaluate((proof: string) => location.search.includes(proof) || JSON.stringify(history.state).includes(proof), proof), false)
  await link('Recent events'); await heading('Recent events')
  assert.equal(external, 0); assert.equal(errors, 0)
  console.log('PASS navigation: factor cancellation/local sign-in preserve the requested page; OIDC proof stays out of search/history state.')
} catch (error) {
  if (page && !page.isClosed()) {
    await mkdir('private/navigation-browser', { recursive: true })
    await page.screenshot({ path: 'private/navigation-browser/failure.png', fullPage: true })
    console.error('Navigation failure location:', new URL(page.url()).pathname, new URL(page.url()).searchParams.get('view'))
    console.error('Visible headings:', await page.getByRole('heading').allTextContents())
  }
  throw error
} finally {
  for (const release of releases) release()
  await browser?.close(); await closeDatabase()
}
