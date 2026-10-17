import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { hashPassword } from 'better-auth/crypto'
import { getConfig } from '../src/server/config.ts'
import { assertSchema, closeDatabase, getDatabase } from '../src/server/db.ts'
import { createWorkspace } from '../src/server/teams.ts'
import { createPrompts } from '../src/server/prompts.ts'
import { updateProjectContext } from '../src/server/project-context.ts'

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
  async function project(workspace: string, name: string, origin?: string) {
    const id = randomUUID()
    await pool.query('INSERT INTO project(id,workspace_id,name,origin,public_key) VALUES($1,$2,$3,$4,$5)', [id, workspace, name, origin??`https://${id}.integration.test`, randomUUID()])
    return id
  }
  const a1 = await project(a.id, 'Alpha one'), a2 = await project(a.id, 'Alpha two'), b1 = await project(b.id, 'Beta one', 'https://navigation-insights.example.com'), foreignProject = await project(foreign.id, 'Unavailable project')
  await pool.query("UPDATE installation SET claimed=true WHERE id='instance'")
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL ?? 'msedge', headless: true })
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  let external = 0, errors = 0
  const requests: string[] = [], aiWrites: string[] = []
  await context.route('**/*', (route: any) => {
    const url = new URL(route.request().url())
    if (url.origin !== config.appUrl) { external++; return route.abort() }
    requests.push(url.pathname)
    if (route.request().method() !== 'GET' && /\/prompt-(?:executions|insights)(?:\/|$)/.test(url.pathname)) aiWrites.push(url.pathname)
    return route.continue()
  })
  page = await context.newPage(); page.setDefaultTimeout(15000); page.on('pageerror', () => errors++)
  const href = (workspace: string, project: string, view: string) => `${config.appUrl}/?${new URLSearchParams({ workspace, ...(project ? { project } : {}), view })}`
  async function auth(email: string) {
    const response = await context.request.post(`${config.appUrl}/api/auth/sign-in/email`, { headers: { origin: config.appUrl }, data: { email, password } })
    assert.equal(response.status(), 200)
  }
  async function heading(name: string) { await page.getByRole('heading', { name: name === 'Account security' ? 'Account' : name, exact: true }).first().waitFor() }
  async function sourceFilters() {
    const disclosure = page.locator('details').filter({ has: page.locator('summary', { hasText: /^Source filters$/ }) })
    await disclosure.waitFor()
    if (await disclosure.getAttribute('open') === null) await disclosure.locator(':scope > summary').click()
  }
  async function menu() {
    const button = page.getByRole('button', { name: /^(Menu|Close menu)$/ })
    if (await button.isVisible() && await button.getAttribute('aria-expanded') === 'false') await button.click()
  }
  async function navigationLink(name: string) {
    await menu()
    const target = page.locator('#app-navigation').getByRole('link', { name, exact: true, includeHidden: true })
    await target.waitFor({ state: 'attached' })
    // Exercise native disclosures, including outer ancestors, rather than changing open in JavaScript.
    for (const disclosure of await target.locator('xpath=ancestor::details').all()) {
      if (await disclosure.getAttribute('open') === null) await disclosure.locator(':scope > summary').click()
    }
    return target
  }
  async function link(name: string) { await (await navigationLink(name)).click() }
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
  const retentionIntent = {retentionMonth:'2024-03', retentionTimeZone:'Asia/Dubai', retentionEntry:new URLSearchParams({kind:'all',path:'/entry'}).toString()}
  await page.goto(href(a.id,a1,'visitor-retention')+'&'+new URLSearchParams(retentionIntent))
  await heading('Retention')
  await page.getByText('2024-03 · Asia/Dubai · Exact local-day returns within this month',{exact:true}).waitFor()
  for(const [key,value] of Object.entries(retentionIntent)) assert.equal(new URL(page.url()).searchParams.get(key),value)
  await page.reload()
  await page.getByText('2024-03 · Asia/Dubai · Exact local-day returns within this month',{exact:true}).waitFor()
  for(const [key,value] of Object.entries(retentionIntent)) assert.equal(new URL(page.url()).searchParams.get(key),value)
  console.log('PASS navigation: compiled parent preserves Retention month/timezone/entry scope through project resolution and reload.')
  const attributionIntent=new URLSearchParams({from:'2024-03-01',to:'2024-03-07',timeZone:'Asia/Dubai',kind:'all',model:'last-click',conversionKind:'custom',conversionValue:'signup'}).toString()
  await page.goto(href(a.id,a1,'attribution')+'&'+new URLSearchParams({attributionQuery:attributionIntent}))
  await page.getByRole('region',{name:'Attribution result',exact:true}).waitFor()
  assert.equal(await page.getByLabel('Attribution model',{exact:true}).inputValue(),'last-click')
  assert.equal(new URL(page.url()).searchParams.get('attributionQuery'),attributionIntent)
  await page.reload()
  await page.getByRole('region',{name:'Attribution result',exact:true}).waitFor()
  assert.equal(await page.getByLabel('Conversion value',{exact:true}).inputValue(),'signup')
  assert.equal(new URL(page.url()).searchParams.get('attributionQuery'),attributionIntent)
  console.log('PASS navigation: compiled parent loads Attribution with its exact applied conversion/model/dates and preserves them on reload.')
  const revenueIntent=new URLSearchParams({from:'2024-03-01',to:'2024-03-07',timeZone:'Asia/Dubai',kind:'all',currency:'AED'}).toString()
  await page.goto(href(a.id,a1,'revenue')+'&'+new URLSearchParams({revenueQuery:revenueIntent}))
  await page.getByRole('region',{name:'Revenue result',exact:true}).waitFor()
  assert.equal(await page.getByLabel('Currency',{exact:true}).inputValue(),'AED')
  assert.equal(new URL(page.url()).searchParams.get('revenueQuery'),revenueIntent)
  await page.reload()
  await page.getByRole('region',{name:'Revenue result',exact:true}).waitFor()
  assert.equal(await page.getByLabel('Time zone',{exact:true}).inputValue(),'Asia/Dubai')
  assert.equal(new URL(page.url()).searchParams.get('revenueQuery'),revenueIntent)
  console.log('PASS navigation: compiled parent preserves Revenue dates,timezone,currency and applied scope through project resolution and reload.')
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
  await (await navigationLink('Recent events')).click({ modifiers: ['Control'] })
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

  const families = ['Measure', 'Research', 'Connect']
  const commonSections = ['Analytics', 'Realtime', 'Compare', 'UTM campaigns', 'Explore', 'Sessions', 'Attribution', 'Journeys', 'Retention', 'Revenue', 'Conversions', 'Recent events', 'Reports', 'Google reports', 'Site audits', 'Context', 'Prompts', 'AI insights', 'AI search', 'Keywords', 'Domain SEO', 'Rank tracking', 'Install tracker', 'Collection and privacy']
  for (const [workspace, projectId, isOwner] of [[a.id, a1, true], [b.id, b1, false]] as const) {
    await page.goto(href(workspace, projectId, 'events')); await heading('Recent events'); await menu()
    const sections = page.getByRole('navigation', { name: 'Project sections', exact: true })
    assert.deepEqual(await sections.locator(':scope > .side-label').allTextContents(), families)
    const expected = isOwner ? [...commonSections.slice(0, commonSections.indexOf('Collection and privacy')), 'Destinations', 'Collection and privacy', 'Domains'] : commonSections
    assert.deepEqual(await sections.getByRole('link', { includeHidden: true }).allTextContents(), expected)
    assert.deepEqual(await sections.locator('a[aria-current="page"]').allTextContents(), ['Recent events'])
    assert.deepEqual(await page.getByRole('navigation', { name: 'Workspace settings', exact: true, includeHidden: true }).getByRole('link', { includeHidden: true }).allTextContents(), isOwner ? ['Manage team', 'ten98 API access', 'AI and search providers', 'Data retention', 'Create workspace'] : ['Data retention', 'Create workspace'])
    assert.deepEqual(await page.getByRole('navigation', { name: 'Account', exact: true, includeHidden: true }).getByRole('link', { includeHidden: true }).allTextContents(), ['Profile and appearance', 'Account security', 'Identity sign-in'])
    assert.equal(await page.getByRole('navigation', { name: 'Instance settings', includeHidden: true }).count(), 0)
    assert.equal(await page.getByRole('link', { name: '+ New project', exact: true, includeHidden: true }).count(), isOwner ? 1 : 0)
    assert.equal(await sections.locator(':scope > details').count(), 0, 'Project sections are flat and always exposed.')
    for (const target of await sections.getByRole('link').all()) assert.equal(await target.isVisible(), true)
    const contextLink = sections.getByRole('link', { name: 'Context', exact: true })
    await contextLink.focus(); await page.keyboard.press('Enter'); await heading('Project context')
    await selected(workspace, projectId, 'context')
    assert.deepEqual(await sections.locator('a[aria-current="page"]').allTextContents(), ['Context'])
    await link('Data retention'); await page.getByRole('heading', { name: /retention/i }).first().waitFor()
    assert.equal(await sections.locator('a[aria-current="page"]').count(), 0)
    assert.deepEqual(await page.getByRole('navigation', { name: 'Workspace settings', exact: true }).locator('a[aria-current="page"]').allTextContents(), ['Data retention'])
  }
  await pool.query("INSERT INTO instance_operator(user_id,source) VALUES($1,'host')", [owner.id])
  try {
    await page.reload(); await page.getByRole('heading', { name: /retention/i }).first().waitFor(); await menu()
    const instance = page.getByRole('navigation', { name: 'Instance settings', exact: true, includeHidden: true })
    assert.deepEqual(await instance.getByRole('link', { includeHidden: true }).allTextContents(), ['Google app setup'])
    assert.equal(await page.getByRole('link', { name: 'AI and search providers', exact: true, includeHidden: true }).count(), 0, 'Instance authority does not upgrade a workspace viewer.')
    await link('Google app setup'); await heading('Google app setup'); await selected(b.id, b1, 'google-app')
    assert.notEqual(await page.locator('details.account-menu').getAttribute('open'), null, 'Current operator destination opens the account footer.')
    assert.deepEqual(await instance.locator('a[aria-current="page"]').allTextContents(), ['Google app setup'])
  } finally { await pool.query('DELETE FROM instance_operator WHERE user_id=$1', [owner.id]) }
  await page.reload(); await heading('Web analytics'); await selected(b.id, b1, 'project')
  assert.equal(await page.getByRole('navigation', { name: 'Instance settings', includeHidden: true }).count(), 0)
  console.log('PASS navigation: three flat ordered groups, owner/viewer/operator permissions, native keyboard links and scoped current-page markers.')

  await mkdir('private/navigation-browser', { recursive: true })
  for (const width of [320, 360, 1440]) {
    await page.setViewportSize({ width, height: 900 })
    await page.goto(href(a.id, a1, 'events')); await heading('Recent events')
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `Closed navigation must fit ${width}px.`)
    await menu()
    const sections = page.getByRole('navigation', { name: 'Project sections', exact: true })
    assert.equal(await sections.locator(':scope > details').count(), 0)
    assert.deepEqual(await sections.locator(':scope > .side-label').allTextContents(), families)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `Expanded navigation must fit ${width}px.`)
    if (width <= 360) {
      for (const target of await sections.locator('summary, a').all()) {
        const bounds = await target.boundingBox(); assert.ok(bounds && bounds.height >= 44 && bounds.width >= 44, 'Mobile navigation targets remain at least 44px.')
      }
    }
    await page.evaluate(() => { window.scrollTo(0, 0); document.querySelector('.side')?.scrollTo(0, 0) })
    await page.screenshot({ path: `private/navigation-browser/families-${width}.png`, fullPage: true })
    await link('Context'); await heading('Project context'); await selected(a.id, a1, 'context')
    if (width <= 360) assert.equal(await page.getByRole('button', { name: 'Menu', exact: true }).getAttribute('aria-expanded'), 'false')
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    await page.screenshot({ path: `private/navigation-browser/context-${width}.png`, fullPage: true })
  }
  await page.setViewportSize({ width: 1280, height: 900 })
  console.log('PASS navigation: real production 320/360/1440 reflow, flat visible groups, mobile targets and project-selection focus.')

  const failedProjects = `**/api/workspaces/${a.id}/projects`
  const unavailable = (route: any) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Synthetic project list unavailable.' }) })
  await context.route(failedProjects, unavailable)
  await page.goto(href(a.id, '', 'project')); await page.getByRole('button', { name: 'Retry projects', exact: true }).waitFor()
  assert.equal(await page.getByRole('button', { name: 'Create project', exact: true }).count(), 0, 'A failed list is not evidence of an empty workspace.')
  assert.equal(await page.getByRole('heading', { name: 'Connect your first website', exact: true }).count(), 0)
  await context.unroute(failedProjects, unavailable); await page.getByRole('button', { name: 'Retry projects', exact: true }).click(); await heading('Web analytics')
  console.log('PASS navigation: failed project discovery preserves its retry state without inventing an empty workspace.')

  await page.goto(href(a.id, a1, 'events')); await heading('Recent events')
  const identityBeforeWorkspaceSwitch = await page.locator('.account-summary-text').textContent()
  const slowWorkspace = await hold(`**/api/workspaces/${b.id}/projects`)
  await page.getByLabel('Workspace', { exact: true }).selectOption(b.id); await slowWorkspace.began
  assert.equal(await page.locator('.account-summary-text').textContent(), identityBeforeWorkspaceSwitch, 'Workspace changes must not change account identity.')
  await link('Account security'); await heading('Account security')
  slowWorkspace.release(); await slowWorkspace.remove(); await delay(150)
  await heading('Account security'); assert.equal(new URL(page.url()).searchParams.get('view'), 'security')
  assert.notEqual(await page.locator('details.account-menu').getAttribute('open'), null, 'Current account destination stays exposed.')
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

  for (const family of ['google']) {
    const fragment=`#${family}=connected&${family}-project=${a2}&${family}-workspace=${a.id}`
    const callback = await hold(`**/api/workspaces/${a.id}/projects`)
    await page.goto(href(b.id, b1, 'events')+fragment); await callback.began
    await link('Account security'); await heading('Account security'); callback.release(); await callback.remove(); await delay(150)
    await heading('Account security'); assert.equal(new URL(page.url()).hash, '')
    await page.goto(href(b.id, b1, 'events')+fragment)
    await heading('Google reports'); await selected(a.id, a2, family); assert.equal(new URL(page.url()).hash, '')
    await page.goto(href(a.id, a1, 'events')+fragment+'&oidc-factor=1')
    await heading('Recent events'); await page.getByRole('alert').filter({ hasText: 'invalid or ambiguous' }).waitFor()
    assert.equal(new URL(page.url()).hash, '')
  }
  // The Meta connection was removed: its old return fragment is no callback family and is scrubbed as invalid.
  await page.goto(href(a.id, a1, 'events')+`#meta=connected&meta-project=${a2}&meta-workspace=${a.id}`)
  await heading('Recent events'); await page.getByRole('alert').filter({ hasText: 'invalid or ambiguous' }).waitFor()
  assert.equal(new URL(page.url()).hash, ''); await selected(a.id, a1, 'events')
  console.log('PASS navigation: callback has one-shot priority, yields to user intent, and rejects mixed fragments.')

  for (const [workspace, project] of [[a.id,a2],[b.id,b1]]) {
    await page.goto(href(workspace,project,'ai-insights'));await heading('AI insights');await selected(workspace,project,'ai-insights')
    await page.getByText('No executions match this drilldown.',{exact:true}).waitFor()
    await page.reload();await heading('AI insights');await page.getByText('No executions match this drilldown.',{exact:true}).waitFor()
    await page.getByRole('button',{name:'Back to prompts',exact:true}).click();await heading('Prompt library');await selected(workspace,project,'prompts')
    await page.goBack();await heading('AI insights');await selected(workspace,project,'ai-insights');await page.getByText('No executions match this drilldown.',{exact:true}).waitFor()
    await link('Context');await heading('Project context');await link('AI insights');await heading('AI insights');await page.getByText('No executions match this drilldown.',{exact:true}).waitFor()
  }
  assert.deepEqual(aiWrites,[])
  console.log('PASS navigation: owner/viewer AI insights deep links, reload, native Back and sidebar preserve project scope without quotes or provider writes.')

  // One retained synthetic answer, including its complete immutable input and
  // settled receipt. No provider credentials, quote API, queue or worker is used.
  const insightConnection=randomUUID(),insightQuote=randomUUID(),insightComparison=randomUUID(),insightRun=randomUUID()
  const insightPrompt=(await createPrompts(b1,other.id,{requestId:randomUUID(),prompts:[{text:'Which brand is mentioned?',enabled:false}]})).items[0]
  const insightOrigin=(await pool.query('SELECT origin FROM project WHERE id=$1',[b1])).rows[0].origin
  const insightAnswer='Beta one is the brand in this retained synthetic answer.'
  const insightInput={connectionId:insightConnection,promptId:insightPrompt.id,versionId:insightPrompt.currentVersionId,systemText:'Copied navigation fixture system input',models:['openai/gpt-4o-mini'],maxCompletionTokens:128,fundedCredits:true}
  const insightRoute={model:'openai/gpt-4o-mini',tag:'openai',providerName:'OpenAI',promptCapacity:128000,completionCapacity:16384,promptPrice:'0.00000015',completionPrice:'0.0000006',requestPrice:'0',estimateMicros:'1000'}
  const insightCompleted=new Date(Date.now()-2*86400000).toISOString()
  await pool.query("INSERT INTO provider_connection(id,workspace_id,provider,name) VALUES($1,$2,'openrouter','No credentials: navigation fixture')",[insightConnection,b.id])
  await pool.query(`INSERT INTO prompt_execution_quote(id,workspace_id,project_id,user_id,prompt_id,version_id,connection_id,connection_revision,request_actor,key_fingerprint,input,messages,routes,input_hash,expires_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,1,repeat('a',64),repeat('b',64),$8,$9,$10,repeat('c',64),clock_timestamp()+interval '5 minutes')`,
    [insightQuote,b.id,b1,other.id,insightPrompt.id,insightPrompt.currentVersionId,insightConnection,JSON.stringify(insightInput),JSON.stringify([{role:'system',content:insightInput.systemText},{role:'user',content:'Which brand is mentioned?'}]),JSON.stringify([insightRoute])])
  await pool.query('INSERT INTO prompt_comparison(id,quote_id,workspace_id,project_id,user_id,request_key) VALUES($1,$2,$3,$4,$5,$6)',[insightComparison,insightQuote,b.id,b1,other.id,randomUUID()])
  await pool.query(`INSERT INTO provider_request(id,workspace_id,connection_id,connection_revision,user_id,request_key,operation,input_hash,estimate_micros,actual_micros,status,budget_month)
    VALUES($1,$2,$3,1,$4,$5,'synthetic.navigation.insight',repeat('d',64),1000,12,'settled',current_date)`,[insightRun,b.id,insightConnection,other.id,randomUUID()])
  await pool.query(`INSERT INTO prompt_execution(id,comparison_id,workspace_id,project_id,position,route,status,result,completed_at)
    VALUES($1,$2,$3,$4,0,$5,'completed',$6,$7)`,[insightRun,insightComparison,b.id,b1,JSON.stringify(insightRoute),JSON.stringify({text:insightAnswer,resolvedModel:'openai/gpt-4o-mini',provider:'OpenAI',finishReason:'stop',citations:[{url:insightOrigin+'/reference',title:'Synthetic provider annotation'}],promptTokens:12,completionTokens:20,receivedAt:insightCompleted}),insightCompleted])
  const financialBefore=(await pool.query('SELECT * FROM provider_request WHERE id=$1',[insightRun])).rows[0]
  for(const email of [other.email,owner.email]) {
    assert.equal((await context.request.post(`${config.appUrl}/api/auth/sign-out`,{headers:{origin:config.appUrl},data:{}})).status(),200)
    await auth(email);await page.goto(href(b.id,b1,'ai-insights'));await heading('AI insights')
    const metrics=page.getByRole('region',{name:'Entity metrics',exact:true})
    await metrics.getByText('Beta one',{exact:true}).waitFor();assert.equal(await metrics.getByText('1 / 1 (100%)',{exact:true}).count(),3)
    if(email===owner.email) {
      for(const width of [1440,360]) {
        await page.setViewportSize({width,height:900});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true)
        await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:`private/navigation-browser/ai-insights-${width}.png`,fullPage:true})
      }
      await page.setViewportSize({width:1280,height:900})
    }
    const [download]=await Promise.all([page.waitForEvent('download'),page.getByRole('button',{name:'Export report CSV',exact:true}).click()])
    assert.equal(download.suggestedFilename(),'prompt-insights.csv');const csv=await readFile(await download.path(),'utf8')
    assert.ok(csv.includes(insightRun)&&csv.includes(insightComparison));assert.ok(!csv.includes(insightAnswer)&&!csv.includes(insightInput.systemText))
    assert.equal(csv.split('\r\n').filter(line=>line.startsWith('"execution",')).length,1)
    const readsBefore=requests.length
    await page.getByRole('button',{name:'Open comparison for execution '+insightRun,exact:true}).click()
    await page.getByRole('region',{name:'Answer from GPT-4o-mini',exact:true}).getByText(insightAnswer,{exact:true}).waitFor()
    assert.ok(requests.slice(readsBefore).includes(`/api/projects/${b1}/prompt-executions`))
    assert.ok(requests.slice(readsBefore).includes(`/api/projects/${b1}/prompt-executions/comparisons/${insightComparison}`))
    assert.equal(new URL(page.url()).searchParams.get('view'),'ai-insights');assert.equal(page.url().includes(insightComparison),false)
    await page.getByText('Copied prompt and system input',{exact:true}).click();await page.getByText(insightInput.systemText,{exact:true}).waitFor()
    await page.getByRole('button',{name:'Back to AI insights',exact:true}).click();await metrics.getByText('1 / 1 (100%)',{exact:true}).first().waitFor()
  }
  // A second immutable receipt in the adjacent closed day makes the real
  // comparison path measurable. Shared messages/settings mean exactly one cell.
  const previousQuote=randomUUID(),previousComparison=randomUUID(),previousRun=randomUUID()
  const currentDay=new Date(Date.now()-2*86400000).toISOString().slice(0,10),previousDay=new Date(Date.now()-3*86400000).toISOString().slice(0,10)
  const previousAnswer='A different product appears in the previous synthetic answer.'
  await pool.query('UPDATE prompt_comparison SET created_at=$2 WHERE id=$1',[insightComparison,currentDay+'T12:00:00Z'])
  await pool.query('UPDATE project_prompt SET user_tags=$2 WHERE id=$1',[insightPrompt.id,JSON.stringify(['navigation-comparison'])])
  await pool.query(`INSERT INTO prompt_execution_quote(id,workspace_id,project_id,user_id,prompt_id,version_id,connection_id,connection_revision,request_actor,key_fingerprint,input,messages,routes,input_hash,expires_at)
    SELECT $2,workspace_id,project_id,user_id,prompt_id,version_id,connection_id,connection_revision,request_actor,key_fingerprint,input,messages,routes,input_hash,expires_at FROM prompt_execution_quote WHERE id=$1`,[insightQuote,previousQuote])
  await pool.query('INSERT INTO prompt_comparison(id,quote_id,workspace_id,project_id,user_id,request_key,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)',[previousComparison,previousQuote,b.id,b1,other.id,randomUUID(),previousDay+'T12:00:00Z'])
  await pool.query(`INSERT INTO provider_request(id,workspace_id,connection_id,connection_revision,user_id,request_key,operation,input_hash,estimate_micros,actual_micros,status,budget_month)
    SELECT $2,workspace_id,connection_id,connection_revision,user_id,$3,operation,input_hash,estimate_micros,actual_micros,status,budget_month FROM provider_request WHERE id=$1`,[insightRun,previousRun,randomUUID()])
  await pool.query(`INSERT INTO prompt_execution(id,comparison_id,workspace_id,project_id,position,route,status,result,completed_at)
    SELECT $2,$3,workspace_id,project_id,position,route,status,jsonb_set(jsonb_set(result,'{text}',to_jsonb($4::text)),'{citations}','[]'),$5 FROM prompt_execution WHERE id=$1`,[insightRun,previousRun,previousComparison,previousAnswer,previousDay+'T12:01:00Z'])
  const previousFinancialBefore=(await pool.query('SELECT * FROM provider_request WHERE id=$1',[previousRun])).rows[0]
  for(const email of [other.email,owner.email]) {
    assert.equal((await context.request.post(`${config.appUrl}/api/auth/sign-out`,{headers:{origin:config.appUrl},data:{}})).status(),200)
    await auth(email);await page.goto(href(b.id,b1,'ai-insights'));await heading('AI insights')
    await page.getByRole('region',{name:'Entity metrics',exact:true}).waitFor()
    const reportFilters=page.locator('details').filter({has:page.locator('summary',{hasText:/^Report filters$/})})
    assert.equal(await reportFilters.getAttribute('open'),null,'Applied-report filters start collapsed.')
    await reportFilters.locator(':scope > summary').click()
    await page.getByRole('button',{name:'Apply filters',exact:true}).waitFor()
    await page.getByLabel('From',{exact:true}).fill(currentDay);await page.getByLabel('To',{exact:true}).fill(currentDay);await page.getByLabel('Timezone',{exact:true}).fill('UTC')
    await page.getByLabel('Model',{exact:true}).selectOption('openai/gpt-4o-mini');await page.getByLabel('Prompt',{exact:true}).selectOption(insightPrompt.id)
    await page.getByLabel('Current tag',{exact:true}).fill('navigation-comparison');await page.getByRole('button',{name:'Apply filters',exact:true}).click()
    await page.getByRole('region',{name:'Entity metrics',exact:true}).getByText('1 / 1 (100%)',{exact:true}).first().waitFor()
    await page.getByRole('button',{name:'Compare periods',exact:true}).click();await heading('Compare AI periods')
    await page.getByText('Comparable',{exact:true}).waitFor();assert.equal(await page.getByLabel('Prompt cohort',{exact:true}).inputValue(),'current-neutral')
    const means=page.getByRole('region',{name:'Equal-cell mention and citation rates',exact:true})
    assert.deepEqual((await means.locator('tbody tr').first().locator('th,td').allTextContents()).slice(1),['1 / 1 (100%)','0 / 1 (0%)','1 / 1 (+100 pp)','1 / 1 (100%)','0 / 1 (0%)','1 / 1 (+100 pp)'])
    await page.getByLabel('Prompt cohort',{exact:true}).selectOption('all');await page.getByRole('button',{name:'Apply cohort',exact:true}).click();await page.getByText('All prompts',{exact:true}).last().waitFor()
    const [download]=await Promise.all([page.waitForEvent('download'),page.getByRole('button',{name:'Export comparison CSV',exact:true}).click()])
    assert.equal(download.suggestedFilename(),'prompt-insights-comparison.csv');const csv=await readFile(await download.path(),'utf8')
    for(const id of [insightRun,previousRun,insightComparison,previousComparison])assert.ok(csv.includes(id))
    for(const secret of [insightAnswer,previousAnswer,insightInput.systemText])assert.equal(csv.includes(secret),false)
    const currentCell=page.getByRole('button',{name:/^Show current executions for cell /}),cellName=await currentCell.getAttribute('aria-label')
    assert.ok(cellName);assert.equal(await currentCell.count(),1);await currentCell.click()
    await page.getByLabel('Evidence',{exact:true}).selectOption('mentioned');await page.getByRole('button',{name:'Open comparison for execution '+insightRun,exact:true}).waitFor()
    const beforeReceipt=requests.length;await page.getByRole('button',{name:'Open comparison for execution '+insightRun,exact:true}).click()
    await page.getByText(insightAnswer,{exact:true}).waitFor();assert.ok(requests.slice(beforeReceipt).includes(`/api/projects/${b1}/prompt-executions/comparisons/${insightComparison}`))
    const beforeReturn=requests.length;await page.getByRole('button',{name:'Back to comparison',exact:true}).click();await page.getByRole('button',{name:'Open comparison for execution '+insightRun,exact:true}).waitFor()
    assert.ok(requests.slice(beforeReturn).includes(`/api/projects/${b1}/prompt-insights/comparison`));assert.equal(await page.getByLabel('Prompt cohort',{exact:true}).inputValue(),'all');assert.equal(await page.getByLabel('Evidence',{exact:true}).inputValue(),'mentioned')
    await page.getByText(/Current executions.*Selected cell/).waitFor();await page.getByRole('button',{name:'Show comparison cells',exact:true}).click()
    await page.getByRole('button',{name:cellName!,exact:true}).waitFor();await page.getByRole('button',{name:cellName!.replace('current','previous'),exact:true}).click()
    await page.getByRole('button',{name:'Open comparison for execution '+previousRun,exact:true}).click();await page.getByText(previousAnswer,{exact:true}).waitFor()
    await page.getByRole('button',{name:'Back to comparison',exact:true}).click();await page.getByRole('button',{name:'Open comparison for execution '+previousRun,exact:true}).waitFor()
    if(email===owner.email)for(const width of [1440,360]){await page.setViewportSize({width,height:900});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:`private/navigation-browser/ai-comparison-${width}.png`,fullPage:true})}
    await page.setViewportSize({width:1280,height:900});const beforeInsights=requests.length;await page.getByRole('button',{name:'Back to insights',exact:true}).click()
    await page.getByRole('region',{name:'Entity metrics',exact:true}).getByText('1 / 1 (100%)',{exact:true}).first().waitFor();assert.ok(requests.slice(beforeInsights).includes(`/api/projects/${b1}/prompt-insights`))
    for(const [label,value]of [['From',currentDay],['To',currentDay],['Timezone','UTC'],['Model','openai/gpt-4o-mini'],['Prompt',insightPrompt.id],['Current tag','navigation-comparison']])assert.equal(await page.getByLabel(label,{exact:true}).inputValue(),value)
    assert.equal(new URL(page.url()).searchParams.get('view'),'ai-insights')
    // This real-API suite has already exercised the shared 30/minute insight limiter.
    // Start the next bounded workflow in a fresh minute; never clear or disable it.
    await delay(60000-Date.now()%60000)
    await page.getByRole('button',{name:'Analyze citations',exact:true}).click();await heading('Citations')
    const sources=page.getByRole('region',{name:'Citation sources',exact:true})
    await sources.getByText(insightOrigin+'/reference',{exact:true}).waitFor()
    await page.getByText('Classified using current project context; historical ownership was not captured.',{exact:true}).waitFor()
    for(const view of ['domains','categories','page-types','daily','changes','urls']) {
      await page.getByRole('combobox',{name:/^View/}).selectOption(view)
      await sourceFilters()
      await page.getByRole('button',{name:'Apply source filters',exact:true}).waitFor()
      assert.equal(await page.getByRole('combobox',{name:/^View/}).inputValue(),view)
      if(view==='categories')assert.equal(await sources.locator('tbody tr').count(),9)
      if(view==='daily')assert.equal(await page.getByRole('region',{name:'Daily citation observations',exact:true}).locator('tbody tr').count(),2)
    }
    await page.getByRole('textbox',{name:/^Source query/}).fill('no-retained-annotation-matches')
    assert.equal(await page.getByRole('button',{name:'Export full analysis CSV',exact:true}).isDisabled(),true)
    await page.getByRole('button',{name:'Apply source filters',exact:true}).click()
    await page.getByText('No retained annotations match the applied source filters. Eligible answers can also have no annotations.',{exact:true}).waitFor()
    const denominators=page.locator('dt').filter({hasText:/^Eligible answers:$/}).locator('..').locator('dd')
    assert.deepEqual(await denominators.allTextContents(),['1','1'],'Source filtering preserves both full answer denominators')
    await sourceFilters()
    await page.getByRole('textbox',{name:/^Source query/}).fill('');await page.getByRole('button',{name:'Apply source filters',exact:true}).click()
    await sources.getByText(insightOrigin+'/reference',{exact:true}).waitFor()
    const [citationDownload]=await Promise.all([page.waitForEvent('download'),page.getByRole('button',{name:'Export full analysis CSV',exact:true}).click()])
    assert.equal(citationDownload.suggestedFilename(),'prompt-citations.csv');const citationCsv=await readFile(await citationDownload.path(),'utf8')
    assert.ok(citationCsv.includes(insightRun)&&citationCsv.includes(insightComparison)&&citationCsv.includes(insightOrigin+'/reference'))
    assert.equal(citationCsv.split('\r\n').filter(line=>line.startsWith('"evidence",')).length,1)
    for(const secret of [insightAnswer,previousAnswer,insightInput.systemText])assert.equal(citationCsv.includes(secret),false)
    if(email===other.email) {
      await sources.getByRole('button',{name:'Track or classify '+insightOrigin+'/reference',exact:true}).click();await heading('Track or classify domain')
      await page.getByRole('combobox',{name:/^Action/}).waitFor();await page.getByRole('button',{name:'Cancel',exact:true}).click();await heading('Citations')
    } else assert.equal(await page.getByRole('button',{name:/^Track or classify /}).count(),0)
    await sources.getByRole('button',{name:'Current evidence for '+insightOrigin+'/reference',exact:true}).click();await heading('Citation evidence')
    const citationRows=page.getByRole('region',{name:'Citation evidence rows',exact:true})
    await citationRows.getByText('Synthetic provider annotation',{exact:true}).waitFor()
    await citationRows.getByRole('button',{name:/^Open comparison for /}).click();await page.getByText(insightAnswer,{exact:true}).waitFor()
    const beforeCitations=requests.length;await page.getByRole('button',{name:'Back to citations',exact:true}).click();await heading('Citation evidence')
    await citationRows.getByText('Synthetic provider annotation',{exact:true}).waitFor();assert.ok(requests.slice(beforeCitations).includes(`/api/projects/${b1}/prompt-insights/citations`))
    await page.getByRole('button',{name:'Back to source report',exact:true}).click();await heading('Citations')
    if(email===owner.email)for(const width of [1440,360]){await page.setViewportSize({width,height:900});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:`private/navigation-browser/ai-citations-${width}.png`,fullPage:true})}
    await page.setViewportSize({width:1280,height:900});const beforeCitationBack=requests.length;await page.getByRole('button',{name:'Back to insights',exact:true}).click()
    await page.getByRole('region',{name:'Entity metrics',exact:true}).getByText('1 / 1 (100%)',{exact:true}).first().waitFor();assert.ok(requests.slice(beforeCitationBack).includes(`/api/projects/${b1}/prompt-insights`))
    for(const [label,value]of [['From',currentDay],['To',currentDay],['Timezone','UTC'],['Model','openai/gpt-4o-mini'],['Prompt',insightPrompt.id],['Current tag','navigation-comparison']])assert.equal(await page.getByLabel(label,{exact:true}).inputValue(),value)
  }
  assert.deepEqual((await pool.query('SELECT * FROM provider_request WHERE id=$1',[previousRun])).rows[0],previousFinancialBefore)
  console.log('PASS navigation: owner/viewer adjacent closed-period equal-cell rates and CSV; exact current/prior receipts return to fresh selected cell/cohort/outcome and preserve Insights filters.')

  // Extend the retained fixture only after the existing single-annotation checks.
  // No provider request, quote, job or new financial record is created.
  const redditUrl='https://www.reddit.com/r/NavigationFixture/comments/retained/example?fixture=1#annotation'
  await pool.query("UPDATE prompt_execution SET result=jsonb_set(result,'{citations}',(result->'citations')||$2::jsonb) WHERE id=$1",[insightRun,JSON.stringify([{url:redditUrl,title:'Retained Reddit navigation annotation'}])])
  const specializedEndpoint=`/api/projects/${b1}/prompt-insights/citation-specializations`
  const specializedRead=()=>page.waitForResponse((response:any)=>new URL(response.url()).pathname===specializedEndpoint&&response.request().method()==='GET')
  await page.setViewportSize({width:360,height:900})
  const specializedEntry=page.getByRole('button',{name:'Specialized citation reports',exact:true})
  await specializedEntry.scrollIntoViewIfNeeded();assert.equal(await specializedEntry.isEnabled(),true)
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true)
  const [specializedResponse]=await Promise.all([specializedRead(),specializedEntry.click()])
  assert.equal(specializedResponse.status(),200)
  const specialized=await specializedResponse.json();assert.equal(specialized.role,'viewer');assert.equal(specialized.current.coverage.eligible,1)
  assert.equal(specialized.page.kind,'reddit');assert.equal(specialized.page.rows.length,1)
  assert.equal(specialized.page.rows[0].communityKey,'r/navigationfixture');assert.equal(specialized.page.rows[0].current.annotations,1)
  assert.deepEqual([specialized.filters.from,specialized.filters.to,specialized.filters.model,specialized.filters.promptId,specialized.filters.tag],[currentDay,currentDay,'openai/gpt-4o-mini',insightPrompt.id,'navigation-comparison'])
  await heading('Reddit communities');await page.getByRole('region',{name:'Group comparison results',exact:true}).getByText('r/navigationfixture',{exact:true}).waitFor()
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true)
  await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:'private/navigation-browser/ai-specializations-360.png',fullPage:true})
  await page.setViewportSize({width:1440,height:900})
  await page.getByRole('button',{name:/^Current pages for r\/navigationfixture /}).click();await heading('Community pages')
  await page.getByText('Retained Reddit navigation annotation',{exact:true}).waitFor()
  await page.getByRole('button',{name:'View community annotations',exact:true}).click();await heading('Retained annotations')
  const specializedRows=page.getByRole('region',{name:'Retained annotation evidence',exact:true})
  await specializedRows.getByText('Retained Reddit navigation annotation',{exact:true}).waitFor()
  assert.equal(await specializedRows.getByRole('link',{name:redditUrl,exact:true}).getAttribute('href'),redditUrl)
  await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:'private/navigation-browser/ai-specializations-evidence-1440.png',fullPage:true})
  await specializedRows.getByRole('button',{name:/^Open saved comparison for /}).click();await page.getByText(insightAnswer,{exact:true}).waitFor()
  const beforeSpecializedReturn=requests.length
  await page.getByRole('button',{name:'Back to specialized citations',exact:true}).click();await heading('Retained annotations')
  await specializedRows.getByText('Retained Reddit navigation annotation',{exact:true}).waitFor();assert.ok(requests.slice(beforeSpecializedReturn).includes(specializedEndpoint))
  await page.getByRole('button',{name:'Back to previous report',exact:true}).click();await heading('Community pages')
  await page.getByRole('button',{name:'Back to previous report',exact:true}).click();await heading('Reddit communities')
  const beforeSpecializedBack=requests.length
  await page.getByRole('button',{name:'Back to insights',exact:true}).click();await heading('AI insights')
  await page.getByRole('region',{name:'Entity metrics',exact:true}).getByText('1 / 1 (100%)',{exact:true}).first().waitFor()
  assert.ok(requests.slice(beforeSpecializedBack).includes(`/api/projects/${b1}/prompt-insights`))
  for(const [label,value]of [['From',currentDay],['To',currentDay],['Timezone','UTC'],['Model','openai/gpt-4o-mini'],['Prompt',insightPrompt.id],['Current tag','navigation-comparison']])assert.equal(await page.getByLabel(label,{exact:true}).inputValue(),value)
  assert.equal(new URL(page.url()).searchParams.get('view'),'ai-insights');assert.equal(page.url().includes(specialized.page.rows[0].id),false)
  await page.setViewportSize({width:1280,height:900})
  console.log('PASS navigation: viewer/mobile specialized citations entry, real retained Reddit group/pages/evidence and exact saved receipt return through fresh filtered Insights; no provider work.')

  // Back must recompute current context, rather than restore cached denominators.
  await page.getByRole('button',{name:'Open comparison for execution '+insightRun,exact:true}).click();await page.getByText(insightAnswer,{exact:true}).waitFor()
  await updateProjectContext(b1,other.id,{requestId:randomUUID(),revision:1,updates:[{kind:'profile',name:'Renamed insight brand',aliases:[]}]})
  await page.getByRole('button',{name:'Back to AI insights',exact:true}).click()
  const freshMetrics=page.getByRole('region',{name:'Entity metrics',exact:true})
  await freshMetrics.getByText('Renamed insight brand',{exact:true}).waitFor();assert.equal(await freshMetrics.getByText('0 / 2 (0%)',{exact:true}).count(),1)
  await page.getByRole('button',{name:'Open comparison for execution '+insightRun,exact:true}).click();await page.getByText(insightAnswer,{exact:true}).waitFor()
  await pool.query('UPDATE workspace SET raw_provider_evidence_days=1 WHERE id=$1',[b.id])
  await page.getByRole('button',{name:'Refresh status',exact:true}).click()
  await page.getByText('Answer and citations expired under workspace retention.',{exact:true}).waitFor()
  await page.getByText('Copied execution input expired under workspace retention. The authored version preview above is preserved separately.',{exact:true}).waitFor()
  assert.equal(await page.getByText(insightAnswer,{exact:true}).count(),0);assert.equal(await page.getByText(insightInput.systemText,{exact:true}).count(),0)
  // Physical payloads still exist: this verifies fresh read policy, not cleanup.
  assert.equal((await pool.query('SELECT result IS NOT NULL AS retained,result_purged_at FROM prompt_execution WHERE id=$1',[insightRun])).rows[0].retained,true)
  await page.getByRole('button',{name:'Back to AI insights',exact:true}).click();await page.getByText('No eligible retained answers in this range.',{exact:true}).waitFor()
  assert.equal(await freshMetrics.getByText('Unavailable',{exact:true}).count(),3)
  await page.getByRole('button',{name:'Open comparison for execution '+insightRun,exact:true}).click();await page.getByText('Answer and citations expired under workspace retention.',{exact:true}).waitFor()
  assert.deepEqual((await pool.query('SELECT * FROM provider_request WHERE id=$1',[insightRun])).rows[0],financialBefore)
  assert.equal((await pool.query('SELECT count(*) FROM prompt_comparison WHERE project_id=$1',[b1])).rows[0].count,'2')
  assert.deepEqual(aiWrites,[`/api/projects/${b1}/prompt-insights/export`,`/api/projects/${b1}/prompt-insights/export`,`/api/projects/${b1}/prompt-insights/comparison/export`,`/api/projects/${b1}/prompt-insights/citations/export`,`/api/projects/${b1}/prompt-insights/comparison/export`,`/api/projects/${b1}/prompt-insights/citations/export`])
  console.log('PASS navigation: real owner/viewer insight denominators and CSV, exact saved receipt, fresh-context Back and immediate policy-expiry masking; no provider writes or financial changes.')

  await page.goto(href(a.id, '', 'new-project')); await heading('Create a new project')
  const oldSession = await hold(`**/api/workspaces/${a.id}/projects`, 401)
  await page.getByLabel('Project name', { exact: true }).fill('Old session response')
  await page.getByLabel('Website origin', { exact: true }).fill('https://old-session.navigation.test')
  await page.getByRole('button', { name: 'Create project', exact: true }).click(); await oldSession.began
  await navigationLink('Account security') // Open account actions without leaving the pending project request.
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
