async function editExplore(target:any){
  const dialog=target.getByRole('dialog',{name:'Explore filters',exact:true}),button=target.getByRole('button',{name:'Edit filters',exact:true});
  if(await button.count()){if(!await dialog.isVisible())await button.click();const presets=dialog.locator('details.explorer-presets');if(!await presets.evaluate((node:any)=>node.open))await presets.locator(':scope > summary').click();}
  return target;
}
import assert from 'node:assert/strict';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {hashPassword} from 'better-auth/crypto';
import {getConfig} from '../src/server/config.ts';
import {assertSchema,getDatabase,closeDatabase} from '../src/server/db.ts';
import {saveAnalyticsSettings} from '../src/server/native-analytics.ts';
import type {SessionList,SessionDetail} from '../src/server/session-explorer-input.ts';
import {launchChromium} from './helpers/playwright.mjs';

// Root supplies a built app and a new migrated database. This runner never builds,
// starts a service, migrates, substitutes an API response, or contacts a provider.
assert.equal(process.env.TEN98_INTEGRATION_TEST,'1');
assert.equal(process.env.TEN98_SESSION_EXPLORER_PRODUCTION_BROWSER,'1');
assert.equal(process.env.ANALYTICS_NETWORK_MODE,'direct');
assert.ok(process.env.PLAYWRIGHT_MODULE);
const config=getConfig(),origin=config.appUrl,db=new URL(config.databaseUrl);
assert.equal(origin,'http://127.0.0.1:3099');
assert.equal(db.hostname,'127.0.0.1');assert.equal(db.port,'55501');
assert.match(db.pathname,/^\/ten98_session_[a-f0-9]{12}$/);
assert.equal(db.search,'');assert.equal(db.hash,'');
for(const name of ['PGHOST','PGHOSTADDR','PGPORT','PGDATABASE','PGSERVICE','PGSERVICEFILE','PGOPTIONS','DATABASE_URL_FILE'])assert.equal(process.env[name],undefined);
const evidence=resolve(process.env.BROWSER_ARTIFACT_DIR??'private/session-explorer-production-'+db.pathname.slice(-12));
const sources=['src/components/SessionExplorerPanel.tsx','src/components/ExplorerFilters.tsx','src/components/ExplorerPanel.tsx','src/lib/session-explorer.ts','src/lib/navigation.ts','src/routes/index.tsx','src/styles.css',
  'src/server/session-explorer-input.ts','src/server/session-explorer.ts','src/server/analytics-population.ts','src/server/api.ts','public/tracker.js',
  'tests/saved-filters-browser.mjs','tests/annotations-browser.mjs','tests/cohorts-browser.mjs','tests/advanced-filters-browser.mjs','tests/session-predicates-browser.ts','tests/session-explorer-browser.ts',
  'tests/session-explorer-production-browser.ts','.output/server/index.mjs'];
const digest=async(path:string)=>createHash('sha256').update(await readFile(path)).digest('hex');
const initialHashes=Object.fromEntries(await Promise.all(sources.map(async path=>[path,await digest(path)])));
const completed:string[]=[],screenshots:string[]=[],external:string[]=[],errors:string[]=[];
const readTimes=new Map<string,number[]>(),allReadTimes:{actor:string;at:number}[]=[];
// Browser navigation and direct API reads share the same per-user budget. Keep
// headroom below the production 30/minute limit; no limiter settings are changed.
async function pace(actor:string){
  for(;;){const now=Date.now(),recent=(readTimes.get(actor)??[]).filter(at=>now-at<61_000);readTimes.set(actor,recent);
    if(recent.length<28){recent.push(now);allReadTimes.push({actor,at:now});return;}
    await new Promise(resolve=>setTimeout(resolve,Math.min(60_000,Math.max(1,recent[0]+61_001-now))));
  }
}
const originalFetch=globalThis.fetch;
globalThis.fetch=(async(input:RequestInfo|URL,init?:RequestInit)=>{
  const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);
  assert.equal(url.origin,origin,'Node requests must use the owned application origin.');
  return originalFetch(input,{...init,redirect:'error'});
}) as typeof fetch;
let browser:any,page:any,stage='fresh fixture';const contexts:any[]=[];
await mkdir(evidence,{recursive:true});
try{
  await assertSchema();const {pool}=getDatabase();
  assert.equal((await pool.query('SELECT current_database() AS name')).rows[0].name,db.pathname.slice(1));
  for(const table of ['"user"','workspace','project','event','analytics_visitor','analytics_session_property','analytics_identify_receipt','analytics_segment','analytics_cohort','api_key'])
    assert.equal(Number((await pool.query(`SELECT count(*) AS n FROM ${table}`)).rows[0].n),0,`A fresh empty fixture is required: ${table}.`);
  assert.equal((await fetch(origin+'/api/health/ready',{signal:AbortSignal.timeout(10_000)})).status,200);
  const fixtureClock=(await pool.query('SELECT clock_timestamp() AS now')).rows[0].now as Date;
  assert.ok(fixtureClock.getUTCDate()>=4,'Use a date after the third UTC day so older fixture dates stay in the actual collector identity month.');
  assert.ok(Math.abs(Date.now()-fixtureClock.getTime())<60_000,'App/test clocks must agree before timestamp-sensitive collection.');
  const reportAt=new Date(Date.UTC(fixtureClock.getUTCFullYear(),fixtureClock.getUTCMonth(),fixtureClock.getUTCDate()-2,12));
  const qualificationAt=new Date(Date.UTC(fixtureClock.getUTCFullYear(),fixtureClock.getUTCMonth(),fixtureClock.getUTCDate()-3,12));
  const reportDay=reportAt.toISOString().slice(0,10),qualificationDay=qualificationAt.toISOString().slice(0,10);
  const owner=randomUUID(),viewer=randomUUID(),workspace=randomUUID(),project=randomUUID(),siteKey=randomUUID();
  const ownerPassword=randomBytes(24).toString('base64url'),viewerPassword=randomBytes(24).toString('base64url');
  const ownerEmail=owner+'@session-explorer.integration.test',viewerEmail=viewer+'@session-explorer.integration.test';
  for(const [id,email,password,name] of [[owner,ownerEmail,ownerPassword,'Session owner'],[viewer,viewerEmail,viewerPassword,'Session viewer']]){
    await pool.query('INSERT INTO "user"(id,name,email) VALUES($1,$2,$3)',[id,name,email]);
    await pool.query('INSERT INTO account(id,"accountId","providerId","userId",password) VALUES($1,$2,\'credential\',$2,$3)',[randomUUID(),id,await hashPassword(password)]);
  }
  await pool.query("INSERT INTO workspace(id,name) VALUES($1,'Session explorer acceptance')",[workspace]);
  await pool.query("INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'viewer')",[workspace,owner,viewer]);
  await pool.query("INSERT INTO project(id,workspace_id,name,origin,public_key,retention_next_run_at) VALUES($1,$2,'Observed sessions sample',$3,$4,'infinity')",[project,workspace,origin,siteKey]);
  await pool.query("UPDATE installation SET claimed=true WHERE id='instance'");
  await saveAnalyticsSettings(project,owner,{revision:1,settings:{enabled:true,consentMode:'builtin',captureReferrer:false,captureCampaigns:false,captureScreen:false,excludeBots:false,excludedPaths:[]}});
  const publicPost=async(path:string,body:unknown,userAgent='Session explorer collector')=>{
    const response=await fetch(origin+path,{method:'POST',credentials:'omit',headers:{origin,'content-type':'application/json','user-agent':userAgent},body:JSON.stringify(body),signal:AbortSignal.timeout(10_000)});
    assert.equal(response.status,path==='/api/collect'?202:200);return response.json();
  };
  const tracking=await publicPost('/api/tracking-config',{siteKey,environment:'live'}),consent={analytics:true,epoch:tracking.consentEpoch};
  assert.deepEqual(tracking.configuration.destinations,[]);
  const identify=async(id:string,properties:unknown)=>{
    const accepted=await publicPost('/api/collect',{type:'identify',siteKey,requestId:randomUUID(),sentAt:new Date().toISOString(),url:origin+'/profile',properties,dimensions:{distinctId:id},consent});
    assert.equal(accepted.accepted,true);assert.equal(accepted.duplicate,false);assert.equal(typeof accepted.context,'string');
  };
  const eventIds:string[]=[],reportIds:string[]=[],timelineIds:string[]=[];
  const collect=async(id:string|null,name:string,path:string,properties:unknown,qualification=false)=>{
    const eventId=randomUUID(),accepted=await publicPost('/api/collect',{siteKey,eventId,name,url:origin+path,properties,...(id===null?{}:{dimensions:{distinctId:id}}),consent},id===null?'':'Session explorer collector');
    assert.equal(accepted.accepted,true);assert.equal(accepted.duplicate,false);eventIds.push(eventId);if(!qualification)reportIds.push(eventId);return eventId;
  };
  const typed={plan:'pro',flag:false,nil:null,items:['',1,false,null],when:'2024-03-09T22:00:00.1234567Z',hostile:'<img src=x onerror="window.fixtureInjected=1">'};
  stage='real collector fixture';await identify('timeline-person',typed);await identify('profile-only',{plan:'profile-only'});
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM event')).rows[0].n,0,'Identify must manufacture no events.');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM analytics_visitor')).rows[0].n,0,'Identify must manufacture no traffic visitor metadata.');
  const qualificationId=await collect('timeline-person','qualified','/qualify',{plan:'qualification-event'},true);
  for(let i=0;i<501;i++)timelineIds.push(await collect('timeline-person',i%2?'page_view':'timeline_action','/timeline',{plan:'event-plan',amount:i,hostile:typed.hostile}));
  for(let i=0;i<55;i++){await collect('list-person-'+i,'matched','/list-filter',{position:i});await collect('list-person-'+i,'other_activity','/other',{position:i});}
  const unknownId=await collect(null,'unknown_activity','/unknown',{});
  assert.equal((await pool.query('SELECT visitor_id FROM event WHERE id=$1',[unknownId])).rows[0].visitor_id,null);
  const mainKey=(await pool.query('SELECT visitor_id FROM event WHERE id=$1',[timelineIds[0]])).rows[0].visitor_id as string;
  assert.match(mainKey,/^[a-f0-9]{64}$/);
  assert.equal((await pool.query('SELECT count(DISTINCT visitor_id)::int AS n FROM event WHERE project_id=$1',[project])).rows[0].n,56);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM event WHERE project_id=$1 AND dimensions ? 'distinctId'",[project])).rows[0].n,0);
  assert.equal((await pool.query('SELECT clock_timestamp() AS now')).rows[0].now.toISOString().slice(0,7),fixtureClock.toISOString().slice(0,7),'Fixture must not cross the collector monthly key boundary.');
  // Only timestamps change after real collection. Three microsecond buckets
  // deliberately include ties and sub-millisecond order that JS Date cannot keep.
  await pool.query('UPDATE event SET received_at=$2 WHERE project_id=$1 AND id=ANY($3::uuid[])',[project,reportAt,reportIds]);
  await pool.query('UPDATE event SET received_at=$2 WHERE project_id=$1 AND id=$3',[project,qualificationAt,qualificationId]);
  for(let bucket=0;bucket<3;bucket++)await pool.query("UPDATE event SET received_at=$2::timestamptz+($3::int*interval '1 microsecond') WHERE project_id=$1 AND id=ANY($4::uuid[])",[project,reportAt,123456+bucket,timelineIds.filter((_,i)=>i%3===bucket)]);
  const expectedTimeline=(await pool.query('SELECT id FROM event WHERE project_id=$1 AND id=ANY($2::uuid[]) ORDER BY received_at DESC,id DESC',[project,timelineIds])).rows.map(row=>row.id as string);
  const mark=(text:string)=>{completed.push(text);console.log('PASS '+text);};
  mark('Real collector creates 56 observed keys and 501 timeline events; identify creates neither events nor traffic visitor metadata.');

  browser=await launchChromium();
  const sessions='/api/projects/'+project+'/sessions',base='/api/projects/'+project;
  const isRead=(path:string)=>path===sessions||path.startsWith(sessions+'/');
  const makeContext=async(actor:string,email:string,password:string)=>{
    const ctx=await browser.newContext({viewport:{width:1440,height:1000},serviceWorkers:'block'});contexts.push(ctx);
    await ctx.route('**/*',async(route:any)=>{const target=new URL(route.request().url());if(target.origin!==origin){external.push(target.origin);return route.abort();}if(isRead(target.pathname))await pace(actor);return route.continue();});
    assert.equal((await ctx.request.post(origin+'/api/auth/sign-in/email',{headers:{origin},data:{email,password},maxRedirects:0})).status(),200);return ctx;
  };
  const ownerContext=await makeContext(owner,ownerEmail,ownerPassword),viewerContext=await makeContext(viewer,viewerEmail,viewerPassword);
  const get=async<T>(ctx:any,actor:string,path:string,status=200):Promise<T>=>{assert.equal(new URL(path,origin).origin,origin);if(isRead(new URL(path,origin).pathname))await pace(actor);const response=await ctx.request.get(origin+path,{maxRedirects:0});assert.equal(response.status(),status);return response.json();};
  const post=async(ctx:any,path:string,data:unknown,status=200)=>{const response=await ctx.request.post(origin+path,{headers:{origin},data,maxRedirects:0});assert.equal(response.status(),status);return response.json();};
  const params=(patch:Record<string,string>={})=>new URLSearchParams({from:reportDay,to:reportDay,timeZone:'America/New_York',...patch});
  const listApi=(patch:Record<string,string>={})=>get<SessionList>(ownerContext,owner,sessions+'?'+params({pageSize:'100',...patch}));
  const detailApi=(patch:Record<string,string>={})=>get<SessionDetail>(ownerContext,owner,sessions+'/'+mainKey+'?'+params({pageSize:'100',...patch}));
  stage='actual SQL list and cursor traversal';const all=await listApi();assert.equal(all.totalKeys,56);assert.equal(all.rows!.length,56);assert.equal(all.paging.nextCursor,null);
  assert.equal(all.identity.unidentifiedEvents,1);assert.equal(all.selection.countsAreLowerBounds,true);
  const seen:string[]=[];let cursor:string|null=null,eventBefore='';let pages=0;
  do{const current=await detailApi(cursor?{cursor}:{});assert.equal(current.summary.events,501);assert.equal(current.activityScope,'all-key-activity-in-selected-dates');assert.equal(current.linkedIdentities.status,'unavailable');
    assert.equal(current.paging.consistency,'current-per-page');assert.equal(current.currentProperties.asOf,current.asOf);
    if(eventBefore)assert.equal(current.paging.eventBefore,eventBefore);else eventBefore=current.paging.eventBefore;
    assert.deepEqual(new Set(current.currentProperties.values.map(row=>row.property.type)),new Set(['string','boolean','null','array','date']));
    assert.equal(current.currentProperties.values.find(row=>row.key==='plan')!.property.value,'pro');
    assert.ok(current.activity!.every(row=>row.properties.plan.value==='event-plan'));
    assert.equal(current.activity!.length,pages===5?1:100);seen.push(...current.activity!.map(row=>row.id));cursor=current.paging.nextCursor;pages++;
  }while(cursor);
  assert.equal(pages,6);assert.equal(new Set(seen).size,501);assert.deepEqual(seen,expectedTimeline);
  mark('Real SQL list exceeds 50 keys and six 100-row activity pages preserve every event exactly once through timestamp ties and a fixed initial event bound.');

  page=await ownerContext.newPage();page.setDefaultTimeout(20_000);page.on('pageerror',(error:Error)=>errors.push(error.message));
  const button=(name:string)=>page.getByRole('button',{name,exact:true}),list=()=>page.getByRole('region',{name:'Session results',exact:true}),activity=()=>page.getByRole('region',{name:'Activity',exact:true});
  const settle=async()=>{await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));await page.waitForFunction(()=>![...document.querySelectorAll('[role=status]')].some(n=>/^Loading (sessions|activity|definitions)/.test(n.textContent??'')));};
  const open=async(name:string,host=page)=>{const summary=host.locator('summary').filter({hasText:name}).first();if(!await summary.locator('..').evaluate((n:HTMLDetailsElement)=>n.open))await summary.click();};
  const uiRead=async<T>(action:()=>Promise<unknown>,detail=false,status=200):Promise<T>=>{const pending=page.waitForResponse((response:any)=>{const u=new URL(response.url());return (detail?u.pathname.startsWith(sessions+'/'):u.pathname===sessions)&&response.request().method()==='GET';},{timeout:90_000});await action();const response=await pending;assert.equal(response.status(),status);const value=await response.json();await settle();return value;};
  const link=(extra:Record<string,string>={})=>origin+'/?'+new URLSearchParams({workspace,project,view:'sessions',from:reportDay,to:reportDay,timeZone:'America/New_York',...extra});
  const shot=async(name:string)=>{assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);await page.screenshot({path:join(evidence,name),fullPage:true,animations:'disabled'});screenshots.push(name);};
  stage='same-date list, detail and restored page';await uiRead<SessionList>(()=>page.goto(link()));await list().waitFor();await open('More filters');
  await (await editExplore(page)).getByLabel('Enable Path',{exact:true}).check();await (await editExplore(page)).getByLabel('Path equals',{exact:true}).fill('/list-filter');
  const readsBeforeDraft=allReadTimes.length;await (await editExplore(page)).getByLabel('Show',{exact:true}).selectOption('custom');await settle();assert.equal(allReadTimes.length,readsBeforeDraft);
  const applied=await uiRead<SessionList>(()=>button('Apply filters').click());assert.equal(applied.totalKeys,55);assert.equal(applied.rows!.length,25);assert.equal(applied.query.filters.path,'/list-filter');assert.equal(page.url().includes('list-filter'),false);
  const second=await uiRead<SessionList>(()=>button('Next').click());assert.equal(second.rows!.length,25);assert.equal(second.paging.eventBefore,applied.paging.eventBefore);
  const selected=second.rows![0].visitorKey,cta=page.getByRole('link',{name:'View activity in selected dates for '+selected,exact:true});
  await cta.focus();const detail=await uiRead<SessionDetail>(()=>page.keyboard.press('Enter'),true);assert.equal(detail.summary.events,2);assert.equal(detail.range.from,reportDay);assert.equal(detail.range.timeZone,'America/New_York');assert.deepEqual(new Set(detail.activity!.map(row=>row.path)),new Set(['/list-filter','/other']));
  assert.match(await page.locator('body').innerText(),/List filters selected this key; they do not filter this timeline/);
  const returned=await uiRead<SessionList>(()=>page.getByRole('link',{name:'Back to sessions',exact:true}).click());assert.deepEqual(returned.rows,second.rows);assert.equal(returned.query.filters.path,'/list-filter');
  assert.match(await (await editExplore(page)).getByLabel('Session pagination').innerText(),/Page 2/);assert.equal(await page.evaluate(()=>document.activeElement?.getAttribute('aria-label')),'View activity in selected dates for '+selected);
  const third=await uiRead<SessionList>(()=>button('Next').click());assert.equal(third.rows!.length,5);assert.equal(third.paging.nextCursor,null);
  assert.equal(new Set([...applied.rows!,...second.rows!,...third.rows!].map(row=>row.visitorKey)).size,55);
  mark('Draft filters wait for Apply; three list pages retain 55 keys, explicit detail shows all same-date activity, and Back restores filters, page and keyboard focus.');

  stage='current typed properties and older report rerun';
  const currentPredicates={version:1,match:'all',fields:[],properties:[{key:'plan',operator:'eq',type:'string',value:'event-plan'}],sessionProperties:[{key:'plan',operator:'eq',type:'string',value:'pro'},{key:'flag',operator:'eq',type:'boolean',value:false},{key:'nil',operator:'eq',type:'null',value:null},{key:'items',operator:'includes',type:'array',value:''},{key:'when',operator:'before',type:'date',value:'2024-03-10'}]};
  const typedQuery={path:'/timeline',predicates:JSON.stringify(currentPredicates)};
  let typedResult=await listApi(typedQuery);assert.equal(typedResult.totalKeys,1);assert.equal(typedResult.rows![0].events,501);assert.equal(typedResult.rows![0].visitorKey,mainKey);assert.equal(typedResult.sessionProperties!.selection.status,'available');
  const eventSnapshot=(await pool.query('SELECT id,received_at,properties,dimensions,visitor_id,visit_id FROM event WHERE project_id=$1 ORDER BY id',[project])).rows;
  const visitorSnapshot=(await pool.query('SELECT to_jsonb(v) AS value FROM analytics_visitor v WHERE project_id=$1 ORDER BY id',[project])).rows;
  await identify('timeline-person',{plan:'changed-now'});typedResult=await listApi(typedQuery);assert.equal(typedResult.totalKeys,0);assert.deepEqual(typedResult.rows,[]);
  assert.deepEqual((await pool.query('SELECT id,received_at,properties,dimensions,visitor_id,visit_id FROM event WHERE project_id=$1 ORDER BY id',[project])).rows,eventSnapshot);
  assert.deepEqual((await pool.query('SELECT to_jsonb(v) AS value FROM analytics_visitor v WHERE project_id=$1 ORDER BY id',[project])).rows,visitorSnapshot);
  await identify('timeline-person',{plan:'pro'});assert.equal((await listApi(typedQuery)).rows![0].events,501);
  await uiRead<SessionDetail>(()=>page.goto(link({visitorKey:mainKey})),true);const currentProperties=page.getByRole('region',{name:'Current session properties',exact:true});
  assert.match(await currentProperties.innerText(),/\(null\)/);assert.match(await currentProperties.innerText(),/\["",1,false,null\]/);assert.match(await currentProperties.innerText(),/1234567Z/);assert.match(await currentProperties.innerText(),/<img src=x/);assert.equal(await page.locator('img[src="x"]').count(),0);assert.equal(await page.evaluate(()=>(window as any).fixtureInjected),undefined);
  const qualificationPredicates={version:1,match:'all',fields:[],properties:[{key:'plan',operator:'eq',type:'string',value:'qualification-event'}],sessionProperties:[{key:'plan',operator:'eq',type:'string',value:'pro'}]};
  const cohort=(await post(ownerContext,base+'/cohorts',{requestId:randomUUID(),definition:{schemaVersion:1,name:'Dubai qualification',query:new URLSearchParams({from:qualificationDay,to:qualificationDay,timeZone:'Asia/Dubai',kind:'all',path:'/qualify',predicates:JSON.stringify(qualificationPredicates)}).toString()}})).item;
  const beforeLink=allReadTimes.length;await page.goto(link({cohortId:cohort.id,cohortRevision:String(cohort.revision)}));await (await editExplore(page)).getByRole('button',{name:'Apply filters',exact:true}).waitFor();await settle();assert.equal(allReadTimes.length,beforeLink);
  await open('Saved filters and cohorts');const cohortBox=page.getByRole('group',{name:'Saved cohort',exact:true});await cohortBox.getByRole('button',{name:'Load linked version',exact:true}).click();await settle();assert.equal(allReadTimes.length,beforeLink);
  const qualified=await uiRead<SessionList>(()=>button('Apply filters').click());assert.equal(qualified.totalKeys,1);assert.equal(qualified.rows![0].events,501);assert.equal(qualified.cohort!.range.from,qualificationDay);assert.equal(qualified.cohort!.range.timeZone,'Asia/Dubai');assert.equal(qualified.range.from,reportDay);assert.equal(qualified.range.timeZone,'America/New_York');assert.equal(qualified.cohort!.sessionProperties!.asOf,qualified.asOf);
  mark('Typed current values stay distinct from event properties; latest identify changes an explicit older-date rerun without traffic mutation, and a staged cohort keeps separate Dubai qualification dates.');

  stage='real empty, unknown and expired property evidence';
  const empty=await listApi({path:'/never-observed'});assert.equal(empty.totalKeys,0);assert.deepEqual(empty.rows,[]);assert.equal(empty.selection.status,'available');
  const unknown=await listApi({path:'/unknown'});assert.equal(unknown.selection.status,'unavailable');assert.equal(unknown.selection.reason,'identity_unavailable');assert.equal(unknown.rows,null);assert.equal(unknown.totalKeys,null);
  await uiRead<SessionList>(()=>page.goto(link()));await open('More filters');await (await editExplore(page)).getByLabel('Enable Path',{exact:true}).check();await (await editExplore(page)).getByLabel('Path equals',{exact:true}).fill('/never-observed');await uiRead<SessionList>(()=>button('Apply filters').click());assert.match(await list().innerText(),/No matching activity/);
  await (await editExplore(page)).getByLabel('Path equals',{exact:true}).fill('/unknown');await uiRead<SessionList>(()=>button('Apply filters').click());assert.match(await list().innerText(),/cannot be grouped into visitor sessions/);
  const profileCount=(await pool.query('SELECT count(*)::int AS n FROM analytics_session_property WHERE project_id=$1',[project])).rows[0].n;
  await pool.query("UPDATE analytics_session_property SET updated_at=clock_timestamp()-interval '4000 days' WHERE project_id=$1 AND visitor_key=$2 AND property_key='plan'",[project,mainKey]);
  const missing={version:1,match:'all',fields:[],properties:[],sessionProperties:[{key:'never-observed',operator:'missing'}]};
  const lost=await listApi({path:'/never-observed',predicates:JSON.stringify(missing)});assert.equal(lost.coverage.status,'complete');assert.equal(lost.sessionProperties!.evidence.expiredValuesPresent,true);assert.equal(lost.sessionProperties!.selection.reason,'missing_evidence_lost');assert.deepEqual(lost.sessionProperties!.candidates,{identifiedEvents:0,unidentifiedEvents:0});assert.equal(lost.totalKeys,null);assert.equal(lost.rows,null);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM analytics_session_property WHERE project_id=$1',[project])).rows[0].n,profileCount,'Loss is real expiry evidence before physical deletion.');
  await (await editExplore(page)).getByLabel('Path equals',{exact:true}).fill('/never-observed');await open('Advanced filters');await button('Add session property condition').click();const propertyRow=page.getByRole('group',{name:'Session property condition 1',exact:true});await propertyRow.getByLabel('Property key',{exact:true}).fill('never-observed');await propertyRow.getByLabel('Operator',{exact:true}).selectOption('missing');
  const lostUi=await uiRead<SessionList>(()=>button('Apply filters').click());assert.equal(lostUi.totalKeys,null);assert.match(await list().innerText(),/Current session property evidence cannot establish/);assert.equal((await list().innerText()).includes('No matching activity'),false);
  mark('Genuine empty membership, unidentified-only activity and expired missing-property evidence produce distinct actual SQL and UI states, including zero-candidate unavailability.');

  stage='current authorization and exact bearer routes';
  const viewerList=await get<SessionList>(viewerContext,viewer,sessions+'?'+params({pageSize:'100'}));assert.equal(viewerList.totalKeys,56);
  const viewerDetail=await get<SessionDetail>(viewerContext,viewer,sessions+'/'+mainKey+'?'+params({pageSize:'100'}));assert.equal(viewerDetail.summary.events,501);assert.equal(viewerDetail.currentProperties.evidence.expiredValuesPresent,true);assert.equal(viewerDetail.currentProperties.values.some(row=>row.key==='plan'),false);
  await post(viewerContext,base+'/cohorts',{requestId:randomUUID(),definition:{schemaVersion:1,name:'Viewer must not write',query:'from='+reportDay+'&to='+reportDay+'&timeZone=UTC&path=%2Ftimeline'}},404);
  const credential=await post(ownerContext,'/api/workspaces/'+workspace+'/api-keys',{name:'Session exact routes',scopes:['analytics:read']},201);
  const bearer=async(path:string,status=200)=>{if(isRead(new URL(path,origin).pathname))await pace(owner);const response=await fetch(origin+path,{headers:{authorization:'Bearer '+credential.token},credentials:'omit',signal:AbortSignal.timeout(10_000)});assert.equal(response.status,status);return response.json();};
  assert.equal((await bearer(sessions+'?'+params({pageSize:'100'}))).totalKeys,56);
  assert.equal((await bearer(sessions+'/'+mainKey+'?'+params({pageSize:'100'}))).summary.events,501);
  await bearer(sessions+'/'+mainKey+'/properties?'+params(),403);
  await post(ownerContext,'/api/workspaces/'+workspace+'/api-keys/'+credential.key.id+'/revoke',{});
  await bearer(sessions+'?'+params(),401);
  const viewerPage=await viewerContext.newPage();viewerPage.setDefaultTimeout(20_000);viewerPage.on('pageerror',(error:Error)=>errors.push(error.message));await viewerPage.goto(link());await viewerPage.getByRole('region',{name:'Session results',exact:true}).waitFor();
  await pool.query('DELETE FROM membership WHERE workspace_id=$1 AND user_id=$2',[workspace,viewer]);
  const denied=viewerPage.waitForResponse((r:any)=>new URL(r.url()).pathname===sessions);await viewerPage.getByRole('button',{name:'Refresh sessions',exact:true}).click();assert.equal((await denied).status(),404);await viewerPage.getByRole('alert').waitFor();assert.equal(await viewerPage.getByRole('region',{name:'Session results',exact:true}).count(),0);await viewerPage.close();
  mark('Owner and viewer read actual session data; viewer writes fail, exact bearer routes work, revoked credentials and lost workspace access fail closed and purge the visible list.');

  stage='mobile, RTL and keyboard detail return';await uiRead<SessionList>(()=>page.goto(link()));await list().waitFor();
  for(const width of [320,360,768,1440])for(const dir of ['ltr','rtl']){
    await page.setViewportSize({width,height:1000});await page.evaluate((value:string)=>document.documentElement.dir=value,dir);await shot(`sessions-${width}-${dir}.png`);
    const firstLink=list().getByRole('link',{name:/^View activity in selected dates for /}).first(),name=await firstLink.getAttribute('aria-label');assert.ok(name);
    await firstLink.focus();await uiRead<SessionDetail>(()=>page.keyboard.press('Enter'),true);await activity().waitFor();await shot(`activity-${width}-${dir}.png`);
    await uiRead<SessionList>(()=>page.getByRole('link',{name:'Back to sessions',exact:true}).click());assert.equal(await page.evaluate(()=>document.activeElement?.getAttribute('aria-label')),name);
    const displayed=list().locator('strong').first();assert.match(await displayed.innerText(),/^[a-f0-9]{64}$/);assert.notEqual(await displayed.evaluate((node:HTMLElement)=>getComputedStyle(node).userSelect),'none');
  }
  assert.deepEqual(external,[]);assert.deepEqual(errors,[]);
  for(const record of allReadTimes)assert.ok(allReadTimes.filter(item=>item.actor===record.actor&&item.at<=record.at&&record.at-item.at<60_000).length<=28);
  mark('320/360/768/1440 LTR/RTL views retain selectable full keys, keyboard detail navigation and restored row focus without horizontal overflow.');
  assert.equal(completed.length,7);
  const finalHashes=Object.fromEntries(await Promise.all(sources.map(async path=>[path,await digest(path)])));assert.deepEqual(finalHashes,initialHashes);
  await writeFile(join(evidence,'production-results.json'),JSON.stringify({checkedAt:new Date().toISOString(),database:db.pathname.slice(1),origin,groups:completed.length,completed,screenshots,externalRequests:external.length,pageErrors:errors,sessionReads:allReadTimes.length,sourceHashes:finalHashes,
    fixtureNotes:['Real HTTP tracking configuration, identify and event collection only; no manufactured visitor keys or profile values.','Only accepted fixture event timestamps and one accepted profile timestamp were aged.','One hundred rows per API page; all session reads paced below the unchanged per-user limit.','Linked identities remain explicitly unavailable in this existing-key checkpoint.']},null,2)+'\n');
}catch(error){await page?.screenshot({path:join(evidence,'failure.png'),fullPage:true}).catch(()=>{});await writeFile(join(evidence,'failure.json'),JSON.stringify({stage,completed,error:String(error),sessionReads:allReadTimes.length,externalRequests:external.length},null,2));console.error('FAILED session explorer production stage: '+stage);throw error;}
finally{for(const context of contexts)await context.close().catch(()=>{});await browser?.close();await closeDatabase();globalThis.fetch=originalFetch;}
