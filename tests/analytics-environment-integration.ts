import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {getConfig} from '../src/server/config.ts';
import {assertSchema,closeDatabase,getDatabase} from '../src/server/db.ts';
import {collectNative,saveAnalyticsSettings} from '../src/server/native-analytics.ts';
import {getPublicDestinations} from '../src/server/destinations.ts';
import {projectAnalytics} from '../src/server/analytics.ts';
import {exploreAnalytics} from '../src/server/explorer.ts';
import {handleApi} from '../src/server/api.ts';
import {createApiKey} from '../src/server/api-keys.ts';
import {saveCohort} from '../src/server/cohorts.ts';
import {runAnalysis,saveAnalysis} from '../src/server/funnels.ts';
import {environmentVersion} from '../src/lib/analytics-environment.ts';

export async function runEnvironmentChecks(){
  assert.equal(process.env.TEN98_INTEGRATION_TEST,'1');assert.equal(process.env.TEN98_ENVIRONMENT_TEST,'1');
  const config=getConfig(),url=new URL(config.databaseUrl),local=['localhost','127.0.0.1','[::1]'];
  assert.ok(local.includes(url.hostname)&&local.includes(new URL(config.appUrl).hostname));const ci=process.env.GITHUB_ACTIONS==='true'&&process.env.TEN98_ISOLATED_CI_DATABASE==='1'&&url.pathname==='/ten98_environment_ci';assert.equal(url.port,ci?'5432':'55501');
  if(!ci)assert.match(url.pathname,/^\/ten98_environment_[a-f0-9]{12}$/);assert.equal(url.search,'');assert.equal(url.hash,'');
  for(const key of ['PGHOST','PGHOSTADDR','PGPORT','PGDATABASE','PGSERVICE','PGSERVICEFILE'])assert.equal(process.env[key],undefined);
  assert.equal(process.env.ANALYTICS_NETWORK_MODE,'off');await assertSchema();
  const {pool}=getDatabase();assert.equal((await pool.query('SELECT count(*)::int AS n FROM workspace')).rows[0].n,0,'Use a fresh owned fixture.');
  const owner=randomUUID(),viewer=randomUUID(),stranger=randomUUID(),workspace=randomUUID(),foreignWorkspace=randomUUID(),native=randomUUID(),metrics=randomUUID(),foreign=randomUUID();
  for(const id of [owner,viewer,stranger])await pool.query('INSERT INTO "user"(id,name,email) VALUES($1,\'Environment fixture\',$2)',[id,id+'@environment.test']);
  for(const id of [workspace,foreignWorkspace])await pool.query("INSERT INTO workspace(id,name) VALUES($1,'Environment fixture')",[id]);
  for(const [uid,wid,role] of [[owner,workspace,'owner'],[viewer,workspace,'viewer'],[stranger,foreignWorkspace,'owner']])await pool.query('INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,$3)',[wid,uid,role]);
  const nativeOrigin='https://environment-native.test',siteKey=randomUUID();
  for(const [id,wid,origin,key]of [[native,workspace,nativeOrigin,siteKey],[metrics,workspace,'https://environment-metrics.test',randomUUID()],[foreign,foreignWorkspace,'https://environment-foreign.test',randomUUID()]]){
    await pool.query("INSERT INTO project(id,workspace_id,name,origin,public_key,retention_next_run_at) VALUES($1,$2,'Environment fixture',$3,$4,'infinity')",[id,wid,origin,key]);
  }
  const chrome='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
  const firefox='Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0';
  let tracking=await getPublicDestinations(siteKey,'live',nativeOrigin);
  const event=(extra:Record<string,unknown>={})=>({eventId:randomUUID(),name:'page_view',url:nativeOrigin+'/public?discard-private#fragment',collection:{mode:'cookieless' as const,epoch:tracking.consentEpoch},...extra});
  const request=(ua=chrome,extra:Record<string,string>={})=>new Request(nativeOrigin,{headers:{origin:nativeOrigin,'user-agent':ua,...extra}});
  const first=event({dimensions:{language:'en-us',screen:{width:1024,height:768}}});
  assert.deepEqual(await collectNative(request(),siteKey,first),{accepted:true,duplicate:false});
  const stored=(id:string)=>pool.query('SELECT to_jsonb(e) AS value FROM event e WHERE project_id=$1 AND id=$2',[native,id]).then(r=>r.rows[0].value);
  const before=await stored(first.eventId);
  assert.deepEqual(before.dimensions,{browser:'chrome',os:'Windows 10',device:'desktop',environmentVersion,language:'en-US',origin:nativeOrigin});
  assert.equal(before.visitor_id,null);assert.equal(before.visit_id,null);assert.equal(before.collection_basis,'cookieless');
  assert.equal(JSON.stringify(before).includes(chrome),false);assert.equal(JSON.stringify(before).includes('discard-private'),false);
  assert.deepEqual(await collectNative(request(firefox),siteKey,{...first,url:nativeOrigin+'/replacement'}),{accepted:true,duplicate:true});
  assert.deepEqual(await stored(first.eventId),before,'Duplicate cannot rewrite environment, source, path, receipt time or identity.');
  const saved=await saveAnalyticsSettings(native,owner,{revision:1,settings:{...tracking.nativeTracking,captureScreen:true}});
  assert.equal(saved.revision,2);tracking=await getPublicDestinations(siteKey,'live',nativeOrigin);
  const enabled=event({dimensions:{screen:{width:1920,height:1080}}});await collectNative(request(),siteKey,enabled);
  assert.equal((await stored(enabled.eventId)).dimensions.device,'laptop');
  const consent={analytics:true as const,epoch:tracking.consentEpoch},granted=event({collection:undefined,consent});
  await collectNative(request('Unknown environment fixture'),siteKey,granted);
  const grantedRow=await stored(granted.eventId);
  assert.deepEqual(grantedRow.dimensions,{browser:'unknown',os:'unknown',device:'unknown',environmentVersion,origin:nativeOrigin});assert.equal(grantedRow.collection_basis,'consent');
  for(const signals of [{dnt:'1'},{'sec-gpc':'1'},{'user-agent':'Example crawler'}] as Record<string,string>[])assert.equal((await collectNative(request(chrome,signals),siteKey,event())).accepted,false);
  assert.equal((await collectNative(request(),siteKey,event({collection:{mode:'cookieless',epoch:randomUUID()}}))).accepted,false);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM event WHERE project_id=$1',[native])).rows[0].n,3);
  console.log('PASS current collection policy, both bases, identity-off environment, enabled-screen-only heuristic, privacy signals and immutable duplicate');

  const apiKey=await createApiKey(workspace,owner,{name:'Environment fixture',scopes:['events:write','analytics:read']});
  async function api(body:unknown,status:number){
    const result=await handleApi(new Request(`${config.appUrl}/api/projects/${native}/events`,{method:'POST',headers:{authorization:'Bearer '+apiKey.token,'content-type':'application/json','user-agent':chrome},body:JSON.stringify(body)}));
    assert.equal(result.status,status);return result.json();
  }
  const apiEvent={eventId:randomUUID(),name:'page_view',url:nativeOrigin+'/api',dimensions:{language:'en'}};
  assert.deepEqual(await api(apiEvent,202),{accepted:true,duplicate:false});
  assert.deepEqual((await stored(apiEvent.eventId)).dimensions,{origin:nativeOrigin,language:'en'});
  assert.equal((await stored(apiEvent.eventId)).source,'api');
  for(const field of ['browser','os','device','environmentVersion','userAgent']){
    await api({...apiEvent,eventId:randomUUID(),dimensions:{[field]:'chrome'}},400);
    const result=await handleApi(new Request(config.appUrl+'/api/collect',{method:'POST',headers:{origin:nativeOrigin,'content-type':'application/json','user-agent':chrome},body:JSON.stringify({...event(),siteKey,dimensions:{[field]:'chrome'}})}));assert.equal(result.status,400);
  }
  const today=new Date().toISOString().slice(0,10),current=await projectAnalytics(native,owner,new URLSearchParams({from:today,to:today}));
  assert.equal(current.environment.coverage.recordedPageViews,3);assert.equal(current.environment.coverage.notRecordedPageViews,1);
  assert.equal(current.measurement.visitors,null);assert.ok(current.environment.browsers.every((row:any)=>row.visitors===null&&row.visits===null&&row.bounceRate===null&&row.averageVisitSeconds===null));
  console.log('PASS actual API-key ingestion remains environment-free, public spoof rejection and nonzero pageviews with unavailable visitor estimates');

  const key=(name:string)=>createHash('sha256').update(name).digest('hex'),a=key('visitor A'),b=key('visitor B'),visitA=key('visit A'),visitB=key('visit B');
  for(const v of [a,b])await pool.query("INSERT INTO analytics_visitor(project_id,id,first_seen_at,last_seen_at) VALUES($1,$2,'2024-02-29','2024-02-29')",[metrics,v]);
  const dimensions=(browser:string,os:string,device:string)=>({browser,os,device,environmentVersion});
  const samples:[string,string,number,string|null,string|null,unknown][]=[
    ['page_view','/chrome',0,a,visitA,dimensions('chrome','Windows 10','desktop')],
    ['signup','/chrome',8,a,visitA,dimensions('chrome','Windows 10','desktop')],
    ['page_view','/chrome',10,a,visitA,dimensions('chrome','Windows 10','desktop')],
    ['page_view','/chrome',11,b,visitB,dimensions('chrome','Windows 10','desktop')],
    ['page_view','/firefox',20,a,visitA,dimensions('firefox','Linux','desktop')],
    ['checkout','/firefox',25,a,visitA,dimensions('firefox','Linux','desktop')],
    ['page_view','/unknown',30,null,null,dimensions('unknown','unknown','unknown')],
    ['page_view','/legacy',40,null,null,{}],
    ['page_view','/api',50,null,null,{}],
  ];
  for(const [name,path,seconds,visitor,visit,dim]of samples)await pool.query("INSERT INTO event(id,project_id,event_name,path,received_at,visitor_id,visit_id,dimensions,source) VALUES($1,$2,$3,$4,'2024-02-29T12:00:00Z'::timestamptz+$5*interval '1 second',$6,$7,$8,$9)",[randomUUID(),metrics,name,path,seconds,visitor,visit,JSON.stringify(dim),path==='/api'?'api':'browser']);
  const base={from:'2024-02-29',to:'2024-02-29'},report=(filters:Record<string,string>={},uid=owner,pid=metrics)=>projectAnalytics(pid,uid,new URLSearchParams({...base,...filters}));
  const all=await report();assert.equal(all.totals.pageViews,7);assert.equal(all.totals.customEvents,2);
  assert.deepEqual(all.environment.coverage,{pageViews:7,recordedPageViews:5,notRecordedPageViews:2,firstRecordedAt:'2024-02-29T12:00:00.000Z'});
  const chromeRow=all.environment.browsers.find((r:any)=>r.value==='chrome');
  assert.deepEqual(chromeRow,{value:'chrome',pageViews:3,identifiedPageViews:3,visitors:2,visits:2,bounceRate:50,averageVisitSeconds:5});
  assert.equal(all.environment.browsers[0].value,'chrome');assert.equal(all.environment.browsers[1].value,'firefox');
  const unknownRow=all.environment.browsers.find((r:any)=>r.value==='unknown'),missingRow=all.environment.browsers.find((r:any)=>r.value===null);assert.ok(unknownRow);assert.ok(missingRow);
  assert.equal(unknownRow.visitors,null);assert.equal(missingRow.pageViews,2);
  for(const rows of [all.environment.browsers,all.environment.operatingSystems,all.environment.devices])assert.equal(rows.reduce((n:number,r:any)=>n+r.pageViews,0),7);
  const filtered=await report({browser:'chrome',os:'Windows 10',device:'desktop'});
  assert.deepEqual(filtered.totals,{pageViews:3,customEvents:1});assert.deepEqual(filtered.pages,[{path:'/chrome',pageViews:3}]);assert.deepEqual(filtered.events,[{name:'signup',count:1}]);
  assert.deepEqual(filtered.daily,[{date:'2024-02-29',pageViews:3,customEvents:1,coverage:'complete'}]);
  assert.equal(filtered.measurement.bounceRate,50);assert.equal(filtered.measurement.averageVisitSeconds,5);assert.deepEqual(filtered.environment.browsers,[chromeRow]);
  assert.deepEqual((await report({browser:'not-recorded'})).totals,{pageViews:2,customEvents:0});
  assert.deepEqual((await report({browser:'unknown'})).totals,{pageViews:1,customEvents:0});
  assert.deepEqual((await report({browser:'chrome',os:'Linux'})).totals,{pageViews:0,customEvents:0});
  assert.deepEqual(await report({},viewer),all);await assert.rejects(report({},stranger),{status:404});await assert.rejects(report({},owner,foreign),{status:404});
  console.log('PASS whole-population environment filters, cards/daily/rankings reconciliation, fixed visitor ordering and observed per-category visit metrics');

  const explore=(params:Record<string,string>={})=>exploreAnalytics(metrics,owner,new URLSearchParams({...base,...params}));
  const grouped=await explore({groupBy:'browser'});
  assert.ok(grouped.breakdown.groups.some(g=>g.type==='missing'&&g.value===null&&g.events===2));assert.ok(grouped.breakdown.groups.some(g=>g.type==='string'&&g.value==='unknown'));
  assert.equal((await explore({browser:'chrome',os:'Windows 10',device:'desktop'})).totals.events,4);
  assert.equal((await explore({browser:'not-recorded'})).totals.events,2);
  for(const field of ['browser','os','device']){
    const predicates={version:1,match:'all',fields:[{field,operator:'missing'}],properties:[]};
    assert.equal((await explore({predicates:JSON.stringify(predicates)})).totals.events,2);
  }
  const cohort=await saveCohort(metrics,owner,{requestId:randomUUID(),definition:{schemaVersion:1,name:'Chrome retained visitors',query:new URLSearchParams({...base,timeZone:'UTC',path:'/chrome',browser:'chrome',device:'desktop'}).toString()}});
  const cohortReport=await explore({groupBy:'browser',cohortId:cohort.item!.id,cohortRevision:String(cohort.item!.revision)});
  assert.equal(cohortReport.totals.pageViews,4);assert.equal(cohortReport.cohort?.identity.observedMemberKeys,2);
  const goal=await saveAnalysis(metrics,owner,'goal',{requestId:randomUUID(),definition:{kind:'goal',name:'Chrome pages',condition:{type:'path',match:'exact',value:'/chrome'}}});
  const analysis=await runAnalysis(metrics,owner,'goal',goal.item!.id,new URLSearchParams({...base,timeZone:'UTC',revision:String(goal.item!.revision),browser:'chrome'}));
  assert.equal(analysis.identity.visitors,2);assert.equal(analysis.goal?.visitors,2);
  await assert.rejects(runAnalysis(metrics,owner,'goal',goal.item!.id,new URLSearchParams({...base,revision:String(goal.item!.revision),cohortId:cohort.item!.id,cohortRevision:String(cohort.item!.revision)})),{status:400},'Unsupported goal cohort selection remains rejected.');
  console.log('PASS Explorer missing/unknown groups and exact/advanced filters, saved cohort qualification slots and goal population reuse');

  await pool.query("UPDATE project SET analytics_retained_from='2024-02-29T12:00:05Z' WHERE id=$1",[metrics]);
  const partial=await report();assert.equal(partial.coverage.status,'partial');assert.equal(partial.totals.pageViews,6);assert.equal(partial.environment.coverage.pageViews,6);
  const expired=await projectAnalytics(metrics,owner,new URLSearchParams({from:'2024-02-28',to:'2024-02-28',browser:'chrome'}));
  assert.equal(expired.coverage.status,'unavailable');assert.deepEqual(expired.environment.coverage,{pageViews:null,recordedPageViews:null,notRecordedPageViews:null,firstRecordedAt:null});
  assert.deepEqual(expired.environment.browsers,[]);assert.deepEqual(expired.environment.operatingSystems,[]);assert.deepEqual(expired.environment.devices,[]);
  console.log('PASS retention watermarks remove expired evidence and distinguish unavailable history from empty environment counts');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM provider_request')).rows[0].n,0);
}
if(process.env.TEN98_ENVIRONMENT_TEST==='1')try{await runEnvironmentChecks();}finally{await closeDatabase();}
