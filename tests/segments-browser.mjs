import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdir,readFile} from 'node:fs/promises';
import {hashPassword} from 'better-auth/crypto';
import {getConfig} from '../src/server/config.ts';
import {assertSchema,getDatabase,closeDatabase} from '../src/server/db.ts';
import {normalizeProperties} from '../src/server/analytics-input.ts';

assert.equal(process.env.TEN98_INTEGRATION_TEST,'1');assert.equal(process.env.TEN98_SEGMENTS_BROWSER,'1');
const config=getConfig(),db=new URL(config.databaseUrl),app=new URL(config.appUrl);
assert.ok(['127.0.0.1','localhost','[::1]'].includes(db.hostname));assert.equal(db.port,'55501');assert.match(db.pathname,/^\/ten98_segments_browser_[a-f0-9]{12}$/);assert.equal(db.search,'');assert.equal(db.hash,'');
assert.equal(app.origin,'http://127.0.0.1:3099');
for(const key of ['PGHOST','PGHOSTADDR','PGPORT','PGDATABASE','PGSERVICE','PGSERVICEFILE','PGOPTIONS','DATABASE_URL_FILE'])assert.equal(process.env[key],undefined);
assert.ok(process.env.PLAYWRIGHT_MODULE);const {chromium}=await import(process.env.PLAYWRIGHT_MODULE);
await assertSchema();const {pool}=getDatabase(),userId=randomUUID(),workspaceId=randomUUID(),projectId=randomUUID();
const email=randomUUID()+'@segments-browser.integration.test',password=randomBytes(24).toString('base64url');
const endpoint='/api/projects/'+projectId+'/segments',explore='/api/projects/'+projectId+'/explore';
const day='2026-03-08',literal='/saved_% 🐎',evidence='private/segments-browser-evidence';let browser;
try{
  assert.equal((await pool.query("SELECT claimed FROM installation WHERE id='instance'")).rows[0].claimed,true,'Run the unchanged original Explorer browser suite on the freshly checked fixture first.');
  await pool.query('INSERT INTO "user"(id,name,email) VALUES($1,\'Saved filter reviewer\',$2)',[userId,email]);
  await pool.query('INSERT INTO account(id,"accountId","providerId","userId",password) VALUES($1,$2,\'credential\',$2,$3)',[randomUUID(),userId,await hashPassword(password)]);
  await pool.query("INSERT INTO workspace(id,name,raw_analytics_days) VALUES($1,'Saved filter browser fixture',3650)",[workspaceId]);
  await pool.query("INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,'owner')",[workspaceId,userId]);
  await pool.query("INSERT INTO project(id,workspace_id,name,origin,public_key,retention_next_run_at) VALUES($1,$2,'Saved filter sample',$3,$4,'infinity')",[projectId,workspaceId,'https://'+projectId+'.integration.test',randomUUID()]);
  for(const [path,value] of [[literal,0],[literal,false],['/other',0]])await pool.query("INSERT INTO event(id,project_id,event_name,path,received_at,properties,dimensions) VALUES($1,$2,'signup',$3,$4,$5,$6)",[randomUUID(),projectId,path,day+'T12:00:00Z',JSON.stringify(normalizeProperties({value})),JSON.stringify({campaign:{source:''}})]);
  browser=await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL??'msedge',headless:true});
  const context=await browser.newContext({viewport:{width:1440,height:1000},acceptDownloads:true});let outbound=0;
  await context.route('**/*',async route=>{if(new URL(route.request().url()).origin===config.appUrl)await route.continue();else{outbound++;await route.abort();}});
  assert.equal((await context.request.post(config.appUrl+'/api/auth/sign-in/email',{headers:{origin:config.appUrl},data:{email,password}})).status(),200);
  const page=await context.newPage();page.setDefaultTimeout(15000);let analyticsGets=0;
  page.on('request',request=>{if(request.method()==='GET'&&new URL(request.url()).pathname===explore)analyticsGets++;});
  await page.goto(config.appUrl);
  async function nav(label){const menu=page.getByRole('button',{name:'Menu',exact:true});if(await menu.isVisible()&&await menu.getAttribute('aria-expanded')==='false')await menu.click();await page.getByRole('link',{name:label,exact:true}).click();}
  async function open(summary){const target=page.getByText(summary,{exact:true});if(!await target.evaluate(el=>el.parentElement.open))await target.click();}
  const button=name=>page.getByRole('button',{name,exact:true});
  const saved=page.getByRole('region',{name:'Saved filters',exact:true}),name=page.getByLabel('Saved filter name',{exact:true});
  async function apply(){const response=page.waitForResponse(r=>new URL(r.url()).pathname===explore&&r.request().method()==='GET');await button('Apply filters').click();assert.equal((await response).status(),200);await button('Download CSV').waitFor();}
  async function csv(){const event=page.waitForEvent('download');await button('Download CSV').click();const download=await event;return readFile(await download.path(),'utf8');}
  async function post(path,body){const response=await context.request.post(config.appUrl+endpoint+path,{headers:{origin:config.appUrl},data:body});assert.equal(response.status(),200);return response.json();}
  async function mutation(label){const response=page.waitForResponse(r=>new URL(r.url()).pathname.startsWith(endpoint)&&r.request().method()==='POST');await button(label).click();const result=await response;assert.equal(result.status(),200);return result.json();}
  await nav('Saved filter sample');await nav('Explore');await button('Download CSV').waitFor();await saved.getByText('No saved filters yet.',{exact:true}).waitFor();
  await page.getByLabel('From',{exact:true}).fill(day);await page.getByLabel('To',{exact:true}).fill(day);await page.getByLabel('Time zone',{exact:true}).fill('Asia/Dubai');await page.getByLabel('Group by',{exact:true}).selectOption('path');await apply();
  assert.equal(await page.locator('.metric-value').first().innerText(),'3');const beforeCsv=await csv();
  await open('More filters');await page.getByLabel('Show',{exact:true}).selectOption('custom');await page.getByLabel('Enable Path',{exact:true}).check();await page.getByLabel('Path equals',{exact:true}).fill(literal);
  await page.getByLabel('Enable Campaign source',{exact:true}).check();await page.getByLabel('Campaign source equals',{exact:true}).fill('');
  await page.getByLabel('Enable property filter',{exact:true}).check();await page.getByLabel('Property key',{exact:true}).fill('value');await page.getByLabel('Type',{exact:true}).selectOption('number');await page.getByLabel('Value (JSON literal)',{exact:true}).fill('0');
  await open('Save or manage filters');await name.fill('Literal zero filter');const reads=analyticsGets;
  const creation=page.waitForResponse(r=>new URL(r.url()).pathname===endpoint&&r.request().method()==='POST');await name.press('Enter');const createdResponse=await creation;assert.equal(createdResponse.status(),200);const created=(await createdResponse.json()).item;
  await saved.getByText('Saved. Results and CSV still use the applied filters.',{exact:true}).waitFor();assert.equal(analyticsGets,reads,'Name Enter saves without implicitly applying.');assert.equal(await csv(),beforeCsv);
  const stored=(await pool.query('SELECT name,query,revision FROM analytics_segment WHERE id=$1 AND project_id=$2',[created.id,projectId])).rows[0];assert.equal(stored.name,'Literal zero filter');assert.equal(stored.revision,1);
  const predicate=new URLSearchParams(stored.query);assert.equal(predicate.get('path'),literal);assert.equal(predicate.get('campaignSource'),'');assert.equal(predicate.get('propertyValue'),'0');for(const key of ['from','to','timeZone','groupBy'])assert.equal(predicate.has(key),false);
  await page.getByLabel('Path equals',{exact:true}).fill('/unapplied replacement');await page.getByLabel('Time zone',{exact:true}).fill('America/New_York');
  await button('Load').click();await saved.getByText('Saved filters loaded into your draft.',{exact:false}).waitFor();assert.equal(analyticsGets,reads);assert.equal(await page.getByLabel('Path equals',{exact:true}).inputValue(),literal);assert.equal(await page.getByLabel('From',{exact:true}).inputValue(),day);assert.equal(await page.getByLabel('To',{exact:true}).inputValue(),day);assert.equal(await page.getByLabel('Time zone',{exact:true}).inputValue(),'America/New_York');assert.equal(await page.getByLabel('Group by',{exact:true}).inputValue(),'path');assert.equal(await csv(),beforeCsv);
  const explicit=new URLSearchParams({from:day,to:day,timeZone:'America/New_York',groupBy:'path',kind:'custom',path:literal,campaignSource:'',propertyKey:'value',propertyType:'number',propertyValue:'0'});
  const expected=await (await context.request.get(config.appUrl+explore+'?'+explicit)).json();assert.equal(expected.totals.events,1);await apply();assert.equal(analyticsGets,reads+1);assert.equal(await csv(),expected.csv);assert.equal(await page.locator('.metric-value').first().innerText(),'1');
  await mkdir(evidence,{recursive:true});await page.screenshot({path:evidence+'/saved-applied-1440.png',fullPage:true});
  for(const width of [320,360]){await page.setViewportSize({width,height:950});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:evidence+'/saved-applied-'+width+'.png',fullPage:true});}
  console.log('PASS actual save with Enter, immutable predicate-only storage, load-to-draft without analytics, retained report context and exact applied CSV at desktop/mobile widths');

  await page.setViewportSize({width:1440,height:1000});await page.getByLabel('Path equals',{exact:true}).fill('/other');await name.fill('Updated filter');const beforeUpdateReads=analyticsGets,appliedCsv=await csv();const updated=(await mutation('Update saved filter')).item;assert.equal(updated.revision,2);assert.equal(new URLSearchParams(updated.definition.query).get('path'),'/other');assert.equal(analyticsGets,beforeUpdateReads);assert.equal(await csv(),appliedCsv);
  const other=await post('/'+created.id+'/update',{requestId:randomUUID(),revision:2,definition:{...updated.definition,name:'Concurrent name'}});assert.equal(other.item.revision,3);
  await page.getByLabel('Path equals',{exact:true}).fill('/retained draft');await name.fill('Stale name');const conflict=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname===endpoint+'/'+created.id+'/update');await button('Rename').click();assert.equal((await conflict).status(),409);
  await saved.getByText('This saved filter changed. Its current definition was reloaded.',{exact:false}).waitFor();assert.equal(await name.inputValue(),'Concurrent name');assert.equal(await page.getByLabel('Path equals',{exact:true}).inputValue(),'/retained draft');assert.equal(analyticsGets,beforeUpdateReads);assert.equal(await csv(),appliedCsv);
  await name.fill('Reviewed name');const renamed=(await mutation('Rename')).item;assert.equal(renamed.revision,4);assert.equal(renamed.definition.query,updated.definition.query,'Rename retains the saved predicates, not the unsaved draft.');
  page.once('dialog',dialog=>dialog.accept());const removed=await mutation('Delete saved filter');assert.equal(removed.deleted,true);await saved.getByText('Saved filter deleted.',{exact:false}).waitFor();assert.equal((await pool.query('SELECT 1 FROM analytics_segment WHERE id=$1',[created.id])).rowCount,0);assert.equal(await page.getByLabel('Path equals',{exact:true}).inputValue(),'/retained draft');assert.equal(analyticsGets,beforeUpdateReads);assert.equal(await csv(),appliedCsv);
  console.log('PASS actual update, concurrent revision conflict with fresh reload, rename preserves saved predicate, and explicit deletion leaves draft/results/CSV unchanged');

  async function loseAcknowledgement(label){
    let committed,originalBody;await page.route('**'+endpoint,async route=>{assert.equal(route.request().method(),'POST');originalBody=route.request().postDataJSON();const response=await route.fetch();assert.equal(response.status(),200);committed=await response.json();await route.fulfill({status:503,contentType:'application/json',body:'{"error":"Synthetic acknowledgement loss after commit"}'});},{times:1});
    await name.fill(label);await button('Save filters').click();await saved.getByText('The outcome is unknown.',{exact:false}).waitFor();assert.ok(committed?.item);assert.equal((await pool.query('SELECT count(*)::int AS n FROM analytics_segment WHERE project_id=$1 AND name=$2',[projectId,label])).rows[0].n,1);return {committed,originalBody};
  }
  const lost=await loseAcknowledgement('Committed once');const retryRequest=page.waitForRequest(r=>new URL(r.url()).pathname===endpoint&&r.method()==='POST');const resolved=await mutation('Retry same request');assert.deepEqual((await retryRequest).postDataJSON(),lost.originalBody);assert.equal(resolved.replayed,true);assert.equal(resolved.item.id,lost.committed.item.id);await saved.getByText('Original save confirmed.',{exact:false}).waitFor();assert.equal((await pool.query('SELECT count(*)::int AS n FROM analytics_segment WHERE project_id=$1 AND name=$2',[projectId,'Committed once'])).rows[0].n,1);
  page.once('dialog',dialog=>dialog.accept());await mutation('Delete saved filter');await saved.getByText('Saved filter deleted.',{exact:false}).waitFor();
  const deletedLost=await loseAcknowledgement('Deleted before confirmation');await post('/'+deletedLost.committed.item.id+'/delete',{requestId:randomUUID(),revision:1});const secondRetry=page.waitForRequest(r=>new URL(r.url()).pathname===endpoint&&r.method()==='POST');const tombstone=await mutation('Retry same request');assert.deepEqual((await secondRetry).postDataJSON(),deletedLost.originalBody);assert.equal(tombstone.replayed,true);assert.equal(tombstone.deleted,true);assert.equal(tombstone.item,null);await saved.getByText('The original save was confirmed, but that saved filter was since deleted.',{exact:false}).waitFor();
  await saved.getByText('No saved filters yet.',{exact:true}).waitFor();assert.equal((await pool.query('SELECT 1 FROM analytics_segment WHERE id=$1',[deletedLost.committed.item.id])).rowCount,0);assert.equal(analyticsGets,beforeUpdateReads);assert.equal(await csv(),appliedCsv);assert.equal(outbound,0);
  await page.setViewportSize({width:360,height:950});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:evidence+'/saved-replay-deleted-360.png',fullPage:true});
  console.log('PASS committed-but-lost acknowledgement retries exact request once; deleted receipt resolves without resurrection, automatic analytics or outbound traffic');
}finally{await browser?.close();await closeDatabase();}

