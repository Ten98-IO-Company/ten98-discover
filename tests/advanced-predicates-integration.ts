import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {hashPassword} from 'better-auth/crypto';
import {getConfig} from '../src/server/config.ts';
import {assertSchema,closeDatabase,getDatabase} from '../src/server/db.ts';
import {normalizeProperties} from '../src/server/analytics-input.ts';
import {parseAdvancedPredicates} from '../src/server/advanced-predicate-input.ts';
import {exploreAnalytics} from '../src/server/explorer.ts';
import {saveSegment,getSegment,deleteSegment} from '../src/server/segments.ts';
import {saveCohort,getCohort,deleteCohort,type CohortItem} from '../src/server/cohorts.ts';
import {runAnalysis} from '../src/server/funnels.ts';
import {handleApi} from '../src/server/api.ts';

const fail=(status:number)=>(error:unknown)=>!!error&&typeof error==='object'&&'status' in error&&error.status===status;
const group=(fields:unknown[]=[],properties:unknown[]=[],match='all')=>parseAdvancedPredicates({version:1,match,fields,properties});
const field=(field:string,operator:string,value?:unknown)=>({field,operator,...(value===undefined?{}:{value})});
const prop=(key:string,operator:string,type?:string,value?:unknown)=>({key,operator,...(type===undefined?{}:{type}),...(value===undefined?{}:{value})});
const definition=(query:URLSearchParams,name='Advanced fixture')=>({schemaVersion:1 as const,name,query:query.toString()});
const base={from:'2026-10-02',to:'2026-10-02',timeZone:'UTC'};

export async function runAdvancedPredicateChecks(){
  assert.equal(process.env.TEN98_INTEGRATION_TEST,'1');assert.equal(process.env.TEN98_PREDICATES_TEST,'1');
  const config=getConfig(),db=new URL(config.databaseUrl),local=['localhost','127.0.0.1','[::1]'];
  const ci=process.env.GITHUB_ACTIONS==='true'&&process.env.TEN98_ISOLATED_CI_DATABASE==='1'&&db.pathname==='/ten98_predicates_ci';
  assert.ok(local.includes(db.hostname)&&local.includes(new URL(config.appUrl).hostname));assert.equal(db.port,ci?'5432':'55501');assert.ok(ci||/^\/ten98_predicates_[a-f0-9]{12}$/.test(db.pathname));assert.equal(db.search,'');assert.equal(db.hash,'');
  for(const key of ['PGHOST','PGHOSTADDR','PGPORT','PGDATABASE','PGSERVICE','PGSERVICEFILE'])assert.equal(process.env[key],undefined);
  await assertSchema();const {pool}=getDatabase();assert.equal((await pool.query('SELECT count(*)::int AS n FROM workspace')).rows[0].n,0,'Use a new empty owned fixture.');
  const owner=randomUUID(),editor=randomUUID(),viewer=randomUUID(),outsider=randomUUID(),workspace=randomUUID(),project=randomUUID(),emptyProject=randomUUID();
  const password=randomBytes(24).toString('base64url'),hashed=await hashPassword(password),originalFetch=globalThis.fetch;
  let outgoing=0;globalThis.fetch=async()=>{outgoing++;throw new Error('External requests forbidden in advanced-filter acceptance.');};
  try{
    for(const uid of [owner,editor,viewer,outsider]){
      await pool.query('INSERT INTO "user"(id,name,email) VALUES($1,\'Predicate fixture\',$2)',[uid,uid+'@predicates.test']);
      await pool.query('INSERT INTO account(id,"accountId","providerId","userId",password) VALUES($1,$2,\'credential\',$2,$3)',[randomUUID(),uid,hashed]);
    }
    await pool.query("INSERT INTO workspace(id,name) VALUES($1,'Predicate fixture')",[workspace]);
    for(const [uid,role]of [[owner,'owner'],[editor,'editor'],[viewer,'viewer']])await pool.query('INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,$3)',[workspace,uid,role]);
    for(const id of [project,emptyProject])await pool.query("INSERT INTO project(id,workspace_id,name,origin,public_key,retention_next_run_at) VALUES($1,$2,'Predicate fixture',$3,$4,'infinity')",[id,workspace,'https://'+id+'.predicate.example',randomUUID()]);
    const a='a'.repeat(64),b='b'.repeat(64),rotated='c'.repeat(64);
    for(const id of [a,b,rotated])await pool.query("INSERT INTO analytics_visitor(project_id,id,first_seen_at,last_seen_at) VALUES($1,$2,'2026-10-01','2026-11-01')",[project,id]);
    const event=async(name:string,path:string,properties:unknown={},dimensions:unknown={},at='2026-10-02T12:00:00Z',visitor:string|null=null,visit=visitor)=>pool.query(
      'INSERT INTO event(id,project_id,event_name,path,received_at,properties,dimensions,visitor_id,visit_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [randomUUID(),project,name,path,at,JSON.stringify(normalizeProperties(properties)),JSON.stringify(dimensions),visitor,visit]);
    const report=(predicates:ReturnType<typeof group>,extra:Record<string,string>={},actor=owner,target=project)=>exploreAnalytics(target,actor,new URLSearchParams({...base,eventName:'text_case',...extra,predicates:JSON.stringify(predicates)}));
    const count=async(predicates:ReturnType<typeof group>,extra:Record<string,string>={})=>(await report(predicates,extra)).totals.events;
    const path='/Shop%_\\ 🐎';
    await event('text_case',path,{text:'Pay%_\\ now',amount:10,items:[1,'1',null,''],flag:false,nil:null},{language:'EN',referrerHost:'first'});
    await event('text_case','/shopXX 🐎',{text:'other',amount:20,items:[1],flag:true},{language:'de'});
    await event('text_case','/Other',{text:'',amount:0,items:[],flag:false},{language:'EN'});
    await event('text_case',path,{text:null,amount:'not numeric',items:'not array'});
    await event('text_case','/empty',{}, {language:''});
    assert.equal(await count(group([field('path','eq','/shopXX 🐎'),field('language','eq','EN')],[],'any'),{path}),1,'Legacy path remains mandatory under additional any.');
    assert.equal(await count(group([field('path','eq',path),field('path','eq','/shopXX 🐎')],[],'any')),3);
    assert.equal(await count(group([field('path','eq',path),field('path','eq','/shopXX 🐎')])),0);
    for(const [operator,value,expected]of [['contains','%_\\',2],['not_contains','%_',3],['prefix','/SHOP',3],['suffix','🐎',3],['regex','^/sHoP',3],['not_regex','^/sHoP',2],['eq','/SHOPXX 🐎',0]] as const)assert.equal(await count(group([field('path',operator,value)])),expected,operator);
    assert.equal(await count(group([field('language','not_contains','e')])),1);assert.equal(await count(group([field('language','neq','EN')])),2);
    assert.equal(await count(group([field('language','missing')])),1);assert.equal(await count(group([field('language','exists')])),4);
    assert.equal(await count(group([field('path','eq',"' OR true; --")])),0);
    for(const [operator,value,expected]of [['neq','other',2],['contains','PAY%_\\',1],['not_contains','PAY',2],['prefix','PAY',1],['suffix','NOW',1],['regex','^pay',1],['not_regex','^pay',2],['eq','',1]] as const)assert.equal(await count(group([],[prop('text',operator,'string',value)])),expected,operator);
    assert.equal(await count(group([field('path','eq',path),field('path','eq','/Other')],[prop('text','contains','string','pay')],'any')),1,'Properties remain AND under field any.');
    assert.equal(await count(group([],[prop('text','missing')])),1);assert.equal(await count(group([],[prop('text','exists')])),4);
    assert.equal(await count(group([],[prop('text','eq','null',null)])),1);assert.equal(await count(group([],[prop('text','neq','null',null)])),0);
    console.log('PASS literal case-insensitive text/regex, repeated all/any, mandatory legacy filters and typed negatives exclude missing/null/wrong types');

    assert.equal(await count(group([],[prop('amount','gte','number',10),prop('amount','lt','number',20)])),1);
    for(const [operator,value,expected]of [['gt',10,1],['lte',10,2],['eq',0,1],['neq',10,2]] as const)assert.equal(await count(group([],[prop('amount',operator,'number',value)])),expected);
    assert.equal(await count(group([],[prop('flag','eq','boolean',false)])),2);assert.equal(await count(group([],[prop('flag','neq','boolean',false)])),1);
    for(const [operator,value,expected]of [['includes',1,2],['includes','1',1],['includes',null,1],['includes','',1],['not_includes',1,1],['eq',[],1],['eq',['1',1,null,''],0]] as const)assert.equal(await count(group([],[prop('items',operator,'array',value)])),expected);
    const numeric=await report(group([],[prop('amount','gte','number',10)]),{groupBy:'property',groupProperty:'amount'});
    assert.equal(numeric.totals.events,2);assert.equal(numeric.daily[0].events,2);assert.equal(numeric.breakdown.returnedGroupEvents,2);assert.equal(numeric.numeric?.sum,'30');assert.equal(numeric.numeric?.samples,2);
    assert.equal(numeric.predicateMethod?.fieldMatch,'all');assert.equal(numeric.predicateMethod?.propertyMatch,'all');assert.ok(numeric.csv.includes('Predicate method'));assert.ok(numeric.csv.includes('postgresql-lower-literal'));
    console.log('PASS guarded numeric comparisons, exact booleans/null, typed array membership and every aggregate uses the filtered report population');

    for(const when of ['2024-03-10T04:59:59.9999999Z','2024-03-10T05:00:00.0000001Z','2024-03-11T04:00:00Z','0000-02-29T00:00:00.123456789Z','not a date'])await event('date_case','/dates',{when});
    await event('date_case','/dates');
    assert.equal(await count(group([],[prop('when','before','date','2024-03-10')]),{eventName:'date_case',timeZone:'America/New_York'}),2);
    assert.equal(await count(group([],[prop('when','after','date','2024-03-10')]),{eventName:'date_case',timeZone:'America/New_York'}),1);
    assert.equal(await count(group([],[prop('when','before','date','2024-03-10')]),{eventName:'date_case'}),1);
    assert.equal(await count(group([],[prop('when','eq','date','2024-03-10T04:59:59.9999999Z')]),{eventName:'date_case'}),1);
    assert.equal(await count(group([],[prop('when','eq','date','2024-03-10T04:59:59.999999Z')]),{eventName:'date_case'}),0);
    console.log('PASS date calendar comparison across DST/timezones, submicrosecond midnight boundary, year0000, and exact fractional equality');

    const qprops={amount:10,when:'2024-03-10T01:00:00Z'};
    await event('signup','/required',qprops,{language:'EN'},'2026-10-01T09:00:00Z',a);
    await event('signup','/required',qprops,{language:'EN'},'2026-10-01T10:00:00Z',a,'d'.repeat(64));
    await event('signup','/required',{...qprops,amount:5},{language:'EN'},'2026-10-01T10:00:00Z',b);
    await event('signup','/other',qprops,{language:'EN'},'2026-10-01T10:30:00Z',b);
    await event('signup','/required',qprops,{language:'EN'},'2026-10-01T11:00:00Z');
    await event('report_case','/traffic',{amount:7,text:'Eligible',when:'2024-03-10T04:59:59.9999999Z'},{language:'de'},'2026-10-02T12:00:00Z',a,'e'.repeat(64));
    await event('report_case','/traffic',{amount:8,text:'Other',when:'2024-03-10T05:00:00Z'},{language:'de'},'2026-10-02T13:00:00Z',a,'f'.repeat(64));
    await event('report_case','/traffic',{amount:99,text:'Eligible'},{language:'de'},'2026-10-02T12:00:00Z',b);
    await event('report_case','/traffic',{amount:7,text:'Eligible'},{language:'de'},'2026-11-01T12:00:00Z',rotated);
    const qualified=group([field('language','eq','EN'),field('path','eq','/optional')],[prop('amount','gte','number',10),prop('when','before','date','2024-03-11')],'any');
    const qparams=new URLSearchParams({from:'2026-10-01',to:'2026-10-01',timeZone:'Asia/Dubai',path:'/required',predicates:JSON.stringify(qualified)});
    const intent={requestId:randomUUID(),definition:definition(qparams,'Qualified with advanced filters')};
    const cohort=(await saveCohort(project,owner,intent)).item!;
    const traffic=group([field('path','eq','/traffic'),field('language','eq','unused')],[prop('text','contains','string','eligible'),prop('amount','gte','number',7),prop('when','before','date','2024-03-10')],'any');
    const cohortReport=(item:CohortItem=cohort,extra:Record<string,string>={})=>report(traffic,{eventName:'report_case',timeZone:'America/New_York',cohortId:item.id,cohortRevision:String(item.revision),groupBy:'property',groupProperty:'amount',...extra});
    const scoped=await cohortReport();
    assert.equal(scoped.totals.events,1);assert.equal(scoped.totals.visits,1);assert.equal(scoped.numeric?.sum,'7');assert.equal(scoped.daily[0].events,1);assert.equal(scoped.breakdown.returnedGroupEvents,1);
    assert.equal(scoped.cohort?.identity.identifiedEvents,2);assert.equal(scoped.cohort?.identity.unidentifiedEvents,1);assert.equal(scoped.cohort?.identity.observedMemberKeys,1);assert.equal(scoped.cohort?.membership.countsAreLowerBounds,true);
    assert.equal(scoped.predicateMethod?.fieldMatch,'any');assert.equal(scoped.cohort?.predicateMethod?.propertyMatch,'all');assert.ok(scoped.csv.includes('Qualified with advanced filters'));assert.ok(scoped.csv.includes('signing secret'));
    assert.equal((await cohortReport(cohort,{from:'2026-11-01',to:'2026-11-01'})).totals.events,0);
    await pool.query("UPDATE project SET analytics_retained_from='2026-10-01T09:30:00Z' WHERE id=$1",[project]);assert.equal((await cohortReport()).cohort?.coverage.status,'partial');
    await pool.query("UPDATE project SET analytics_retained_from='2026-10-02T00:00:00Z' WHERE id=$1",[project]);const expired=await cohortReport();assert.equal(expired.totals.events,null);assert.equal(expired.numeric,null);assert.equal(expired.cohort?.membership.status,'unavailable');
    await pool.query('UPDATE project SET analytics_retained_from=NULL WHERE id=$1',[project]);
    console.log('PASS mandatory same-row cohort action, distinct monthly keys, separate report/qualification values and timezones after slots22, and retained coverage limitations');

    const savedIntent={requestId:randomUUID(),definition:definition(new URLSearchParams({eventName:'text_case',predicates:JSON.stringify(group([],[prop('amount','gte','number',10)]))}),'Saved advanced')};
    const saved=(await saveSegment(project,owner,savedIntent)).item!;
    assert.equal((await exploreAnalytics(project,owner,new URLSearchParams({...base,...Object.fromEntries(new URLSearchParams(saved.definition.query))}))).totals.events,2);
    assert.equal((await getSegment(project,viewer,saved.id)).item.id,saved.id);assert.equal((await getCohort(project,viewer,cohort.id)).item.id,cohort.id);
    const invalid=group([field('path','regex','[')]),invalidParams=new URLSearchParams({predicates:JSON.stringify(invalid)});
    await assert.rejects(report(invalid,{},owner,emptyProject),fail(400));await assert.rejects(report(invalid,{},outsider,emptyProject),fail(404));
    const badSegment={requestId:randomUUID(),definition:definition(invalidParams)};
    const badCohort={requestId:randomUUID(),definition:definition(new URLSearchParams({...Object.fromEntries(qparams),predicates:JSON.stringify(invalid)}))};
    await assert.rejects(saveSegment(project,owner,badSegment),fail(400));await assert.rejects(saveCohort(project,owner,badCohort),fail(400));
    for(const requestId of [badSegment.requestId,badCohort.requestId])assert.equal((await pool.query('SELECT 1 FROM project_content_request WHERE request_id=$1',[requestId])).rowCount,0);
    await assert.rejects(saveSegment(project,viewer,badSegment),fail(404));await assert.rejects(saveCohort(project,viewer,badCohort),fail(404));
    const regexGroup=group([field('path','regex','^/Shop')]);
    const regexIntent={requestId:randomUUID(),definition:definition(new URLSearchParams({predicates:JSON.stringify(regexGroup)}),'Regex saved')};
    const regexItem=(await saveSegment(project,owner,regexIntent)).item!;
    const regexCohortIntent={requestId:randomUUID(),definition:definition(new URLSearchParams({...Object.fromEntries(qparams),predicates:JSON.stringify(regexGroup)}),'Regex cohort')};
    const regexCohort=(await saveCohort(project,owner,regexCohortIntent)).item!;
    const originalConnect=pool.connect.bind(pool),replayClient=await originalConnect(),originalQuery=replayClient.query;
    let regexValidations=0;
    replayClient.query=(function(...args:unknown[]){if(typeof args[0]==='string'&&args[0].includes('unnest($1::text[])'))regexValidations++;return (originalQuery as any).apply(replayClient,args);}) as typeof replayClient.query;
    pool.connect=(async()=>replayClient) as typeof pool.connect;
    const originalRelease=replayClient.release;replayClient.release=()=>{};
    try{
      assert.equal((await saveSegment(project,owner,regexIntent)).replayed,true);assert.equal((await saveCohort(project,owner,regexCohortIntent)).replayed,true);assert.equal(regexValidations,0,'Replay must precede regex validation.');
    }finally{pool.connect=originalConnect;replayClient.query=originalQuery;replayClient.release=originalRelease;replayClient.release();}
    await assert.rejects(saveSegment(project,editor,regexIntent),fail(409));await assert.rejects(saveCohort(project,editor,regexCohortIntent),fail(409));
    await assert.rejects(saveSegment(project,owner,{requestId:randomUUID(),revision:2,definition:regexIntent.definition},regexItem.id),fail(409));
    await deleteSegment(project,owner,regexItem.id,{requestId:randomUUID(),revision:1});assert.equal((await saveSegment(project,owner,regexIntent)).deleted,true);
    await deleteCohort(project,owner,regexCohort.id,{requestId:randomUUID(),revision:1});assert.equal((await saveCohort(project,owner,regexCohortIntent)).deleted,true);
    await assert.rejects(runAnalysis(project,owner,'funnel',randomUUID(),new URLSearchParams({...base,revision:'1',predicates:JSON.stringify(regexGroup)})),fail(400));
    console.log('PASS saved-filter reuse, empty-data regex400, authorization before validation, failed-save rollback, actor/CAS guards and replay before regex validation');

    const snapshotClient=await originalConnect(),snapshotQuery=snapshotClient.query;
    let releaseSnapshot!:()=>void,entered!:()=>void;const held=new Promise<void>(r=>releaseSnapshot=r),enteredPromise=new Promise<void>(r=>entered=r);
    snapshotClient.query=(function(...args:unknown[]){if(typeof args[0]==='string'&&args[0].includes('labeled AS MATERIALIZED')){entered();return held.then(()=>(snapshotQuery as any).apply(snapshotClient,args));}return (snapshotQuery as any).apply(snapshotClient,args);}) as typeof snapshotClient.query;
    pool.connect=(async()=>{pool.connect=originalConnect;return snapshotClient;}) as typeof pool.connect;
    const pending=cohortReport();void pending.catch(()=>{});
    try{
      await Promise.race([enteredPromise,delay(3000).then(()=>{throw new Error('Aggregate hold was not reached.');})]);
      const changed=await saveCohort(project,owner,{requestId:randomUUID(),revision:1,definition:definition(new URLSearchParams({...Object.fromEntries(qparams),predicates:JSON.stringify(group([],[prop('amount','gt','number',100)]))}),'Changed qualification')},cohort.id);
      await event('report_case','/traffic',{amount:7,text:'Eligible',when:'2024-03-10T04:59:59.9999999Z'}, {},'2026-10-02T14:00:00Z',a);
      releaseSnapshot();const old=await pending;assert.equal(old.cohort?.item.revision,1);assert.equal(old.totals.events,1);assert.ok(old.csv.includes('Qualified with advanced filters'));assert.equal(old.csv.includes('Changed qualification'),false);
      assert.equal((await cohortReport(changed.item!)).totals.events,0);await assert.rejects(cohortReport(),fail(409));
    }finally{pool.connect=originalConnect;releaseSnapshot();await pending.catch(()=>{});snapshotClient.query=snapshotQuery;}
    console.log('PASS actual concurrent definition/event commit cannot mix with the already resolved advanced report or snapshot CSV');

    const gate=await pool.connect();
    try{await gate.query('BEGIN');await gate.query('LOCK TABLE event IN ACCESS EXCLUSIVE MODE');await assert.rejects(report(regexGroup),fail(503));}
    finally{await gate.query('ROLLBACK');gate.release();}
    assert.equal(await count(regexGroup),3);
    const timeoutClient=await originalConnect(),timeoutQuery=timeoutClient.query;
    timeoutClient.query=(function(...args:unknown[]){if(typeof args[0]==='string'&&args[0].includes('unnest($1::text[])'))return (timeoutQuery as any).call(timeoutClient,'SELECT pg_sleep(6)');return (timeoutQuery as any).apply(timeoutClient,args);}) as typeof timeoutClient.query;
    pool.connect=(async()=>timeoutClient) as typeof pool.connect;
    const timeoutRelease=timeoutClient.release;timeoutClient.release=()=>{};
    try{
      await assert.rejects(saveSegment(project,owner,{...regexIntent,requestId:randomUUID()}),fail(503));
      await assert.rejects(saveCohort(project,owner,{...regexCohortIntent,requestId:randomUUID()}),fail(503));
    }finally{pool.connect=originalConnect;timeoutClient.query=timeoutQuery;timeoutClient.release=timeoutRelease;timeoutClient.release();}
    assert.equal((await pool.query('SELECT 1 AS ok')).rows[0].ok,1);
    console.log('PASS real data-query deadline and bounded regex-validation statements return503 with usable pool afterward');

    const login=async(uid:string)=>{const response=await handleApi(new Request(config.appUrl+'/api/auth/sign-in/email',{method:'POST',headers:{origin:config.appUrl,'content-type':'application/json'},body:JSON.stringify({email:uid+'@predicates.test',password})}));assert.equal(response.status,200);return response.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');};
    const cookie=await login(owner),viewerCookie=await login(viewer),endpoint=config.appUrl+'/api/projects/'+project;
    const http=(path:string,method='GET',body?:unknown,actor=cookie,origin=config.appUrl)=>handleApi(new Request(endpoint+path,{method,headers:{cookie:actor,origin,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})}));
    const query=new URLSearchParams({...base,predicates:JSON.stringify(invalid)});
    assert.equal((await http('/explore?'+query)).status,400);
    assert.equal((await http('/segments','POST',badSegment)).status,400);assert.equal((await http('/cohorts','POST',badCohort)).status,400);
    assert.equal((await http('/segments','POST',badSegment,viewerCookie)).status,404);assert.equal((await http('/cohorts','POST',badCohort,cookie,'https://foreign.example')).status,403);
    assert.equal((await http('/segments','POST',{...savedIntent,requestId:randomUUID(),padding:'x'.repeat(33000)})).status,413);
    await pool.query("UPDATE membership SET role='viewer' WHERE workspace_id=$1 AND user_id=$2",[workspace,editor]);await assert.rejects(saveSegment(project,editor,{...savedIntent,requestId:randomUUID()}),fail(404));
    assert.equal(outgoing,0);console.log('PASS actual HTTP regex, role, Origin and body-limit boundaries; zero external/provider calls');
  }finally{globalThis.fetch=originalFetch;}
}
if(import.meta.main){try{await runAdvancedPredicateChecks();}finally{await closeDatabase();}}
