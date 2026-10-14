import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import type {AddressInfo} from 'node:net';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {hashPassword} from 'better-auth/crypto';
import {getConfig} from '../src/server/config.ts';
import {assertSchema,closeDatabase,getDatabase} from '../src/server/db.ts';
import {createWorkspace} from '../src/server/teams.ts';
import {saveAnalyticsSettings} from '../src/server/native-analytics.ts';
import {getDestinations,saveDestinationsDraft,publishDestinations} from '../src/server/destinations.ts';

// Root builds/starts the production app and supplies a fresh owned database.
// This runner never migrates, launches the app, retries against another DB, or contacts vendors.
assert.equal(process.env.TEN98_INTEGRATION_TEST,'1');
assert.equal(process.env.TEN98_IDENTIFY_BROWSER,'1');
assert.equal(process.env.ANALYTICS_NETWORK_MODE,'direct','The separately started app must use the same direct-network fixture setting.');
assert.ok(process.env.PLAYWRIGHT_MODULE,'Supply the installed Playwright module path or file URL.');
const config=getConfig(),app=new URL(config.appUrl),db=new URL(config.databaseUrl),local=['localhost','127.0.0.1','[::1]'];
assert.ok(local.includes(app.hostname)&&local.includes(db.hostname));
assert.equal(app.protocol,'http:');assert.equal(app.port,'3099');assert.equal(app.pathname,'/');assert.equal(app.search,'');assert.equal(app.hash,'');
assert.equal(db.port,'55501');assert.match(db.pathname,/^\/ten98_identify_[a-f0-9]{12}$/);assert.equal(db.search,'');assert.equal(db.hash,'');
for(const key of ['PGHOST','PGHOSTADDR','PGPORT','PGDATABASE','PGSERVICE','PGSERVICEFILE'])assert.equal(process.env[key],undefined);
const artifacts=resolve(process.env.BROWSER_ARTIFACT_DIR??'private/native-identify-production-evidence');
const completed:string[]=[],external:string[]=[],captured:Array<{body:string;value:any}>=[],screenshots:string[]=[];
const sources=['public/tracker.js','public/destinations.js','tests/native-identify-production-browser.ts'];
const digest=async(path:string)=>createHash('sha256').update(await readFile(path)).digest('hex');
const initialHashes=Object.fromEntries(await Promise.all(sources.map(async path=>[path,await digest(path)])));
const originalFetch=globalThis.fetch;
globalThis.fetch=(async(input:RequestInfo|URL,init?:RequestInit)=>{
  const target=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);
  assert.equal(target.origin,app.origin,'Node HTTP is restricted to the owned production app.');
  return originalFetch(input,init);
}) as typeof fetch;
let browser:any,fixture:ReturnType<typeof createServer>|undefined;
try{
  // Every DB/API mutation is below these read-only checks, including account setup.
  await assertSchema();const {pool}=getDatabase();
  assert.equal((await pool.query('SELECT current_database() AS name')).rows[0].name,db.pathname.slice(1));
  for(const table of ['"user"','workspace','project','event','analytics_visitor','analytics_session_property','analytics_identify_receipt'])
    assert.equal(Number((await pool.query(`SELECT count(*) AS n FROM ${table}`)).rows[0].n),0,`Fresh fixture required: ${table} is not empty.`);
  assert.equal((await fetch(`${app.origin}/api/health/ready`,{redirect:'error',signal:AbortSignal.timeout(10000)})).status,200);
  const module=process.env.PLAYWRIGHT_MODULE!;
  const {chromium}=await import(module.startsWith('file:')?module:pathToFileURL(resolve(module)).href);
  const siteKey=randomUUID(),projectId=randomUUID(),userId=randomUUID(),email=`${randomUUID()}@identify-browser.integration.test`,password=randomBytes(24).toString('base64url');
  fixture=createServer((request,response)=>{
    if(request.url==='/favicon.ico'){response.writeHead(204);response.end();return;}
    response.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store'});
    response.end(`<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Native identify acceptance</title><body><h1>Native identify acceptance</h1><p>Synthetic local analytics only.</p><script defer src="${app.origin}/tracker.js" data-site-key="${siteKey}"></script></body></html>`);
  });
  await new Promise<void>((yes,no)=>{fixture!.once('error',no);fixture!.listen(0,'127.0.0.1',yes);});
  const siteOrigin=`http://127.0.0.1:${(fixture.address() as AddressInfo).port}`;
  await pool.query('INSERT INTO "user"(id,name,email) VALUES($1,$2,$3)',[userId,'Identify browser reviewer',email]);
  await pool.query('INSERT INTO account(id,"accountId","providerId","userId",password) VALUES($1,$2,\'credential\',$2,$3)',[randomUUID(),userId,await hashPassword(password)]);
  const {workspace}=await createWorkspace(userId,{name:'Identify browser workspace'});
  await pool.query('INSERT INTO project(id,workspace_id,name,origin,public_key,retention_next_run_at) VALUES($1,$2,$3,$4,$5,\'infinity\')',[projectId,workspace.id,'Identify browser project',siteOrigin,siteKey]);
  await pool.query("UPDATE installation SET claimed=true WHERE id='instance'");
  await saveAnalyticsSettings(projectId,userId,{revision:1,settings:{enabled:true,consentMode:'builtin',captureReferrer:false,captureCampaigns:false,captureScreen:false,excludeBots:false,excludedPaths:[]}});
  const current=await getDestinations(projectId,userId,'live');
  const draft=await saveDestinationsDraft(projectId,userId,'live',{expectedVersion:current.draftVersion,configuration:{destinations:[{provider:'meta',assetId:'123',enabled:true,owner:'managed',ownershipConfirmed:true,mappings:[{event:'page_view'}]}]}});
  await publishDestinations(projectId,userId,'live',{expectedVersion:draft.draftVersion});
  await mkdir(artifacts,{recursive:true});
  browser=await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL??'msedge',headless:true});
  const context=await browser.newContext({viewport:{width:1440,height:900},serviceWorkers:'block'});
  await context.route('**/*',async(route:any)=>{
    const origin=new URL(route.request().url()).origin;
    if(![app.origin,siteOrigin].includes(origin)){external.push(origin);await route.abort();}else await route.continue();
  });
  const page=await context.newPage();page.setDefaultTimeout(15000);await page.clock.install();
  page.on('request',(request:any)=>{if(request.url()===`${app.origin}/api/collect`&&request.method()==='POST'){
    assert.equal(request.headers()['cookie'],undefined,'Native collection must omit dashboard cookies.');
    captured.push({body:request.postData()!,value:request.postDataJSON()});
  }});
  const site={siteKey,environment:'live',collectorOrigin:app.origin};
  const identify=async(properties:unknown,identifier?:string)=>page.evaluate(({site,properties,identifier}:any)=>identifier===undefined?(window as any).ten98.identify(properties,site):(window as any).ten98.identify(identifier,properties,site),{site,properties,identifier});
  const traffic=async()=>({events:(await pool.query('SELECT * FROM event WHERE project_id=$1 ORDER BY id',[projectId])).rows,visitors:(await pool.query('SELECT * FROM analytics_visitor WHERE project_id=$1 ORDER BY id',[projectId])).rows});
  const profiles=async()=>(await pool.query('SELECT visitor_key,property_key,property,updated_at FROM analytics_session_property WHERE project_id=$1 ORDER BY visitor_key,property_key',[projectId])).rows;
  const receipts=async()=>Number((await pool.query('SELECT count(*) AS n FROM analytics_identify_receipt WHERE project_id=$1',[projectId])).rows[0].n);
  const mark=(text:string)=>{completed.push(text);console.log(`PASS ${completed.length}: ${text}`);};
  async function screenshot(target:any,name:string){assert.equal(await target.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);await target.screenshot({path:join(artifacts,name),fullPage:true});screenshots.push(name);}
  const preferences=()=>page.getByRole('button',{name:`Tracking preferences for ${app.origin}`,exact:true});
  const dialog=()=>page.getByRole('dialog',{name:'Tracking preferences',exact:true});
  async function grant(){
    await preferences().click();
    await dialog().getByRole('checkbox',{name:'Analytics',exact:true}).check();
    for(const name of ['Advertising','Ad user data','Ad personalization'])await dialog().getByRole('checkbox',{name,exact:true}).uncheck();
    const receipt=page.waitForResponse((r:any)=>r.url()===`${app.origin}/api/collect`&&r.request().method()==='POST'&&r.request().postDataJSON().name==='page_view');
    await dialog().getByRole('button',{name:'Save choices',exact:true}).click();assert.equal((await (await receipt).json()).accepted,true);
  }
  async function track(name:string,properties:unknown={}){
    const receipt=page.waitForResponse((r:any)=>r.url()===`${app.origin}/api/collect`&&r.request().method()==='POST'&&r.request().postDataJSON().name===name);
    await page.evaluate(({name,properties}:any)=>(window as any).ten98.track(name,properties),{name,properties});assert.equal((await (await receipt).json()).accepted,true);
  }
  async function replay(body:string){return page.evaluate(async({url,body}:any)=>{const r=await fetch(url,{method:'POST',credentials:'omit',referrerPolicy:'no-referrer',mode:'cors',cache:'no-store',redirect:'error',headers:{'content-type':'application/json'},body});return {status:r.status,body:await r.json()};},{url:`${app.origin}/api/collect`,body});}
  await page.goto(`${siteOrigin}/account?discard=private#fragment`,{waitUntil:'networkidle'});await preferences().waitFor();
  assert.equal((await identify({plan:'never-stored'},'discarded-before-consent')).status,'not_sent');
  assert.equal(captured.length,0);assert.deepEqual(await traffic(),{events:[],visitors:[]});assert.deepEqual(await profiles(),[]);assert.equal(await receipts(),0);
  await preferences().click();await dialog().getByText(/identifier and profile details/).waitFor();
  for(const width of [1440,320]){await page.setViewportSize({width,height:900});await screenshot(page,`identify-consent-${width}.png`);const fit=await dialog().evaluate((node:HTMLElement)=>{const r=node.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight;});assert.equal(fit,true);}
  await dialog().getByRole('button',{name:'Cancel',exact:true}).click();await page.setViewportSize({width:1440,height:900});
  mark('fresh guarded fixture; pre-consent identify has no writes, retained identifier or outbound request; consent copy fits desktop/mobile');

  await grant();const beforeProfile=await traffic();assert.equal(beforeProfile.events.length,1);assert.equal(beforeProfile.visitors.length,1);assert.equal(captured[0].value.dimensions.distinctId,undefined);assert.equal(captured[0].value.properties,undefined);
  const anonymousKey=beforeProfile.events[0].visitor_id;assert.match(anonymousKey,/^[a-f0-9]{64}$/);
  const typed={plan:'pro',zero:0,enabled:false,nil:null,date:'2024-02-29T23:59:59.123456789+04:00',array:[1,'1',false,null],nested:{id:'caller-metadata'},'a.b':2};
  const first=await identify({...typed,id:'sdk-account-sentinel'});assert.equal(first.status,'accepted');assert.equal(first.duplicate,false);
  const original=captured.find(row=>row.value.type==='identify')!;assert.equal(original.value.url,`${siteOrigin}/account`);assert.equal(original.value.properties.id,undefined);assert.equal(original.value.dimensions.distinctId,'sdk-account-sentinel');
  assert.deepEqual(await traffic(),beforeProfile,'Identify must not add traffic or touch visitor first/last metadata.');
  const firstRows=await profiles(),identifiedKey=firstRows[0].visitor_key;assert.notEqual(identifiedKey,anonymousKey);assert.equal(new Set(firstRows.map(row=>row.visitor_key)).size,1);
  assert.deepEqual(Object.fromEntries(firstRows.map(row=>[row.property_key,row.property])),{plan:{type:'string',value:'pro'},zero:{type:'number',value:0},enabled:{type:'boolean',value:false},nil:{type:'null',value:null},date:{type:'date',value:'2024-02-29T19:59:59.123456789Z'},array:{type:'array',value:[1,'1',false,null]},'nested.id':{type:'string',value:'caller-metadata'},'a\\.b':{type:'number',value:2}});
  assert.equal(await receipts(),1);assert.equal(JSON.stringify(firstRows).includes('sdk-account-sentinel'),false);assert.equal(external.length,0);
  mark('real typed profile patch uses a rotating visitor key and leaves all traffic and visitor timestamps unchanged');

  await track('identify_probe',{eventOnly:'kept'});const afterEvent=await traffic(),event=afterEvent.events.find(row=>row.event_name==='identify_probe');
  assert.equal(afterEvent.events.length,2);assert.equal(event.visitor_id,identifiedKey);assert.deepEqual(event.properties,{eventOnly:{type:'string',value:'kept'}});assert.equal(event.dimensions.distinctId,undefined);
  assert.equal(JSON.stringify(event).includes('sdk-account-sentinel'),false);assert.equal(JSON.stringify(event).includes('plan'),false);assert.deepEqual(await profiles(),firstRows);
  assert.equal(await page.evaluate(()=>['fbq','ttq','gtag','pintrk','snaptr','twq'].some(name=>(window as any)[name]!==undefined)),false);assert.equal(external.length,0);
  mark('future native event joins the identified key without copying profile data or raw ID into events or vendor queues');

  assert.equal((await identify({plan:'later'})).status,'accepted');const afterPatch=await profiles(),trafficAfterPatch=await traffic(),receiptCount=await receipts();
  assert.equal(afterPatch.find(row=>row.property_key==='plan').property.value,'later');
  assert.deepEqual(await replay(original.body),{status:202,body:{accepted:true,duplicate:true}});
  assert.deepEqual(await profiles(),afterPatch);assert.deepEqual(await traffic(),trafficAfterPatch);assert.equal(await receipts(),receiptCount);
  mark('exact captured-body replay after a newer patch is a no-op, including values, timestamps, receipts and traffic');

  const settings=(await pool.query('SELECT analytics_revision,analytics_settings FROM project WHERE id=$1',[projectId])).rows[0];
  await saveAnalyticsSettings(projectId,userId,{revision:settings.analytics_revision,settings:{...settings.analytics_settings,captureCampaigns:true}});
  const rejected=await identify({plan:'must-not-write'});assert.equal(rejected.status,'rejected');assert.equal(rejected.reason,'consent_required');
  assert.deepEqual(await replay(original.body),{status:202,body:{accepted:false,reason:'consent_required'}});
  assert.deepEqual(await profiles(),afterPatch);assert.deepEqual(await traffic(),trafficAfterPatch);assert.equal(await receipts(),receiptCount);
  const refresh=page.waitForResponse((r:any)=>r.url()===`${app.origin}/api/tracking-config`&&r.request().method()==='POST');await page.clock.fastForward(30001);await refresh;
  await page.waitForFunction((site:any)=>(window as any).ten98.destinationStatus(site).consent.analytics===false,site);
  const status=await page.evaluate((site:any)=>(window as any).ten98.destinationStatus(site),site);
  // stop() needs reload only after a vendor adapter loaded. Analytics-only Meta
  // consent avoids that branch; honor it if the coordinator nevertheless reports it.
  if(status.routes.some((route:any)=>route.state==='reload_required')){await page.reload({waitUntil:'networkidle'});await preferences().waitFor();}
  await page.waitForFunction((site:any)=>{const state=(window as any).ten98.destinationStatus(site);return state.ready&&state.consent.analytics===false;},site);
  mark('current revoked consent rejects both a new SDK update and an old receipt replay without writes');

  await grant();assert.equal(captured.at(-1)!.value.dimensions.distinctId,undefined,'Fresh consent must not restore the old explicit ID.');
  assert.equal((await identify({},'sdk-account-sentinel')).status,'accepted');const retained=await profiles();
  assert.equal((await page.evaluate((site:any)=>(window as any).ten98.resetIdentity(site),site)).ok,true);
  await track('after_reset');const resetEvent=(await traffic()).events.find(row=>row.event_name==='after_reset');
  assert.equal(resetEvent.visitor_id,anonymousKey);assert.deepEqual(await profiles(),retained);assert.equal(captured.at(-1)!.value.dimensions.distinctId,undefined);
  mark('reset changes only future local identity; fresh consent and reset do not restore IDs or erase earlier profile rows');

  // Preview-only screen acceptance; no retention policy is saved or cleanup executed.
  await pool.query("UPDATE analytics_session_property SET updated_at=clock_timestamp()-interval '2 days' WHERE project_id=$1 AND property_key='plan'",[projectId]);
  const signed=await context.request.post(`${app.origin}/api/auth/sign-in/email`,{headers:{origin:app.origin},data:{email,password},maxRedirects:0});assert.equal(signed.status(),200);
  const dashboard=await context.newPage();dashboard.setDefaultTimeout(15000);await dashboard.goto(app.origin,{waitUntil:'networkidle'});
  const settingsNav=dashboard.getByRole('navigation',{name:'Workspace settings',exact:true}),retentionLink=settingsNav.getByRole('link',{name:'Data retention',exact:true});
  if(!await retentionLink.isVisible())await dashboard.getByText('Workspace settings',{exact:true}).click();await retentionLink.click();
  await dashboard.getByLabel('Raw analytics (days)',{exact:true}).fill('1');
  const previewUrl=`${app.origin}/api/workspaces/${workspace.id}/retention/preview`;
  const response=dashboard.waitForResponse((r:any)=>r.url()===previewUrl&&r.request().method()==='POST');await dashboard.getByRole('button',{name:'Preview cleanup',exact:true}).click();
  const preview=await (await response).json();assert.deepEqual(preview.profileEstimate,{status:'available',properties:1,atLeast:false});assert.equal(preview.estimate.rows,0);
  await dashboard.getByText('1 session property eligible for cleanup.',{exact:true}).waitFor();await screenshot(dashboard,'identify-retention-1440.png');
  await dashboard.route(previewUrl,async(route:any)=>{const original=await route.fetch(),body=await original.json();body.profileEstimate={status:'unavailable',properties:null,atLeast:false};await route.fulfill({response:original,json:body});});
  await dashboard.getByRole('button',{name:'Preview cleanup',exact:true}).click();await dashboard.getByText('Session-property estimate unavailable. Try previewing again; retention still applies.',{exact:true}).waitFor();
  assert.equal(await dashboard.getByText('0 session properties eligible for cleanup.',{exact:true}).count(),0);
  await dashboard.setViewportSize({width:320,height:900});await screenshot(dashboard,'identify-retention-unavailable-320.png');
  assert.equal((await pool.query('SELECT raw_analytics_days FROM workspace WHERE id=$1',[workspace.id])).rows[0].raw_analytics_days,90);
  mark('real retention preview separates profile count from event count; injected unavailable estimate stays unavailable and preview does not save');

  assert.equal(completed.length,7);assert.deepEqual(external,[]);
  const finalHashes=Object.fromEntries(await Promise.all(sources.map(async path=>[path,await digest(path)])));assert.deepEqual(finalHashes,initialHashes,'Source changed during production acceptance.');
  await writeFile(join(artifacts,'production-results.json'),JSON.stringify({checkedAt:new Date().toISOString(),groups:completed.length,completed,screenshots,externalRequests:external.length,sourceHashes:finalHashes,
    limitations:['Unavailable profile estimate is an explicitly injected UI fault response; backend timeout behavior is covered separately.','Original browser runners were not imported or changed.']},null,2)+'\n');
  console.log(`PASS all ${completed.length} native identify production-browser groups; ${screenshots.length} screenshots; zero external requests.`);
}finally{
  await browser?.close();if(fixture?.listening)await new Promise<void>((yes,no)=>fixture!.close(error=>error?no(error):yes()));
  await closeDatabase();globalThis.fetch=originalFetch;
}
