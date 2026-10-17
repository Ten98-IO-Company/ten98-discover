import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {FoundationError} from '../src/server/auth.ts';
import {getConfig} from '../src/server/config.ts';
import {assertSchema,getDatabase,closeDatabase} from '../src/server/db.ts';
import {getBoss,startWorker,stopJobs} from '../src/server/jobs.ts';
import {saveBudget,saveProvider} from '../src/server/providers.ts';
import {getRankTracker,changeRankKeywords,updateRankTracker} from '../src/server/rank-tracking.ts';
import {quoteRankCheck,getRankRun,rankQueue} from '../src/server/rank-execution.ts';
import {listRankRuns} from '../src/server/rank-history.ts';
import {approveRankSchedule,disableRankSchedule,getRankSchedule} from '../src/server/rank-scheduling.ts';
import {claimDueRankOccurrence,assertRankRecurringAuthority} from '../src/server/rank-recurring.ts';
import {executeRankDispatch,pollRankDispatch,cancelRankRun,rankDispatchSnapshot,rankPollQueue} from '../src/server/rank-worker.ts';
import {readRankPlan} from '../src/server/rank-execution-plan.ts';
import {keywordAccountEndpoint} from '../src/server/keyword-research-input.ts';
import {rankSerpEndpoints} from '../src/server/rank-serp-input.ts';

const rejected=(status:number)=>(error:unknown)=>(error as {status?:number})?.status===status;
function latch(){let enter!:()=>void,release!:()=>void;const entered=new Promise<void>(r=>enter=r),wait=new Promise<void>(r=>release=r);return {entered,release,hold:async()=>{enter();await wait;}};}
async function reached(promise:Promise<unknown>,ms=5000){let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Expected synthetic acceptance stage was not reached.')),ms);})]);}finally{clearTimeout(timer);}}
async function until(check:()=>Promise<boolean>,ms=30000){const end=Date.now()+ms;while(!await check()){if(Date.now()>end)throw new Error('Synthetic worker did not finish within the acceptance bound.');await new Promise(r=>setTimeout(r,50));}}

export async function runRankRecurringChecks(){
  assert.equal(process.env.TEN98_INTEGRATION_TEST,'1');assert.equal(process.env.TEN98_RANK_RECURRING_TEST,'1');
  const cfg=getConfig(),url=new URL(cfg.databaseUrl),loopback=['localhost','127.0.0.1','[::1]'];
  const ci=process.env.GITHUB_ACTIONS==='true'&&process.env.TEN98_ISOLATED_CI_DATABASE==='1'&&url.pathname==='/ten98_rank_recurring_ci';
  assert.ok(loopback.includes(url.hostname)&&loopback.includes(new URL(cfg.appUrl).hostname));assert.equal(url.port,ci?'5432':'55501');assert.equal(url.search,'');assert.equal(url.hash,'');assert.match(url.pathname,/^\/ten98_rank_recurring_[a-z0-9_]+$/);
  await assertSchema();const pool=getDatabase().pool;assert.equal((await pool.query('SELECT count(*)::int AS n FROM workspace')).rows[0].n,0,'Use one new migrated owned fixture.');
  const owner=randomUUID(),viewer=randomUUID(),oldFetch=globalThis.fetch;let unexpected=0;
  globalThis.fetch=async()=>{unexpected++;throw new Error('Real provider traffic is forbidden in recurring acceptance.');};
  function transport(){
    const state={account:'recurring@integration.test',base:.001,free:0,paid:0,gets:0,lost:false,accountHook:null as null|(()=>Promise<void>),tasks:new Map<string,any>()};
    const send:typeof fetch=async(address,options)=>{
      assert.equal(options?.redirect,'error');assert.equal(options?.credentials,'omit');const target=String(address);
      if(target===keywordAccountEndpoint){assert.equal(options?.method,'GET');state.free++;if(state.accountHook)await state.accountHook();const price=(cost:number)=>[{cost_type:'per_request',cost}];return Response.json({status_code:20000,cost:0,tasks_count:1,tasks_error:0,tasks:[{status_code:20000,cost:0,path:['v3','appendix','user_data'],result_count:1,result:[{login:state.account,price:{serp:{live:{advanced:{priority_normal:price(.002)}},task_post:{priority_normal:price(state.base)},task_get:{advanced:{priority_normal:price(0)}}}}}]}]});}
      if(target===rankSerpEndpoints.queued){assert.equal(options?.method,'POST');state.paid++;const body=JSON.parse(options?.body as string),tasks=body.map((data:any)=>{const task={id:randomUUID(),status_code:20100,cost:.001,path:['v3','serp','google','organic','task_post'],data:{...data,api:'serp',se:'google',se_type:'organic',function:'task_post'},result_count:0,result:null};state.tasks.set(task.id,task);return task;});if(state.lost)throw new Error('Synthetic lost POST acknowledgement.');return Response.json({status_code:20000,cost:tasks.length*.001,tasks_count:tasks.length,tasks});}
      assert.ok(target.startsWith(rankSerpEndpoints.task),'Only fixed synthetic free retrieval is allowed.');assert.equal(options?.method,'GET');state.gets++;const id=target.slice(rankSerpEndpoints.task.length),saved=state.tasks.get(id);assert.ok(saved);
      return Response.json({status_code:20000,cost:.001,tasks_count:1,tasks:[{...saved,status_code:20000,cost:.001,path:['v3','serp','google','organic','task_get','advanced',id],data:{...saved.data,function:'task_get'},result_count:1,result:[{keyword:decodeURIComponent(saved.data.keyword.replace(/\+/g,' ')),type:'organic',location_code:saved.data.location_code,language_code:saved.data.language_code,datetime:new Date().toISOString(),pages_count:1,items_count:1,item_types:['organic'],items:[{type:'organic',rank_group:1,rank_absolute:1,page:1,url:'https://example.com/result',domain:'example.com',title:'Synthetic recurring result'}]}]}]});
    };return {state,send};
  }
  async function fixture(net:ReturnType<typeof transport>,count=2,ceiling='1.000000'){
    const f={workspace:randomUUID(),project:randomUUID(),tracker:randomUUID(),connection:'',quote:''};
    await pool.query("INSERT INTO workspace(id,name) VALUES($1,'Recurring acceptance')",[f.workspace]);
    for(const [user,role]of [[owner,'owner'],[viewer,'viewer']])await pool.query('INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,$3)',[f.workspace,user,role]);
    await pool.query("INSERT INTO project(id,workspace_id,name,origin,public_key,retention_next_run_at) VALUES($1,$2,'Recurring acceptance','https://example.com',$3,'infinity')",[f.project,f.workspace,randomUUID()]);
    f.connection=(await saveProvider(f.workspace,owner,{provider:'dataforseo',name:'Synthetic recurring account',credentials:{login:'recurring@integration.test',password:'never-live'}})).connection.id;await saveBudget(f.workspace,owner,{paused:false});
    await pool.query("INSERT INTO rank_config(id,workspace_id,project_id,name,target_domain,location_code,location_name,location_type,country_location_code,country_iso,language_code,language_name,catalog_verified_at,devices,serp_depth,max_crawl_pages) VALUES($1,$2,$3,'Recurring acceptance','example.com',2840,'US','Country',2840,'US','en','English',clock_timestamp(),'desktop',100,1)",[f.tracker,f.workspace,f.project]);
    await changeRankKeywords(f.project,owner,f.tracker,'add',{requestId:randomUUID(),revision:1,keywords:Array.from({length:count},(_,i)=>'C++ %20 '+i),matchCase:true});
    const t=(await getRankTracker(f.project,owner,f.tracker)).tracker,q=await quoteRankCheck(f.project,owner,f.tracker,{requestId:randomUUID(),connectionId:f.connection,revision:t.revision,keywordsRevision:t.keywordsRevision,method:'queued'},net.send);assert.ok(q);f.quote=q.run.id;
    await approveRankSchedule(f.project,owner,f.tracker,{requestId:randomUUID(),revision:t.authoredRevision,quoteId:f.quote,maximumUsd:ceiling,interval:'daily',timezone:'UTC',hour:9,minute:0});return f;
  }
  type Fixture=Awaited<ReturnType<typeof fixture>>;
  const raw=(f:Fixture)=>pool.query('SELECT * FROM rank_config WHERE id=$1',[f.tracker]).then(r=>r.rows[0]);
  const due=(f:Fixture)=>pool.query("UPDATE rank_config SET next_due_at=clock_timestamp()-interval '2 days' WHERE id=$1 RETURNING to_char(next_due_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS due",[f.tracker]).then(r=>r.rows[0].due as string);
  const counts=(f:Fixture)=>pool.query(`SELECT (SELECT count(*)::int FROM rank_run WHERE config_id=$1 AND trigger='scheduled') AS runs,(SELECT count(*)::int FROM provider_request WHERE workspace_id=$2) AS ledger,(SELECT count(*)::int FROM rank_dispatch WHERE project_id=$3) AS dispatch,(SELECT count(*)::int FROM rank_task WHERE project_id=$3) AS tasks`,[f.tracker,f.workspace,f.project]).then(r=>r.rows[0]);
  const dispatches=(run:string)=>pool.query('SELECT id FROM rank_dispatch WHERE run_id=$1 ORDER BY ordinal',[run]).then(r=>r.rows.map(v=>v.id as string));
  const disable=async(f:Fixture)=>disableRankSchedule(f.project,owner,f.tracker,{requestId:randomUUID(),revision:(await getRankSchedule(f.project,owner,f.tracker)).authoredRevision});
  async function setRole(f:Fixture,role:string){const c=await pool.connect();try{await c.query('BEGIN');await c.query('SELECT id FROM workspace WHERE id=$1 FOR UPDATE',[f.workspace]);await c.query('UPDATE membership SET role=$3 WHERE workspace_id=$1 AND user_id=$2',[f.workspace,owner,role]);await c.query('COMMIT');}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}
  try{
    for(const id of [owner,viewer])await pool.query('INSERT INTO "user"(id,name,email) VALUES($1,\'Recurring acceptance\',$2)',[id,id+'@recurring.integration.test']);
    const boss=await getBoss();assert.deepEqual(await claimDueRankOccurrence(),{status:'idle'});
    const net=transport(),f=await fixture(net,101),stamp=await due(f),hold=latch();let entered=0;net.state.accountHook=async()=>{if(++entered===2)await hold.hold();else await hold.entered;};
    const a=claimDueRankOccurrence(net.send),b=claimDueRankOccurrence(net.send);await reached(hold.entered);hold.release();const results=await Promise.all([a,b]);assert.deepEqual(results.map(r=>r.status).sort(),['started','superseded']);const run=results.find(r=>r.runId)!.runId!;
    assert.deepEqual(await counts(f),{runs:1,ledger:2,dispatch:2,tasks:101});assert.equal(net.state.paid,0);assert.equal((await pool.query("SELECT to_char(scheduled_for AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS due FROM rank_run WHERE id=$1",[run])).rows[0].due,stamp);assert.ok((await raw(f)).next_due_at>new Date());assert.equal((await claimDueRankOccurrence(net.send)).status,'idle');
    const jobs=(await pool.query('SELECT j.retry_limit FROM pgboss.job j JOIN rank_dispatch d ON d.id=j.id WHERE d.run_id=$1',[run])).rows;assert.equal(jobs.length,2);assert.ok(jobs.every(v=>v.retry_limit===0));
    const dto=JSON.parse(JSON.stringify((await getRankRun(f.project,viewer,run)).run));assert.equal(dto.trigger,'scheduled');assert.equal(dto.scheduledFor,new Date(stamp).toISOString());assert.equal(dto.canStart,false);
    console.log('PASS concurrent due claims create one exact occurrence with atomic full queue/ledger, strict next-future scheduling and no paid retry');

    for(const failure of ['exception','conflict','budget'] as const){
      const n=transport(),x=await fixture(n,101);await due(x);const before=(await raw(x)).next_due_at.toISOString(),beforeJobs=(await pool.query('SELECT count(*)::int AS n FROM pgboss.job')).rows[0].n,send=boss.send;let sends=0;
      // Owner decision D3: no connection cap. A test-only trigger records an uncertain sentinel charge after the first group's reservation (N=1),
      // so the second group meets the real ledger gate (409 SPENDING_BUDGET) and the savepoint rolls back every child, sentinel included.
      const ledgerHash=async()=>(await pool.query("SELECT md5(COALESCE(jsonb_agg(to_jsonb(p) ORDER BY id),'[]'::jsonb)::text) AS h FROM provider_request p")).rows[0].h as string,ledgerBefore=await ledgerHash();
      if(failure==='budget'){await pool.query(`CREATE FUNCTION d3_sentinel() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.operation<>'test.sentinel' AND NEW.workspace_id=TG_ARGV[0] AND (SELECT count(*) FROM provider_request WHERE workspace_id=NEW.workspace_id AND operation<>'test.sentinel')=TG_ARGV[1]::int THEN
          INSERT INTO provider_request(id,workspace_id,connection_id,user_id,request_key,operation,input_hash,estimate_micros,connection_revision,status,budget_month)
          VALUES(gen_random_uuid(),NEW.workspace_id,NEW.connection_id,NEW.user_id,gen_random_uuid(),'test.sentinel',repeat('0',64),1,NEW.connection_revision,'uncertain',NEW.budget_month);
        END IF; RETURN NULL; END $$`);await pool.query(`CREATE TRIGGER d3_sentinel AFTER INSERT ON provider_request FOR EACH ROW EXECUTE FUNCTION d3_sentinel('${x.workspace}','1')`);}
      const dropSentinel=async()=>{await pool.query('DROP TRIGGER IF EXISTS d3_sentinel ON provider_request');await pool.query('DROP FUNCTION IF EXISTS d3_sentinel()');};
      boss.send=(async(...args:Parameters<typeof send>)=>{const result=await send.apply(boss,args);sends++;if(sends===2)throw failure==='conflict'?new FoundationError(409,'Synthetic invariant conflict.'):new Error('Synthetic post-queue failure.');return result;}) as typeof send;
      try{if(failure==='budget'){const skipped=await claimDueRankOccurrence(n.send);assert.equal(skipped.status,'skipped');assert.equal(sends,1);assert.deepEqual(await counts(x),{runs:1,ledger:0,dispatch:0,tasks:0});assert.ok((await raw(x)).next_due_at>new Date());
          assert.equal(await ledgerHash(),ledgerBefore);assert.equal((await raw(x)).last_skip_reason,'Skipped: paid work is paused or an earlier charge is uncertain. No paid request was sent.');
          await dropSentinel();boss.send=send;await due(x);assert.equal((await claimDueRankOccurrence(n.send)).status,'started');assert.deepEqual(await counts(x),{runs:2,ledger:2,dispatch:2,tasks:101});assert.equal(n.state.paid,0);}
        else{await assert.rejects(claimDueRankOccurrence(n.send),failure==='conflict'?rejected(409):/Synthetic post-queue failure/);assert.equal(sends,2);assert.deepEqual(await counts(x),{runs:0,ledger:0,dispatch:0,tasks:0});assert.equal((await raw(x)).next_due_at.toISOString(),before);}}
      finally{boss.send=send;await dropSentinel();await disable(x);}assert.equal((await pool.query('SELECT count(*)::int AS n FROM pgboss.job')).rows[0].n,beforeJobs+(failure==='budget'?2:0),'Only the post-trigger budget claim keeps its two queued groups.');
    }
    console.log('PASS real queue insert rollback, invariant409 propagation and all-child rollback through the real uncertain-charge gate before one durable skip (D3)');

    for(const why of ['provider','price','account','paused','overlap'] as const){
      const n=transport(),x=await fixture(n,2,'0.002000');if(why==='overlap'){await due(x);assert.equal((await claimDueRankOccurrence(n.send)).status,'started');}
      const when=await due(x),calls=n.state.free;if(why==='price')n.state.base=.002;if(why==='account')n.state.account='different@integration.test';if(why==='paused')await saveBudget(x.workspace,owner,{paused:true});
      const result=await claimDueRankOccurrence(why==='provider'?async()=>{throw new Error('Synthetic unavailable response.');}:n.send);assert.equal(result.status,'skipped');const skipped=JSON.parse(JSON.stringify((await getRankRun(x.project,viewer,result.runId!)).run));
      assert.equal(skipped.status,'skipped');assert.equal(skipped.taskCount,0);assert.equal(skipped.estimateUsd,'0.000000');assert.equal(skipped.canStart,false);assert.equal(skipped.priceAsOf,null);assert.equal(skipped.scheduledFor,new Date(when).toISOString());assert.deepEqual(skipped.tasks,[]);assert.deepEqual(skipped.quotedTasks,[]);assert.deepEqual(skipped.dispatches,[]);assert.equal(skipped.costStatus,'not_started');assert.equal(n.state.paid,0);if(why==='overlap')assert.equal(n.state.free,calls);
      const summary=(await listRankRuns(x.project,viewer,x.tracker,new URLSearchParams())).runs.find(r=>r.id===result.runId);assert.ok(summary);assert.equal(summary.scheduledFor,new Date(when).toISOString());assert.equal(summary.taskCount,0);assert.equal(summary.estimateUsd,'0.000000');
      assert.equal((await raw(x)).schedule_enabled,why!=='account');if(why!=='account')await disable(x);
    }
    console.log('PASS unavailable account, price ceiling, account change, paused budget and overlap produce honest zero-child skipped receipts');

    for(const mutation of ['role','credentials','definition','disable_reapprove','metadata'] as const){
      const n=transport(),x=await fixture(n),gate=latch();await due(x);n.state.accountHook=gate.hold;const pending=claimDueRankOccurrence(n.send);await reached(gate.entered);
      try{
        if(mutation==='role')await setRole(x,'editor');
        if(mutation==='credentials')await saveProvider(x.workspace,owner,{name:'Changed synthetic connection',credentials:{login:'recurring@integration.test',password:'different-never-live'}},x.connection);
        if(mutation==='definition'){const detail=await getRankTracker(x.project,owner,x.tracker),removed=await changeRankKeywords(x.project,owner,x.tracker,'remove',{requestId:randomUUID(),revision:detail.tracker.authoredRevision,keywordIds:[detail.keywords[0].id]});await changeRankKeywords(x.project,owner,x.tracker,'add',{requestId:randomUUID(),revision:removed.tracker.authoredRevision,keywords:[detail.keywords[0].keyword],matchCase:true});}
        if(mutation==='disable_reapprove'){await disable(x);await approveRankSchedule(x.project,owner,x.tracker,{requestId:randomUUID(),revision:(await getRankSchedule(x.project,owner,x.tracker)).authoredRevision,quoteId:x.quote,maximumUsd:'1',interval:'daily',timezone:'UTC',hour:9,minute:0});}
        if(mutation==='metadata'){const {tracker:t,keywords}=await getRankTracker(x.project,owner,x.tracker);await updateRankTracker(x.project,owner,x.tracker,{requestId:randomUUID(),revision:t.authoredRevision,name:'Metadata only',devices:t.devices,depth:t.depth,maxCrawlPages:t.maxCrawlPages});await changeRankKeywords(x.project,owner,x.tracker,'pin',{requestId:randomUUID(),revision:(await getRankSchedule(x.project,owner,x.tracker)).authoredRevision,keywordIds:[keywords[0].id],pinned:true});}
      }finally{gate.release();}const result=await pending;assert.equal(result.status,mutation==='metadata'?'started':['role','credentials'].includes(mutation)?'skipped':'superseded');assert.equal((await counts(x)).ledger,mutation==='metadata'?1:0);if(mutation==='role')await setRole(x,'owner');await disable(x);
    }
    console.log('PASS post-network live owner, connection, stable keyword identity and approval-generation rechecks; metadata/pins preserve standing scope');

    for(const position of ['before','during'] as const){
      const n=transport(),x=await fixture(n);await due(x);const occurrence=await claimDueRankOccurrence(n.send),ids=await dispatches(occurrence.runId!),gate=latch();
      if(position==='before')await disable(x);else n.state.accountHook=gate.hold;
      const work=executeRankDispatch(ids[0],n.send);if(position==='during'){await reached(gate.entered);try{await disable(x);}finally{gate.release();}}await work;assert.equal(n.state.paid,0);assert.equal((await pool.query('SELECT status FROM provider_request WHERE id=$1',[ids[0]])).rows[0].status,'cancelled');
    }
    const mixed=transport(),m=await fixture(mixed,101);await due(m);const occurrence=await claimDueRankOccurrence(mixed.send),ids=await dispatches(occurrence.runId!);await executeRankDispatch(ids[0],mixed.send);await disable(m);await executeRankDispatch(ids[1],mixed.send);for(let i=0;i<100;i++)await pollRankDispatch(ids[0],undefined,mixed.send);assert.equal(mixed.state.paid,1);assert.equal(mixed.state.gets,100);assert.equal((await pool.query('SELECT status FROM provider_request WHERE id=$1',[ids[0]])).rows[0].status,'settled');assert.equal((await pool.query('SELECT status FROM provider_request WHERE id=$1',[ids[1]])).rows[0].status,'cancelled');assert.equal((await getRankRun(m.project,owner,occurrence.runId!)).run.status,'partial');
    console.log('PASS standing approval revocation at both paid gates cancels untouched work while incurred charge/free collection survive');

    const forged=transport(),g=await fixture(forged);await due(g);const forgedRun=await claimDueRankOccurrence(forged.send),first=(await dispatches(forgedRun.runId!))[0],c=await pool.connect();
    try{await c.query('BEGIN');await c.query('SELECT id FROM workspace WHERE id=$1 FOR UPDATE',[g.workspace]);await c.query('SELECT id FROM project WHERE id=$1 FOR UPDATE',[g.project]);const row=await rankDispatchSnapshot(c,first);assert.ok(row);const plan=readRankPlan(row.run_request,row.run_hash);await assertRankRecurringAuthority(c,row,plan);for(const patch of [{approval_id:randomUUID()},{user_id:viewer},{account_fingerprint:'a'.repeat(64)},{approval_snapshot:{...(row.approval_snapshot as object),maximumMicros:'999999'}}])await assert.rejects(assertRankRecurringAuthority(c,{...row,...patch},plan),rejected(409));}finally{await c.query('ROLLBACK');c.release();}
    const authSecret=process.env.AUTH_SECRET;process.env.AUTH_SECRET=randomUUID()+randomUUID();try{await executeRankDispatch(first,forged.send);assert.equal(forged.state.paid,1);}finally{if(authSecret===undefined)delete process.env.AUTH_SECRET;else process.env.AUTH_SECRET=authSecret;}await disable(g);await pollRankDispatch(first,undefined,forged.send);await pollRankDispatch(first,undefined,forged.send);
    const lost=transport(),u=await fixture(lost);await due(u);const lostRun=await claimDueRankOccurrence(lost.send);lost.state.lost=true;const lostId=(await dispatches(lostRun.runId!))[0];await executeRankDispatch(lostId,lost.send);await executeRankDispatch(lostId,lost.send);assert.equal(lost.state.paid,1);
    // Owner decision D3: the ambiguous charge pauses nothing; the uncertain ledger row alone skips the next occurrence as 'budget'.
    assert.equal((await pool.query('SELECT paused FROM workspace_budget WHERE workspace_id=$1',[u.workspace])).rows[0].paused,false);assert.equal((await pool.query('SELECT status FROM provider_request WHERE id=$1',[lostId])).rows[0].status,'uncertain');await due(u);assert.equal((await claimDueRankOccurrence(lost.send)).status,'skipped');assert.equal((await raw(u)).last_skip_reason,'Skipped: paid work is paused or an earlier charge is uncertain. No paid request was sent.');assert.equal(lost.state.paid,1);await disable(u);
    console.log('PASS immutable approval/actor/account snapshot guards, stable identity across AUTH_SECRET rotation, and no paid retry after ambiguous charge');

    // Retire only this suite's earlier pending jobs before testing the real worker.
    for(const row of (await pool.query("SELECT id,project_id FROM rank_run WHERE status IN('queued','running','waiting')")).rows)await cancelRankRun(row.project_id,owner,row.id,{requestId:randomUUID()});
    await pool.query("UPDATE rank_config SET schedule_enabled=false,next_due_at=NULL WHERE schedule_enabled");await pool.query("UPDATE pgboss.job SET state='cancelled' WHERE name=ANY($1::text[]) AND state IN('created','retry')",[[rankQueue,rankPollQueue]]);
    const actual=transport(),w=await fixture(actual,1);await due(w);globalThis.fetch=actual.send;await startWorker();await until(async()=>!!(await pool.query("SELECT 1 FROM rank_run WHERE config_id=$1 AND trigger='scheduled' AND status='completed'",[w.tracker])).rowCount);assert.equal(actual.state.paid,1);assert.equal(actual.state.gets,1);await stopJobs();assert.equal((await counts(w)).runs,1);
    const stopping=transport(),s=await fixture(stopping,1),stopGate=latch();await due(s);stopping.state.accountHook=stopGate.hold;globalThis.fetch=stopping.send;await startWorker();await reached(stopGate.entered,15000);let stopped=false;const closing=stopJobs().then(()=>{stopped=true;});await new Promise(r=>setTimeout(r,100));assert.equal(stopped,false,'Shutdown must join the pending occurrence instead of abandoning it.');stopGate.release();await reached(closing,10000);assert.equal((await counts(s)).runs,1);assert.ok((await raw(s)).next_due_at>new Date());assert.equal(unexpected,0);
    console.log('PASS actual worker timer starts one due check, paid/free handlers complete it, and graceful stop joins an in-flight recurrence claim');
  }finally{try{await stopJobs();}finally{globalThis.fetch=oldFetch;}}
}
if(import.meta.main){try{await runRankRecurringChecks();}finally{await closeDatabase();}}
