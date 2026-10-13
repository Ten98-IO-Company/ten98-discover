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
  const requests: string[] = [], metaReportWrites: string[] = [], aiWrites: string[] = []
  await context.route('**/*', (route: any) => {
    const url = new URL(route.request().url())
    if (url.origin !== config.appUrl) { external++; return route.abort() }
    requests.push(url.pathname)
    if (route.request().method() !== 'GET' && /\/prompt-(?:executions|insights)(?:\/|$)/.test(url.pathname)) aiWrites.push(url.pathname)
    if (route.request().method()==='POST' && /\/meta\/(?:connections\/[^/]+\/(?:imports|campaign-inventories)|(?:imports|campaign-inventories)\/[^/]+\/cancel)$/.test(url.pathname)) metaReportWrites.push(url.pathname)
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

  await page.goto(href(a.id,a2,'meta-reports')); await heading('Meta reports'); await selected(a.id,a2,'meta-reports')
  await page.getByText('No sources on this page.',{exact:true}).waitFor()
  assert.equal(await page.getByLabel('Source',{exact:true}).locator('option').count(),1)
  assert.equal(await page.getByRole('button',{name:'Import report',exact:true}).count(),0)
  await page.reload(); await heading('Meta reports'); await page.getByText('No sources on this page.',{exact:true}).waitFor(); await selected(a.id,a2,'meta-reports')
  await link('Context'); await heading('Project context'); await page.goBack(); await heading('Meta reports'); await selected(a.id,a2,'meta-reports')
  await page.getByRole('button',{name:'Manage connections',exact:true}).click(); await heading('Meta ads'); await selected(a.id,a2,'meta')
  await page.goBack(); await heading('Meta reports'); await selected(a.id,a2,'meta-reports'); await page.getByText('No sources on this page.',{exact:true}).waitFor()
  await page.setViewportSize({width:360,height:800})
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true)
  await mkdir('private/navigation-browser',{recursive:true}); await page.screenshot({path:'private/navigation-browser/meta-reports-360.png',fullPage:true})
  await page.setViewportSize({width:1280,height:900})
  await page.goto(href(b.id,b1,'meta-reports')); await heading('Meta reports'); await selected(b.id,b1,'meta-reports'); await page.getByText('No sources on this page.',{exact:true}).waitFor()
  const memberSources=await context.request.get(`${config.appUrl}/api/projects/${b1}/meta`)
  assert.equal(memberSources.status(),200); assert.equal((await memberSources.json()).role,'viewer')
  assert.equal(await page.getByRole('button',{name:'Import report',exact:true}).count(),0)
  assert.equal(await page.getByRole('button',{name:'Cancel local import',exact:true}).count(),0)
  assert.deepEqual(metaReportWrites,[])
  assert.equal((await pool.query('SELECT count(*) FROM meta_import WHERE project_id=ANY($1::text[])',[[a2,b1]])).rows[0].count,'0')
  console.log('PASS navigation: Meta reports realAPI empty state, deep link/reload/Back, Manage connections, viewer read access and no automatic imports.')

  // Retained reports stay useful with the provider disconnected. Seed only local
  // evidence; this journey must never authorize or submit a provider report.
  const metaApp=randomUUID(),metaSource=randomUUID(),metaGrant=randomUUID(),metaReceipt=randomUUID(),metaEmpty=randomUUID()
  const metaDefinition={provider:'meta_ads',accountId:'12345678901234567890',accountName:'Navigation retained account',currency:'AED',timeZone:'Asia/Dubai',graphVersion:'v26.0',report:'campaign_daily',definitionVersion:1,level:'campaign',breakdowns:[],attribution:{mode:'meta_reported',requestedWindows:['7d_click','1d_view'],reportingPolicy:'meta_mixed',effectiveAdSetSettings:'unknown'}}
  const metaRows=['2026-09-01','2026-09-02'].map(date=>({date,accountId:metaDefinition.accountId,campaignId:'99999999999999999999',campaignName:'=Navigation campaign',impressions:'123456789012345678901234567890',clicks:'0',spend:'12.000000000000000001',actions:null,actionValues:[]}))
  await pool.query(`INSERT INTO meta_app_registration(id,app_id,config_id,revision,credential_revision,encrypted_config,active,enabled,bound_origin,declared_mode)
    VALUES($1,$2,'67890',1,1,'{}',false,false,$3,'development')`,[metaApp,String(BigInt('0x'+randomBytes(12).toString('hex'))),config.appUrl])
  await pool.query(`INSERT INTO meta_connection(id,workspace_id,project_id,name,status,account_id,account_name,currency,time_zone,account_status)
    VALUES($1,$2,$3,'Navigation retained source','disconnected',$4,$5,'AED','Asia/Dubai',1)`,[metaSource,b.id,b1,metaDefinition.accountId,metaDefinition.accountName])
  await pool.query(`INSERT INTO meta_oauth_flow(id,registration_id,app_revision,start_epoch,workspace_id,project_id,user_id,connection_id,phase,subject_hash,granted_at,expires_at)
    VALUES($1,$2,1,1,$3,$4,$5,$6,'completed',$7,clock_timestamp(),clock_timestamp())`,[metaGrant,metaApp,b.id,b1,other.id,metaSource,'a'.repeat(64)])
  await pool.query('UPDATE meta_connection SET current_grant_id=$2 WHERE id=$1',[metaSource,metaGrant])
  for(const [id,from,rowCount,age]of [[metaReceipt,'2026-09-01',2,2],[metaEmpty,'2026-09-02',0,1]]as const){
    await pool.query(`INSERT INTO meta_import(id,workspace_id,project_id,user_id,connection_id,grant_id,connection_revision,app_revision,request_id,report,date_from,date_to,source,status,completed_at,created_at,row_count,pages,definition_key)
      VALUES($1,$2,$3,$4,$5,$6,1,1,$7,'campaign_daily',$8,'2026-09-02',$9,'completed',clock_timestamp()-make_interval(mins=>$10),clock_timestamp()-make_interval(mins=>$10),$11,$12,encode(sha256(convert_to(($9::jsonb-'accountName')::text,'UTF8')),'hex'))`,[id,b.id,b1,other.id,metaSource,metaGrant,randomUUID(),from,JSON.stringify(metaDefinition),age,rowCount,rowCount?1:0])
  }
  await pool.query('INSERT INTO meta_import_page(import_id,project_id,workspace_id,page,rows,row_count,content_hash) VALUES($1,$2,$3,0,$4,2,$5)',[metaReceipt,b1,b.id,JSON.stringify(metaRows),createHash('sha256').update(JSON.stringify(metaRows)).digest('hex')])
  await page.reload();await heading('Meta reports');await page.getByLabel('Source',{exact:true}).selectOption(metaSource)
  await page.getByLabel('Import history',{exact:true}).selectOption(metaReceipt)
  const latest=page.getByRole('button',{name:'Latest complete coverage',exact:true});await latest.click();await heading('Latest complete coverage')
  const coverage=page.getByRole('region',{name:'Daily coverage',exact:true}),latestRows=page.getByRole('region',{name:'Latest daily Meta rows',exact:true})
  await coverage.getByText('Completed with no rows',{exact:true}).waitFor();assert.equal(await latestRows.locator('tbody tr').count(),1)
  await latestRows.getByText('12.000000000000000001',{exact:true}).waitFor();await latestRows.getByText('123456789012345678901234567890',{exact:true}).waitFor()
  const downloadReady=page.waitForEvent('download');await page.getByRole('button',{name:'Export CSV',exact:true}).click();const download=await downloadReady
  assert.equal(download.suggestedFilename(),'meta-latest-campaign_daily.csv');const csv=await readFile(await download.path(),'utf8')
  assert.match(csv,/"coverage"/);assert.match(csv,/"empty"/);assert.match(csv,/"12\.000000000000000001"/);assert.match(csv,/"'=Navigation campaign"/);assert.match(csv,/"null","\[\]"/)
  assert.equal(csv.split('\r\n').filter(line=>line.startsWith('"row",')).length,1)
  await page.setViewportSize({width:360,height:800});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true)
  await page.screenshot({path:'private/navigation-browser/meta-latest-360.png',fullPage:true});await page.setViewportSize({width:1280,height:900})
  await page.getByRole('button',{name:'Open import for 2026-09-02',exact:true}).click();await heading('Meta reports');await page.waitForFunction((id:string)=>(document.querySelector('select[id$="import"]')as HTMLSelectElement|null)?.value===id,metaEmpty)
  assert.equal(await page.getByRole('button',{name:'Import report',exact:true}).count(),0)
  await latest.click();await heading('Latest complete coverage');await page.getByRole('button',{name:'Back to imports',exact:true}).click();await heading('Meta reports')
  assert.deepEqual(metaReportWrites,[]);assert.equal((await pool.query('SELECT count(*) FROM meta_import WHERE connection_id=$1',[metaSource])).rows[0].count,'2')
  console.log('PASS navigation: viewer reads disconnected-source coverage, complete empty day supersedes older rows, exact CSV download and receipt/Back handoff through production UI/API.')

  const inventoryComplete=randomUUID(),inventoryPartial=randomUUID(),inventoryEmpty=randomUUID()
  const inventoryDefinition={provider:'meta_ads',accountId:metaDefinition.accountId,accountName:metaDefinition.accountName,currency:'AED',timeZone:'Asia/Dubai',graphVersion:'v26.0',definitionVersion:1,kind:'campaign_inventory',effectiveStatuses:['ACTIVE','PAUSED','ARCHIVED','DELETED','IN_PROCESS','WITH_ISSUES']}
  async function inventory(id:string,status:string,age:number,rows:unknown[]){
    await pool.query(`INSERT INTO meta_campaign_inventory(id,workspace_id,project_id,user_id,connection_id,grant_id,connection_revision,app_revision,request_id,source,status,created_at,completed_at,first_fetched_at,last_fetched_at,pages,row_count)
      VALUES($1,$2,$3,$4,$5,$6,1,1,$7,$8,$9,clock_timestamp()-make_interval(mins=>$10),clock_timestamp()-make_interval(mins=>$10)+interval '10 seconds',clock_timestamp()-make_interval(mins=>$10)+interval '1 second',clock_timestamp()-make_interval(mins=>$10)+interval '9 seconds',1,$11)`,[id,b.id,b1,other.id,metaSource,metaGrant,randomUUID(),JSON.stringify(inventoryDefinition),status,age,rows.length])
    await pool.query('INSERT INTO meta_campaign_inventory_page(inventory_id,project_id,workspace_id,page,rows,row_count,content_hash) VALUES($1,$2,$3,0,$4,$5,$6)',[id,b1,b.id,JSON.stringify(rows),rows.length,createHash('sha256').update(JSON.stringify(rows)).digest('hex')])
  }
  await inventory(inventoryComplete,'completed',3,[{id:'1234567890123456789012345678901234567890',accountId:metaDefinition.accountId,name:'=Campaign without activity',status:'PAUSED',effectiveStatus:'NEW_PROVIDER_STATUS'}])
  await inventory(inventoryPartial,'partial',2,[{id:'2',accountId:metaDefinition.accountId,name:'Partial campaign only',status:null,effectiveStatus:'ARCHIVED'}])
  await page.getByRole('button',{name:'Campaign inventory',exact:true}).click();await heading('Campaign inventory')
  const inventoryTable=page.getByRole('region',{name:'Saved campaigns',exact:true})
  await inventoryTable.getByText('=Campaign without activity',{exact:true}).waitFor();await inventoryTable.getByText('Unknown: NEW_PROVIDER_STATUS',{exact:true}).waitFor()
  assert.equal(await inventoryTable.locator('tbody tr').count(),1);assert.equal(await page.getByRole('button',{name:'Refresh campaign inventory',exact:true}).count(),0)
  const inventoryDownloadReady=page.waitForEvent('download');await page.getByRole('button',{name:'Export CSV',exact:true}).click();const inventoryDownload=await inventoryDownloadReady
  assert.equal(inventoryDownload.suggestedFilename(),'meta-campaign-inventory.csv');const inventoryCsv=await readFile(await inventoryDownload.path(),'utf8')
  assert.match(inventoryCsv,/"coverage"/);assert.match(inventoryCsv,/"complete"/);assert.match(inventoryCsv,/"'=Campaign without activity"/);assert.match(inventoryCsv,/"1234567890123456789012345678901234567890"/);assert.match(inventoryCsv,/"PAUSED","NEW_PROVIDER_STATUS"/)
  assert.equal(inventoryCsv.split('\r\n').filter(line=>line.startsWith('"campaign",')).length,1)
  await page.getByLabel('Inventory history',{exact:true}).selectOption(inventoryPartial);await inventoryTable.getByText('Partial campaign only',{exact:true}).waitFor()
  await page.getByRole('button',{name:'Show latest complete',exact:true}).click();await inventoryTable.getByText('=Campaign without activity',{exact:true}).waitFor()
  await page.setViewportSize({width:360,height:800});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.screenshot({path:'private/navigation-browser/meta-campaign-360.png',fullPage:true});await page.setViewportSize({width:1280,height:900})
  await inventory(inventoryEmpty,'completed',1,[]);await page.getByRole('button',{name:'Reload saved inventory',exact:true}).click()
  await page.getByText('No campaigns returned on this page. Review the snapshot coverage before drawing conclusions.',{exact:true}).waitFor();assert.equal(await inventoryTable.count(),0);assert.equal(await page.getByRole('button',{name:'Export CSV',exact:true}).isEnabled(),true)
  await pool.query('UPDATE meta_campaign_inventory SET data_expired_at=clock_timestamp() WHERE id=$1',[inventoryEmpty]);await page.getByRole('button',{name:'Reload saved inventory',exact:true}).click()
  await page.getByText(/This snapshot.s campaign data has expired\./,{exact:true}).waitFor();assert.equal(await inventoryTable.count(),0);assert.equal(await page.getByRole('button',{name:'Export CSV',exact:true}).count(),0)
  await page.getByRole('button',{name:'Back to reports',exact:true}).click();await heading('Meta reports');await page.waitForFunction((id:string)=>(document.querySelector('select[id$="import"]')as HTMLSelectElement|null)?.value===id,metaEmpty)
  assert.deepEqual(metaReportWrites,[]);assert.equal((await pool.query('SELECT count(*) FROM meta_campaign_inventory WHERE connection_id=$1',[metaSource])).rows[0].count,'3')
  console.log('PASS navigation: disconnected-source campaign snapshots, exact CSV, explicit partial history, empty/expired latest without fallback, mobile rendering and fresh report handoff; no Meta writes.')

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
  }
  assert.deepEqual((await pool.query('SELECT * FROM provider_request WHERE id=$1',[previousRun])).rows[0],previousFinancialBefore)
  console.log('PASS navigation: owner/viewer adjacent closed-period equal-cell rates and CSV; exact current/prior receipts return to fresh selected cell/cohort/outcome and preserve Insights filters.')

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
  assert.deepEqual(aiWrites,[`/api/projects/${b1}/prompt-insights/export`,`/api/projects/${b1}/prompt-insights/export`,`/api/projects/${b1}/prompt-insights/comparison/export`,`/api/projects/${b1}/prompt-insights/comparison/export`])
  console.log('PASS navigation: real owner/viewer insight denominators and CSV, exact saved receipt, fresh-context Back and immediate policy-expiry masking; no provider writes or financial changes.')

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
