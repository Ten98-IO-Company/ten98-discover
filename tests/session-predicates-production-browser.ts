async function editExplore(target:any){
  const dialog=target.getByRole('dialog',{name:'Explore filters',exact:true}),button=target.getByRole('button',{name:'Edit filters',exact:true});
  if(await button.count()){if(!await dialog.isVisible())await button.click();const presets=dialog.locator('details.explorer-presets');if(!await presets.evaluate((node:any)=>node.open))await presets.locator(':scope > summary').click();}
  return target;
}
async function closeExplore(target:any){
  const dialog=target.getByRole('dialog',{name:'Explore filters',exact:true});if(await dialog.isVisible())await dialog.getByRole('button',{name:'Close filters',exact:true}).click();return target;
}
import assert from 'node:assert/strict';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {hashPassword} from 'better-auth/crypto';
import {getConfig} from '../src/server/config.ts';
import {assertSchema,getDatabase,closeDatabase} from '../src/server/db.ts';
import {saveAnalyticsSettings} from '../src/server/native-analytics.ts';
import {launchChromium} from './helpers/playwright.mjs';

// Root supplies one built app and a fresh owned fixture. This runner never starts
// a service, migrates, mocks an API result, or contacts another origin.
assert.equal(process.env.TEN98_INTEGRATION_TEST,'1');assert.equal(process.env.TEN98_SESSION_PRODUCTION_BROWSER,'1');
assert.equal(process.env.ANALYTICS_NETWORK_MODE,'direct');assert.ok(process.env.PLAYWRIGHT_MODULE);
const config=getConfig(),origin=config.appUrl,db=new URL(config.databaseUrl);
assert.equal(origin,'http://127.0.0.1:3099');assert.equal(db.hostname,'127.0.0.1');assert.equal(db.port,'55501');
assert.match(db.pathname,/^\/ten98_session_[a-f0-9]{12}$/);assert.equal(db.search,'');assert.equal(db.hash,'');
for(const key of ['PGHOST','PGHOSTADDR','PGPORT','PGDATABASE','PGSERVICE','PGSERVICEFILE','PGOPTIONS','DATABASE_URL_FILE'])assert.equal(process.env[key],undefined);
const evidence=resolve(process.env.BROWSER_ARTIFACT_DIR??'private/session-production-'+db.pathname.slice(-12));
const sources=['src/server/advanced-predicate-input.ts','src/server/advanced-predicates.ts','src/server/explorer.ts','src/components/ExplorerPanel.tsx','public/tracker.js',
  'tests/advanced-filters-production-browser.mjs','tests/cohorts-production-browser.mjs','tests/native-identify-production-browser.ts','tests/session-predicates-production-browser.ts','.output/server/index.mjs'];
const digest=async(path:string)=>createHash('sha256').update(await readFile(path)).digest('hex');
const initialHashes=Object.fromEntries(await Promise.all(sources.map(async path=>[path,await digest(path)])));
const errors:string[]=[],external:string[]=[],requests:string[]=[],completed:string[]=[],screenshots:string[]=[];
const originalFetch=globalThis.fetch;
globalThis.fetch=(async(input:RequestInfo|URL,init?:RequestInit)=>{
  const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);
  assert.equal(url.origin,origin,'Node HTTP is restricted to the owned app.');return originalFetch(input,{...init,redirect:'error'});
}) as typeof fetch;
let browser:any,context:any,page:any,stage='fresh fixture';await mkdir(evidence,{recursive:true});
try{
  await assertSchema();const {pool}=getDatabase();assert.equal((await pool.query('SELECT current_database() AS name')).rows[0].name,db.pathname.slice(1));
  for(const table of ['"user"','workspace','project','event','analytics_visitor','analytics_session_property','analytics_identify_receipt','analytics_segment','analytics_cohort'])
    assert.equal(Number((await pool.query(`SELECT count(*) AS n FROM ${table}`)).rows[0].n),0,`A new empty fixture is required: ${table}.`);
  assert.equal((await fetch(origin+'/api/health/ready',{signal:AbortSignal.timeout(10000)})).status,200);
  const owner=randomUUID(),workspace=randomUUID(),project=randomUUID(),siteKey=randomUUID(),password=randomBytes(24).toString('base64url'),email=owner+'@session-production.integration.test';
  await pool.query('INSERT INTO "user"(id,name,email) VALUES($1,\'Session production reviewer\',$2)',[owner,email]);
  await pool.query('INSERT INTO account(id,"accountId","providerId","userId",password) VALUES($1,$2,\'credential\',$2,$3)',[randomUUID(),owner,await hashPassword(password)]);
  await pool.query("INSERT INTO workspace(id,name) VALUES($1,'Session production fixture')",[workspace]);
  await pool.query("INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,'owner')",[workspace,owner]);
  await pool.query("INSERT INTO project(id,workspace_id,name,origin,public_key,retention_next_run_at) VALUES($1,$2,'Session production sample',$3,$4,'infinity')",[project,workspace,origin,siteKey]);
  await pool.query("UPDATE installation SET claimed=true WHERE id='instance'");
  await saveAnalyticsSettings(project,owner,{revision:1,settings:{enabled:true,consentMode:'builtin',captureReferrer:false,captureCampaigns:false,captureScreen:false,excludeBots:false,excludedPaths:[]}});
  const post=async(path:string,body:unknown,userAgent='Session production collector')=>{
    const response=await fetch(origin+path,{method:'POST',credentials:'omit',headers:{origin,'content-type':'application/json','user-agent':userAgent},body:JSON.stringify(body),signal:AbortSignal.timeout(10000)});
    const value=await response.json();assert.equal(response.status,path==='/api/collect'?202:200);return value;
  };
  const publicConfig=await post('/api/tracking-config',{siteKey,environment:'live'}),consent={analytics:true,epoch:publicConfig.consentEpoch};
  assert.deepEqual(publicConfig.configuration.destinations,[]);
  const identify=async(id:string,properties:unknown)=>{const result=await post('/api/collect',{type:'identify',siteKey,requestId:randomUUID(),sentAt:new Date().toISOString(),url:origin+'/account',properties,dimensions:{distinctId:id},consent});assert.equal(result.accepted,true);assert.equal(result.duplicate,false);assert.equal(typeof result.context,'string');return result;};
  const events:Array<{id:string;day:'qualification'|'report'}>=[];
  const collect=async(id:string|null,name:string,path:string,properties:unknown,day:'qualification'|'report')=>{
    const eventId=randomUUID(),result=await post('/api/collect',{siteKey,eventId,name,url:origin+path,properties,...(id?{dimensions:{distinctId:id}}:{}),consent},id?'Session production collector':'');
    assert.equal(result.accepted,true);assert.equal(result.duplicate,false);events.push({id:eventId,day});return eventId;
  };
  await identify('person-a',{plan:'pro',flag:false,nil:null,items:[1,'1',null],boundary:'2024-03-09T22:00:00.9999999Z'});
  await identify('person-b',{plan:'starter'});
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM event')).rows[0].n,0,'Real identify must not manufacture traffic.');
  for(let i=0;i<2;i++)await collect('person-a','qualified','/qualify',{plan:'qualification-event'},'qualification');
  await collect('person-b','qualified','/qualify',{plan:'qualification-event'},'qualification');
  await collect('person-a','report_probe','/report',{plan:'event-plan',amount:7},'report');
  await collect('person-a','report_probe','/report',{plan:'event-plan',amount:3},'report');
  await collect('person-b','report_probe','/report',{plan:'event-plan',amount:99},'report');
  const unknownId=await collect(null,'unknown_probe','/unknown',{plan:'event-plan'},'report');
  assert.equal((await pool.query('SELECT visitor_id FROM event WHERE id=$1',[unknownId])).rows[0].visitor_id,null,'An ordinary collector request without a usable User-Agent keeps identity unknown.');
  const profileRows=(await pool.query('SELECT visitor_key,property_key,property FROM analytics_session_property WHERE project_id=$1',[project])).rows;
  const aKey=profileRows.find(row=>row.property_key==='plan'&&row.property.value==='pro')!.visitor_key;
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM event WHERE project_id=$1 AND visitor_id=$2 AND event_name='report_probe'",[project,aKey])).rows[0].n,2);
  assert.equal(JSON.stringify(profileRows).includes('person-a'),false);
  const now=new Date(),reportAt=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate()-2,12)),qualificationAt=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate()-3,12));
  assert.equal(qualificationAt.toISOString().slice(0,7),now.toISOString().slice(0,7),'Run this older-date fixture after the third UTC day to keep the collected monthly identity period unchanged.');
  const reportDay=reportAt.toISOString().slice(0,10),qualificationDay=qualificationAt.toISOString().slice(0,10);
  // Only synthetic fixture timestamps are aged. Events/profile values themselves
  // came through the running collector; all report output remains actual SQL.
  for(const event of events)await pool.query('UPDATE event SET received_at=$2 WHERE project_id=$1 AND id=$3',[project,event.day==='report'?reportAt:qualificationAt,event.id]);
  const mark=(message:string)=>{completed.push(message);console.log('PASS '+message);};
  mark('Real HTTP identify and event collection share rotating keys, preserve distinct event/profile values and retain genuinely unidentified traffic.');

  browser=await launchChromium();
  context=await browser.newContext({viewport:{width:1440,height:1000},acceptDownloads:true,serviceWorkers:'block'});
  await context.route('**/*',(route:any)=>{const target=new URL(route.request().url());if(target.origin===origin)return route.continue();external.push(target.origin);return route.abort();});
  assert.equal((await context.request.post(origin+'/api/auth/sign-in/email',{headers:{origin},data:{email,password},maxRedirects:0})).status(),200);
  const base='/api/projects/'+project,explore=base+'/explore',segmentBase=base+'/segments',cohortBase=base+'/cohorts';
  page=await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',(error:Error)=>errors.push(error.message));
  page.on('request',(request:any)=>{if(new URL(request.url()).pathname===explore)requests.push(request.url());});
  const button=(name:string)=>page.getByRole('button',{name,exact:true}),advanced=()=>page.locator('details.advanced-controls').first(),saved=()=>page.getByRole('region',{name:'Saved filters',exact:true}),cohorts=()=>page.getByRole('region',{name:'Cohorts',exact:true}),editor=()=>page.getByRole('form',{name:'Cohort qualification'});
  const settled=()=>page.waitForFunction(()=>![...document.querySelectorAll('[role=status]')].some(n=>/^(Loading cohorts|Saving cohort|Saving filters|Loading explore data|Loading annotations|Loading saved filters)/.test(n.textContent??'')));
  const reveal=async(host:any)=>{if(!await host.evaluate((node:HTMLDetailsElement)=>node.open))await host.locator(':scope > summary').click();};
  const open=async(label:string,host=page)=>{await editExplore(page);const summary=host.locator('summary').filter({hasText:label});if(!await summary.locator('..').evaluate((node:HTMLDetailsElement)=>node.open))await summary.click();};
  const nav=async(label:string)=>{await closeExplore(page);const menu=button('Menu');if(await menu.isVisible()&&await menu.getAttribute('aria-expanded')==='false')await menu.click();await (await closeExplore(page)).getByRole('link',{name:label,exact:true}).click();};
  const csv=async()=>{const download=page.waitForEvent('download');await (await closeExplore(page)).getByRole('button',{name:'Download CSV',exact:true}).click();return readFile(await(await download).path(),'utf8');};
  const report=async(action='Apply filters')=>{const response=page.waitForResponse((r:any)=>new URL(r.url()).pathname===explore&&r.request().method()==='GET');await (action==='Apply filters'?await editExplore(page):await closeExplore(page)).getByRole('button',{name:action,exact:true}).click();const actual=await response;assert.equal(actual.status(),200);const result=await actual.json();await settled();await (await closeExplore(page)).getByRole('button',{name:'Download CSV',exact:true}).waitFor();assert.equal(await csv(),result.csv);return result;};
  const mutate=async(path:string,click:()=>Promise<void>)=>{const response=page.waitForResponse((r:any)=>new URL(r.url()).pathname.startsWith(path)&&r.request().method()==='POST');await click();const actual=await response;assert.equal(actual.status(),200);const result=await actual.json();await settled();return result;};
  const add=async(host:any,key:string,type:string,operator:string,value='',session=true)=>{await reveal(host);await host.getByRole('button',{name:session?'Add session property condition':'Add property condition',exact:true}).click();const row=host.getByRole('group',{name:session?/^Session property condition /:/^Property condition /}).last();await row.getByLabel('Property key',{exact:true}).fill(key);if(!['exists','missing'].includes(operator))await row.getByLabel('Property type',{exact:true}).selectOption(type);await row.getByLabel('Operator',{exact:true}).selectOption(operator);if(!['exists','missing'].includes(operator))await row.getByLabel(['before','after'].includes(operator)?'Comparison day':'Value (JSON literal)',{exact:true}).fill(value);return row;};
  const clear=async()=>{await reveal(advanced());for(const kind of ['session property','property'])while(await (await editExplore(page)).locator('details.advanced-controls').first().getByRole('button',{name:'Remove '+kind+' condition 1',exact:true}).count())await (await editExplore(page)).locator('details.advanced-controls').first().getByRole('button',{name:'Remove '+kind+' condition 1',exact:true}).click();};
  const loadSaved=async(id:string)=>{await (await editExplore(page)).getByRole('region',{name:'Saved filters',exact:true}).getByLabel('Saved filters',{exact:true}).selectOption(id);await settled();await (await editExplore(page)).getByRole('region',{name:'Saved filters',exact:true}).getByRole('button',{name:'Load',exact:true}).click();await settled();};
  const shot=async(name:string)=>{assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.screenshot({path:join(evidence,name),fullPage:true,animations:'disabled'});screenshots.push(name);};
  stage='real combined filters and explicit rerun';await page.goto(origin);await nav('Session production sample');await nav('Explore');await (await closeExplore(page)).getByRole('button',{name:'Download CSV',exact:true}).waitFor();await settled();
  await (await editExplore(page)).getByLabel('From',{exact:true}).fill(reportDay);await (await editExplore(page)).getByLabel('To',{exact:true}).fill(reportDay);await (await editExplore(page)).getByLabel('Time zone',{exact:true}).fill('America/New_York');
  await (await editExplore(page)).getByLabel('Group by',{exact:true}).selectOption('property');await (await editExplore(page)).getByLabel('Property key',{exact:true}).fill('amount');
  await open('More filters');await (await editExplore(page)).getByLabel('Enable Event name',{exact:true}).check();await (await editExplore(page)).getByLabel('Event name equals',{exact:true}).fill('report_probe');
  await add(advanced(),'plan','string','eq','"event-plan"',false);await add(advanced(),'plan','string','eq','"pro"');await add(advanced(),'boundary','date','before','2024-03-10');
  let result=await report();assert.equal(result.totals.events,2);assert.equal(result.daily[0].events,2);assert.equal(result.breakdown.returnedGroupEvents,2);assert.equal(result.numeric.sum,'10');
  assert.equal(result.sessionProperties.selection.status,'available');assert.equal(result.sessionProperties.selection.countsAreLowerBounds,false);assert.deepEqual(result.sessionProperties.candidates,{identifiedEvents:3,unidentifiedEvents:0});
  assert.equal(result.predicateMethod.sessionPropertyMatch,'all');assert.equal(result.predicateMethod.sessionPropertyValues,'current-retained-at-report-snapshot');assert.match(result.sessionProperties.asOf,/\.\d{3}Z$/);assert.ok(result.csv.includes('Current session properties'));
  await page.getByRole('region',{name:'Report session properties',exact:true}).getByText('Current retained session properties applied.',{exact:true}).waitFor();
  await open('Save or manage filters',saved());await (await editExplore(page)).getByRole('region',{name:'Saved filters',exact:true}).getByLabel('Saved filter name',{exact:true}).fill('Event and current session');
  const segment=(await mutate(segmentBase,()=>saved().getByRole('button',{name:/^Save (filters|as new)$/}).click())).item;
  const savedPredicates=JSON.parse(new URLSearchParams(segment.definition.query).get('predicates')!);assert.equal(savedPredicates.properties[0].value,'event-plan');assert.equal(savedPredicates.sessionProperties[0].value,'pro');
  let reads=requests.length,snapshot=await csv();await clear();await loadSaved(segment.id);assert.equal(requests.length,reads);assert.equal(await csv(),snapshot);assert.equal(await (await editExplore(page)).locator('details.advanced-controls').first().getByRole('group',{name:/^Session property condition /}).count(),2);
  const eventSnapshot=(await pool.query('SELECT id,received_at,properties FROM event WHERE project_id=$1 ORDER BY id',[project])).rows;
  await identify('person-a',{plan:'changed-now'});assert.equal(requests.length,reads);assert.equal(await csv(),snapshot);
  result=await report('Refresh');assert.equal(result.totals.events,0);assert.deepEqual((await pool.query('SELECT id,received_at,properties FROM event WHERE project_id=$1 ORDER BY id',[project])).rows,eventSnapshot);
  await identify('person-a',{plan:'pro'});result=await report();assert.equal(result.totals.events,2);assert.equal(result.query.from,reportDay);
  mark('Actual applied metadata/aggregates/CSV and saved filters keep event and session properties separate; later HTTP identify changes only an explicit rerun of older event dates.');

  stage='real cohort qualification and independent scope';reads=requests.length;snapshot=await csv();await open('Manage cohorts',cohorts());await (await editExplore(page)).getByRole('button',{name:'New cohort',exact:true}).click();
  await editor().getByLabel('Cohort name',{exact:true}).fill('Current profile qualification');await editor().getByLabel('Qualification from',{exact:true}).fill(qualificationDay);await editor().getByLabel('Qualification to',{exact:true}).fill(qualificationDay);await editor().getByLabel('Qualification time zone',{exact:true}).fill('Asia/Dubai');
  await editor().getByLabel('Qualifying action',{exact:true}).selectOption('path');await editor().getByLabel('Qualification path equals',{exact:true}).fill('/qualify');
  const qualification=editor().locator('details.advanced-controls');await add(qualification,'plan','string','eq','"qualification-event"',false);await add(qualification,'plan','string','eq','"pro"');await add(qualification,'boundary','date','after','2024-03-09');
  const cohort=(await mutate(cohortBase,()=>editor().getByRole('button',{name:'Save cohort',exact:true}).click())).item;
  assert.equal(requests.length,reads);assert.equal(await csv(),snapshot);assert.equal(new URLSearchParams(cohort.definition.query).get('timeZone'),'Asia/Dubai');
  await (await editExplore(page)).getByLabel('Saved cohort',{exact:true}).selectOption(cohort.id);await settled();await (await editExplore(page)).getByRole('button',{name:'Load cohort',exact:true}).click();await settled();assert.equal(requests.length,reads);assert.equal(await csv(),snapshot);
  result=await report();assert.equal(result.totals.events,2);assert.equal(result.cohort.identity.identifiedEvents,2);assert.equal(result.cohort.identity.observedMemberKeys,1);assert.equal(result.cohort.item.revision,1);
  assert.equal(result.cohort.range.timeZone,'Asia/Dubai');assert.equal(result.range.timeZone,'America/New_York');assert.equal(result.cohort.sessionProperties.asOf,result.sessionProperties.asOf);assert.equal(result.cohort.sessionProperties.retainedFrom,result.sessionProperties.retainedFrom);
  assert.deepEqual(result.query.predicates,savedPredicates);assert.ok(result.csv.includes('Current profile qualification'));
  await page.getByRole('region',{name:'Qualification session properties',exact:true}).getByText('Current retained session properties applied.',{exact:true}).waitFor();
  await open('Manage cohorts',cohorts());await (await editExplore(page)).getByRole('button',{name:'Edit cohort',exact:true}).click();await settled();await reveal(qualification);assert.equal(await qualification.getByRole('group',{name:/^Session property condition /}).count(),2);await (await editExplore(page)).getByRole('button',{name:'Cancel cohort edit',exact:true}).click();
  mark('Real cohort save/read/load/Apply preserves revision and independent event/session clauses; Dubai qualification and New York report date conditions share one actual snapshot.');

  stage='real identity and retained evidence unavailability';await (await editExplore(page)).getByRole('button',{name:'Clear cohort',exact:true}).click();await clear();await (await editExplore(page)).getByLabel('Event name equals',{exact:true}).fill('unknown_probe');await add(advanced(),'plan','','missing');
  result=await report();assert.equal(result.sessionProperties.selection.reason,'identity_unavailable');assert.equal(result.totals.events,null);assert.equal(result.numeric,null);assert.equal(result.daily[0].events,null);
  await page.getByRole('region',{name:'Report session properties',exact:true}).getByText(/The candidate activity has no usable visitor identifiers/).waitFor();
  await (await editExplore(page)).locator('details.advanced-controls').first().getByRole('group',{name:'Session property condition 1',exact:true}).getByLabel('Property key',{exact:true}).fill('never-observed');await (await editExplore(page)).getByLabel('Event name equals',{exact:true}).fill('report_probe');
  result=await report();assert.equal(result.totals.events,3);assert.equal(result.sessionProperties.selection.status,'available');
  const countBefore=(await pool.query('SELECT count(*)::int AS n FROM analytics_session_property WHERE project_id=$1',[project])).rows[0].n;
  await pool.query("UPDATE analytics_session_property SET updated_at=clock_timestamp()-interval '4000 days' WHERE project_id=$1 AND visitor_key=$2 AND property_key='plan'",[project,aKey]);
  result=await report();assert.equal(result.coverage.status,'complete');assert.equal(result.sessionProperties.selection.reason,'missing_evidence_lost');assert.equal(result.sessionProperties.evidence.expiredValuesPresent,true);assert.equal(result.sessionProperties.evidence.lostAt,null);
  assert.equal(result.totals.events,null);assert.equal(result.breakdown.totalGroups,null);assert.deepEqual(result.properties.keys,[]);assert.equal(result.numeric,null);assert.equal(result.daily[0].events,null);assert.equal(result.sessionProperties.selection.countsAreLowerBounds,false);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM analytics_session_property WHERE project_id=$1',[project])).rows[0].n,countBefore,'Expiry is evaluated before any physical cleanup.');
  await page.getByRole('region',{name:'Report session properties',exact:true}).getByText(/Retention removed property evidence/).waitFor();assert.equal(await page.locator('.metric-value').first().innerText(),'Unavailable');assert.equal(await page.getByText(/No retained events match these filters/).count(),0);
  assert.ok(result.csv.includes('missing_evidence_lost'));assert.ok(result.csv.includes('Unavailable'));
  for(const width of [1440,320,360]){await page.setViewportSize({width,height:1000});await reveal(advanced());assert.deepEqual(await (await editExplore(page)).locator('details.advanced-controls').first().locator('input,select,button,summary').evaluateAll((nodes:HTMLElement[])=>nodes.filter(n=>n.getClientRects().length&&n.getBoundingClientRect().height<44).map(n=>n.id)),[]);await shot('session-unavailable-'+width+'.png');}
  mark('Real unidentified activity and physically retained expired evidence produce unavailable JSON/CSV and matching desktop/mobile UI, never false empty results.');
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);assert.equal(completed.length,4);
  const finalHashes=Object.fromEntries(await Promise.all(sources.map(async path=>[path,await digest(path)])));assert.deepEqual(finalHashes,initialHashes);
  await writeFile(join(evidence,'production-results.json'),JSON.stringify({checkedAt:new Date().toISOString(),database:db.pathname.slice(1),origin,completed,screenshots,externalRequests:external.length,pageErrors:errors,reportRequests:requests.length,sourceHashes:finalHashes,
    fixtureNotes:['All profile values and events were accepted by the real HTTP collector.','Only fixture event timestamps and one profile update timestamp were aged with SQL; no report, metadata or SQL result was mocked.','No cleanup, worker, vendor or additional web server was run.']},null,2)+'\n');
}catch(error){await page?.screenshot({path:join(evidence,'failure.png'),fullPage:true}).catch(()=>{});console.error('FAILED session production stage: '+stage);throw error;}
finally{await context?.close().catch(()=>{});await browser?.close();await closeDatabase();globalThis.fetch=originalFetch;}
