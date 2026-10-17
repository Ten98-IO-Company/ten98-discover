import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {hashPassword} from 'better-auth/crypto';
import {getConfig} from '../src/server/config.ts';
import {assertSchema,closeDatabase,getDatabase} from '../src/server/db.ts';
import {handleApi} from '../src/server/api.ts';
import {createApiKey} from '../src/server/api-keys.ts';
import {normalizeProperties} from '../src/server/analytics-input.ts';
import {exploreAnalytics} from '../src/server/explorer.ts';
import {analyticsIdentity} from '../src/server/native-analytics.ts';
import {runAnalysis} from '../src/server/funnels.ts';
import {listCohorts,getCohort,saveCohort,deleteCohort} from '../src/server/cohorts.ts';

const qualification={from:'2026-10-01',to:'2026-10-01',timeZone:'UTC'};
const definition=(query='',name='Cohort')=>{const params=new URLSearchParams(query);for(const [key,value]of Object.entries(qualification))if(!params.has(key))params.set(key,value);if(!params.has('path')&&!params.has('eventName'))params.set('path','/offer');return {schemaVersion:1 as const,name,query:params.toString()};};
const fail=(status:number)=>(error:unknown)=>!!error&&typeof error==='object'&&'status' in error&&error.status===status;
export async function runCohortChecks(){
  assert.equal(process.env.TEN98_INTEGRATION_TEST,'1');assert.equal(process.env.TEN98_COHORTS_TEST,'1');
  const config=getConfig(),db=new URL(config.databaseUrl),local=['localhost','127.0.0.1','[::1]'];
  const ci=process.env.GITHUB_ACTIONS==='true'&&process.env.TEN98_ISOLATED_CI_DATABASE==='1'&&db.pathname==='/ten98_cohorts_ci';
  assert.ok(local.includes(db.hostname)&&local.includes(new URL(config.appUrl).hostname));assert.equal(db.port,ci?'5432':'55501');assert.ok(ci||/^\/ten98_cohorts_[a-f0-9]{12}$/.test(db.pathname));assert.equal(db.search,'');assert.equal(db.hash,'');
  for(const key of ['PGHOST','PGHOSTADDR','PGPORT','PGDATABASE','PGSERVICE','PGSERVICEFILE'])assert.equal(process.env[key],undefined);
  await assertSchema();const {pool}=getDatabase();assert.equal((await pool.query('SELECT count(*)::int AS n FROM workspace')).rows[0].n,0,'Use a fresh owned fixture.');
  const owner=randomUUID(),admin=randomUUID(),editor=randomUUID(),viewer=randomUUID(),stranger=randomUUID(),workspace=randomUUID(),foreignWorkspace=randomUUID(),project=randomUUID(),foreign=randomUUID(),sibling=randomUUID();
  const password=randomBytes(24).toString('base64url'),hashed=await hashPassword(password),savedFetch=globalThis.fetch;
  let outbound=0;globalThis.fetch=async()=>{outbound++;throw new Error('External traffic forbidden in cohort acceptance.');};
  try{
    for(const uid of [owner,admin,editor,viewer,stranger]){
      await pool.query('INSERT INTO "user"(id,name,email) VALUES($1,\'Cohort fixture\',$2)',[uid,uid+'@cohorts.test']);
      await pool.query('INSERT INTO account(id,"accountId","providerId","userId",password) VALUES($1,$2,\'credential\',$2,$3)',[randomUUID(),uid,hashed]);
    }
    for(const wid of [workspace,foreignWorkspace])await pool.query("INSERT INTO workspace(id,name) VALUES($1,'Cohort fixture')",[wid]);
    for(const [uid,role] of [[owner,'owner'],[admin,'admin'],[editor,'editor'],[viewer,'viewer']])await pool.query('INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,$3)',[workspace,uid,role]);
    await pool.query("INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,'owner')",[foreignWorkspace,stranger]);
    for(const [pid,wid] of [[project,workspace],[sibling,workspace],[foreign,foreignWorkspace]])await pool.query("INSERT INTO project(id,workspace_id,name,origin,public_key,retention_next_run_at) VALUES($1,$2,'Cohort fixture',$3,$4,'infinity')",[pid,wid,'https://'+pid+'.example.com',randomUUID()]);
    const save=(raw=definition(),pid=project,uid=owner)=>saveCohort(pid,uid,{requestId:randomUUID(),definition:raw});
    const all=()=>listCohorts(project,owner,new URLSearchParams());

    const intent={requestId:randomUUID(),definition:definition('path=%2Fa%25_&campaignSource=','  Exact filter  ')};
    const [first,replayed]=await Promise.all([saveCohort(project,owner,intent),saveCohort(project,owner,intent)]);
    assert.ok(first.item&&replayed.item);assert.equal(first.item.id,replayed.item.id);assert.notEqual(first.replayed,replayed.replayed);assert.equal(first.item.definition.name,'Exact filter');
    assert.equal((await pool.query('SELECT 1 FROM analytics_cohort WHERE project_id=$1',[project])).rowCount,1);
    for(const [uid,role] of [[owner,'owner'],[admin,'admin'],[editor,'editor'],[viewer,'viewer']]){const result=await getCohort(project,uid,first.item.id);assert.equal(result.role,role);assert.deepEqual(result.item,first.item);}
    await assert.rejects(save(definition(),project,viewer),fail(404));await assert.rejects(getCohort(project,stranger,first.item.id),fail(404));await assert.rejects(getCohort(foreign,stranger,first.item.id),fail(404));
    await assert.rejects(saveCohort(project,admin,intent),fail(409));await assert.rejects(saveCohort(project,owner,{...intent,definition:definition('path=/other')}),fail(409));
    assert.ok((await save(definition('','Admin'),project,admin)).item);const editorIntent={requestId:randomUUID(),definition:definition('','Editor')};assert.ok((await saveCohort(project,editor,editorIntent)).item);
    console.log('PASS current member reads, owner/admin/editor writes, foreign-scope isolation and actor-bound concurrent create replay');

    const id=first.item.id,updates=[{requestId:randomUUID(),revision:1,definition:definition('path=/one','One')},{requestId:randomUUID(),revision:1,definition:definition('path=/two','Two')}];
    const races=await Promise.allSettled(updates.map(body=>saveCohort(project,owner,body,id)));
    assert.equal(races.filter(x=>x.status==='fulfilled').length,1);assert.equal(races.filter(x=>x.status==='rejected'&&fail(409)(x.reason)).length,1);
    const current=(await getCohort(project,owner,id)).item;assert.equal(current.revision,2);const winning=updates.find(x=>x.definition.name===current.definition.name)!;
    const replayUpdate=await saveCohort(project,owner,winning,id);assert.equal(replayUpdate.replayed,true);assert.equal(replayUpdate.item?.revision,2);
    await assert.rejects(deleteCohort(project,owner,id,{requestId:randomUUID(),revision:1}),fail(409));
    const deletion={requestId:randomUUID(),revision:2};assert.equal((await deleteCohort(project,owner,id,deletion)).replayed,false);assert.equal((await deleteCohort(project,owner,id,deletion)).replayed,true);
    assert.deepEqual(await saveCohort(project,owner,intent),{role:'owner',item:null,deleted:true,replayed:true});assert.equal((await saveCohort(project,owner,winning,id)).deleted,true);
    await assert.rejects(deleteCohort(project,admin,id,deletion),fail(409));assert.equal((await pool.query('SELECT 1 FROM analytics_cohort WHERE id=$1',[id])).rowCount,0);
    const cap=(await save()).item!;await pool.query('UPDATE analytics_cohort SET revision=2147483647 WHERE id=$1',[cap.id]);
    await assert.rejects(saveCohort(project,owner,{requestId:randomUUID(),revision:2147483647,definition:definition()},cap.id),fail(409));await deleteCohort(project,owner,cap.id,{requestId:randomUUID(),revision:2147483647});
    console.log('PASS revision races, exact update/delete replay, deleted receipt cannot recreate, and deletion remains possible at revision cap');

    const rollbackIntent={requestId:randomUUID(),definition:definition('path=/atomic','Atomic')};
    await pool.query(`CREATE FUNCTION cohort_receipt_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.operation LIKE 'cohort.%' THEN RAISE EXCEPTION 'Synthetic receipt failure'; END IF; RETURN NEW; END $$`);
    await pool.query('CREATE TRIGGER cohort_receipt_failure BEFORE INSERT ON project_content_request FOR EACH ROW EXECUTE FUNCTION cohort_receipt_failure()');
    try{await assert.rejects(saveCohort(project,owner,rollbackIntent));assert.equal((await pool.query("SELECT 1 FROM analytics_cohort WHERE name='Atomic'")).rowCount,0);assert.equal((await pool.query('SELECT 1 FROM project_content_request WHERE request_id=$1',[rollbackIntent.requestId])).rowCount,0);}finally{await pool.query('DROP TRIGGER cohort_receipt_failure ON project_content_request');await pool.query('DROP FUNCTION cohort_receipt_failure()');}
    assert.equal((await saveCohort(project,owner,rollbackIntent)).replayed,false);
    const gate=await pool.connect();let waiting:Promise<unknown>|undefined;
    try{
      await gate.query('BEGIN');await gate.query('SELECT id FROM workspace WHERE id=$1 FOR UPDATE',[workspace]);
      waiting=save(definition('path=/revoked','Revoked'),project,editor);const observed=waiting.catch(error=>error);const deadline=Date.now()+3000;let blocked=false;
      do{blocked=(await pool.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT w.id FROM workspace w JOIN project%') AS blocked")).rows[0].blocked;if(!blocked)await delay(10);}while(!blocked&&Date.now()<deadline);
      assert.equal(blocked,true);await gate.query("UPDATE membership SET role='viewer' WHERE workspace_id=$1 AND user_id=$2",[workspace,editor]);await gate.query('COMMIT');assert.ok(fail(404)(await observed));
      assert.equal((await pool.query("SELECT 1 FROM analytics_cohort WHERE name='Revoked'")).rowCount,0);
      await assert.rejects(saveCohort(project,editor,editorIntent),fail(404),'A former writer cannot replay their own accepted receipt.');
    }finally{await gate.query('ROLLBACK').catch(()=>{});gate.release();await waiting?.catch(()=>{});await pool.query("UPDATE membership SET role='editor' WHERE workspace_id=$1 AND user_id=$2",[workspace,editor]);}
    console.log('PASS mutation and receipt are atomic; write admission rechecks membership after actual workspace lock wait');

    await pool.query(`INSERT INTO analytics_cohort(id,project_id,name,schema_version,query,created_at,updated_at)
      SELECT gen_random_uuid(),$1,'Page '||n,1,$2,'2026-01-01T00:00:00.123Z','2026-01-01T00:00:00.123Z' FROM generate_series(1,102) n`,[sibling,definition().query]);
    const seen=new Set<string>();let cursor:string|null=null;let pages=0;
    do{const p=await listCohorts(sibling,viewer,new URLSearchParams(cursor?{cursor}:{}));assert.ok(p.items.length<=50);for(const row of p.items){assert.equal(seen.has(row.id),false);seen.add(row.id);}if(!pages){assert.equal(p.items.length,50);assert.ok(p.nextCursor);await assert.rejects(listCohorts(project,owner,new URLSearchParams({cursor:p.nextCursor!})),fail(400));await deleteCohort(sibling,owner,p.items[49].id,{requestId:randomUUID(),revision:1});}cursor=p.nextCursor;pages++;}while(cursor);
    assert.equal(seen.size,102);assert.equal(pages,3,'A deleted page boundary must not skip older rows.');
    for(const q of ['cursor=x','cursor=x&cursor=y','limit=100','from=2026-01-01'])await assert.rejects(listCohorts(project,owner,new URLSearchParams(q)),fail(400));
    console.log('PASS bounded50 pagination with tied timestamps, deleted anchors, scoped cursors and rejected extra filters');

    const identity=(at:string,person='a')=>analyticsIdentity({projectId:project,ip:'192.0.2.1',userAgent:'Cohort fixture',distinctId:person,secret:'cohort-fixture-secret-only',now:new Date(at)})!;
    const a=identity('2026-10-01T09:00:00Z'),aLater=identity('2026-10-02T09:00:00Z'),b=identity('2026-10-01T09:00:00Z','b'),november=identity('2026-11-01T09:00:00Z');
    assert.equal(a.visitor,aLater.visitor);assert.notEqual(a.visit,aLater.visit);assert.notEqual(a.visitor,november.visitor);
    const event=async(path:string,at:string,who:ReturnType<typeof identity>|null,language='en',properties:unknown={},name='page_view')=>{
      if(who)await pool.query('INSERT INTO analytics_visitor(project_id,id,first_seen_at,last_seen_at) VALUES($1,$2,$3,$3) ON CONFLICT(project_id,id) DO NOTHING',[project,who.visitor,at]);
      await pool.query('INSERT INTO event(id,project_id,event_name,path,received_at,visitor_id,visit_id,properties,dimensions) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[randomUUID(),project,name,path,at,who?.visitor??null,who?.visit??null,JSON.stringify(normalizeProperties(properties)),JSON.stringify({language,campaign:{source:''}})]);
    };
    await event('/offer','2026-10-01T09:00:00Z',a);await event('/offer','2026-10-01T10:00:00Z',a);
    await event('/offer','2026-10-01T09:00:00Z',b,'de');await event('/other','2026-10-01T10:00:00Z',b);
    await event('/report','2026-10-02T09:00:00Z',aLater,'en',{value:42});await event('/else','2026-10-02T10:00:00Z',aLater);
    await event('/report','2026-10-02T09:00:00Z',b);await event('/report','2026-11-01T09:00:00Z',november);
    const cohort=(await save(definition(new URLSearchParams({path:'/offer',language:'en'}).toString(),'Qualified visitors'))).item!;
    const reportParams=(saved=cohort,extra:Record<string,string>={})=>new URLSearchParams({from:'2026-10-02',to:'2026-10-02',timeZone:'UTC',path:'/report',groupBy:'path',cohortId:saved.id,cohortRevision:String(saved.revision),...extra});
    const result=await exploreAnalytics(project,viewer,reportParams());
    assert.equal(result.totals.events,1);assert.equal(result.totals.visits,1);assert.equal(result.cohort?.identity.observedMemberKeys,1);assert.equal(result.cohort?.identity.identifiedEvents,2);
    assert.equal(result.cohort?.membership.status,'available');assert.equal(result.cohort?.identity.status,'complete');assert.equal(result.cohort?.range.start,'2026-10-01T00:00:00.000Z');
    assert.equal(result.breakdown.returnedGroupEvents,1);assert.equal(result.daily[0].events,1);assert.equal(result.cohort?.item.id,cohort.id);assert.ok(result.csv.includes('Qualified visitors'));assert.ok(result.csv.includes('signing secret'));
    assert.equal((await exploreAnalytics(project,viewer,reportParams(cohort,{from:'2026-11-01',to:'2026-11-01'}))).totals.events,0,'A rotated monthly key cannot inherit prior membership.');
    assert.equal((await exploreAnalytics(project,viewer,reportParams(cohort,{from:'2026-10-01',to:'2026-10-01',path:'/offer'}))).totals.events,2,'Report dates and actions are independent and membership never multiplies rows.');
    await assert.rejects(exploreAnalytics(foreign,stranger,reportParams()),fail(404));await assert.rejects(exploreAnalytics(sibling,owner,reportParams()),fail(404));
    await assert.rejects(exploreAnalytics(project,viewer,reportParams(cohort,{cohortRevision:'2'})),fail(409));
    await assert.rejects(exploreAnalytics(project,viewer,reportParams(cohort,{cohortId:randomUUID()})),fail(404));
    await assert.rejects(runAnalysis(project,viewer,'funnel',randomUUID(),new URLSearchParams({revision:'1',from:'2026-10-01',to:'2026-10-02',cohortId:cohort.id,cohortRevision:'1'})),fail(400),'Funnel scope must continue rejecting unsupported cohort selection.');
    console.log('PASS same-row qualification, distinct visitor membership across visits, no duplicate report rows, independent scopes, monthly rotation and saved revision/tenant guards');

    await event('/race','2026-10-01T09:00:00Z',a);
    const snapshotCohort=(await save(definition('path=/race','Before concurrent update'))).item!;
    const snapshotClient=await pool.connect(),originalConnect=pool.connect,originalQuery=snapshotClient.query;
    let releaseSnapshot!:()=>void,enteredSnapshot!:()=>void;
    const snapshotHold=new Promise<void>(resolve=>releaseSnapshot=resolve),snapshotEntered=new Promise<void>(resolve=>enteredSnapshot=resolve);
    snapshotClient.query=(function(...args:any[]){
      if(typeof args[0]==='string'&&args[0].startsWith('WITH RECURSIVE')&&args[0].includes('report_scope AS MATERIALIZED')){
        snapshotClient.query=originalQuery;enteredSnapshot();return snapshotHold.then(()=>(originalQuery as any).apply(snapshotClient,args));
      }
      return (originalQuery as any).apply(snapshotClient,args);
    }) as typeof snapshotClient.query;
    pool.connect=(async()=>{pool.connect=originalConnect;return snapshotClient;}) as typeof pool.connect;
    const snapshotResult=exploreAnalytics(project,viewer,reportParams(snapshotCohort));void snapshotResult.catch(()=>{});
    try{
      await Promise.race([snapshotEntered,delay(3000).then(()=>{throw new Error('Report did not reach its held aggregate.');})]);
      await event('/race','2026-10-01T10:00:00Z',b);
      const updated=(await saveCohort(project,owner,{requestId:randomUUID(),revision:1,definition:definition('path=/race','After concurrent update')},snapshotCohort.id)).item!;
      releaseSnapshot();const before=await snapshotResult;
      assert.equal(before.cohort?.item.revision,1);assert.equal(before.cohort?.item.definition.name,'Before concurrent update');assert.equal(before.totals.events,1);assert.equal(before.cohort?.identity.observedMemberKeys,1);
      assert.ok(before.csv.includes('Before concurrent update'));assert.equal(before.csv.includes('After concurrent update'),false);
      const after=await exploreAnalytics(project,viewer,reportParams(updated));assert.equal(after.totals.events,2);assert.equal(after.cohort?.item.revision,2);
      await assert.rejects(exploreAnalytics(project,viewer,reportParams(snapshotCohort)),fail(409));
    }finally{pool.connect=originalConnect;releaseSnapshot();await snapshotResult.catch(()=>{});snapshotClient.query=originalQuery;}
    console.log('PASS actual concurrent definition/event commits cannot mix with an already resolved cohort report or its CSV snapshot');

    await event('/unknown','2026-10-01T09:00:00Z',null);
    const unknown=(await save(definition('path=/unknown'))).item!,empty=(await save(definition('path=/absent'))).item!;
    const unavailable=await exploreAnalytics(project,viewer,reportParams(unknown,{groupBy:'property',groupProperty:'value'}));
    assert.equal(unavailable.coverage.status,'complete');assert.equal(unavailable.cohort?.membership.status,'unavailable');assert.equal(unavailable.cohort?.identity.unidentifiedEvents,1);
    assert.ok(Object.values(unavailable.totals).every(v=>v===null));assert.equal(unavailable.daily[0].events,null);assert.equal(unavailable.numeric,null);assert.equal(unavailable.breakdown.totalGroups,null);assert.deepEqual(unavailable.properties.keys,[]);
    const zero=await exploreAnalytics(project,viewer,reportParams(empty));assert.equal(zero.totals.events,0);assert.equal(zero.cohort?.membership.status,'available');assert.equal(zero.cohort?.identity.observedMemberKeys,0);
    await event('/offer','2026-10-01T11:00:00Z',null);
    const partialIdentity=await exploreAnalytics(project,viewer,reportParams());assert.equal(partialIdentity.totals.events,1);assert.equal(partialIdentity.cohort?.identity.status,'partial');assert.equal(partialIdentity.cohort?.membership.countsAreLowerBounds,true);
    await pool.query("UPDATE project SET analytics_retained_from='2026-10-01T09:30:00Z' WHERE id=$1",[project]);
    const partial=await exploreAnalytics(project,viewer,reportParams());assert.equal(partial.cohort?.coverage.status,'partial');assert.equal(partial.cohort?.identity.identifiedEvents,1);assert.equal(partial.totals.events,1);assert.equal(partial.coverage.status,'complete');
    await pool.query("UPDATE project SET analytics_retained_from='2026-10-02T00:00:00Z' WHERE id=$1",[project]);
    for(const selected of [cohort,empty]){const expired=await exploreAnalytics(project,viewer,reportParams(selected));assert.equal(expired.cohort?.coverage.status,'unavailable');assert.equal(expired.cohort?.membership.status,'unavailable');assert.equal(expired.cohort?.identity.observedMemberKeys,null);assert.equal(expired.totals.events,null);assert.equal(expired.daily[0].events,null);assert.equal(expired.coverage.status,'complete');}
    await pool.query('UPDATE project SET analytics_retained_from=NULL WHERE id=$1',[project]);
    console.log('PASS unavailable identity and expired qualification redact all report aggregates; real empty qualification remains zero; partial retained evidence stays labelled as lower bounds');

    for(const [value,who,path]of [[0,a,'/literal%_, 🐎'],[null,b,'/literalXX, 🐎'],[false,b,'/literal%_, 🐎'],[undefined,b,'/literal%_, 🐎']] as const)await event(path,'2026-10-01T12:00:00Z',who,'en',value===undefined?{}:{value});
    for(const [type,value]of [['number','0'],['boolean','false'],['missing',undefined],['null','null']] as const){
      const fields=new URLSearchParams({path:type==='null'?'/literalXX, 🐎':'/literal%_, 🐎',campaignSource:'',propertyKey:'value',propertyType:type});if(value!==undefined)fields.set('propertyValue',value);
      const typed=(await save(definition(fields.toString()))).item!,actual=await exploreAnalytics(project,viewer,reportParams(typed));
      assert.equal(actual.totals.events,1);assert.equal(actual.cohort?.identity.observedMemberKeys,1);
    }
    console.log('PASS literal commas/wildcards/Unicode, exact empty campaign, typed zero/false/null and missing qualification filters');
    await event('/event-only','2026-10-01T12:00:00Z',a,'en',{},'signup');
    const eventCohort=(await save(definition('eventName=signup&kind=custom'))).item!;
    assert.equal((await exploreAnalytics(project,viewer,reportParams(eventCohort))).totals.events,1);
    const contradictory=(await save(definition('eventName=signup&kind=pageviews'))).item!;
    assert.equal((await exploreAnalytics(project,viewer,reportParams(contradictory))).totals.events,0,'The saved kind is preserved, never inferred from an action.');
    const deadlineGate=await pool.connect();
    try{await deadlineGate.query('BEGIN');await deadlineGate.query('LOCK TABLE event IN ACCESS EXCLUSIVE MODE');await assert.rejects(exploreAnalytics(project,viewer,reportParams()),fail(503));}
    finally{await deadlineGate.query('ROLLBACK');deadlineGate.release();}
    assert.equal((await exploreAnalytics(project,viewer,reportParams())).totals.events,1);
    console.log('PASS explicit event action/kind semantics, real PostgreSQL statement deadline, and successful recovery');

    const login=async(uid:string)=>{const response=await handleApi(new Request(config.appUrl+'/api/auth/sign-in/email',{method:'POST',headers:{origin:config.appUrl,'content-type':'application/json'},body:JSON.stringify({email:uid+'@cohorts.test',password})}));assert.equal(response.status,200);return response.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ');};
    const cookie=await login(owner),viewerCookie=await login(viewer),endpoint=config.appUrl+'/api/projects/'+project+'/cohorts';
    const http=async(method:string,path='',body?:unknown,who=cookie,origin=config.appUrl)=>handleApi(new Request(endpoint+path,{method,headers:{cookie:who,origin,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})}));
    const request={requestId:randomUUID(),definition:definition('path=/http','HTTP')};const created=await http('POST','',request);assert.equal(created.status,200);assert.equal(created.headers.get('cache-control'),'no-store');const createdBody=await created.json();assert.equal(createdBody.item.projectId,project);
    assert.equal((await http('GET','/'+createdBody.item.id,undefined,viewerCookie)).status,200);assert.equal((await http('POST','',request,viewerCookie)).status,404);assert.equal((await http('POST','',request,cookie,'https://foreign.example')).status,403);
    assert.equal((await http('GET','',undefined,'')).status,401);assert.equal((await http('DELETE','/'+createdBody.item.id)).status,405);assert.equal((await http('GET','/'+createdBody.item.id+'?cursor=x')).status,400);assert.equal((await http('POST','?x=1',request)).status,400);
    assert.equal((await http('POST','',{...request,padding:'x'.repeat(33000)})).status,413);
    const token=await createApiKey(workspace,owner,{name:'Cohort fixture',scopes:['analytics:read']});
    assert.equal((await handleApi(new Request(endpoint,{headers:{authorization:'Bearer '+token.token}}))).status,403);
    const scoped=await createApiKey(workspace,owner,{name:'Cohort reader',scopes:['segments:read']}),bearerList=await handleApi(new Request(endpoint,{headers:{authorization:'Bearer '+scoped.token}}));assert.equal(bearerList.status,200);assert.deepEqual(await bearerList.json(),await(await http('GET','')).json());
    assert.equal((await handleApi(new Request(endpoint+'/'+createdBody.item.id,{headers:{authorization:'Bearer '+scoped.token}}))).status,200);assert.equal((await handleApi(new Request(endpoint,{method:'POST',headers:{authorization:'Bearer '+scoped.token,'content-type':'application/json'},body:JSON.stringify(request)}))).status,403,'segments:read admits no write');
    const longDefinition=definition(new URLSearchParams({path:'中'.repeat(1000)}).toString(),'Large valid filter');assert.ok(JSON.stringify(longDefinition).length>8192);assert.equal((await http('POST','',{requestId:randomUUID(),definition:longDefinition})).status,200);
    const updateHttp=await http('POST','/'+createdBody.item.id+'/update',{requestId:randomUUID(),revision:1,definition:definition('path=/changed','HTTP changed')});assert.equal(updateHttp.status,200);assert.equal((await updateHttp.json()).item.revision,2);
    const deleteHttp={requestId:randomUUID(),revision:2};assert.equal((await http('POST','/'+createdBody.item.id+'/delete',deleteHttp)).status,200);const replayHttp=await http('POST','',request);assert.deepEqual(await replayHttp.json(),{role:'owner',item:null,deleted:true,replayed:true});
    console.log('PASS actual session/Origin/API-key/body-cap/method/query and CRUD routes; valid definitions larger than8KiB remain usable');

    let release!:()=>void,entered!:()=>void;const hold=new Promise<void>(r=>release=r),reading=new Promise<void>(r=>entered=r);
    const delayedBody={requestId:randomUUID(),definition:definition('path=/held','Held')};
    const held=new Request(endpoint,{method:'POST',headers:{cookie,origin:config.appUrl,'content-type':'application/json'},body:new ReadableStream({async start(controller){entered();await hold;controller.enqueue(new TextEncoder().encode(JSON.stringify(delayedBody)));controller.close();}}),duplex:'half'} as RequestInit);
    const response=handleApi(held);await reading;await pool.query("UPDATE membership SET role='viewer' WHERE workspace_id=$1 AND user_id=$2",[workspace,owner]);release();assert.equal((await response).status,404);
    await pool.query("UPDATE membership SET role='owner' WHERE workspace_id=$1 AND user_id=$2",[workspace,owner]);
    const rateDeadline=(await pool.query("SELECT to_timestamp((floor(extract(epoch FROM clock_timestamp())/60)+2)*60) AS at")).rows[0].at;
    await pool.query("INSERT INTO request_limit(key,minute,count) SELECT $1,floor(extract(epoch FROM now())/60)+n,30 FROM generate_series(0,1) n ON CONFLICT(key,minute) DO UPDATE SET count=30",['cohorts:'+owner+':write']);
    assert.equal((await http('POST','',{requestId:randomUUID(),definition:definition('','Rate limited')})).status,429);
    assert.equal((await pool.query('SELECT clock_timestamp()<$1 AS within_bound',[rateDeadline])).rows[0].within_bound,true,'The bounded rate check must complete within its two seeded real buckets.');
    assert.equal((await pool.query("SELECT 1 FROM analytics_cohort WHERE name IN ('Held','Rate limited')")).rowCount,0);assert.equal(outbound,0);
    await pool.query('DELETE FROM membership WHERE workspace_id=$1 AND user_id=$2',[workspace,viewer]);assert.equal((await http('GET','',undefined,viewerCookie)).status,404);
    console.log('PASS held-body current-role revocation, write-rate rejection and subsequent reader revocation; zero provider calls');
    assert.ok((await all()).items.length>0);
  }finally{globalThis.fetch=savedFetch;}
}
if(import.meta.main){try{await runCohortChecks();}finally{await closeDatabase();}}
