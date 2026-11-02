import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {hashPassword} from 'better-auth/crypto';
import {getConfig} from '../src/server/config.ts';
import {assertSchema,getDatabase,closeDatabase} from '../src/server/db.ts';
import {getBoss,startWorker,stopJobs} from '../src/server/jobs.ts';
import {handleApi} from '../src/server/api.ts';
import {createApiKey} from '../src/server/api-keys.ts';
import {saveProviderRequestControls,saveProvider,revokeProvider} from '../src/server/providers.ts';
import {reserveRequest,cancelRequest,dispatchRequest} from '../src/server/provider-requests.ts';
import {getRankTracker,changeRankKeywords} from '../src/server/rank-tracking.ts';
import {prepareRankCheck,startRankCheck,getRankRun,rankQueue} from '../src/server/rank-execution.ts';
import {executeRankDispatch,pollRankDispatch,reconcileRankJobs,cancelRankRun,rankPollQueue,rankDispatchSnapshot,applyReconciledRankOutcome} from '../src/server/rank-worker.ts';
import {rankGroupTasks,readRankPlan} from '../src/server/rank-execution-plan.ts';
import {parseRankReconciliation} from '../src/server/rank-provider-outcome.ts';
import {rankSerpEndpoints} from '../src/server/rank-serp-input.ts';
import {keywordAccountEndpoint} from '../src/server/keyword-research-input.ts';
import {dataforseoRefusalMessage} from '../src/server/dataforseo-transport.ts';

const failed=(status:number)=>(error:unknown)=>!!error&&typeof error==='object'&&'status'in error&&error.status===status;
const reached=(promise:Promise<void>)=>Promise.race([promise,new Promise<never>((_,reject)=>{const timer=setTimeout(()=>reject(new Error('Synthetic transport was not reached.')),5000);timer.unref();})]);
function latch(){let enter!:()=>void,release!:()=>void;const entered=new Promise<void>(r=>enter=r),wait=new Promise<void>(r=>release=r);return {entered,release,hold:async()=>{enter();await wait;}};}
type Fixture={workspace:string;project:string;tracker:string;connection:string;run:string;dispatches:string[]};

export async function runRankWorkerChecks(){
  assert.equal(process.env.TEN98_INTEGRATION_TEST,'1');assert.equal(process.env.TEN98_RANK_WORKER_TEST,'1');
  const config=getConfig(),url=new URL(config.databaseUrl),loopback=['localhost','127.0.0.1','[::1]'];
  const ci=process.env.GITHUB_ACTIONS==='true'&&process.env.TEN98_ISOLATED_CI_DATABASE==='1'&&url.pathname==='/ten98_rank_worker_ci';
  assert.ok(loopback.includes(url.hostname)&&loopback.includes(new URL(config.appUrl).hostname));assert.equal(url.port,ci?'5432':'55501');assert.match(url.pathname,/^\/ten98_rank_worker_[a-z0-9_]+$/);assert.equal(url.search,'');assert.equal(url.hash,'');
  await assertSchema();const pool=getDatabase().pool;assert.equal((await pool.query('SELECT count(*)::int AS n FROM workspace')).rows[0].n,0,'Use a newly created migrated owned test database.');
  const owner=randomUUID(),editor=randomUUID(),viewer=randomUUID(),priorFetch=globalThis.fetch;let unexpected=0;
  globalThis.fetch=async()=>{unexpected++;throw new Error('External requests forbidden in rank worker acceptance.');};
  function transport(){
    const state={posts:0,free:0,gets:0,account:'rank-worker@integration.test',postMode:'ok' as 'ok'|'lost'|'bad'|'malformed'|'refusal'|'refusal_task',getMode:'ok' as 'ok'|'pending'|'lost'|'foreign',accountHook:null as null|(()=>Promise<void>),postHook:null as null|(()=>Promise<void>),getHook:null as null|(()=>Promise<void>),rawUnsafe:false,observedAt:null as null|string,tasks:new Map<string,any>()};
    const result=(data:any)=>({keyword:decodeURIComponent(data.keyword.replace(/\+/g,' ')),type:'organic',location_code:data.location_code,language_code:data.language_code,datetime:state.observedAt??new Date().toISOString(),pages_count:1,items_count:1,item_types:['organic'],items:[{type:'organic',rank_group:1,rank_absolute:1,page:1,url:'https://example.com/result',domain:'example.com',title:state.rawUnsafe?'bad\0title':'Synthetic result'}]});
    const send:typeof fetch=async(address,options)=>{
      assert.equal(options?.redirect,'error');assert.equal(options?.credentials,'omit');const target=String(address);
      if(target===keywordAccountEndpoint){state.free++;if(state.accountHook)await state.accountHook();
        return Response.json({status_code:20000,tasks_count:1,tasks_error:0,tasks:[{status_code:20000,path:['v3','appendix','user_data'],result_count:1,result:[{login:state.account}]}]});}
      if(target===rankSerpEndpoints.live||target===rankSerpEndpoints.queued){assert.equal(options?.method,'POST');state.posts++;const payload=JSON.parse(options?.body as string),queued=target===rankSerpEndpoints.queued;
        const tasks=payload.map((data:any)=>{const id=randomUUID(),task={id,status_code:queued?20100:20000,path:queued?['v3','serp','google','organic','task_post']:['v3','serp','google','organic','live','advanced'],data:{...data,api:'serp',se:'google',se_type:'organic',function:queued?'task_post':'live'},result_count:queued?0:1,result:queued?null:[result(data)]};state.tasks.set(id,task);return task;});
        if(state.postHook)await state.postHook();if(state.postMode==='lost')throw new Error('Synthetic lost acknowledgement.');if(state.postMode==='bad')tasks[0].data.tag='foreign';
        if(state.postMode==='malformed')return Response.json({status_code:20000,tasks_count:1,tasks:{}});
        // A provider refusal may cover the whole request or only one task in a batch.
        if(state.postMode==='refusal')return Response.json({status_code:40210,status_message:'Synthetic provider refusal.',tasks_count:0,tasks_error:0,tasks:null});
        if(state.postMode==='refusal_task')Object.assign(tasks[1],{status_code:40210});
        return Response.json({status_code:20000,tasks_count:tasks.length,tasks});
      }
      assert.ok(target.startsWith(rankSerpEndpoints.task),'No fallback or metadata endpoint is implicit in a worker.');assert.equal(options?.method,'GET');state.gets++;
      const id=target.slice(rankSerpEndpoints.task.length),saved=state.tasks.get(id);assert.ok(saved,'Only a known task ID may be retrieved.');
      if(state.getHook)await state.getHook();if(state.getMode==='lost')throw new Error('Synthetic missing GET.');const pending=state.getMode==='pending';
      return Response.json({status_code:20000,tasks_count:1,tasks:[{...saved,status_code:pending?40602:20000,path:['v3','serp','google','organic','task_get','advanced',id],data:{...saved.data,function:'task_get',...(state.getMode==='foreign'?{tag:'foreign-task-tag'}:{})},result_count:pending?0:1,result:pending?null:[result(saved.data)]}]});
    };return {state,send};
  }
  async function fixture(net:ReturnType<typeof transport>,method:'live'|'queued'='live',count=1,user=owner):Promise<Fixture>{
    const f={workspace:randomUUID(),project:randomUUID(),tracker:randomUUID(),connection:'',run:'',dispatches:[] as string[]};
    await pool.query("INSERT INTO workspace(id,name) VALUES($1,'Rank worker fixture')",[f.workspace]);
    for(const [uid,role]of [[owner,'owner'],[editor,'editor'],[viewer,'viewer']])await pool.query('INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,$3)',[f.workspace,uid,role]);
    await pool.query("INSERT INTO project(id,workspace_id,name,origin,public_key,retention_next_run_at) VALUES($1,$2,'Rank worker','https://example.com',$3,'infinity')",[f.project,f.workspace,randomUUID()]);
    f.connection=(await saveProvider(f.workspace,owner,{provider:'dataforseo',name:'Synthetic account',credentials:{login:'rank-worker@integration.test',password:'never-live'}})).connection.id;await saveProviderRequestControls(f.workspace,owner,{paused:false});
    await pool.query(`INSERT INTO rank_config(id,workspace_id,project_id,name,target_domain,location_code,location_name,location_type,country_location_code,country_iso,language_code,language_name,catalog_verified_at,devices,serp_depth,max_crawl_pages) VALUES($1,$2,$3,'Rank worker','example.com',2840,'US','Country',2840,'US','en','English',clock_timestamp(),'desktop',100,1)`,[f.tracker,f.workspace,f.project]);
    await changeRankKeywords(f.project,owner,f.tracker,'add',{requestId:randomUUID(),revision:1,keywords:Array.from({length:count},(_,i)=>'C++ %20 '+i),matchCase:true});
    const t=(await getRankTracker(f.project,owner,f.tracker)).tracker,q=await prepareRankCheck(f.project,user,f.tracker,{requestId:randomUUID(),connectionId:f.connection,revision:t.revision,keywordsRevision:t.keywordsRevision,method},net.send);assert.ok(q);f.run=q.run.id;await startRankCheck(f.project,user,f.run,{requestId:randomUUID()});
    f.dispatches=(await pool.query('SELECT id FROM rank_dispatch WHERE run_id=$1 ORDER BY ordinal',[f.run])).rows.map(row=>row.id);return f;
  }
  const requestActivity=async(id:string)=>{const row=(await pool.query('SELECT status,estimate_micros,actual_micros,budget_month,provider_reference FROM provider_request WHERE id=$1',[id])).rows[0];assert.ok(row);assert.equal(row.estimate_micros,null);assert.equal(row.actual_micros,null);assert.equal(row.budget_month,null);return row;};
  const dispatch=async(id:string)=>(await pool.query('SELECT *,generation::text FROM rank_dispatch WHERE id=$1',[id])).rows[0];
  const paused=async(f:Fixture)=>(await pool.query('SELECT COALESCE((SELECT paused FROM workspace_provider_control WHERE workspace_id=$1),false) AS paused',[f.workspace])).rows[0].paused;
  const tasks=async(f:Fixture)=>(await pool.query('SELECT * FROM rank_task WHERE run_id=$1 ORDER BY id',[f.run])).rows;
  async function role(f:Fixture,uid:string,value:string){const c=await pool.connect();try{await c.query('BEGIN');await c.query('SELECT id FROM workspace WHERE id=$1 FOR UPDATE',[f.workspace]);await c.query('UPDATE membership SET role=$3 WHERE workspace_id=$1 AND user_id=$2',[f.workspace,uid,value]);await c.query('COMMIT');}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}
  async function recover(f:Fixture,net:ReturnType<typeof transport>,connectionId=f.connection){
    await pool.query("UPDATE rank_dispatch SET dispatched_at=clock_timestamp()-interval '3 minutes' WHERE id=$1",[f.dispatches[0]]);
    const c=await pool.connect();try{await c.query('BEGIN');await c.query('SELECT id FROM workspace WHERE id=$1 FOR UPDATE',[f.workspace]);await c.query('SELECT id FROM project WHERE id=$1 FOR UPDATE',[f.project]);
      const row=await rankDispatchSnapshot(c,f.dispatches[0]);assert.ok(row);const plan=readRankPlan(row.run_request,row.run_hash),expected=rankGroupTasks(plan,plan.groups[row.ordinal]);const stored=await tasks(f);
      for(const item of expected){const known=stored.find(s=>s.id===item.id)?.provider_task_id;if(known)Object.assign(item,{providerTaskId:known});}
      const stamp=(time:number)=>new Date(time).toISOString().slice(0,19).replace('T',' ')+' +00:00',rows=[...net.state.tasks.values()].map(task=>({id:task.id,url:row.method==='live'?'v3/serp/google/organic/live/advanced':'v3/serp/google/organic/task_post',metadata:task.data,status:'20000',datetime_posted:stamp(row.dispatched_at!.getTime())}));
      const response={httpStatus:200,body:{status_code:20000,tasks_count:1,tasks:[{status_code:20000,path:['v3','serp','id_list'],data:{datetime_from:stamp(row.dispatched_at!.getTime()-60000),datetime_to:stamp(row.dispatched_at!.getTime()+120000),offset:0,limit:1000,sort:'asc',include_metadata:true},result_count:rows.length,result:rows}]}};
      const outcome=parseRankReconciliation(response,row.method,expected,row.dispatched_at!);assert.equal(outcome.known,true);assert.ok(outcome.tasks.every(task=>task.known&&task.providerTaskId));
      const version=(await c.query('SELECT revision FROM provider_connection WHERE id=$1',[connectionId])).rows[0].revision;
      await applyReconciledRankOutcome(c,row.id,row.generation,outcome,{connectionId,connectionRevision:version,approvedBy:owner});await c.query('COMMIT');
    }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
  }
  try{
    for(const id of [owner,editor,viewer])await pool.query('INSERT INTO "user"(id,name,email) VALUES($1,\'Rank worker\',$2)',[id,id+'@rank-worker.integration.test']);
    const boss=await getBoss();await boss.createQueue(rankPollQueue);
    const live=transport(),f=await fixture(live,'live',1,editor),held=latch();live.state.postHook=held.hold;
    const running=executeRankDispatch(f.dispatches[0],live.send);try{await reached(held.entered);assert.equal((await requestActivity(f.dispatches[0])).status,'dispatched');await executeRankDispatch(f.dispatches[0],live.send);assert.equal(live.state.posts,1);await role(f,editor,'viewer');}finally{held.release();}await running;
    assert.equal((await requestActivity(f.dispatches[0])).actual_micros,null);assert.equal((await getRankRun(f.project,owner,f.run)).run.status,'completed');assert.equal((await tasks(f))[0].result_status,'ranked');await executeRankDispatch(f.dispatches[0],live.send);assert.equal(live.state.posts,1);
    console.log('PASS persisted-before-send Live dispatch, duplicate fencing and settlement after initiating user loses access');

    for(const mutation of ['role','legacy_preparation','account','credentials','keywords','pause'] as const){
      const net=transport(),f=await fixture(net,'live',1,editor),gate=latch();net.state.accountHook=gate.hold;const run=executeRankDispatch(f.dispatches[0],net.send);
      try{await reached(gate.entered);if(mutation==='role')await role(f,editor,'viewer');if(mutation==='legacy_preparation')await pool.query('UPDATE rank_run SET request_version=0 WHERE id=$1',[f.run]);if(mutation==='account')net.state.account='other@integration.test';if(mutation==='credentials')await revokeProvider(f.workspace,owner,f.connection);if(mutation==='pause')await saveProviderRequestControls(f.workspace,owner,{paused:true});if(mutation==='keywords'){const d=await getRankTracker(f.project,owner,f.tracker);await changeRankKeywords(f.project,owner,f.tracker,'remove',{requestId:randomUUID(),revision:d.tracker.authoredRevision,keywordIds:[d.keywords[0].id]});}}finally{gate.release();}await run;
      assert.equal(net.state.posts,0,mutation);assert.equal((await requestActivity(f.dispatches[0])).status,'cancelled',mutation);
    }
    const aged=transport(),age=await fixture(aged);await pool.query("UPDATE rank_run SET created_at=clock_timestamp()-interval '10 minutes',expires_at=clock_timestamp()-interval '1 minute' WHERE id=$1",[age.run]);await executeRankDispatch(age.dispatches[0],aged.send);assert.equal(aged.state.posts,1);assert.equal((await requestActivity(age.dispatches[0])).status,'settled');
    console.log('PASS fresh scope, account, credentials, manual stop and legacy-preparation checks; explicitly started work outlives preparation expiry');

    const queued=transport(),q=await fixture(queued,'queued',2);await executeRankDispatch(q.dispatches[0],queued.send);assert.equal((await requestActivity(q.dispatches[0])).status,'settled');assert.equal((await getRankRun(q.project,owner,q.run)).run.status,'waiting');
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM pgboss.job WHERE name=$1 AND data->>'dispatchId'=$2",[rankPollQueue,q.dispatches[0]])).rows[0].n,1);
    queued.state.getMode='pending';await pollRankDispatch(q.dispatches[0],undefined,queued.send);assert.ok((await tasks(q)).every(t=>t.final_micros===null&&t.provisional_micros===null&&t.request_evidence?.known===true&&t.result_status==='pending'));
    queued.state.getMode='ok';await role(q,owner,'viewer');await pollRankDispatch(q.dispatches[0],undefined,queued.send);await pollRankDispatch(q.dispatches[0],undefined,queued.send);await role(q,owner,'owner');
    assert.equal((await requestActivity(q.dispatches[0])).actual_micros,null);assert.equal((await getRankRun(q.project,owner,q.run)).run.status,'completed');assert.equal(queued.state.posts,1);assert.equal(queued.state.gets,3);
    console.log('PASS queued acknowledgement, durable one-task free collection, pending evidence and completed observations after role change');

    // A lost POST keeps its original request recoverable while independent reservations remain available.
    const lost=transport(),u=await fixture(lost,'queued',2);lost.state.postMode='lost';await executeRankDispatch(u.dispatches[0],lost.send);assert.equal((await requestActivity(u.dispatches[0])).status,'uncertain');assert.equal(await paused(u),false);await executeRankDispatch(u.dispatches[0],lost.send);await reconcileRankJobs();assert.equal(lost.state.posts,1);
    const independent=await reserveRequest(u.workspace,owner,{connectionId:u.connection,requestKey:randomUUID(),operation:'rank.queued',inputHash:'0'.repeat(64)});assert.equal(independent.created,true);await cancelRequest(u.workspace,owner,independent.id);assert.equal((await requestActivity(independent.id)).status,'cancelled');await assert.rejects(dispatchRequest(u.workspace,owner,u.dispatches[0]),failed(409));await executeRankDispatch(u.dispatches[0],lost.send);assert.equal((await requestActivity(u.dispatches[0])).status,'uncertain');assert.equal((await requestActivity(u.dispatches[0])).actual_micros,null);assert.equal(lost.state.posts,1);
    const replacement=(await saveProvider(u.workspace,owner,{provider:'dataforseo',name:'Replacement same account',credentials:{login:'rank-worker@integration.test',password:'replacement-never-live'}})).connection.id;await revokeProvider(u.workspace,owner,u.connection);
    await recover(u,lost,replacement);assert.equal((await requestActivity(u.dispatches[0])).actual_micros,null);assert.equal((await dispatch(u.dispatches[0])).phase,'collecting');
    await pollRankDispatch(u.dispatches[0],undefined,lost.send);await pollRankDispatch(u.dispatches[0],undefined,lost.send);assert.equal((await getRankRun(u.project,owner,u.run)).run.status,'completed');assert.equal(lost.state.posts,1);assert.equal(await paused(u),false);
    console.log('PASS unknown acceptance never retries POST; explicit same-account replacement credentials recover task identity and observations');

    const cancelled=transport(),c=await fixture(cancelled,'live',2,editor);const cancelBody={requestId:randomUUID()};await assert.rejects(cancelRankRun(c.project,viewer,c.run,cancelBody),failed(404));await cancelRankRun(c.project,editor,c.run,cancelBody);await cancelRankRun(c.project,editor,c.run,cancelBody);
    for(const id of c.dispatches)await executeRankDispatch(id,cancelled.send);assert.equal(cancelled.state.posts,0);assert.ok((await tasks(c)).every(t=>t.result_status==='cancelled'));assert.equal((await getRankRun(c.project,owner,c.run)).run.status,'cancelled');
    const partial=transport(),p=await fixture(partial,'live',2);await executeRankDispatch(p.dispatches[0],partial.send);await cancelRankRun(p.project,owner,p.run,{requestId:randomUUID()});assert.equal((await requestActivity(p.dispatches[0])).status,'settled');assert.equal((await requestActivity(p.dispatches[1])).status,'cancelled');assert.equal((await getRankRun(p.project,owner,p.run)).run.status,'partial');
    console.log('PASS current-role cancellation releases only reserved work and preserves completed requests');

    const stale=transport(),s=await fixture(stale,'queued');await executeRankDispatch(s.dispatches[0],stale.send);const original=await dispatch(s.dispatches[0]);
    await pool.query("UPDATE pgboss.job SET state='completed' WHERE name=$1 AND data->>'dispatchId'=$2",[rankPollQueue,s.dispatches[0]]);await pool.query("UPDATE rank_dispatch SET next_poll_at=clock_timestamp()-interval '1 second' WHERE id=$1",[s.dispatches[0]]);await reconcileRankJobs();
    assert.notEqual((await dispatch(s.dispatches[0])).generation,original.generation);await pollRankDispatch(s.dispatches[0],original.generation,stale.send);assert.equal(stale.state.gets,0);
    const gate=latch();stale.state.getHook=gate.hold;const old=pollRankDispatch(s.dispatches[0],undefined,stale.send);try{await reached(gate.entered);await pool.query("UPDATE rank_dispatch SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[s.dispatches[0]]);await reconcileRankJobs();}finally{gate.release();}await old;
    assert.equal((await requestActivity(s.dispatches[0])).status,'settled');stale.state.getHook=null;await pollRankDispatch(s.dispatches[0],undefined,stale.send);assert.equal((await requestActivity(s.dispatches[0])).status,'settled');assert.equal(stale.state.posts,1);
    console.log('PASS missing poll repair and generation fencing discard late free responses without another POST');

    const mixed=transport(),m=await fixture(mixed,'queued',2);await executeRankDispatch(m.dispatches[0],mixed.send);await pollRankDispatch(m.dispatches[0],undefined,mixed.send);const measured=(await tasks(m)).find(t=>t.result_status==='ranked')!;assert.ok(measured);
    mixed.state.getMode='lost';await pollRankDispatch(m.dispatches[0],undefined,mixed.send);assert.equal((await requestActivity(m.dispatches[0])).status,'settled');mixed.state.getMode='ok';await recover(m,mixed);
    const preserved=(await tasks(m)).find(t=>t.id===measured.id)!;assert.equal(preserved.position,measured.position);assert.equal(preserved.observed_at.toISOString(),measured.observed_at.toISOString());assert.equal(preserved.retrieved_at.toISOString(),measured.retrieved_at.toISOString());assert.deepEqual(preserved.raw_evidence,measured.raw_evidence);await pollRankDispatch(m.dispatches[0],undefined,mixed.send);assert.equal((await getRankRun(m.project,owner,m.run)).run.status,'completed');assert.deepEqual((await tasks(m)).find(t=>t.id===measured.id)!.raw_evidence,measured.raw_evidence);
    const known=transport(),k=await fixture(known,'queued');known.state.postMode='lost';await executeRankDispatch(k.dispatches[0],known.send);await recover(k,known);assert.equal(await paused(k),false);
    const finalProof=(await tasks(k))[0].request_evidence;known.state.getMode='pending';await pollRankDispatch(k.dispatches[0],undefined,known.send);const pendingProof=(await tasks(k))[0].request_evidence;assert.equal(pendingProof.known,true);assert.equal(pendingProof.state,'pending');assert.equal(pendingProof.providerTaskId,finalProof.providerTaskId);
    known.state.getMode='lost';await pollRankDispatch(k.dispatches[0],undefined,known.send);assert.equal((await requestActivity(k.dispatches[0])).status,'settled');assert.equal(await paused(k),false);assert.equal((await dispatch(k.dispatches[0])).phase,'finished');assert.deepEqual((await tasks(k))[0].request_evidence,pendingProof);
    known.state.getMode='ok';await recover(k,known);await pollRankDispatch(k.dispatches[0],undefined,known.send);assert.equal((await getRankRun(k.project,owner,k.run)).run.status,'completed');assert.equal(known.state.posts,1);assert.equal(await paused(k),false);
    console.log('PASS metadata-only recovery preserves proven measurements; unavailable free results do not make a known request uncertain');

    const conflict=transport(),cf=await fixture(conflict,'queued');conflict.state.postMode='lost';await executeRankDispatch(cf.dispatches[0],conflict.send);await recover(cf,conflict);assert.equal(await paused(cf),false);const receipt=(await tasks(cf))[0];conflict.state.getMode='foreign';
    await pollRankDispatch(cf.dispatches[0],undefined,conflict.send);assert.equal((await requestActivity(cf.dispatches[0])).actual_micros,null);assert.equal((await dispatch(cf.dispatches[0])).phase,'collecting');assert.equal(await paused(cf),false,'A foreign response cannot change the request identity or pause unrelated work.');assert.deepEqual((await tasks(cf))[0].request_evidence,receipt.request_evidence);assert.equal((await tasks(cf))[0].provider_task_id,receipt.provider_task_id);assert.equal((await tasks(cf))[0].final_charge_at,null);assert.equal(conflict.state.posts,1);assert.equal((await tasks(cf))[0].position,null);conflict.state.getMode='ok';await pollRankDispatch(cf.dispatches[0],undefined,conflict.send);assert.equal((await getRankRun(cf.project,owner,cf.run)).run.status,'completed');assert.equal(conflict.state.posts,1);
    const malformed=transport(),mf=await fixture(malformed);malformed.state.postMode='malformed';await executeRankDispatch(mf.dispatches[0],malformed.send);assert.equal((await requestActivity(mf.dispatches[0])).status,'uncertain');assert.equal(malformed.state.posts,1);
    console.log('PASS foreign task responses preserve prior request evidence and identity; malformed acknowledgements remain uncertain');

    // Owner decision D3: a 40210 task_post refusal is a known failed request with generic provider text; nothing becomes uncertain or pauses.
    const refused=transport(),w=await fixture(refused,'queued',2);refused.state.postMode='refusal';await executeRankDispatch(w.dispatches[0],refused.send);await executeRankDispatch(w.dispatches[0],refused.send);
    const refusedDispatch=await dispatch(w.dispatches[0]);assert.equal(refusedDispatch.phase,'finished');assert.equal(refusedDispatch.diagnostic,dataforseoRefusalMessage.provider);
    assert.equal((await requestActivity(w.dispatches[0])).status,'settled');assert.equal((await requestActivity(w.dispatches[0])).actual_micros,null);
    assert.deepEqual((await tasks(w)).map(t=>[t.result_status,t.final_micros,t.diagnostic]),[['failed',null,dataforseoRefusalMessage.provider],['failed',null,dataforseoRefusalMessage.provider]]);
    assert.equal((await getRankRun(w.project,owner,w.run)).run.status,'failed');assert.equal(await paused(w),false);assert.equal(refused.state.posts,1);assert.equal(refused.state.gets,0);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM pgboss.job WHERE name=$1 AND data->>'dispatchId'=$2",[rankPollQueue,w.dispatches[0]])).rows[0].n,0);
    assert.equal((await reserveRequest(w.workspace,owner,{connectionId:w.connection,requestKey:randomUUID(),operation:'rank.queued',inputHash:'0'.repeat(64)})).status,'reserved');
    const refusedBatch=transport(),wb=await fixture(refusedBatch,'queued',2);refusedBatch.state.postMode='refusal_task';await executeRankDispatch(wb.dispatches[0],refusedBatch.send);
    assert.equal((await requestActivity(wb.dispatches[0])).status,'settled');assert.equal((await dispatch(wb.dispatches[0])).phase,'collecting');
    const batchTasks=await tasks(wb),refusedTask=batchTasks.find(t=>t.result_status==='failed');assert.ok(refusedTask);assert.equal(batchTasks.filter(t=>t.result_status==='pending'&&t.request_evidence?.known===true).length,1);
    assert.equal(refusedTask.final_micros,null);assert.equal(refusedTask.provider_status,40210);assert.equal(refusedTask.diagnostic,dataforseoRefusalMessage.provider);
    await pollRankDispatch(wb.dispatches[0],undefined,refusedBatch.send);assert.equal(refusedBatch.state.gets,1);assert.equal(refusedBatch.state.posts,1);
    assert.equal((await requestActivity(wb.dispatches[0])).status,'settled');assert.equal((await requestActivity(wb.dispatches[0])).actual_micros,null);assert.equal((await dispatch(wb.dispatches[0])).phase,'finished');
    assert.equal((await getRankRun(wb.project,owner,wb.run)).run.status,'partial');assert.equal(await paused(wb),false);
    console.log('PASS known provider refusals finish failed, leave financial columns NULL and preserve sibling result collection');

    const rebound=transport(),rp=await fixture(rebound,'queued');rebound.state.postMode='lost';await executeRankDispatch(rp.dispatches[0],rebound.send);await recover(rp,rebound);assert.equal(await paused(rp),false);rebound.state.account='changed-collection@integration.test';
    await pollRankDispatch(rp.dispatches[0],undefined,rebound.send);assert.equal(rebound.state.gets,0);assert.equal(rebound.state.posts,1);assert.equal((await requestActivity(rp.dispatches[0])).status,'settled');assert.equal(await paused(rp),false);assert.equal((await dispatch(rp.dispatches[0])).phase,'finished');
    console.log('PASS changed collection account cannot authorize a GET or erase a known request');

    const expiry=transport(),e=await fixture(expiry),gate2=latch();expiry.state.postHook=gate2.hold;const pending=executeRankDispatch(e.dispatches[0],expiry.send);
    try{await reached(gate2.entered);await pool.query("UPDATE rank_run SET started_at=clock_timestamp()-interval '400 days',created_at=clock_timestamp()-interval '400 days' WHERE id=$1",[e.run]);}finally{gate2.release();}await pending;
    const expired=(await tasks(e))[0];assert.equal((await requestActivity(e.dispatches[0])).status,'settled');assert.equal(expired.result_status,'ranked');assert.ok(expired.raw_expired_at&&expired.data_expired_at);assert.equal(expired.position,null);assert.equal(expired.checked_depth,null);assert.equal(expired.raw_evidence,null);assert.equal((await dispatch(e.dispatches[0])).phase,'finished');assert.equal((await getRankRun(e.project,owner,e.run)).run.status,'completed');
    const unsafe=transport(),n=await fixture(unsafe);unsafe.state.rawUnsafe=true;await executeRankDispatch(n.dispatches[0],unsafe.send);assert.equal((await requestActivity(n.dispatches[0])).status,'settled');assert.equal((await tasks(n))[0].raw_evidence,null);
    console.log('PASS fresh irreversible retention bounds and PostgreSQL-unsafe optional raw evidence cannot undo verified requests');

    const rollback=transport(),b=await fixture(rollback,'queued'),realSend=boss.send.bind(boss);let inserted:string|null=null;
    boss.send=(async(...args:any[])=>{const id=await(realSend as any)(...args);if(args[0]===rankPollQueue){inserted=id;throw new Error('Synthetic failure after real poll insertion.');}return id;})as typeof boss.send;
    try{await assert.rejects(executeRankDispatch(b.dispatches[0],rollback.send));}finally{boss.send=realSend;}
    assert.ok(inserted);assert.equal((await pool.query('SELECT 1 FROM pgboss.job WHERE id=$1',[inserted])).rowCount,0);assert.equal((await requestActivity(b.dispatches[0])).status,'dispatched');assert.equal((await tasks(b))[0].provider_task_id,null);
    await pool.query("UPDATE rank_dispatch SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[b.dispatches[0]]);await reconcileRankJobs();await executeRankDispatch(b.dispatches[0],rollback.send);assert.equal((await requestActivity(b.dispatches[0])).status,'uncertain');assert.equal(rollback.state.posts,1);
    const timeout=transport(),t=await fixture(timeout,'queued');await executeRankDispatch(t.dispatches[0],timeout.send);await pool.query("UPDATE rank_dispatch SET collect_deadline=clock_timestamp()-interval '1 second' WHERE id=$1",[t.dispatches[0]]);await pollRankDispatch(t.dispatches[0],undefined,timeout.send);assert.equal(timeout.state.gets,0);assert.equal((await requestActivity(t.dispatches[0])).status,'settled');
    console.log('PASS poll enqueue rollback, crashed dispatch uncertainty and bounded collection deadline never replay provider requests');

    const http=transport(),h=await fixture(http);await cancelRankRun(h.project,owner,h.run,{requestId:randomUUID()});
    const password=randomBytes(24).toString('base64url'),passwordHash=await hashPassword(password),cookies=new Map<string,string>();
    for(const uid of [owner,editor,viewer]){
      await pool.query('INSERT INTO account(id,"accountId","providerId","userId",password) VALUES($1,$2,\'credential\',$2,$3)',[randomUUID(),uid,passwordHash]);
      const login=await handleApi(new Request(config.appUrl+'/api/auth/sign-in/email',{method:'POST',headers:{origin:config.appUrl,'content-type':'application/json'},body:JSON.stringify({email:uid+'@rank-worker.integration.test',password})}));assert.equal(login.status,200);
      cookies.set(uid,login.headers.getSetCookie().map(value=>value.split(';')[0]).join('; '));
    }
    const api=(path:string,method='GET',body?:unknown,user=owner,extra:Record<string,string>={})=>handleApi(new Request(config.appUrl+path,{method,headers:{cookie:cookies.get(user)??'',origin:config.appUrl,'content-type':'application/json',...extra},...(body===undefined?{}:{body:typeof body==='string'?body:JSON.stringify(body)})}));
    const trackerPath='/api/projects/'+h.project+'/rank-trackers/'+h.tracker,checkPath='/api/projects/'+h.project+'/rank-checks/';
    const tracker=(await getRankTracker(h.project,owner,h.tracker)).tracker,quoteBody={requestId:randomUUID(),connectionId:h.connection,revision:tracker.revision,keywordsRevision:tracker.keywordsRevision,method:'queued'};
    assert.equal((await handleApi(new Request(config.appUrl+checkPath+h.run))).status,401);
    const token=(await createApiKey(h.workspace,owner,{name:'No rank execution scope',scopes:['projects:read']})).token;
    assert.equal((await api(checkPath+h.run,'GET',undefined,owner,{authorization:'Bearer '+token})).status,400,'Mixed browser and bearer credentials are rejected.');
    assert.equal((await handleApi(new Request(config.appUrl+checkPath+h.run,{headers:{authorization:'Bearer '+token}}))).status,403);
    assert.equal((await api(trackerPath+'/prepare','POST',quoteBody,owner,{origin:'https://outside.example.com'})).status,403);
    assert.equal((await api(trackerPath+'/prepare','POST',quoteBody,viewer)).status,404);
    assert.equal((await api(trackerPath+'/prepare','GET')).status,405);
    assert.equal((await api(trackerPath+'/prepare','POST',{...quoteBody,padding:'x'.repeat(262144)})).status,413);
    assert.equal((await api(trackerPath+'/prepare?method=live','POST',quoteBody)).status,400);
    const blockedFetch=globalThis.fetch;globalThis.fetch=http.send;
    try{
      const before=http.state.free,quoted=await api(trackerPath+'/prepare','POST',quoteBody);assert.equal(quoted.status,200);const quotedDto=await quoted.json();for(const removed of ['estimateUsd','knownChargeUsd','priceAsOf','costStatus'])assert.equal(Object.hasOwn(quotedDto.run,removed),false);const run=quotedDto.run.id as string,path=checkPath+run;
      assert.equal(http.state.free,before+1);assert.equal(http.state.posts,0);assert.equal(quotedDto.run.status,'quoted');
      const quotedReplay=await api(trackerPath+'/prepare','POST',quoteBody);assert.equal(quotedReplay.status,200);assert.equal((await quotedReplay.json()).run.id,run);assert.equal(http.state.free,before+1);
      const read=await api(path,'GET',undefined,viewer);assert.equal(read.status,200);assert.equal(read.headers.get('cache-control'),'no-store');const text=await read.text();
      for(const secret of ['never-live','account_fingerprint','request_hash','encrypted_credentials','lease_owner'])assert.ok(!text.includes(secret));
      assert.equal((await api('/api/projects/'+f.project+'/rank-checks/'+run)).status,404);
      assert.equal((await api(path+'?other=1')).status,400);assert.equal((await api(path+'/start','GET')).status,405);assert.equal((await api(path,'PUT',{})).status,405);
      assert.equal((await api(path+'/start','POST',{requestId:randomUUID(),padding:'x'.repeat(8192)})).status,413);
      assert.equal((await api(path+'/start','POST','{')).status,400);
      const startBody={requestId:randomUUID()};assert.equal((await api(path+'/start','POST',startBody,editor)).status,403);assert.equal((await api(path+'/start','POST',startBody,viewer)).status,404);
      const started=await api(path+'/start','POST',startBody);assert.equal(started.status,202);assert.equal((await started.json()).run.status,'queued');
      const retry=await api(path+'/start','POST',startBody);assert.equal(retry.status,202);assert.equal((await retry.json()).replayed,true);
      assert.equal((await pool.query('SELECT count(*)::integer AS n FROM rank_dispatch WHERE run_id=$1',[run])).rows[0].n,1);assert.equal(http.state.posts,0);
      const recovery={requestId:randomUUID(),dispatchId:(await pool.query('SELECT id FROM rank_dispatch WHERE run_id=$1',[run])).rows[0].id,connectionId:h.connection};
      assert.equal((await api(path+'/recover','POST',recovery,editor)).status,404);assert.equal((await api(path+'/recover','POST',recovery)).status,409);assert.equal(http.state.free,before+1);
      const cancelBody={requestId:randomUUID()};assert.equal((await api(path+'/cancel','POST',cancelBody,editor)).status,403);
      const cancelled=await api(path+'/cancel','POST',cancelBody);assert.equal(cancelled.status,200);assert.equal((await cancelled.json()).run.status,'cancelled');assert.equal((await api(path+'/cancel','POST',cancelBody)).status,200);
      await pool.query('DELETE FROM membership WHERE workspace_id=$1 AND user_id=$2',[h.workspace,viewer]);assert.equal((await api(path,'GET',undefined,viewer)).status,404);assert.equal(http.state.posts,0);
    }finally{globalThis.fetch=blockedFetch;}
    console.log('PASS production rank HTTP routes: cookie/Origin/live-role scope, body caps, preparation/read/start receipt/cancel and owner-only recovery');

    await pool.query("UPDATE pgboss.job SET state='cancelled' WHERE name=ANY($1::text[]) AND state IN('created','retry')",[[rankQueue,rankPollQueue]]);
    const actual=transport(),a=await fixture(actual,'queued');globalThis.fetch=actual.send;
    await startWorker();
    const end=Date.now()+18000;while((await dispatch(a.dispatches[0])).phase!=='finished'&&Date.now()<end)await new Promise(r=>setTimeout(r,50));
    assert.equal((await requestActivity(a.dispatches[0])).status,'settled');assert.equal((await getRankRun(a.project,owner,a.run)).run.status,'completed');assert.equal(actual.state.posts,1);assert.equal(actual.state.gets,1);assert.equal(unexpected,0);
    console.log('PASS production startWorker registers paid and free pg-boss handlers; synthetic queued check completes without fallback requests');
  }finally{try{await stopJobs();}finally{globalThis.fetch=priorFetch;}}
}
if(import.meta.main){try{await runRankWorkerChecks();}finally{await closeDatabase();}}
