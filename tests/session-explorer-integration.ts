import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {getConfig} from '../src/server/config.ts';
import {assertSchema,closeDatabase,getDatabase} from '../src/server/db.ts';
import {listSessions,getSessionDetail,type SessionReadAuthority} from '../src/server/session-explorer.ts';
import {parseSessionCursor,encodeSessionCursor} from '../src/server/session-explorer-input.ts';
import {normalizeProperties} from '../src/server/analytics-input.ts';
import {exploreAnalytics} from '../src/server/explorer.ts';
import {saveCohort} from '../src/server/cohorts.ts';
import {createApiKey,revokeApiKey} from '../src/server/api-keys.ts';
import {getRetention,previewRetention,saveRetention} from '../src/server/retention.ts';
import {removeMember} from '../src/server/teams.ts';
import {collectIdentify} from '../src/server/native-identify.ts';
import {parseIdentifyInput} from '../src/server/identify-input.ts';
import {trackingConsentEpoch} from '../src/server/native-analytics.ts';

const fail=(status:number)=>(error:unknown)=>!!error&&typeof error==='object'&&'status'in error&&error.status===status;
const base={from:'2026-10-02',to:'2026-10-02',timeZone:'UTC'};
export async function runSessionExplorerChecks(){
  assert.equal(process.env.TEN98_INTEGRATION_TEST,'1');assert.equal(process.env.TEN98_SESSION_EXPLORER_TEST,'1');
  const config=getConfig(),db=new URL(config.databaseUrl),local=['localhost','127.0.0.1','[::1]'];
  const ci=process.env.GITHUB_ACTIONS==='true'&&process.env.TEN98_ISOLATED_CI_DATABASE==='1'&&db.pathname==='/ten98_session_explorer_ci';
  assert.ok(local.includes(db.hostname)&&local.includes(new URL(config.appUrl).hostname));assert.equal(db.port,ci?'5432':'55501');
  assert.ok(ci||/^\/ten98_session_[a-f0-9]{12}$/.test(db.pathname));assert.equal(db.search,'');assert.equal(db.hash,'');
  for(const key of ['PGHOST','PGHOSTADDR','PGPORT','PGDATABASE','PGSERVICE','PGSERVICEFILE'])assert.equal(process.env[key],undefined);
  await assertSchema();const {pool}=getDatabase();assert.equal((await pool.query('SELECT count(*)::int AS n FROM workspace')).rows[0].n,0,'Use a fresh empty fixture.');
  const savedFetch=globalThis.fetch;let outbound=0;globalThis.fetch=async()=>{outbound++;throw Error('No external requests in session fixture.');};
  try{
    const owner=randomUUID(),outsider=randomUUID(),workspace=randomUUID(),project=randomUUID(),empty=randomUUID();
    const authority:SessionReadAuthority={kind:'session',userId:owner};
    for(const id of [owner,outsider])await pool.query('INSERT INTO "user"(id,name,email) VALUES($1,\'Session explorer\',$2)',[id,id+'@session.test']);
    await pool.query("INSERT INTO workspace(id,name) VALUES($1,'Session explorer')",[workspace]);
    await pool.query("INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,'owner')",[workspace,owner]);
    for(const id of [project,empty])await pool.query("INSERT INTO project(id,workspace_id,name,origin,public_key,retention_next_run_at) VALUES($1,$2,'Session explorer',$3,$4,'infinity')",[id,workspace,'https://'+id+'.session.example',randomUUID()]);
    const [a,b,c,profileOnly]=['a','b','c','d'].map(value=>value.repeat(64));
    for(const key of [a,b,c])await pool.query("INSERT INTO analytics_visitor(project_id,id,first_seen_at,last_seen_at) VALUES($1,$2,'2026-10-01','2026-10-03')",[project,key]);
    const events:string[]=[];
    async function event(key:string|null,visit:string|null,at:string,path='/match',eventName='case'){
      const id=randomUUID();events.push(id);await pool.query('INSERT INTO event(id,project_id,visitor_id,visit_id,event_name,path,received_at,properties,dimensions) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [id,project,key,visit,eventName,path,at,JSON.stringify(normalizeProperties({amount:7,nil:null})),JSON.stringify({language:'EN',distinctId:'must-not-escape'})]);return id;
    }
    async function profile(key:string,value:number,age=0){await pool.query(`INSERT INTO analytics_session_property(project_id,visitor_key,property_key,property,updated_at)
      VALUES($1,$2,'score',$3,clock_timestamp()-$4::int*interval '24 hours') ON CONFLICT(project_id,visitor_key,property_key) DO UPDATE SET property=EXCLUDED.property,updated_at=EXCLUDED.updated_at`,[project,key,JSON.stringify({type:'number',value}),age]);}
    const query=(extra:Record<string,string>={})=>new URLSearchParams({...base,...extra});
    const list=(extra:Record<string,string>={},target=project)=>listSessions(target,authority,query(extra));
    await event(a,'1'.repeat(64),'2026-10-02T12:00:00.123456Z');await event(a,'1'.repeat(64),'2026-10-02T12:00:00.123456Z');
    await event(a,'2'.repeat(64),'2026-10-02T12:00:00.123457Z','/other','page_view');
    await event(b,'3'.repeat(64),'2026-10-02T12:00:00.123456Z');await event(c,'4'.repeat(64),'2026-10-02T12:00:00.123456Z');
    await event(null,null,'2026-10-02T12:00:00.123456Z','/anonymous');await profile(a,10);await profile(b,20);await profile(profileOnly,99);
    const first=await list({pageSize:'1'});assert.equal(first.totalKeys,3);assert.equal(first.rows?.[0].visitorKey,a);assert.equal(first.rows?.[0].visits,2);
    assert.equal(first.identity.unidentifiedEvents,1);assert.equal(first.selection.countsAreLowerBounds,true);assert.ok(first.paging.nextCursor);
    const seen=[a];let cursor:string|null=first.paging.nextCursor;
    while(cursor){const page=await list({pageSize:'1',cursor});seen.push(...page.rows!.map(row=>row.visitorKey));assert.equal(page.paging.eventBefore,first.paging.eventBefore);cursor=page.paging.nextCursor;}
    assert.deepEqual(seen,[a,b,c]);const matching=await list({path:'/match'});assert.equal(matching.rows?.find(row=>row.visitorKey===a)?.events,2);
    const detail=await getSessionDetail(project,a,authority,query({pageSize:'1'}));assert.equal(detail.summary.events,3);assert.equal(detail.summary.visits,2);
    assert.equal(detail.activity?.[0].kind,'pageview');assert.equal(Object.hasOwn(detail.activity![0].dimensions,'distinctId'),false);
    assert.equal(detail.currentProperties.values[0].property.value,10);assert.equal(detail.linkedIdentities.status,'unavailable');
    const ids=[detail.activity![0].id];let activityCursor=detail.paging.nextCursor;
    while(activityCursor){const page=await getSessionDetail(project,a,authority,query({pageSize:'1',cursor:activityCursor}));ids.push(...page.activity!.map(row=>row.id));activityCursor=page.paging.nextCursor;}
    assert.equal(new Set(ids).size,3);assert.deepEqual(ids.slice(1),events.slice(0,2).sort().reverse());
    await assert.rejects(getSessionDetail(project,profileOnly,authority,query()),fail(404));await assert.rejects(listSessions(project,{kind:'session',userId:outsider},query()),fail(404));
    const noRows=await list({},empty);assert.deepEqual(noRows.rows,[]);assert.equal(noRows.totalKeys,0);
    const unknown=await list({path:'/anonymous'});assert.equal(unknown.selection.reason,'identity_unavailable');assert.equal(unknown.rows,null);
    const wrongScope=parseSessionCursor(first.paging.nextCursor!);wrongScope.scope='0'.repeat(64);await assert.rejects(list({pageSize:'1',cursor:encodeSessionCursor(wrongScope)}),fail(400));
    console.log('PASS typed ungrouped SQL slots, event-derived discovery, distinct visits, microsecond list/activity paging, explicit all-activity detail and identity limits');

    const predicates=(operator='eq',value=10)=>JSON.stringify({version:1,match:'all',fields:[],properties:[{key:'amount',operator:'eq',type:'number',value:7}],
      sessionProperties:[operator==='missing'?{key:'absent',operator}:{key:'score',operator,type:'number',value}]});
    const selected=await list({predicates:predicates()});assert.deepEqual(selected.rows?.map(row=>row.visitorKey),[a]);assert.equal(selected.sessionProperties?.candidates.unidentifiedEvents,1);
    assert.equal(selected.identity.unidentifiedEvents,null);assert.equal(selected.sessionProperties?.asOf,selected.asOf);
    await profile(a,11);assert.equal((await list({predicates:predicates()})).totalKeys,0);await profile(a,10);
    const cohort=(await saveCohort(project,owner,{requestId:randomUUID(),definition:{schemaVersion:1,name:'Observed a',query:query({path:'/other',predicates:predicates()}).toString()}})).item!;
    const scoped=await list({cohortId:cohort.id,cohortRevision:'1',path:'/match',predicates:predicates()});assert.equal(scoped.rows?.[0].events,2);
    assert.equal(scoped.cohort?.identity.observedMemberKeys,1);assert.equal(scoped.cohort?.sessionProperties?.asOf,scoped.sessionProperties?.asOf);
    const explorer=await exploreAnalytics(project,owner,query({cohortId:cohort.id,cohortRevision:'1',path:'/match',predicates:predicates()}));assert.equal(explorer.totals.events,2);
    await assert.rejects(list({cohortId:cohort.id,cohortRevision:'2'}),fail(409));
    const badRegex=JSON.stringify({version:1,match:'all',fields:[{field:'path',operator:'regex',value:'['}],properties:[]});await assert.rejects(list({predicates:badRegex},empty),fail(400));
    const key=await createApiKey(workspace,owner,{name:'Read',scopes:['analytics:read']});assert.equal((await listSessions(project,{kind:'api-key',token:key.token},query())).totalKeys,3);
    await revokeApiKey(workspace,owner,key.key.id);await assert.rejects(listSessions(project,{kind:'api-key',token:key.token},query()),fail(401));
    console.log('PASS current typed properties, combined cohort/report bindings, unchanged Explorer population, empty-data regex validation and current API key checks');

    const connect=pool.connect.bind(pool),dataSql=(sql:unknown)=>typeof sql==='string'&&sql.startsWith('WITH RECURSIVE target')&&sql.includes('selected_candidates AS MATERIALIZED');
    const waitFor=async(check:()=>Promise<boolean>,message:string,milliseconds=200)=>{
      const deadline=Date.now()+milliseconds;
      do{if(await check())return;await delay(5);}while(Date.now()<deadline);assert.fail(message);
    };
    async function admissionRace(mutate:()=>Promise<unknown>,read:()=>Promise<unknown>,status:number){
      const writer=await connect(),reader=await connect(),writeQuery=writer.query,readQuery=reader.query;
      const writerPid=(await writer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid,readerPid=(await reader.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      let reached!:()=>void,release!:()=>void;const held=new Promise<void>(r=>reached=r),resume=new Promise<void>(r=>release=r);let dataStatements=0;
      writer.query=(function(...args:unknown[]){if(args[0]==='COMMIT'){reached();return resume.then(()=>(writeQuery as any).apply(writer,args));}return (writeQuery as any).apply(writer,args);}) as typeof writer.query;
      reader.query=(function(...args:unknown[]){if(dataSql(args[0]))dataStatements++;return (readQuery as any).apply(reader,args);}) as typeof reader.query;
      pool.connect=(async()=>{pool.connect=connect;return writer;}) as typeof pool.connect;
      const mutation=mutate();void mutation.catch(()=>{});let reading:Promise<unknown>|undefined;
      try{
        await Promise.race([held,delay(3000).then(()=>{throw Error('Mutation did not reach held COMMIT.');})]);
        pool.connect=(async()=>{pool.connect=connect;return reader;}) as typeof pool.connect;reading=read();void reading.catch(()=>{});
        await waitFor(async()=>(await pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid=$1 AND wait_event_type='Lock' AND $2=ANY(pg_blocking_pids(pid))",[readerPid,writerPid])).rowCount===1,'Expected exact reader/writer lock wait.');
        release();await mutation;await assert.rejects(reading,fail(status));assert.equal(dataStatements,0,'Current authorization must reject before final data SQL.');
      }finally{pool.connect=connect;release();await mutation.catch(()=>{});if(reading)await reading.catch(()=>{});else reader.release();writer.query=writeQuery;reader.query=readQuery;}
    }
    const revokeAtGate=await createApiKey(workspace,owner,{name:'Revoked during admission',scopes:['analytics:read']});
    await admissionRace(()=>revokeApiKey(workspace,owner,revokeAtGate.key.id),()=>listSessions(project,{kind:'api-key',token:revokeAtGate.token},query()),401);
    await pool.query("INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,'viewer')",[workspace,outsider]);
    await admissionRace(()=>removeMember(workspace,owner,outsider),()=>listSessions(project,{kind:'session',userId:outsider},query()),404);

    const expiring=await createApiKey(workspace,owner,{name:'Expires before data statement',scopes:['analytics:read']});
    await pool.query("UPDATE api_key SET expires_at=clock_timestamp()+interval '1 second' WHERE id=$1",[expiring.key.id]);
    const expiryClient=await connect(),expiryQuery=expiryClient.query;let keyChecks=0,finalDispatched=false,reachedData!:()=>void,resumeData!:()=>void;
    const dataReached=new Promise<void>(r=>reachedData=r),dataResume=new Promise<void>(r=>resumeData=r);
    expiryClient.query=(async function(...args:unknown[]){
      if(dataSql(args[0])){assert.equal(keyChecks,3,'All three real key validators succeeded before the data hold.');reachedData();await dataResume;finalDispatched=true;}
      const result=await (expiryQuery as any).apply(expiryClient,args);
      if(typeof args[0]==='string'&&args[0].startsWith('SELECT k.id')){assert.equal(result.rowCount,1);keyChecks++;}return result;
    }) as typeof expiryClient.query;
    pool.connect=(async()=>{pool.connect=connect;return expiryClient;}) as typeof pool.connect;
    const expiredRead=listSessions(project,{kind:'api-key',token:expiring.token},query());void expiredRead.catch(()=>{});
    try{
      await Promise.race([dataReached,delay(3000).then(()=>{throw Error('Final data hold was not reached.');})]);
      await waitFor(async()=>(await pool.query('SELECT expires_at<=clock_timestamp() AS expired FROM api_key WHERE id=$1',[expiring.key.id])).rows[0].expired,'The known key deadline did not pass.',3000);
      resumeData();await assert.rejects(expiredRead,fail(401));assert.equal(finalDispatched,true,'The real final SQL executed after expiry; no fabricated query result.');
    }finally{pool.connect=connect;resumeData();await expiredRead.catch(()=>{});expiryClient.query=expiryQuery;}
    const valid=await createApiKey(workspace,owner,{name:'Unexpired control',scopes:['analytics:read']});
    assert.equal((await listSessions(project,{kind:'api-key',token:valid.token},query())).totalKeys,3);
    console.log('PASS actual blocked admission with key revocation/member removal and final-statement key expiry after successful validators; valid key control');

    async function sleepingRead(seconds:number){
      const client=await connect(),original=client.query,pid=(await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      let cancellation:string|undefined;
      client.query=(async function(...args:unknown[]){
        if(dataSql(args[0]))args[0]=(args[0] as string).replace('SELECT EXISTS(SELECT 1 FROM target) AS allowed',`SELECT (SELECT true FROM (SELECT pg_sleep(${seconds})) held) AS held,EXISTS(SELECT 1 FROM target) AS allowed`);
        try{return await (original as any).apply(client,args);}catch(error){cancellation=(error as {code?:string}).code;throw error;}
      }) as typeof client.query;
      pool.connect=(async()=>{pool.connect=connect;return client;}) as typeof pool.connect;
      const pending=getSessionDetail(project,a,authority,query());void pending.catch(()=>{});
      return {pid,pending,code:()=>cancellation,restore:async()=>{pool.connect=connect;await pending.catch(()=>{});client.query=original;}};
    }
    const snapshot=await sleepingRead(1),concurrentEvent=randomUUID();
    try{
      await waitFor(async()=>(await pool.query("SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND wait_event='PgSleep'",[snapshot.pid])).rowCount===1,'Actual data statement never entered PgSleep.',1000);
      const writer=await connect();
      try{await writer.query('BEGIN');await writer.query("UPDATE analytics_session_property SET property='{\"type\":\"number\",\"value\":11}',updated_at=clock_timestamp() WHERE project_id=$1 AND visitor_key=$2 AND property_key='score'",[project,a]);
        await writer.query("INSERT INTO event(id,project_id,visitor_id,visit_id,event_name,path,received_at) VALUES($1,$2,$3,$4,'case','/concurrent','2026-10-02T13:00:00Z')",[concurrentEvent,project,a,'5'.repeat(64)]);await writer.query('COMMIT');
      }catch(error){await writer.query('ROLLBACK');throw error;}finally{writer.release();}
      const old=await snapshot.pending;assert.equal(old.summary.events,3);assert.equal(old.currentProperties.values.find(value=>value.key==='score')?.property.value,10);
      const fresh=await getSessionDetail(project,a,authority,query());assert.equal(fresh.summary.events,4);assert.equal(fresh.currentProperties.values.find(value=>value.key==='score')?.property.value,11);
    }finally{await snapshot.restore();await pool.query('DELETE FROM event WHERE project_id=$1 AND id=$2',[project,concurrentEvent]);await profile(a,10);}
    const cancelled=await sleepingRead(10);
    try{
      await waitFor(async()=>(await pool.query("SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND wait_event='PgSleep'",[cancelled.pid])).rowCount===1,'Cancellation target did not enter real data SQL.',1000);
      assert.equal((await pool.query('SELECT pg_cancel_backend($1) AS cancelled',[cancelled.pid])).rows[0].cancelled,true);
      await assert.rejects(cancelled.pending,fail(503));assert.equal(cancelled.code(),'57014');
    }finally{await cancelled.restore();}
    assert.equal((await list()).totalKeys,3);assert.equal((await pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND state='idle in transaction'")).rows[0].n,0);
    const locked=await connect();try{await locked.query('BEGIN');await locked.query('SELECT id FROM workspace WHERE id=$1 FOR UPDATE',[workspace]);await assert.rejects(list(),fail(503));}
    finally{await locked.query('ROLLBACK');locked.release();}assert.equal((await list()).totalKeys,3);
    console.log('PASS one real data-statement snapshot across atomic concurrent traffic/property commit, actual57014 cancellation, lock deadline and pool recovery');

    const network=process.env.ANALYTICS_NETWORK_MODE;process.env.ANALYTICS_NETWORK_MODE='direct';
    try{
      const site=(await pool.query('SELECT public_key,origin,analytics_epoch FROM project WHERE id=$1',[project])).rows[0];
      const identify=()=>collectIdentify(new Request(site.origin,{headers:{origin:site.origin,'user-agent':'Session explorer fixture'}}),parseIdentifyInput({type:'identify',siteKey:site.public_key,
        requestId:randomUUID(),sentAt:new Date().toISOString(),url:site.origin+'/account',dimensions:{distinctId:'cursor-update'},properties:{plan:'current'},consent:{analytics:true,epoch:trackingConsentEpoch(site.analytics_epoch,null)}}),'192.0.2.48');
      assert.equal((await identify()).accepted,true);const marker=(await pool.query('SELECT session_properties_retained_from AS cutoff FROM project WHERE id=$1',[project])).rows[0].cutoff;
      await delay(5);assert.equal((await identify()).accepted,true);
      const continuation=await list({pageSize:'1',cursor:first.paging.nextCursor!});assert.equal(continuation.retention.policy.revision,first.retention.policy.revision);assert.equal(continuation.paging.retentionEvidenceChanged,false);
      assert.ok((await pool.query('SELECT session_properties_retained_from AS cutoff FROM project WHERE id=$1',[project])).rows[0].cutoff>marker,'Real identify advanced the automatic marker without invalidating paging.');
    }finally{if(network===undefined)delete process.env.ANALYTICS_NETWORK_MODE;else process.env.ANALYTICS_NETWORK_MODE=network;}
    const naturalDeadline=(await pool.query(`UPDATE analytics_session_property SET updated_at=clock_timestamp()-(SELECT raw_analytics_days FROM workspace WHERE id=$3)*interval '24 hours'+interval '1 second'
      WHERE project_id=$1 AND visitor_key=$2 AND property_key='score' RETURNING updated_at+(SELECT raw_analytics_days FROM workspace WHERE id=$3)*interval '24 hours' AS expires`,[project,profileOnly,workspace])).rows[0].expires;
    const beforeNatural=await list({pageSize:'1'});assert.equal(beforeNatural.retention.profileEvidenceLost,false);
    await waitFor(async()=>(await pool.query('SELECT clock_timestamp()>=$1::timestamptz AS expired',[naturalDeadline])).rows[0].expired,'Natural property deadline did not pass.',3000);
    const afterNatural=await list({pageSize:'1',cursor:beforeNatural.paging.nextCursor!});assert.equal(afterNatural.retention.profileEvidenceLost,true);assert.equal(afterNatural.paging.retentionEvidenceChanged,true);
    assert.equal(afterNatural.retention.policy.revision,beforeNatural.retention.policy.revision);
    console.log('PASS real identify marker advancement and natural per-key expiry preserve policy cursor validity while updating evidence');

    await profile(profileOnly,99,4000);const lost=await list({predicates:predicates('missing'),path:'/none'});assert.equal(lost.selection.reason,'session_property_selection_unavailable');assert.equal(lost.rows,null);
    const changed=await list({pageSize:'1',cursor:first.paging.nextCursor!});assert.equal(changed.paging.retentionEvidenceChanged,true);
    assert.equal((await getSessionDetail(project,a,authority,query())).summary.events,3,'Profile evidence loss must not hide retained events.');
    const settings=await getRetention(workspace,owner),preview=await previewRetention(workspace,owner,{revision:settings.revision,settings:{...settings.settings,rawAnalyticsDays:settings.settings.rawAnalyticsDays-1}});
    await saveRetention(workspace,owner,{previewToken:preview.previewToken});await assert.rejects(list({pageSize:'1',cursor:first.paging.nextCursor!}),fail(409));
    await pool.query("UPDATE project SET analytics_retained_from='2026-10-03' WHERE id=$1",[project]);
    const expired=await list();assert.equal(expired.selection.reason,'event_history_unavailable');assert.equal(expired.totalKeys,null);assert.equal(expired.rows,null);
    await assert.rejects(getSessionDetail(project,a,authority,query()),fail(404));assert.equal(outbound,0);
    console.log('PASS physical expiry before cleanup, conservative missing even on zero candidates, evidence-change metadata, actual retention save cursor409, expired event history and zero external calls');
  }finally{globalThis.fetch=savedFetch;}
}
if(import.meta.main){try{await runSessionExplorerChecks();}finally{await closeDatabase();}}
