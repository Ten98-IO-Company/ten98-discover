import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {getConfig} from '../src/server/config.ts';
import {assertSchema,getDatabase,closeDatabase} from '../src/server/db.ts';
import {getBoss,stopJobs} from '../src/server/jobs.ts';
import {saveProvider,saveBudget,revokeProvider} from '../src/server/providers.ts';
import {changeRankKeywords,getRankTracker} from '../src/server/rank-tracking.ts';
import {quoteRankCheck,startRankCheck,getRankRun} from '../src/server/rank-execution.ts';
import {executeRankDispatch,rankPollQueue} from '../src/server/rank-worker.ts';
import {reconcileRankCheck} from '../src/server/rank-reconciliation.ts';
import {keywordAccountEndpoint} from '../src/server/keyword-research-input.ts';
import {rankSerpEndpoints} from '../src/server/rank-serp-input.ts';

const fails=(status:number)=>(error:unknown)=>(error as {status?:number})?.status===status;
function latch(){let enter!:()=>void,release!:()=>void;return {entered:new Promise<void>(r=>enter=r),release:()=>release(),hold:async()=>{enter();await new Promise<void>(r=>release=r);}};}
const reached=(p:Promise<void>)=>Promise.race([p,new Promise<never>((_,reject)=>{setTimeout(()=>reject(new Error('Expected synthetic recovery request was not reached.')),5000).unref();})]);
export async function runRankReconciliationChecks(){
  assert.equal(process.env.TEN98_INTEGRATION_TEST,'1');assert.equal(process.env.TEN98_RANK_RECONCILIATION_TEST,'1');
  const config=getConfig(),url=new URL(config.databaseUrl),loopback=['localhost','127.0.0.1','[::1]'];
  const ci=process.env.GITHUB_ACTIONS==='true'&&process.env.TEN98_ISOLATED_CI_DATABASE==='1'&&url.pathname==='/ten98_rank_reconciliation_ci';
  assert.ok(loopback.includes(url.hostname)&&loopback.includes(new URL(config.appUrl).hostname));assert.equal(url.port,ci?'5432':'55501');assert.equal(url.search,'');assert.equal(url.hash,'');assert.match(url.pathname,/^\/ten98_rank_reconciliation_[a-z0-9_]+$/);
  await assertSchema();const pool=getDatabase().pool;assert.equal((await pool.query('SELECT count(*)::int AS n FROM workspace')).rows[0].n,0,'Use an empty owned migrated fixture.');
  const owner=randomUUID(),otherOwner=randomUUID(),editor=randomUUID(),viewer=randomUUID(),originalFetch=globalThis.fetch;let unexpected=0;
  globalThis.fetch=async()=>{unexpected++;throw new Error('External calls forbidden during rank recovery acceptance.');};
  async function fixture(count=2){
    const f={workspace:randomUUID(),project:randomUUID(),tracker:randomUUID(),connection:'',run:'',dispatch:''};
    const net={account:'recovery@integration.test',paid:0,accounts:0,metadata:0,mode:'ok' as 'ok'|'missing'|'duplicate'|'unknown',hook:null as null|(()=>Promise<void>),rows:[] as any[],posted:'',usedAuth:''};
    const send:typeof fetch=async(address,options)=>{
      assert.equal(options?.redirect,'error');assert.equal(options?.credentials,'omit');const target=String(address);net.usedAuth=new Headers(options?.headers).get('authorization')??'';
      if(target===keywordAccountEndpoint){assert.equal(options?.method,'GET');net.accounts++;const price=[{cost_type:'per_request',cost:.001}];return Response.json({status_code:20000,cost:0,tasks_count:1,tasks_error:0,tasks:[{status_code:20000,cost:0,path:['v3','appendix','user_data'],result_count:1,result:[{login:net.account,price:{serp:{live:{advanced:{priority_normal:price}},task_post:{priority_normal:price},task_get:{advanced:{priority_normal:[{cost_type:'per_request',cost:0}]}}}}}]}]});}
      assert.equal(options?.method,'POST');
      if(target===rankSerpEndpoints.queued){net.paid++;net.rows=JSON.parse(options?.body as string).map((data:any)=>({id:randomUUID(),metadata:{...data,api:'serp',se:'google',se_type:'organic',function:'task_post'},url:'v3/serp/google/organic/task_post',status:'20000',cost:.0005}));throw new Error('Synthetic lost acknowledgement after one paid boundary.');}
      assert.equal(target,'https://api.dataforseo.com/v3/serp/id_list','Recovery may only call the free account/metadata endpoints.');net.metadata++;if(net.hook)await net.hook();const data=JSON.parse(options?.body as string)[0];
      let rows=net.rows.map(row=>({...row,datetime_posted:net.posted,status:net.mode==='unknown'?'50000':row.status}));if(net.mode==='missing')rows=rows.slice(1);if(net.mode==='duplicate')rows.push(rows[0]);
      return Response.json({status_code:20000,cost:0,tasks_count:1,tasks_error:0,tasks:[{status_code:20000,cost:0,path:['v3','serp','id_list'],data,result_count:rows.length,result:rows}]});
    };
    await pool.query("INSERT INTO workspace(id,name) VALUES($1,'Recovery acceptance')",[f.workspace]);
    for(const [uid,role]of [[owner,'owner'],[otherOwner,'owner'],[editor,'editor'],[viewer,'viewer']])await pool.query('INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,$3)',[f.workspace,uid,role]);
    await pool.query("INSERT INTO project(id,workspace_id,name,origin,public_key,retention_next_run_at) VALUES($1,$2,'Recovery acceptance','https://example.com',$3,'infinity')",[f.project,f.workspace,randomUUID()]);
    f.connection=(await saveProvider(f.workspace,owner,{provider:'dataforseo',name:'Synthetic original',credentials:{login:net.account,password:'synthetic-original'}})).connection.id;await saveBudget(f.workspace,owner,{paused:false});
    await pool.query(`INSERT INTO rank_config(id,workspace_id,project_id,name,target_domain,location_code,location_name,location_type,country_location_code,country_iso,language_code,language_name,catalog_verified_at,devices,serp_depth,max_crawl_pages) VALUES($1,$2,$3,'Recovery acceptance','example.com',2840,'US','Country',2840,'US','en','English',clock_timestamp(),'desktop',100,1)`,[f.tracker,f.workspace,f.project]);
    await changeRankKeywords(f.project,owner,f.tracker,'add',{requestId:randomUUID(),revision:1,keywords:Array.from({length:count},(_,i)=>'C++ %20 '+i),matchCase:true});
    const t=(await getRankTracker(f.project,owner,f.tracker)).tracker,q=await quoteRankCheck(f.project,owner,f.tracker,{requestId:randomUUID(),connectionId:f.connection,revision:t.revision,keywordsRevision:t.keywordsRevision,method:'queued'},send);assert.ok(q);f.run=q.run.id;await startRankCheck(f.project,owner,f.run,{requestId:randomUUID()});f.dispatch=(await pool.query('SELECT id FROM rank_dispatch WHERE run_id=$1',[f.run])).rows[0].id;
    await executeRankDispatch(f.dispatch,send);assert.equal(net.paid,1);assert.equal((await pool.query('SELECT status FROM provider_request WHERE id=$1',[f.dispatch])).rows[0].status,'uncertain');
    async function age(interval='3 minutes'){const at=(await pool.query("UPDATE rank_dispatch SET dispatched_at=clock_timestamp()-$2::interval WHERE id=$1 RETURNING dispatched_at",[f.dispatch,interval])).rows[0].dispatched_at as Date;net.posted=at.toISOString().slice(0,19).replace('T',' ')+' +00:00';}
    await age();return {f,net,send,age};
  }
  type Fixture=Awaited<ReturnType<typeof fixture>>;
  const body=(x:Fixture,extra:Record<string,unknown>={})=>({requestId:randomUUID(),dispatchId:x.f.dispatch,connectionId:x.f.connection,...extra});
  const recover=(x:Fixture,input=body(x),uid=owner)=>reconcileRankCheck(x.f.project,uid,x.f.run,input,x.send);
  async function snapshot(x:Fixture){return(await pool.query(`SELECT to_jsonb(r) AS run,to_jsonb(d) AS dispatch,to_jsonb(p) AS ledger,
    (SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM rank_task t WHERE t.run_id=r.id) AS tasks,
    (SELECT jsonb_agg(to_jsonb(c) ORDER BY c.request_id) FROM project_content_request c WHERE c.project_id=r.project_id) AS receipts
    FROM rank_run r JOIN rank_dispatch d ON d.run_id=r.id JOIN provider_request p ON p.id=d.id WHERE r.id=$1`,[x.f.run])).rows[0];}
  async function role(x:Fixture,value:string){const c=await pool.connect();try{await c.query('BEGIN');await c.query('SELECT id FROM workspace WHERE id=$1 FOR UPDATE',[x.f.workspace]);await c.query('UPDATE membership SET role=$3 WHERE workspace_id=$1 AND user_id=$2',[x.f.workspace,owner,value]);await c.query('COMMIT');}finally{await c.query('ROLLBACK').catch(()=>{});c.release();}}
  try{
    for(const id of [owner,otherOwner,editor,viewer])await pool.query('INSERT INTO "user"(id,name,email) VALUES($1,\'Rank recovery fixture\',$2)',[id,id+'@integration.test']);
    await(await getBoss()).createQueue(rankPollQueue);
    const guard=await fixture(),foreign=await fixture();let beforeCalls=guard.net.accounts+guard.net.metadata;
    const capability=async(x:Fixture,uid=owner)=>(await getRankRun(x.f.project,uid,x.f.run)).run.dispatches[0].canReconcile;
    assert.equal(await capability(guard),true);assert.equal(await capability(guard,editor),false);assert.equal(await capability(guard,viewer),false);
    await assert.rejects(recover(guard,body(guard),editor),fails(404));await assert.rejects(recover(guard,body(guard),viewer),fails(404));
    await assert.rejects(recover(guard,body(guard,{dispatchId:foreign.f.dispatch})),fails(404));await assert.rejects(recover(guard,body(guard,{connectionId:foreign.f.connection})),fails(404));
    await guard.age('1 minute');assert.equal(await capability(guard),false);await assert.rejects(recover(guard),fails(409));await guard.age('29 days');assert.equal(await capability(guard),false);await assert.rejects(recover(guard),fails(409));assert.equal(guard.net.accounts+guard.net.metadata,beforeCalls);
    await guard.age();guard.net.account='wrong-account@integration.test';const unchanged=await snapshot(guard);await assert.rejects(recover(guard),fails(409));assert.equal(guard.net.metadata,0);assert.deepEqual(await snapshot(guard),unchanged);
    console.log('PASS owner, project, selected connection, closed recovery window and same-account identity gates before metadata mutation');

    const incomplete=await fixture();for(const mode of ['missing','duplicate','unknown'] as const){incomplete.net.mode=mode;const before=await snapshot(incomplete),key=body(incomplete),result=await recover(incomplete,key);assert.equal(result.reconciliation.status,'inconclusive');assert.equal(result.reconciliation.message,'The provider evidence could not uniquely confirm every captured task. The recorded charges are unchanged.');assert.deepEqual(await snapshot(incomplete),before);
      // Owner decision D3: the lost dispatch never paused the workspace, and an inconclusive recovery leaves that unchanged.
      assert.equal((await pool.query('SELECT paused FROM workspace_budget WHERE workspace_id=$1',[incomplete.f.workspace])).rows[0].paused,false);}
    console.log('PASS incomplete, ambiguous and financially unproven metadata leave charges, tasks and receipts unchanged');

    for(const mutation of ['owner','connection','generation'] as const){const x=await fixture(),gate=latch(),input=body(x);x.net.hook=gate.hold;const pending=recover(x,input),rejected=assert.rejects(pending,fails(mutation==='owner'?404:409));
      try{await reached(gate.entered);if(mutation==='owner')await role(x,'viewer');if(mutation==='connection')await saveProvider(x.f.workspace,owner,{name:'Changed during recovery',credentials:{login:x.net.account,password:'synthetic-changed'}},x.f.connection);if(mutation==='generation')await pool.query('UPDATE rank_dispatch SET generation=generation+1 WHERE id=$1',[x.f.dispatch]);}finally{gate.release();}await rejected;
      assert.equal((await pool.query('SELECT status FROM provider_request WHERE id=$1',[x.f.dispatch])).rows[0].status,'uncertain');assert.equal((await pool.query('SELECT 1 FROM project_content_request WHERE project_id=$1 AND request_id=$2',[x.f.project,input.requestId])).rowCount,0);
    }
    console.log('PASS live owner, selected credential revision and dispatch generation are rechecked after held free metadata I/O');

    const good=await fixture(),original=(await snapshot(good)),replacement=(await saveProvider(good.f.workspace,owner,{provider:'dataforseo',name:'Synthetic replacement',credentials:{login:good.net.account,password:'synthetic-replacement'}})).connection.id;
    await revokeProvider(good.f.workspace,owner,good.f.connection);const input=body(good,{connectionId:replacement}),accepted=await recover(good,input);assert.equal(accepted.reconciliation.status,'matched');assert.equal(accepted.reconciliation.message,'Provider task evidence was recovered. Available results can be fetched without submitting another paid check.');assert.equal(accepted.run.costStatus,'final');assert.equal(accepted.run.knownChargeUsd,'0.001000');assert.equal(accepted.run.status,'waiting');
    const saved=await snapshot(good);assert.equal(saved.run.connection_id,original.run.connection_id);assert.equal(saved.run.account_fingerprint,original.run.account_fingerprint);assert.deepEqual(saved.run.request,original.run.request);assert.equal(saved.ledger.connection_id,original.ledger.connection_id);assert.equal(saved.dispatch.charge_evidence.recovery.connectionId,replacement);assert.equal((await pool.query('SELECT paused FROM workspace_budget WHERE workspace_id=$1',[good.f.workspace])).rows[0].paused,false,'Owner decision D3: recovery leaves the pause state unchanged.');
    const accounts=good.net.accounts,metadata=good.net.metadata;await revokeProvider(good.f.workspace,owner,replacement);
    const retry=await recover(good,input);assert.equal(retry.reconciliation.replayed,true);assert.equal(good.net.accounts,accounts);assert.equal(good.net.metadata,metadata);
    await assert.rejects(recover(good,{...input,dispatchId:foreign.f.dispatch}),fails(409));await assert.rejects(recover(good,input,otherOwner),fails(409));assert.equal(good.net.paid,1);
    console.log('PASS explicit replacement credentials retain original financial binding, an unchanged pause state (D3) and actor-bound replay before revoked credentials are reopened');

    const retryable=await fixture();await recover(retryable);assert.equal(await capability(retryable),false,'Active result collection is not another owner recovery.');
    await pool.query("UPDATE rank_dispatch SET phase='finished',next_poll_at=NULL,completed_at=clock_timestamp() WHERE id=$1",[retryable.f.dispatch]);
    assert.equal(await capability(retryable),true,'A settled charge with a known unavailable retained result supports free recovery.');
    await pool.query('UPDATE rank_task SET data_expired_at=clock_timestamp(),raw_expired_at=clock_timestamp() WHERE run_id=$1',[retryable.f.run]);
    assert.equal(await capability(retryable),false,'Expired settled results do not advertise recovery.');
    console.log('PASS current-owner recovery capability matches closed time windows and retained settled-result eligibility');

    const expired=await fixture();await pool.query("UPDATE rank_run SET created_at=clock_timestamp()-interval '400 days',started_at=clock_timestamp()-interval '400 days',raw_expired_at=clock_timestamp(),data_expired_at=clock_timestamp() WHERE id=$1",[expired.f.run]);
    await pool.query("UPDATE rank_task SET raw_expired_at=clock_timestamp(),data_expired_at=clock_timestamp() WHERE run_id=$1",[expired.f.run]);
    await pool.query('UPDATE workspace SET raw_provider_evidence_days=3650,derived_history_days=3650 WHERE id=$1',[expired.f.workspace]);
    const recovered=await recover(expired);assert.equal(recovered.run.costStatus,'final');assert.ok(recovered.run.dataExpiredAt);assert.equal((await pool.query('SELECT phase FROM rank_dispatch WHERE id=$1',[expired.f.dispatch])).rows[0].phase,'finished');assert.equal((await pool.query("SELECT 1 FROM pgboss.job WHERE name=$1 AND data->>'dispatchId'=$2",[rankPollQueue,expired.f.dispatch])).rowCount,0);assert.ok(recovered.run.tasks.every((t:any)=>t.position===null&&t.dataExpiredAt));
    assert.equal(unexpected,0);console.log('PASS explicit recovery settles expired receipts without restoring result payloads or scheduling useless free collection');
  }finally{try{await stopJobs();}finally{globalThis.fetch=originalFetch;}}
}
if(import.meta.main){try{await runRankReconciliationChecks();}finally{await closeDatabase();}}
