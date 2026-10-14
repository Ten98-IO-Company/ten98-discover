import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {getConfig} from '../src/server/config.ts';
import {assertSchema,getDatabase,closeDatabase} from '../src/server/db.ts';
import {getBoss,stopJobs} from '../src/server/jobs.ts';
import {saveBudget,saveProvider,revokeProvider,saveProviderLimit} from '../src/server/providers.ts';
import {reserveSpend} from '../src/server/spending.ts';
import {canonicalHash} from '../src/server/context-input.ts';
import {getRankTracker,updateRankTracker,archiveRankTracker,changeRankKeywords} from '../src/server/rank-tracking.ts';
import {quoteRankCheck,startRankCheck,getRankRun} from '../src/server/rank-execution.ts';
import {rankGroupPayload,type RankPlan} from '../src/server/rank-execution-plan.ts';
import {keywordAccountEndpoint,microUsd} from '../src/server/keyword-research-input.ts';

const failed=(status:number)=>(error:unknown)=>!!error&&typeof error==='object'&&'status'in error&&error.status===status;
const reached=(signal:Promise<void>)=>Promise.race([signal,new Promise<never>((_,reject)=>{const timer=setTimeout(()=>reject(new Error('Expected synthetic account preflight did not start.')),5000);timer.unref();})]);
type Fixture={workspace:string;project:string;tracker:string;connection:string};
export async function runRankExecutionChecks(){
  assert.equal(process.env.TEN98_INTEGRATION_TEST,'1');assert.equal(process.env.TEN98_RANK_EXECUTION_TEST,'1');
  const config=getConfig(),database=new URL(config.databaseUrl),loopback=['localhost','127.0.0.1','[::1]'];
  const ci=process.env.GITHUB_ACTIONS==='true'&&process.env.TEN98_ISOLATED_CI_DATABASE==='1'&&database.pathname==='/ten98_rank_execution_ci';
  assert.ok(loopback.includes(database.hostname)&&loopback.includes(new URL(config.appUrl).hostname));assert.equal(database.port,ci?'5432':'55501');assert.equal(database.search,'');assert.equal(database.hash,'');assert.match(database.pathname,/^\/ten98_rank_execution_[a-z0-9_]+$/);
  await assertSchema();const pool=getDatabase().pool;assert.equal((await pool.query('SELECT count(*)::integer AS n FROM workspace')).rows[0].n,0,'Use a fresh migrated owned fixture.');
  const owner=randomUUID(),editor=randomUUID(),viewer=randomUUID(),outsider=randomUUID();let freeCalls=0,unexpected=0;
  const priorFetch=globalThis.fetch;globalThis.fetch=async()=>{unexpected++;throw new Error('Real provider traffic is forbidden in rank execution acceptance.');};
  const send:typeof fetch=async(url,init)=>{
    assert.equal(url,keywordAccountEndpoint);assert.equal(init?.method,'GET');assert.equal(init?.redirect,'error');assert.equal(init?.credentials,'omit');freeCalls++;
    const price=(cost:number)=>[{cost_type:'per_request',cost}];
    const serp={live:{advanced:{priority_normal:price(0.002)}},task_post:{priority_normal:price(0.001)},task_get:{advanced:{priority_normal:price(0)}}};
    return Response.json({status_code:20000,cost:0,tasks_count:1,tasks_error:0,tasks:[{status_code:20000,cost:0,path:['v3','appendix','user_data'],result_count:1,result:[{login:'synthetic-rank@integration.test',price:{serp}}]}]});
  };
  async function fixture(count=2,devices='desktop'):Promise<Fixture>{
    const f={workspace:randomUUID(),project:randomUUID(),tracker:randomUUID(),connection:''};
    await pool.query("INSERT INTO workspace(id,name) VALUES($1,'Rank execution fixture')",[f.workspace]);
    for(const [uid,role]of [[owner,'owner'],[editor,'editor'],[viewer,'viewer']])await pool.query('INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,$3)',[f.workspace,uid,role]);
    await pool.query("INSERT INTO project(id,workspace_id,name,origin,public_key,retention_next_run_at) VALUES($1,$2,'Rank execution','https://example.com',$3,'infinity')",[f.project,f.workspace,randomUUID()]);
    f.connection=(await saveProvider(f.workspace,owner,{provider:'dataforseo',name:'Synthetic account',credentials:{login:'synthetic-rank@integration.test',password:'synthetic-never-live'},monthlyLimitUsd:'10'})).connection.id;
    await saveBudget(f.workspace,owner,{monthlyLimitUsd:'10',paused:false});
    await pool.query(`INSERT INTO rank_config(id,workspace_id,project_id,name,target_domain,location_code,location_name,location_type,country_location_code,country_iso,language_code,language_name,catalog_verified_at,devices,serp_depth,max_crawl_pages)
      VALUES($1,$2,$3,'Rank execution','example.com',2840,'United States','Country',2840,'US','en','English',clock_timestamp(),$4,100,1)`,[f.tracker,f.workspace,f.project,devices]);
    await changeRankKeywords(f.project,owner,f.tracker,'add',{requestId:randomUUID(),revision:1,keywords:Array.from({length:count},(_,i)=>i===0?'C++ %20':'term '+i),matchCase:true});
    return f;
  }
  async function quoteBody(f:Fixture,extra:Record<string,unknown>={}){const t=(await getRankTracker(f.project,owner,f.tracker)).tracker;return {requestId:randomUUID(),connectionId:f.connection,revision:t.revision,keywordsRevision:t.keywordsRevision,method:'live',...extra};}
  async function quote(f:Fixture,extra:Record<string,unknown>={},user=owner,transport=send){const result=await quoteRankCheck(f.project,user,f.tracker,await quoteBody(f,extra),transport);assert.ok(result);return result;}
  const start=(f:Fixture,id:string,requestId=randomUUID(),user=owner)=>startRankCheck(f.project,user,id,{requestId});
  async function counts(f:Fixture){return (await pool.query(`SELECT (SELECT count(*)::integer FROM provider_request WHERE workspace_id=$1) AS ledger,(SELECT count(*)::integer FROM rank_dispatch WHERE project_id=$2) AS dispatch,(SELECT count(*)::integer FROM rank_task WHERE project_id=$2) AS tasks`,[f.workspace,f.project])).rows[0];}
  async function expire(id:string){await pool.query("UPDATE rank_run SET created_at=clock_timestamp()-interval '10 minutes',expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[id]);}
  async function changeRole(f:Fixture,uid:string,role:string){const c=await pool.connect();try{await c.query('BEGIN');await c.query('SELECT id FROM workspace WHERE id=$1 FOR UPDATE',[f.workspace]);await c.query('UPDATE membership SET role=$3 WHERE workspace_id=$1 AND user_id=$2',[f.workspace,uid,role]);await c.query('COMMIT');}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}
  try{
    for(const id of [owner,editor,viewer,outsider])await pool.query("INSERT INTO \"user\"(id,name,email) VALUES($1,'Rank execution fixture',$2)",[id,id+'@rank-execution.integration.test']);
    const base=await fixture(2,'both'),input=await quoteBody(base),q=await quoteRankCheck(base.project,owner,base.tracker,input,send);assert.ok(q);
    assert.equal(q.run.taskCount,4);assert.equal(q.run.dispatchCount,4);assert.equal(q.run.estimateUsd,'0.008000');assert.equal(q.run.costStatus,'not_started');assert.equal(q.run.canStart,true);assert.deepEqual(await counts(base),{ledger:0,dispatch:0,tasks:0});
    assert.equal((await getRankRun(base.project,viewer,q.run.id)).run.canStart,false);await assert.rejects(getRankRun(base.project,outsider,q.run.id),failed(404));
    await assert.rejects(quoteRankCheck(base.project,viewer,base.tracker,input,send),failed(404));await assert.rejects(quoteRankCheck(base.project,editor,base.tracker,input,send),failed(409));
    await assert.rejects(quoteRankCheck(base.project,owner,base.tracker,{...input,method:'queued'},send),failed(409));
    await expire(q.run.id);const calls=freeCalls,replayed=await quoteRankCheck(base.project,owner,base.tracker,input,send);assert.ok(replayed);assert.equal(replayed.replayed,true);assert.equal(replayed.run.id,q.run.id);assert.equal(replayed.run.quoteExpired,true);assert.equal(freeCalls,calls);await assert.rejects(start(base,q.run.id),failed(409));
    const other=await fixture();await assert.rejects(getRankRun(other.project,owner,q.run.id),failed(404));await assert.rejects(quoteRankCheck(base.project,owner,base.tracker,{...await quoteBody(base),connectionId:other.connection},send),failed(404));
    console.log('PASS exact free quotes, literal captured pairs, actor/project receipts and expired quote replay without new reservations');

    const held=await fixture();let enter!:()=>void,release!:()=>void;const ready=new Promise<void>(r=>enter=r),gate=new Promise<void>(r=>release=r);
    const heldInput=await quoteBody(held),pending=quoteRankCheck(held.project,editor,held.tracker,heldInput,async(...args)=>{enter();await gate;return send(...args);});
    const denied=assert.rejects(pending,failed(404));try{await reached(ready);await changeRole(held,editor,'viewer');}finally{release();}await denied;
    assert.equal((await pool.query('SELECT 1 FROM rank_run WHERE project_id=$1',[held.project])).rowCount,0);assert.equal((await pool.query('SELECT 1 FROM project_content_request WHERE project_id=$1 AND request_id=$2',[held.project,heldInput.requestId])).rowCount,0);
    const connectionRace=await fixture();let enter2!:()=>void,release2!:()=>void;const ready2=new Promise<void>(r=>enter2=r),gate2=new Promise<void>(r=>release2=r),raceBody=await quoteBody(connectionRace);
    const race=quoteRankCheck(connectionRace.project,owner,connectionRace.tracker,raceBody,async(...args)=>{enter2();await gate2;return send(...args);}),rejected=assert.rejects(race,failed(404));try{await reached(ready2);await revokeProvider(connectionRace.workspace,owner,connectionRace.connection);}finally{release2();}await rejected;assert.equal((await pool.query('SELECT 1 FROM rank_run WHERE project_id=$1',[connectionRace.project])).rowCount,0);
    const changedDuring=await fixture();let enter3!:()=>void,release3!:()=>void;const ready3=new Promise<void>(r=>enter3=r),gate3=new Promise<void>(r=>release3=r),changedBody=await quoteBody(changedDuring);
    const changing=quoteRankCheck(changedDuring.project,owner,changedDuring.tracker,changedBody,async(...args)=>{enter3();await gate3;return send(...args);}),stale=assert.rejects(changing,failed(409));
    try{await reached(ready3);const d=await getRankTracker(changedDuring.project,owner,changedDuring.tracker);await changeRankKeywords(changedDuring.project,owner,changedDuring.tracker,'remove',{requestId:randomUUID(),revision:d.tracker.authoredRevision,keywordIds:[d.keywords[0].id]});}finally{release3();}await stale;
    assert.equal((await pool.query('SELECT 1 FROM rank_run WHERE project_id=$1',[changedDuring.project])).rowCount,0);
    console.log('PASS free-account await rechecks live actor, connection and keyword scope before persisting any quote');

    const working=await fixture(),fresh=await quote(working),details=await getRankTracker(working.project,owner,working.tracker),t=details.tracker;
    await updateRankTracker(working.project,owner,working.tracker,{requestId:randomUUID(),revision:t.authoredRevision,name:'Metadata rename',devices:t.devices,depth:t.depth,maxCrawlPages:t.maxCrawlPages});
    await assert.rejects(start(working,fresh.run.id,randomUUID(),editor),failed(403));
    const key=randomUUID(),accepted=await start(working,fresh.run.id,key);assert.equal(accepted.run.status,'queued');assert.equal(accepted.run.costStatus,'pending');assert.equal(accepted.run.tasks.length,2);assert.deepEqual(await counts(working),{ledger:2,dispatch:2,tasks:2});
    const jobs=(await pool.query('SELECT j.id,j.retry_limit FROM pgboss.job j JOIN rank_dispatch d ON d.id=j.id WHERE d.run_id=$1',[fresh.run.id])).rows;assert.equal(jobs.length,2);assert.ok(jobs.every(j=>j.retry_limit===0));
    await expire(fresh.run.id);const retry=await start(working,fresh.run.id,key);assert.equal(retry.replayed,true);assert.deepEqual(await counts(working),{ledger:2,dispatch:2,tasks:2});await assert.rejects(start(working,fresh.run.id),failed(409));
    await changeRole(working,owner,'viewer');await assert.rejects(start(working,fresh.run.id,key),failed(404));await changeRole(working,owner,'owner');
    console.log('PASS atomic real ledger/queue/tasks, metadata-independent paid scope and current-authority same-key start recovery after expiry');

    for(const mutation of ['settings','keywords','archive','connection'] as const){
      const f=await fixture(),q=await quote(f),d=await getRankTracker(f.project,owner,f.tracker),t=d.tracker;
      if(mutation==='settings')await updateRankTracker(f.project,owner,f.tracker,{requestId:randomUUID(),revision:t.authoredRevision,name:t.name,devices:t.devices,depth:90,maxCrawlPages:1});
      if(mutation==='keywords')await changeRankKeywords(f.project,owner,f.tracker,'remove',{requestId:randomUUID(),revision:t.authoredRevision,keywordIds:[d.keywords[0].id]});
      if(mutation==='archive')await archiveRankTracker(f.project,owner,f.tracker,{requestId:randomUUID(),revision:t.authoredRevision,archived:true});
      if(mutation==='connection')await saveProvider(f.workspace,owner,{name:'Changed credentials',credentials:{login:'synthetic-rank@integration.test',password:'synthetic-rotated'},monthlyLimitUsd:'10'},f.connection);
      await assert.rejects(start(f,q.run.id),failed(409));assert.deepEqual(await counts(f),{ledger:0,dispatch:0,tasks:0});
    }
    console.log('PASS current paid settings, captured keyword membership, archive and connection revisions fence stale starts');

    const queued=await fixture(101),queuedQuote=await quote(queued,{method:'queued'});assert.equal(queuedQuote.run.taskCount,101);assert.equal(queuedQuote.run.dispatchCount,2);assert.equal(queuedQuote.run.estimateUsd,'0.101000');
    await saveProviderLimit(queued.workspace,owner,queued.connection,{revision:1,expectedMonthlyLimitUsd:'10',monthlyLimitUsd:'0.100000'});await assert.rejects(start(queued,queuedQuote.run.id),failed(409));assert.deepEqual(await counts(queued),{ledger:0,dispatch:0,tasks:0});
    const rolled=await fixture(),rollbackQuote=await quote(rolled),boss=await getBoss(),originalSend=boss.send.bind(boss),inserted:string[]=[];
    boss.send=(async(...args:any[])=>{const job=await(originalSend as any)(...args);assert.equal(typeof job,'string');inserted.push(job);if(inserted.length===2)throw new Error('Synthetic failure after second real queue insertion.');return job;})as typeof boss.send;
    const rollbackKey=randomUUID();try{await assert.rejects(start(rolled,rollbackQuote.run.id,rollbackKey));}finally{boss.send=originalSend;}
    assert.equal(inserted.length,2);assert.equal((await pool.query('SELECT id FROM pgboss.job WHERE id=ANY($1::uuid[])',[inserted])).rowCount,0);assert.deepEqual(await counts(rolled),{ledger:0,dispatch:0,tasks:0});assert.equal((await getRankRun(rolled.project,owner,rollbackQuote.run.id)).run.status,'quoted');assert.equal((await pool.query('SELECT 1 FROM project_content_request WHERE project_id=$1 AND request_id=$2',[rolled.project,rollbackKey])).rowCount,0);
    await start(rolled,rollbackQuote.run.id,rollbackKey);assert.deepEqual(await counts(rolled),{ledger:2,dispatch:2,tasks:2});
    console.log('PASS second-child budget and actual second queue insertion failures roll back the entire start, allowing one exact retry');

    const orphan=await fixture(),oq=await quote(orphan),raw=(await pool.query('SELECT request FROM rank_run WHERE id=$1',[oq.run.id])).rows[0].request as RankPlan,group=raw.groups[0],payload=rankGroupPayload(raw,group),requestKey=randomUUID();
    await reserveSpend(orphan.workspace,owner,{connectionId:orphan.connection,requestKey:group.requestKey,operation:'rank.'+raw.method,inputHash:canonicalHash({runId:oq.run.id,method:raw.method,payload}),estimateUsd:microUsd(BigInt(group.maximumMicros))});
    await assert.rejects(start(orphan,oq.run.id,requestKey),failed(409));assert.deepEqual(await counts(orphan),{ledger:1,dispatch:0,tasks:0});assert.equal((await getRankRun(orphan.project,owner,oq.run.id)).run.status,'quoted');assert.equal((await pool.query('SELECT 1 FROM project_content_request WHERE project_id=$1 AND request_id=$2',[orphan.project,requestKey])).rowCount,0);
    console.log('PASS an identical orphan reservation cannot become a successful childless start');

    const competing=await fixture(),qa=await quote(competing),qb=await quote(competing),starts=await Promise.allSettled([start(competing,qa.run.id),start(competing,qb.run.id)]);
    assert.equal(starts.filter(r=>r.status==='fulfilled').length,1);assert.equal(starts.filter(r=>r.status==='rejected'&&failed(409)(r.reason)).length,1);assert.deepEqual(await counts(competing),{ledger:2,dispatch:2,tasks:2});
    assert.equal(unexpected,0);assert.ok(freeCalls>0);assert.equal((await pool.query("SELECT count(*)::integer AS n FROM provider_request WHERE status<>'reserved'")).rows[0].n,0,'This suite never dispatches paid work.');
    console.log('PASS concurrent tracker starts serialize; no paid/provider call or worker was invoked');
  }finally{try{await stopJobs();}finally{globalThis.fetch=priorFetch;}}
}
if(import.meta.main){try{await runRankExecutionChecks();}finally{await closeDatabase();}}
