import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {getConfig} from '../src/server/config.ts';
import {assertSchema,closeDatabase,getDatabase} from '../src/server/db.ts';
import {normalizeProperties} from '../src/server/analytics-input.ts';
import {parseAdvancedPredicates} from '../src/server/advanced-predicate-input.ts';
import {exploreAnalytics} from '../src/server/explorer.ts';
import {saveSegment} from '../src/server/segments.ts';
import {saveCohort,deleteCohort} from '../src/server/cohorts.ts';
import {getRetention,previewRetention,saveRetention} from '../src/server/retention.ts';
import {runAnalysis} from '../src/server/funnels.ts';
import {removeMember} from '../src/server/teams.ts';

const fail=(status:number)=>(error:unknown)=>!!error&&typeof error==='object'&&'status' in error&&error.status===status;
const prop=(key:string,operator:string,type?:string,value?:unknown)=>({key,operator,...(type===undefined?{}:{type}),...(value===undefined?{}:{value})});
const group=(sessionProperties:unknown[],properties:unknown[]=[],fields:unknown[]=[],match='all')=>parseAdvancedPredicates({version:1,match,fields,properties,sessionProperties});
const base={from:'2026-10-02',to:'2026-10-02',timeZone:'UTC'};
const definition=(query:URLSearchParams,name='Session fixture')=>({schemaVersion:1 as const,name,query:query.toString()});

export async function runSessionPredicateChecks(){
  assert.equal(process.env.TEN98_INTEGRATION_TEST,'1');assert.equal(process.env.TEN98_SESSION_PREDICATE_TEST,'1');
  const config=getConfig(),db=new URL(config.databaseUrl),local=['localhost','127.0.0.1','[::1]'];
  const ci=process.env.GITHUB_ACTIONS==='true'&&process.env.TEN98_ISOLATED_CI_DATABASE==='1'&&db.pathname==='/ten98_session_ci';
  assert.ok(local.includes(db.hostname)&&local.includes(new URL(config.appUrl).hostname));assert.equal(db.port,ci?'5432':'55501');
  assert.ok(ci||/^\/ten98_session_[a-f0-9]{12}$/.test(db.pathname));assert.equal(db.search,'');assert.equal(db.hash,'');
  for(const key of ['PGHOST','PGHOSTADDR','PGPORT','PGDATABASE','PGSERVICE','PGSERVICEFILE'])assert.equal(process.env[key],undefined);
  await assertSchema();const {pool}=getDatabase();assert.equal((await pool.query('SELECT count(*)::int AS n FROM workspace')).rows[0].n,0,'Use a fresh empty fixture.');
  const waitForLock=async(waiter:number,blocker:number)=>{
    const deadline=Date.now()+200;
    do{
      const found=await pool.query("SELECT wait_event FROM pg_stat_activity WHERE datname=current_database() AND pid=$1 AND wait_event_type='Lock' AND $2=ANY(pg_blocking_pids(pid))",[waiter,blocker]);
      if(found.rowCount)return;
      await delay(5);
    }while(Date.now()<deadline);
    assert.fail('The expected fixture backend did not enter an observed lock wait before the report admission deadline.');
  };
  const owner=randomUUID(),outsider=randomUUID(),workspace=randomUUID(),project=randomUUID(),emptyProject=randomUUID();
  const originalFetch=globalThis.fetch;let outgoing=0;globalThis.fetch=async()=>{outgoing++;throw new Error('External requests are forbidden in this fixture.');};
  try{
    for(const id of [owner,outsider])await pool.query('INSERT INTO "user"(id,name,email) VALUES($1,\'Session fixture\',$2)',[id,id+'@session.test']);
    await pool.query("INSERT INTO workspace(id,name) VALUES($1,'Session fixture')",[workspace]);
    await pool.query("INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,'owner')",[workspace,owner]);
    for(const id of [project,emptyProject])await pool.query("INSERT INTO project(id,workspace_id,name,origin,public_key,retention_next_run_at) VALUES($1,$2,'Session fixture',$3,$4,'infinity')",[id,workspace,'https://'+id+'.session.example',randomUUID()]);
    const [a,b,c,d]=['a','b','c','d'].map(x=>x.repeat(64));
    for(const id of [a,b,c,d])await pool.query("INSERT INTO analytics_visitor(project_id,id,first_seen_at,last_seen_at) VALUES($1,$2,'2026-10-01','2026-11-01')",[project,id]);
    const event=async(visitor:string|null,name='case',path='/required',amount=7,at='2026-10-02T12:00:00Z')=>pool.query(
      'INSERT INTO event(id,project_id,event_name,path,received_at,properties,dimensions,visitor_id,visit_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [randomUUID(),project,name,path,at,JSON.stringify(normalizeProperties({amount,eventFlag:visitor===a})),JSON.stringify({language:'EN'}),visitor,visitor?randomUUID().replaceAll('-','').repeat(2):null]);
    const profile=async(visitor:string,properties:unknown,age=0)=>{
      for(const [key,value]of Object.entries(normalizeProperties(properties)))await pool.query(`INSERT INTO analytics_session_property(project_id,visitor_key,property_key,property,updated_at)
        VALUES($1,$2,$3,$4,clock_timestamp()-$5::int*interval '24 hours') ON CONFLICT(project_id,visitor_key,property_key) DO UPDATE SET property=EXCLUDED.property,updated_at=EXCLUDED.updated_at`,[project,visitor,key,JSON.stringify(value),age]);
    };
    const report=(predicates:ReturnType<typeof group>,extra:Record<string,string>={},actor=owner,target=project)=>exploreAnalytics(target,actor,new URLSearchParams({...base,eventName:'case',...extra,predicates:JSON.stringify(predicates)}));
    const count=async(rows:unknown[],extra:Record<string,string>={})=>(await report(group(rows),extra)).totals.events;
    await profile(a,{text:'Pay%_\\ now',amount:10,items:[1,'1',null,''],flag:false,nil:null,empty:'','a.b':'literal',when:'2024-03-10T04:59:59.9999999Z',ancient:'0000-02-29T00:00:00.123456789Z'});
    await profile(b,{text:'other',amount:20,items:[1],flag:true,empty:'other',when:'2024-03-10T05:00:00Z'});
    await profile(c,{text:null,amount:'wrong',items:'wrong',empty:null,when:'not a date'});
    await event(a);await event(a);await event(b,'case','/other',99);await event(c);await event(d);await event(null);await event(null,'unknown');
    for(const [operator,value,expected]of [['eq','Pay%_\\ now',2],['neq','other',2],['contains','PAY%_\\',2],['not_contains','PAY',1],['prefix','PAY',2],['suffix','NOW',2],['regex','^pay',2],['not_regex','^pay',1]] as const){
      assert.equal(await count([prop('text',operator,'string',value)]),expected,operator);
    }
    assert.equal(await count([prop('text','exists')]),4);assert.equal(await count([prop('text','missing')]),1);
    assert.equal(await count([prop('empty','eq','string','')]),2);assert.equal(await count([prop('a\\.b','eq','string','literal')]),2);
    for(const [operator,value,expected]of [['eq',10,2],['neq',10,1],['gt',10,1],['gte',10,3],['lt',20,2],['lte',20,3]] as const)assert.equal(await count([prop('amount',operator,'number',value)]),expected);
    assert.equal(await count([prop('flag','eq','boolean',false)]),2);assert.equal(await count([prop('flag','neq','boolean',false)]),1);
    assert.equal(await count([prop('nil','eq','null',null)]),2);assert.equal(await count([prop('nil','neq','null',null)]),0);
    for(const [operator,value,expected]of [['includes',1,3],['includes','1',2],['includes',null,2],['not_includes','1',1],['eq',[1],1],['neq',[1],2]] as const)assert.equal(await count([prop('items',operator,'array',value)]),expected);
    assert.equal(await count([prop('when','before','date','2024-03-10')],{timeZone:'America/New_York'}),2);
    assert.equal(await count([prop('when','before','date','2024-03-10')]),0);
    assert.equal(await count([prop('when','eq','date','2024-03-10T04:59:59.9999999Z')]),2);
    assert.equal(await count([prop('when','eq','date','2024-03-10T04:59:59.999999Z')]),0);
    assert.equal(await count([prop('ancient','before','date','1970-01-01')]),2);
    assert.equal(await count([prop('amount','gt','number',10),prop('amount','lt','number',10)]),0);
    const selected=group([prop('amount','eq','number',10)],[prop('eventFlag','eq','boolean',true)],[{field:'path',operator:'eq',value:'/other'},{field:'language',operator:'eq',value:'EN'}],'any');
    const numeric=await report(selected,{path:'/required',groupBy:'property',groupProperty:'amount'});
    assert.equal(numeric.totals.events,2);assert.equal(numeric.totals.visits,2);assert.equal(numeric.daily[0].events,2);assert.equal(numeric.breakdown.returnedGroupEvents,2);assert.equal(numeric.numeric?.sum,'14');
    assert.deepEqual(numeric.sessionProperties?.candidates,{identifiedEvents:2,unidentifiedEvents:0});assert.equal(numeric.sessionProperties?.selection.countsAreLowerBounds,false);
    assert.equal(numeric.predicateMethod?.sessionPropertyMatch,'all');assert.ok(numeric.csv.includes('Current session properties'));assert.ok(numeric.csv.includes('signing secret'));
    const unknown=await report(group([prop('text','missing')]),{eventName:'unknown'});assert.equal(unknown.totals.events,null);assert.equal(unknown.sessionProperties?.selection.reason,'identity_unavailable');
    const empty=await report(group([prop('text','missing')]),{eventName:'none'});assert.equal(empty.totals.events,0);assert.equal(empty.sessionProperties?.selection.status,'available');
    await profile(a,{amount:11});assert.equal(await count([prop('amount','eq','number',10)]),0,'Old event dates use current accepted profile values.');await profile(a,{amount:10});
    console.log('PASS complete typed matrix, literal operators, independent required event filters, current values, null identity and every aggregate');

    await event(a,'qualify','/qualification',7,'2026-10-01T12:00:00Z');await event(a,'qualify','/qualification',7,'2026-10-01T13:00:00Z');await event(b,'qualify','/qualification',7,'2026-10-01T12:00:00Z');await event(null,'qualify','/qualification',7,'2026-10-01T12:00:00Z');
    const qualification=new URLSearchParams({from:'2026-10-01',to:'2026-10-01',timeZone:'Asia/Dubai',path:'/qualification',predicates:JSON.stringify(group([prop('amount','eq','number',10)],[prop('eventFlag','eq','boolean',true)]))});
    const intent={requestId:randomUUID(),definition:definition(qualification)},cohort=(await saveCohort(project,owner,intent)).item!;
    const cohortParams={cohortId:cohort.id,cohortRevision:String(cohort.revision)};
    const scoped=await report(selected,{...cohortParams,timeZone:'America/New_York'});
    assert.equal(scoped.totals.events,2);assert.equal(scoped.cohort?.identity.observedMemberKeys,1);assert.equal(scoped.cohort?.identity.identifiedEvents,2);
    assert.equal(scoped.cohort?.sessionProperties?.asOf,scoped.sessionProperties?.asOf);assert.equal(scoped.cohort?.sessionProperties?.retainedFrom,scoped.sessionProperties?.retainedFrom);
    const cohortOnly=await exploreAnalytics(project,owner,new URLSearchParams({...base,...cohortParams}));assert.equal(cohortOnly.totals.events,2);assert.equal(Object.hasOwn(cohortOnly,'sessionProperties'),false);
    const mixedIntent={requestId:randomUUID(),definition:definition(new URLSearchParams({...Object.fromEntries(qualification),predicates:JSON.stringify(group([prop('amount','eq','number',10)]))}))};
    const mixedCohort=(await saveCohort(project,owner,mixedIntent)).item!;
    const mixed=await report(selected,{cohortId:mixedCohort.id,cohortRevision:'1'});
    assert.equal(mixed.cohort?.sessionProperties?.candidates.unidentifiedEvents,1);assert.equal(mixed.cohort?.identity.unidentifiedEvents,null);
    assert.equal(mixed.cohort?.identity.status,'partial');assert.equal(mixed.cohort?.membership.countsAreLowerBounds,true);
    await profile(a,{scopeBoundary:'2024-03-09T22:00:00.9999999Z'});
    const dateQualification=new URLSearchParams({...Object.fromEntries(qualification),predicates:JSON.stringify(group([prop('scopeBoundary','after','date','2024-03-09')]))});
    const dateCohort=(await saveCohort(project,owner,{requestId:randomUUID(),definition:definition(dateQualification)})).item!;
    const zoned=await report(group([prop('scopeBoundary','before','date','2024-03-10')]),{cohortId:dateCohort.id,cohortRevision:'1',timeZone:'America/New_York'});
    assert.equal(zoned.cohort?.identity.observedMemberKeys,1);assert.equal(zoned.cohort?.identity.identifiedEvents,2);assert.equal(zoned.totals.events,2,
      'The same session timestamp is March10 in qualification Dubai and March9 in report New York; swapping either timezone excludes it.');
    const invalid=group([prop('text','regex','string','[')]),badSegment={requestId:randomUUID(),definition:definition(new URLSearchParams({predicates:JSON.stringify(invalid)}))};
    const badCohort={requestId:randomUUID(),definition:definition(new URLSearchParams({...Object.fromEntries(qualification),predicates:JSON.stringify(invalid)}))};
    await assert.rejects(report(invalid,{},owner,emptyProject),fail(400));await assert.rejects(report(invalid,{},outsider,emptyProject),fail(404));
    await assert.rejects(saveSegment(project,owner,badSegment),fail(400));await assert.rejects(saveCohort(project,owner,badCohort),fail(400));
    for(const requestId of [badSegment.requestId,badCohort.requestId])assert.equal((await pool.query('SELECT 1 FROM project_content_request WHERE request_id=$1',[requestId])).rowCount,0);
    assert.equal((await saveCohort(project,owner,intent)).replayed,true);
    await assert.rejects(runAnalysis(project,owner,'funnel',randomUUID(),new URLSearchParams({...base,revision:'1',predicates:JSON.stringify(selected)})),fail(400));
    console.log('PASS distinct qualifying keys, report/qualification binding scopes, conditional session-cohort mode, empty regex and saves/auth/replay');

    await profile(d,{expired:'old'},4000);
    const missing=await report(group([prop('never','missing')]),{eventName:'none',groupBy:'property',groupProperty:'amount'});
    assert.equal(missing.sessionProperties?.evidence.expiredValuesPresent,true);assert.equal(missing.sessionProperties?.evidence.lostAt,null);
    assert.equal(missing.sessionProperties?.selection.reason,'missing_evidence_lost');assert.equal(missing.totals.events,null);assert.equal(missing.daily[0].events,null);
    assert.equal(missing.breakdown.totalGroups,null);assert.deepEqual(missing.properties.keys,[]);assert.equal(missing.numeric,null);
    assert.equal((await report(selected)).sessionProperties?.selection.countsAreLowerBounds,true);
    const current=await getRetention(workspace,owner),preview=await previewRetention(workspace,owner,{revision:current.revision,settings:current.settings});
    await saveRetention(workspace,owner,{previewToken:preview.previewToken});
    await pool.query("DELETE FROM analytics_session_property WHERE project_id=$1 AND property_key='expired'",[project]);
    const sticky=await report(group([prop('never','missing')]),{eventName:'none'});assert.equal(sticky.sessionProperties?.evidence.expiredValuesPresent,false);assert.ok(sticky.sessionProperties?.evidence.lostAt);assert.equal(sticky.totals.events,null);
    const missingCohort=(await saveCohort(project,owner,{requestId:randomUUID(),definition:definition(new URLSearchParams({...Object.fromEntries(qualification),predicates:JSON.stringify(group([prop('never','missing')]))}))})).item!;
    const unavailableCohort=await report(selected,{cohortId:missingCohort.id,cohortRevision:'1'});
    assert.equal(unavailableCohort.cohort?.sessionProperties?.selection.reason,'missing_evidence_lost');assert.equal(unavailableCohort.cohort?.identity.observedMemberKeys,null);
    assert.equal(unavailableCohort.cohort?.identity.identifiedEvents,null);assert.equal(unavailableCohort.totals.events,null);
    assert.equal(unavailableCohort.sessionProperties?.selection.reason,'candidate_scope_unavailable');assert.equal(unavailableCohort.sessionProperties?.candidates.identifiedEvents,null);
    await pool.query("UPDATE project SET analytics_retained_from='2026-10-03' WHERE id=$1",[project]);
    const expiredReport=await report(selected);assert.equal(expiredReport.sessionProperties?.selection.reason,'candidate_scope_unavailable');assert.equal(expiredReport.sessionProperties?.candidates.identifiedEvents,null);
    await pool.query('UPDATE project SET analytics_retained_from=NULL WHERE id=$1',[project]);
    console.log('PASS pending physical expiry and actual retention-save sticky loss, zero-candidate Missing unavailable and separate event coverage');

    const originalConnect=pool.connect.bind(pool),heldClient=await originalConnect(),heldQuery=heldClient.query;
    let entered!:()=>void,release!:()=>void;const enteredPromise=new Promise<void>(r=>entered=r),held=new Promise<void>(r=>release=r);
    heldClient.query=(function(...args:unknown[]){if(typeof args[0]==='string'&&args[0].includes('labeled AS MATERIALIZED')){entered();return held.then(()=>(heldQuery as any).apply(heldClient,args));}return (heldQuery as any).apply(heldClient,args);}) as typeof heldClient.query;
    pool.connect=(async()=>{pool.connect=originalConnect;return heldClient;}) as typeof pool.connect;
    const pending=report(selected);void pending.catch(()=>{});
    try{
      await Promise.race([enteredPromise,delay(3000).then(()=>{throw new Error('Data statement hold was not reached.');})]);
      await profile(a,{amount:12});await event(a);
      release();const fresh=await pending;assert.equal(fresh.totals.events,0,'Profile and traffic committed before the single statement are read together.');
    }finally{pool.connect=originalConnect;release();await pending.catch(()=>{});heldClient.query=heldQuery;}
    await profile(a,{amount:10});
    const snapshotClient=await originalConnect(),snapshotQuery=snapshotClient.query;
    const pid=(await snapshotClient.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    snapshotClient.query=(function(...args:unknown[]){
      if(typeof args[0]==='string'&&args[0].includes('labeled AS MATERIALIZED'))args[0]=args[0].replace('SELECT EXISTS(SELECT 1 FROM target) AS allowed',"SELECT (SELECT true FROM (SELECT pg_sleep(1)) held) AS held,EXISTS(SELECT 1 FROM target) AS allowed");
      return (snapshotQuery as any).apply(snapshotClient,args);
    }) as typeof snapshotClient.query;
    pool.connect=(async()=>{pool.connect=originalConnect;return snapshotClient;}) as typeof pool.connect;
    const snapshot=report(selected);void snapshot.catch(()=>{});
    try{
      let sleeping=false;
      for(let i=0;i<100;i++){if((await pool.query("SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND wait_event='PgSleep'",[pid])).rowCount){sleeping=true;break;}await delay(10);}
      assert.equal(sleeping,true,'Wait for the real data statement snapshot before the concurrent commits.');
      await profile(a,{amount:12});await event(a);
      const old=await snapshot;assert.equal(old.totals.events,3);assert.equal(old.daily[0].events,3);assert.equal(old.breakdown.returnedGroupEvents,3);
      assert.ok(old.csv.includes('"events","3"'));assert.equal((await report(selected)).totals.events,0);
    }finally{pool.connect=originalConnect;await snapshot.catch(()=>{});snapshotClient.query=snapshotQuery;}
    await profile(a,{amount:10});

    await profile(a,{oldPolicy:'retained-before-shrink'},2);
    const prior=await getRetention(workspace,owner),shrinkPreview=await previewRetention(workspace,owner,{revision:prior.revision,settings:{...prior.settings,rawAnalyticsDays:1}});
    const saveClient=await originalConnect(),saveQuery=saveClient.query,waitingClient=await originalConnect();
    const savePid=(await saveClient.query('SELECT pg_backend_pid() AS pid')).rows[0].pid,waitingPid=(await waitingClient.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    let saved!:()=>void,allowSave!:()=>void;const beforeCommit=new Promise<void>(r=>saved=r),saveHeld=new Promise<void>(r=>allowSave=r);
    saveClient.query=(function(...args:unknown[]){if(args[0]==='COMMIT'){saved();return saveHeld.then(()=>(saveQuery as any).apply(saveClient,args));}return (saveQuery as any).apply(saveClient,args);}) as typeof saveClient.query;
    pool.connect=(async()=>{pool.connect=originalConnect;return saveClient;}) as typeof pool.connect;
    const shrinking=saveRetention(workspace,owner,{previewToken:shrinkPreview.previewToken});void shrinking.catch(()=>{});
    let fresh:ReturnType<typeof report>|undefined;
    try{
      await Promise.race([beforeCommit,delay(3000).then(()=>{throw new Error('Retention commit hold was not reached.');})]);
      pool.connect=(async()=>{pool.connect=originalConnect;return waitingClient;}) as typeof pool.connect;
      fresh=report(group([prop('oldPolicy','exists')]));void fresh.catch(()=>{});
      await waitForLock(waitingPid,savePid);allowSave();await shrinking;
      const result=await fresh;assert.equal(result.totals.events,0);assert.equal(result.sessionProperties?.evidence.lost,true,'Admission reads the committed shrink and its loss marker.');
    }finally{pool.connect=originalConnect;allowSave();await shrinking.catch(()=>{});if(fresh)await fresh.catch(()=>{});else waitingClient.release();saveClient.query=saveQuery;}
    const shortened=await getRetention(workspace,owner),extensionPreview=await previewRetention(workspace,owner,{revision:shortened.revision,settings:{...shortened.settings,rawAnalyticsDays:90}});
    const admittedClient=await originalConnect(),admittedQuery=admittedClient.query,extensionClient=await originalConnect();
    const admittedPid=(await admittedClient.query('SELECT pg_backend_pid() AS pid')).rows[0].pid,extensionPid=(await extensionClient.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    let admitted!:()=>void,allowRead!:()=>void;const admission=new Promise<void>(r=>admitted=r),readHeld=new Promise<void>(r=>allowRead=r);
    admittedClient.query=(function(...args:unknown[]){if(typeof args[0]==='string'&&args[0].includes('labeled AS MATERIALIZED')){admitted();return readHeld.then(()=>(admittedQuery as any).apply(admittedClient,args));}return (admittedQuery as any).apply(admittedClient,args);}) as typeof admittedClient.query;
    pool.connect=(async()=>{pool.connect=originalConnect;return admittedClient;}) as typeof pool.connect;
    const admittedReport=report(group([prop('oldPolicy','exists')]));void admittedReport.catch(()=>{});
    let extending:ReturnType<typeof saveRetention>|undefined;
    try{
      await Promise.race([admission,delay(3000).then(()=>{throw new Error('Gated report hold was not reached.');})]);
      pool.connect=(async()=>{pool.connect=originalConnect;return extensionClient;}) as typeof pool.connect;
      extending=saveRetention(workspace,owner,{previewToken:extensionPreview.previewToken});void extending.catch(()=>{});
      await waitForLock(extensionPid,admittedPid);
      allowRead();const result=await admittedReport;await extending;assert.equal(result.totals.events,0);
      assert.equal((await report(group([prop('oldPolicy','exists')]))).totals.events,0,'Extension cannot revive values already expired at the report snapshot.');
      const cutoff=(await pool.query('SELECT session_properties_retained_from AS cutoff FROM project WHERE id=$1',[project])).rows[0].cutoff;
      assert.ok(new Date(cutoff).getTime()>=Date.parse(result.sessionProperties!.retainedFrom));
    }finally{pool.connect=originalConnect;allowRead();await admittedReport.catch(()=>{});if(extending)await extending.catch(()=>{});else extensionClient.release();admittedClient.query=admittedQuery;}
    const restartClient=await originalConnect(),restartQuery=restartClient.query;let rolledBack=false;
    restartClient.query=(async function(...args:unknown[]){
      const result=await (restartQuery as any).apply(restartClient,args);
      if(args[0]==='ROLLBACK'&&!rolledBack){rolledBack=true;await saveCohort(project,owner,{requestId:randomUUID(),revision:1,definition:{...intent.definition,name:'Changed during restart'}},cohort.id);}
      return result;
    }) as typeof restartClient.query;
    pool.connect=(async()=>{pool.connect=originalConnect;return restartClient;}) as typeof pool.connect;
    try{await assert.rejects(exploreAnalytics(project,owner,new URLSearchParams({...base,...cohortParams})),fail(409));assert.equal(rolledBack,true);}
    finally{pool.connect=originalConnect;restartClient.query=restartQuery;}
    const deletedCohort=(await saveCohort(project,owner,{requestId:randomUUID(),definition:intent.definition})).item!;
    const deleteClient=await originalConnect(),deleteQuery=deleteClient.query;let deleted=false,deleteClassification=0,deleteAggregates=0;
    deleteClient.query=(async function(...args:unknown[]){
      if(typeof args[0]==='string'&&args[0].includes('labeled AS MATERIALIZED'))deleteAggregates++;
      const result=await (deleteQuery as any).apply(deleteClient,args);
      if(typeof args[0]==='string'&&args[0].includes('SELECT c.* FROM analytics_cohort')&&result.rowCount===1)deleteClassification++;
      if(args[0]==='ROLLBACK'&&!deleted){deleted=true;await deleteCohort(project,owner,deletedCohort.id,{requestId:randomUUID(),revision:1});}
      return result;
    }) as typeof deleteClient.query;
    pool.connect=(async()=>{pool.connect=originalConnect;return deleteClient;}) as typeof pool.connect;
    try{
      await assert.rejects(exploreAnalytics(project,owner,new URLSearchParams({...base,cohortId:deletedCohort.id,cohortRevision:'1'})),fail(404));
      assert.equal(deleted,true);assert.equal(deleteClassification,1);assert.equal(deleteAggregates,0,'Deleted definitions cannot reach a data statement after classification.');
    }finally{pool.connect=originalConnect;deleteClient.query=deleteQuery;}

    await pool.query("INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,'viewer')",[workspace,outsider]);
    const revokeClient=await originalConnect(),revokeQuery=revokeClient.query,revokedReadClient=await originalConnect(),revokedReadQuery=revokedReadClient.query;
    const revokePid=(await revokeClient.query('SELECT pg_backend_pid() AS pid')).rows[0].pid,revokedReadPid=(await revokedReadClient.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    let revoking!:()=>void,allowRevoke!:()=>void;const revokeBeforeCommit=new Promise<void>(r=>revoking=r),revokeHeld=new Promise<void>(r=>allowRevoke=r);
    let revokeClassification=0,revokeAggregates=0;
    revokeClient.query=(function(...args:unknown[]){if(args[0]==='COMMIT'){revoking();return revokeHeld.then(()=>(revokeQuery as any).apply(revokeClient,args));}return (revokeQuery as any).apply(revokeClient,args);}) as typeof revokeClient.query;
    revokedReadClient.query=(async function(...args:unknown[]){
      if(typeof args[0]==='string'&&args[0].includes('labeled AS MATERIALIZED'))revokeAggregates++;
      const result=await (revokedReadQuery as any).apply(revokedReadClient,args);
      if(typeof args[0]==='string'&&args[0].includes('SELECT c.* FROM analytics_cohort')&&result.rowCount===1)revokeClassification++;
      return result;
    }) as typeof revokedReadClient.query;
    pool.connect=(async()=>{pool.connect=originalConnect;return revokeClient;}) as typeof pool.connect;
    const revocation=removeMember(workspace,owner,outsider);void revocation.catch(()=>{});
    let revokedRead:ReturnType<typeof exploreAnalytics>|undefined;
    try{
      await Promise.race([revokeBeforeCommit,delay(3000).then(()=>{throw new Error('Membership removal commit hold was not reached.');})]);
      pool.connect=(async()=>{pool.connect=originalConnect;return revokedReadClient;}) as typeof pool.connect;
      revokedRead=exploreAnalytics(project,outsider,new URLSearchParams({...base,cohortId:mixedCohort.id,cohortRevision:'1'}));void revokedRead.catch(()=>{});
      await waitForLock(revokedReadPid,revokePid);assert.equal(revokeClassification,1,'The RR preflight saw the still-committed membership before admission waited.');
      allowRevoke();await revocation;await assert.rejects(revokedRead,fail(404));assert.equal(revokeAggregates,0,'Fresh authorization must reject removed membership before reading data.');
    }finally{pool.connect=originalConnect;allowRevoke();await revocation.catch(()=>{});if(revokedRead)await revokedRead.catch(()=>{});else revokedReadClient.release();revokeClient.query=revokeQuery;revokedReadClient.query=revokedReadQuery;}
    const lock=await originalConnect();
    try{await lock.query('BEGIN');await lock.query('SELECT id FROM workspace WHERE id=$1 FOR UPDATE',[workspace]);await assert.rejects(report(selected),fail(503));}
    finally{await lock.query('ROLLBACK');lock.release();}
    assert.equal((await report(selected)).totals.events,4);assert.equal(outgoing,0);
    console.log('PASS actual data-statement snapshot, observed retention lock waits and nonresurrection, restart revision409/deletion404, observed revocation wait with fresh authorization404, gate timeout and pool recovery; zero external calls');
  }finally{globalThis.fetch=originalFetch;}
}
if(import.meta.main){try{await runSessionPredicateChecks();}finally{await closeDatabase();}}
