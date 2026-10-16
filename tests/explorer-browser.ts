import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdir,readFile} from 'node:fs/promises';
import {hashPassword} from 'better-auth/crypto';
import {getConfig} from '../src/server/config.ts';
import {getDatabase,closeDatabase} from '../src/server/db.ts';
import {normalizeProperties} from '../src/server/analytics-input.ts';

assert.equal(process.env.TEN98_INTEGRATION_TEST,'1');
const config=getConfig(),local=['localhost','127.0.0.1','[::1]'];
assert.ok(local.includes(new URL(config.appUrl).hostname)&&local.includes(new URL(config.databaseUrl).hostname));
assert.ok(process.env.PLAYWRIGHT_MODULE,'Supply an installed Playwright module URL.');
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE!);
const {pool}=getDatabase(),userId=randomUUID(),workspaceId=randomUUID(),projectId=randomUUID(),otherId=randomUUID();
const email=`${randomUUID()}@explorer-browser.integration.test`,password=randomBytes(24).toString('base64url');
let browser:any,release:(()=>void)|undefined;
try{
  // Isolated test installation only; no account reset or existing user mutation.
  await pool.query("UPDATE installation SET claimed=true WHERE id='instance'");
  await pool.query('INSERT INTO "user"(id,name,email) VALUES($1,\'Explorer reviewer\',$2)',[userId,email]);
  await pool.query('INSERT INTO account(id,"accountId","providerId","userId",password) VALUES($1,$2,\'credential\',$2,$3)',[randomUUID(),userId,await hashPassword(password)]);
  await pool.query("INSERT INTO workspace(id,name,raw_analytics_days) VALUES($1,'Explorer browser fixture',3650)",[workspaceId]);
  await pool.query("INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,'owner')",[workspaceId,userId]);
  for(const [id,name] of [[projectId,'Explorer sample'],[otherId,'Other sample']])await pool.query("INSERT INTO project(id,workspace_id,name,origin,public_key,retention_next_run_at) VALUES($1,$2,$3,'https://'||$1||'.integration.test',$4,'infinity')",[id,workspaceId,name,randomUUID()]);
  for(const value of [42,'42',null,'=SUM(1,2)'])await pool.query("INSERT INTO event(id,project_id,event_name,path,received_at,properties) VALUES(gen_random_uuid(),$1,'signup','/sample','2026-03-08T12:00:00Z',$2)",[projectId,JSON.stringify(normalizeProperties({' spaced ':value}))]);
  browser=await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL??'msedge',headless:true});
  const ctx=await browser.newContext({viewport:{width:1360,height:950},acceptDownloads:true});
  await ctx.route('**/*',async(route:any)=>new URL(route.request().url()).origin===config.appUrl?route.continue():route.abort());
  assert.equal((await ctx.request.post(`${config.appUrl}/api/auth/sign-in/email`,{headers:{origin:config.appUrl},data:{email,password}})).status(),200);
  const page=await ctx.newPage();page.setDefaultTimeout(15000);
  await page.goto(config.appUrl);
  async function nav(label:string,target=page){const menu=target.getByRole('button',{name:'Menu',exact:true});if(await menu.isVisible()&&await menu.getAttribute('aria-expanded')==='false')await menu.click();await target.getByRole('link',{name:label,exact:true}).click();}
  await nav('Explorer sample');await nav('Explore');
  await page.getByRole('button',{name:'Download CSV'}).waitFor();
  await page.getByLabel('From',{exact:true}).fill('2026-03-08');await page.getByLabel('To',{exact:true}).fill('2026-03-08');
  await page.getByLabel('Time zone',{exact:true}).fill('America/New_York');await page.getByLabel('Group by',{exact:true}).selectOption('property');
  await page.getByLabel('Property key',{exact:true}).fill(' spaced ');
  await page.getByRole('button',{name:'Apply filters',exact:true}).click();await page.getByRole('button',{name:'Download CSV'}).waitFor();
  assert.equal(await page.locator('.metric-value').first().innerText(),'4');
  const unapplied=page.getByText('You have unapplied changes.',{exact:false});
  assert.equal(await unapplied.count(),0);
  assert.deepEqual(await page.getByRole('region',{name:'Numeric property data, scroll horizontally for all columns'}).getByRole('cell').allTextContents(),['42','42','42','42']);
  assert.equal(await page.getByRole('cell',{name:'Number',exact:true}).count(),1);assert.equal(await page.getByRole('cell',{name:'String',exact:true}).count(),2);
  const result=await (await ctx.request.get(`${config.appUrl}/api/projects/${projectId}/explore?`+new URLSearchParams({from:'2026-03-08',to:'2026-03-08',timeZone:'America/New_York',kind:'all',groupBy:'property',groupProperty:' spaced '}))).json();
  await page.getByLabel('Time zone',{exact:true}).fill('Asia/Dubai');
  await unapplied.waitFor();
  const downloadEvent=page.waitForEvent('download');await page.getByRole('button',{name:'Download CSV'}).click();const download=await downloadEvent;
  assert.equal(await readFile(await download.path(),'utf8'),result.csv,'Draft timezone changes must not alter the current exported snapshot.');
  assert.ok(result.csv.includes("'=SUM"));
  await mkdir('private/explorer-evidence',{recursive:true});await page.screenshot({path:'private/explorer-evidence/explorer-desktop.png',fullPage:true});
  await page.setViewportSize({width:360,height:900});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Mobile document must not overflow.');
  await page.screenshot({path:'private/explorer-evidence/explorer-mobile.png',fullPage:true});
  await page.getByText('More filters',{exact:true}).click();
  await page.getByLabel('Enable property filter',{exact:true}).check();
  await page.getByLabel('Property key',{exact:true}).last().fill(' spaced ');await page.getByLabel('Type',{exact:true}).selectOption('number');await page.getByLabel('Value (JSON literal)',{exact:true}).fill('42');
  await page.getByRole('button',{name:'Apply filters',exact:true}).click();await page.getByRole('button',{name:'Download CSV'}).waitFor();assert.equal(await page.locator('.metric-value').first().innerText(),'1');
  assert.equal(await unapplied.count(),0);
  let queries=0;page.on('request',(r:any)=>{if(r.url().includes('/explore?'))queries++;});
  await page.getByRole('button',{name:'Apply filters',exact:true}).click();await page.getByRole('button',{name:'Download CSV'}).waitFor();assert.equal(queries,1,'Applying unchanged filters must refresh once.');
  const explorePattern=`**/api/projects/${projectId}/explore?*`;
  await page.route(explorePattern,(route:any)=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Synthetic query retry'})}),{times:1});
  await page.getByRole('button',{name:'Refresh',exact:true}).click();await page.getByRole('button',{name:'Retry',exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Download CSV'}).count(),0);assert.equal(await page.locator('.metric-grid').count(),0);
  await page.getByRole('button',{name:'Retry',exact:true}).click();await page.getByRole('button',{name:'Download CSV'}).waitFor();
  const holding=new Promise<void>(resolve=>{release=resolve;});let intercepted!:()=>void;const received=new Promise<void>(resolve=>{intercepted=resolve;});
  await page.route(explorePattern,async(route:any)=>{const response=await route.fetch();intercepted();await holding;await route.fulfill({response}).catch(()=>{});},{times:1});
  await page.getByRole('button',{name:'Refresh',exact:true}).click();await received;
  assert.equal(await page.getByRole('button',{name:'Download CSV'}).count(),0);
  await nav('Other sample');await nav('Explore');release!();await page.getByRole('button',{name:'Download CSV'}).waitFor();
  assert.equal(await page.locator('.metric-value').first().innerText(),'0');assert.equal(await page.getByLabel('Group by',{exact:true}).inputValue(),'event');
  await nav('Explorer sample');await nav('Explore');await page.getByRole('button',{name:'Download CSV'}).waitFor();
  // Additive positive responses are native; mutated bodies below are negative reader fixtures only.
  const tupleSamples=[['google','cpc','spring','page_view'],['google','cpc','spring','page_view'],['google','cpc','spring','signup'],['google','cpc','summer','page_view'],['google','cpc','summer','page_view'],['email','newsletter','spring','page_view'],[undefined,'cpc','spring','page_view'],['','cpc','spring','signup'],['missing','cpc','spring','page_view']];
  for(const [source,medium,campaign,event]of tupleSamples)await pool.query("INSERT INTO event(id,project_id,event_name,path,received_at,dimensions)VALUES(gen_random_uuid(),$1,$2,'/tuple','2026-03-08T12:00:00Z',$3)",[otherId,event,JSON.stringify({campaign:{...(source===undefined?{}:{source}),medium,campaign}})]);
  await nav('Other sample');await nav('Explore');await page.getByRole('button',{name:'Download CSV'}).waitFor();
  await page.getByLabel('From',{exact:true}).fill('2026-03-08');await page.getByLabel('To',{exact:true}).fill('2026-03-08');await page.getByLabel('Time zone',{exact:true}).fill('America/New_York');await page.getByLabel('Grouping',{exact:true}).selectOption('combined');
  let tupleRequests=0;page.on('request',(request:any)=>{if(new URL(request.url()).pathname===`/api/projects/${otherId}/explore`)tupleRequests++;});
  await page.getByRole('button',{name:'Add third field',exact:true}).click();await page.getByLabel('Field 3',{exact:true}).selectOption('campaignName');assert.equal(tupleRequests,0,'Grouping changes remain draft-only.');
  const responseForTuple=()=>page.waitForResponse((response:any)=>new URL(response.url()).pathname===`/api/projects/${otherId}/explore`&&response.request().method()==='GET').then(async(response:any)=>{assert.equal(response.status(),200);return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await response.body()));});
  let tuplePending=responseForTuple();await page.getByRole('button',{name:'Apply filters',exact:true}).click();const actualTuple=await tuplePending;await page.getByRole('button',{name:'Download CSV'}).waitFor();assert.equal(tupleRequests,1);assert.equal(actualTuple.totals.events,9);assert.equal(actualTuple.breakdown.totalGroups,6);assert.deepEqual(actualTuple.query.fields,['campaignSource','campaignMedium','campaignName']);
  const tupleTable=page.getByRole('region',{name:'Breakdown data, scroll horizontally for all columns'});assert.equal(await tupleTable.getByRole('row').count(),7);assert.equal(await tupleTable.getByRole('columnheader',{name:'Campaign source',exact:true}).count(),1);
  for(const name of ['Page views','Visitors (all events)','Estimated visitors (page views)','Visits (page views)','Bounce rate','Average observed visit duration'])assert.equal(await tupleTable.getByRole('columnheader',{name,exact:true}).count(),1);
  assert.equal(actualTuple.breakdown.groups.every((row:any)=>row.pageViews>=0&&row.estimatedVisitors===null&&row.visits===null&&row.bounceRate===null&&row.averageVisitSeconds===null),true,'Native anonymous page views stay counted while key metrics are unknown.');
  let tupleDownload=page.waitForEvent('download');await page.getByRole('button',{name:'Download CSV'}).click();assert.equal(await readFile(await(await tupleDownload).path(),'utf8'),actualTuple.csv);
  const beforePreset=tupleRequests;await page.getByRole('button',{name:'Stage source × medium × campaign',exact:true}).click();assert.equal(await page.getByLabel('Show',{exact:true}).inputValue(),'pageviews');assert.equal(tupleRequests,beforePreset);await unapplied.waitFor();
  tuplePending=responseForTuple();await page.getByRole('button',{name:'Apply filters',exact:true}).click();const actualCampaign=await tuplePending;await page.getByRole('button',{name:'Download CSV'}).waitFor();assert.equal(actualCampaign.totals.events,7);assert.equal(tupleRequests,beforePreset+1);
  const beforeUnchanged=tupleRequests;await page.getByRole('button',{name:'Apply filters',exact:true}).click();await page.getByRole('button',{name:'Download CSV'}).waitFor();assert.equal(tupleRequests,beforeUnchanged+1,'Unchanged combination Apply reloads exactly once.');
  await page.getByRole('button',{name:'Move field 3 earlier',exact:true}).click();await unapplied.waitFor();tupleDownload=page.waitForEvent('download');await page.getByRole('button',{name:'Download CSV'}).click();assert.equal(await readFile(await(await tupleDownload).path(),'utf8'),actualCampaign.csv,'Grouping drafts must not change the saved CSV snapshot.');await page.getByRole('button',{name:'Stage source × medium × campaign',exact:true}).click();
  const invalidTuples=[(value:any)=>{value.query.fields.reverse();},(value:any)=>{value.breakdown.groups[0].events=value.totals.events+1;},(value:any)=>{value.breakdown.groups[1].value=value.breakdown.groups[0].value;},(value:any)=>{value.breakdown.groups[0].value[0]={type:'missing',value:'invented'};}];
  invalidTuples.push(
    (value:any)=>{for(const key of Object.keys(value.totals))value.totals[key]=null;value.breakdown={groups:[],totalGroups:null,returnedGroupEvents:null,truncated:false};},
    (value:any)=>{for(const key of Object.keys(value.totals))value.totals[key]=null;value.breakdown={groups:[],totalGroups:null,returnedGroupEvents:null,truncated:false};value.properties={keys:[],truncated:false};for(const day of value.daily)for(const key of ['events','pageViews','customEvents'])day[key]=null;},
    (value:any)=>{value.daily=null;},(value:any)=>{value.properties=null;},
    (value:any)=>{value.daily[0].pageViews++;},(value:any)=>{value.daily.pop();},
    (value:any)=>{value.range.start='not a timestamp';},(value:any)=>{value.properties.keys=[null];},
    (value:any)=>{value.breakdown.groups[0].pageViews=value.breakdown.groups[0].events+1;},
    (value:any)=>{value.breakdown.groups[0].estimatedVisitors=1;value.breakdown.groups[0].visits=1;value.breakdown.groups[0].bounceRate=100;value.breakdown.groups[0].averageVisitSeconds=0;},
    (value:any)=>{delete value.breakdown.groups[0].averageVisitSeconds;}
  );
  for(const [index,mutate]of invalidTuples.entries()){const malformed=structuredClone(actualCampaign);mutate(malformed);await page.route(`**/api/projects/${otherId}/explore?*`,(route:any)=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(malformed)}),{times:1});await page.getByRole('button',{name:index===0?'Refresh':'Retry',exact:true}).click();await page.getByRole('button',{name:'Retry',exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'Download CSV'}).count(),0,'Synthetic contradictory tuple responses must withhold downloadable data.');}
  await page.getByRole('button',{name:'Retry',exact:true}).click();await page.getByRole('button',{name:'Download CSV'}).waitFor();
  await page.getByText('Advanced filters (0 conditions)',{exact:true}).click();await page.getByRole('button',{name:'Add field condition',exact:true}).click();await page.getByLabel('Field',{exact:true}).selectOption('path');await page.getByLabel('Operator',{exact:true}).selectOption('eq');await page.getByLabel('Value',{exact:true}).fill('/tuple');
  tuplePending=responseForTuple();await page.getByRole('button',{name:'Apply filters',exact:true}).click();const filteredCampaign=await tuplePending;await page.getByRole('button',{name:'Download CSV'}).waitFor();assert.equal(filteredCampaign.totals.events,7);assert.equal(filteredCampaign.query.predicates.fields[0].field,'path');
  const sizeMessage='The complete combination report is too large. Choose a shorter range or more filters.';
  for(const message of [sizeMessage,'Synthetic unknown combination failure']){
    await page.route(`**/api/projects/${otherId}/explore?*`,(route:any)=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:message})}),{times:1});await page.getByRole('button',{name:'Refresh',exact:true}).click();await page.getByRole('button',{name:'Retry',exact:true}).waitFor();assert.equal(await page.getByText(message,{exact:message===sizeMessage}).count(),1,'Safe size guidance and unknown503 details must not be relabeled as timeouts.');assert.equal(await page.getByRole('button',{name:'Download CSV'}).count(),0);await page.getByRole('button',{name:'Retry',exact:true}).click();await page.getByRole('button',{name:'Download CSV'}).waitFor();
  }
  await page.getByRole('button',{name:'Remove field condition 1',exact:true}).click();await page.getByText('Advanced filters (0 conditions)',{exact:true}).click();await page.getByRole('button',{name:'Apply filters',exact:true}).click();await page.getByRole('button',{name:'Download CSV'}).waitFor();
  await page.setViewportSize({width:320,height:900});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:'private/explorer-evidence/compound-320-ltr.png',fullPage:true});await page.evaluate(()=>{document.documentElement.dir='rtl';document.body.style.zoom='2';});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'320px RTL with body CSS zoom200% must remain contained.');await page.getByLabel('Field 1',{exact:true}).focus();await page.keyboard.press('Tab');assert.notEqual(await page.evaluate(()=>document.activeElement?.tagName),'BODY');await page.screenshot({path:'private/explorer-evidence/compound-320-rtl-body-zoom200.png',fullPage:true});await page.evaluate(()=>{document.documentElement.dir='ltr';document.body.style.zoom='';});await page.setViewportSize({width:1440,height:950});await page.screenshot({path:'private/explorer-evidence/compound-1440-ltr.png',fullPage:true});
  console.log('PASS additive actual compound grouping/CSV/draft preset/oneApply, four synthetic reader contradictions,320RTL/bodyCSSzoom200 and keyboard traversal');
  console.log('PASS additive malformed daily/properties/range and unavailable-evidence contradictions, specific size503 and unknown503 recovery guidance');
  // P33 uses a separate normal synthetic owner/session:15 real Explore GETs; original actor's21 are unchanged.
  const propertyUser=randomUUID(),propertyEmail=`${randomUUID()}@property-browser.integration.test`,propertyPassword=randomBytes(24).toString('base64url');
  await pool.query('INSERT INTO "user"(id,name,email)VALUES($1,\'Property reviewer\',$2)',[propertyUser,propertyEmail]);
  await pool.query('INSERT INTO account(id,"accountId","providerId","userId",password)VALUES($1,$2,\'credential\',$2,$3)',[randomUUID(),propertyUser,await hashPassword(propertyPassword)]);await pool.query("INSERT INTO membership(workspace_id,user_id,role)VALUES($1,$2,'owner')",[workspaceId,propertyUser]);
  const propertyContext=await browser.newContext({viewport:{width:1440,height:950},acceptDownloads:true});let propertyExploreReads=0;
  try{
    const ctx=propertyContext;await ctx.route('**/*',(route:any)=>{const url=new URL(route.request().url());if(url.origin!==config.appUrl)return route.abort();if(url.pathname===`/api/projects/${projectId}/explore`&&route.request().method()==='GET')propertyExploreReads++;return route.continue();});assert.equal((await ctx.request.post(`${config.appUrl}/api/auth/sign-in/email`,{headers:{origin:config.appUrl},data:{email:propertyEmail,password:propertyPassword}})).status(),200);const page=await ctx.newPage();page.setDefaultTimeout(15000);await page.goto(config.appUrl);
  // Additional actual source rows only after all original value/count/CSV assertions.
  for(const value of [false,'2026-04-01T12:00:00+04:00',[42,'x','x'],[],0.1,0.2])await pool.query("INSERT INTO event(id,project_id,event_name,path,received_at,properties)VALUES(gen_random_uuid(),$1,'signup','/property-series','2026-03-08T12:00:00Z',$2)",[projectId,JSON.stringify(normalizeProperties({' spaced ':value}))]);
  await nav('Explorer sample',page);await nav('Explore',page);await page.getByRole('button',{name:'Download CSV'}).waitFor();
  await page.getByLabel('From',{exact:true}).fill('2026-03-08');await page.getByLabel('To',{exact:true}).fill('2026-03-08');await page.getByLabel('Time zone',{exact:true}).fill('America/New_York');await page.getByLabel('Group by',{exact:true}).selectOption('property');await page.getByLabel('Property key',{exact:true}).fill(' spaced ');
  await page.getByRole('checkbox',{name:'Property analysis and event properties',exact:true}).check();const propertyResponse=page.waitForResponse((r:any)=>r.url().includes(`/api/projects/${projectId}/explore?`)&&new URL(r.url()).searchParams.get('propertyView')==='details'&&r.status()===200);await page.getByRole('button',{name:'Apply filters',exact:true}).click();const propertyDto=await(await propertyResponse).json();await page.getByRole('region',{name:'Property analysis',exact:true}).waitFor();assert.equal(propertyDto.propertyReport.arrays.occurrences,3);
  await page.getByRole('button',{name:'Array occurrences',exact:true}).click();assert.ok((await page.getByRole('region',{name:'Property series data',exact:true}).innerText()).includes('"x"'));
  await page.getByRole('button',{name:'Date values',exact:true}).click();await page.getByRole('region',{name:'Date property distribution',exact:true}).getByText('2026-04-01T08:00:00.000Z',{exact:true}).waitFor();await page.getByRole('button',{name:'Event properties',exact:true}).click();assert.equal(await page.getByRole('region',{name:'Event property pivot',exact:true}).locator('tbody tr').count(),10);
  const propertyDownload=page.waitForEvent('download');await page.getByRole('button',{name:'Download CSV'}).click();assert.equal(await readFile(await(await propertyDownload).path(),'utf8'),propertyDto.csv);  // Synthetic contradictory bodies are negative reader probes; all recoveries use the real endpoint.
  const invalidProperties=[(v:any)=>{v.query.timeZone='UTC';v.range.timeZone='UTC';},(v:any)=>{v.query.filters.path='/wrong-project-path';},(v:any)=>{v.query.property={key:' spaced ',type:'number',value:42};},(v:any)=>{v.daily[0].coverage='unavailable';},(v:any)=>{v.propertyReport.snapshot='2026-02-30T00:00:00.000000Z';},(v:any)=>{v.propertyReport.nextCursor=Buffer.from(JSON.stringify({version:1,scope:'a'.repeat(64),policy:'b'.repeat(64),before:'2026-03-01T00:00:00.000000Z',last:{at:v.propertyReport.events.at(-1).receivedAt,id:v.propertyReport.events.at(-1).id}})).toString('base64url');}];
  for(const mutate of invalidProperties){const malformed=structuredClone(propertyDto);mutate(malformed);await page.route(`**/api/projects/${projectId}/explore?*`,(route:any)=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(malformed)}),{times:1});await page.getByRole('button',{name:'Refresh',exact:true}).click();await page.getByRole('button',{name:'Retry',exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'Download CSV'}).count(),0,'Wrong-scope/clock/evidence property reports cannot be downloaded.');await page.getByRole('button',{name:'Retry',exact:true}).click();await page.getByRole('region',{name:'Property analysis',exact:true}).waitFor();}
  await page.getByRole('checkbox',{name:'Property analysis and event properties',exact:true}).uncheck();
  console.log('PASS actual property series views, typed array occurrences/date values, anonymous property rows and exact same-response CSV');
  // A separate native cohort fixture exercises genuine cursor-policy409, not a mocked cohort error.
  const cursorVisitor='d'.repeat(64);await pool.query("INSERT INTO analytics_visitor(project_id,id,first_seen_at,last_seen_at)VALUES($1,$2,'2026-03-08','2026-03-08')",[projectId,cursorVisitor]);
  await pool.query("INSERT INTO event(id,project_id,event_name,path,received_at,visitor_id,properties)SELECT gen_random_uuid(),$1,'property_cursor','/property-cursor','2026-03-08T12:00:00Z'::timestamptz+n*interval '1 microsecond',$2,$3::jsonb FROM generate_series(1,51)n",[projectId,cursorVisitor,JSON.stringify(normalizeProperties({' spaced ':'cursor'}))]);
  const cohortSave=await ctx.request.post(`${config.appUrl}/api/projects/${projectId}/cohorts`,{headers:{origin:config.appUrl},data:{requestId:randomUUID(),definition:{schemaVersion:1,name:'Property cursor cohort',query:new URLSearchParams({from:'2026-03-08',to:'2026-03-08',timeZone:'America/New_York',kind:'custom',eventName:'property_cursor'}).toString()}}});assert.equal(cohortSave.status(),200);const cursorCohort=(await cohortSave.json()).item;
  await page.getByRole('button',{name:'Refresh cohorts',exact:true}).click();await page.getByLabel('Saved cohort',{exact:true}).selectOption(cursorCohort.id);await page.getByRole('button',{name:'Load cohort',exact:true}).click();await page.getByRole('checkbox',{name:'Property analysis and event properties',exact:true}).check();
  const cursorFirst=page.waitForResponse((response:any)=>{const url=new URL(response.url());return url.pathname===`/api/projects/${projectId}/explore`&&url.searchParams.get('cohortId')===cursorCohort.id&&!url.searchParams.has('propertyCursor')&&response.status()===200;});await page.getByRole('button',{name:'Apply filters',exact:true}).click();const cursorDto=await(await cursorFirst).json();assert.equal(cursorDto.propertyReport.events.length,50);assert.ok(cursorDto.propertyReport.nextCursor);assert.equal(cursorDto.cohort.membership.status,'available');await page.getByRole('button',{name:'Event properties',exact:true}).click();
  await pool.query("UPDATE project SET analytics_retained_from=$2::timestamptz+interval '1 hour' WHERE id=$1",[projectId,cursorDto.range.start]);const cursorConflict=page.waitForResponse((response:any)=>{const url=new URL(response.url());return url.pathname===`/api/projects/${projectId}/explore`&&url.searchParams.has('propertyCursor')&&response.status()===409;});await page.getByRole('button',{name:'Next50 events',exact:true}).click();assert.equal((await(await cursorConflict).json()).error,'Retention settings changed. Reload property events.');await page.getByText('Retention settings changed. Retry to reload the first page of property events. Your draft and cohort are unchanged.',{exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'Download CSV'}).count(),0);assert.equal(await page.getByText('The report draft references an unavailable cohort version.',{exact:false}).count(),0);assert.equal(await page.getByLabel('Saved cohort',{exact:true}).inputValue(),cursorCohort.id);
  const cursorRecovery=page.waitForResponse((response:any)=>{const url=new URL(response.url());return url.pathname===`/api/projects/${projectId}/explore`&&url.searchParams.get('cohortId')===cursorCohort.id&&!url.searchParams.has('propertyCursor')&&response.status()===200;});await page.getByRole('button',{name:'Retry',exact:true}).click();const recovered=(await(await cursorRecovery).json());assert.equal(recovered.query.cohort.id,cursorCohort.id);assert.equal(recovered.query.cohort.revision,cursorCohort.revision);assert.equal(recovered.propertyReport.events.length,50);await page.getByRole('button',{name:'Download CSV'}).waitFor();await page.getByRole('button',{name:'Apply filters',exact:true}).click();await page.getByRole('button',{name:'Download CSV'}).waitFor();assert.equal(await page.getByText('Clear the unavailable cohort or load its current definition before applying.',{exact:true}).count(),0,'A cursor-policy conflict must not poison a still-valid cohort.');  await page.getByRole('button',{name:'Clear cohort',exact:true}).click();await page.getByRole('button',{name:'Apply filters',exact:true}).click();await page.getByRole('button',{name:'Download CSV'}).waitFor();
  await pool.query('UPDATE project SET analytics_retained_from=$2::timestamptz WHERE id=$1',[projectId,cursorDto.range.end]);const expiredRead=page.waitForResponse((response:any)=>{const url=new URL(response.url());return url.pathname===`/api/projects/${projectId}/explore`&&url.searchParams.get('propertyView')==='details'&&!url.searchParams.has('cohortId')&&response.status()===200;});await page.getByRole('button',{name:'Refresh',exact:true}).click();const expiredProperty=await(await expiredRead).json();assert.equal(expiredProperty.coverage.status,'unavailable');assert.equal(expiredProperty.totals.events,null);assert.deepEqual(expiredProperty.breakdown,{groups:[],totalGroups:null,returnedGroupEvents:null,truncated:false});assert.deepEqual(expiredProperty.propertyReport.events,[]);await page.getByRole('region',{name:'Property analysis',exact:true}).waitFor();await page.getByText('This history is no longer available. Choose a more recent range.',{exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'Retry',exact:true}).count(),0,'A genuine unavailable report is not a validation error.');await page.getByRole('button',{name:'Download CSV'}).waitFor();
  await pool.query('UPDATE project SET analytics_retained_from=NULL WHERE id=$1',[projectId]);const restoredRead=page.waitForResponse((response:any)=>{const url=new URL(response.url());return url.pathname===`/api/projects/${projectId}/explore`&&url.searchParams.get('propertyView')==='details'&&!url.searchParams.has('cohortId')&&response.status()===200;});await page.getByRole('button',{name:'Refresh',exact:true}).click();const restoredProperty=await(await restoredRead).json();assert.equal(restoredProperty.coverage.status,'complete');assert.equal(restoredProperty.totals.events,61);await page.getByRole('region',{name:'Property analysis',exact:true}).waitFor();await page.getByRole('button',{name:'Download CSV'}).waitFor();
  assert.equal(propertyExploreReads,15,'P33 keeps every real native read below the unchanged30/min actor budget; synthetic negative fulfills are excluded.');
  }finally{await propertyContext.close();}
  await nav('Explorer sample');await nav('Explore');await page.getByRole('button',{name:'Download CSV'}).waitFor();
  await page.getByLabel('Group by',{exact:true}).selectOption('property');await page.getByLabel('Property key',{exact:true}).fill('private draft');
  await pool.query('DELETE FROM membership WHERE workspace_id=$1 AND user_id=$2',[workspaceId,userId]);
  await page.getByRole('button',{name:'Refresh',exact:true}).click();await page.getByText('This project is unavailable.',{exact:false}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Download CSV'}).count(),0);assert.equal(await page.getByLabel('Property key',{exact:true}).count(),0);
  await pool.query("INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,'owner')",[workspaceId,userId]);
  await page.getByRole('button',{name:'Retry',exact:true}).click();await page.getByRole('button',{name:'Download CSV'}).waitFor();
  await page.route(explorePattern,(route:any)=>route.fulfill({status:401,contentType:'application/json',body:'{"error":"Sign in again"}'}),{times:1});
  await page.getByRole('button',{name:'Refresh',exact:true}).click();await page.getByRole('button',{name:'Sign in',exact:true}).waitFor();
  assert.equal(await page.locator('.metric-grid').count(),0);
  console.log('PASS production Explorer filters, whitespace keys, exact CSV snapshot, same-query refresh, errors, stale project responses, access loss and360px layout');
}finally{release?.();await browser?.close();await closeDatabase();}
