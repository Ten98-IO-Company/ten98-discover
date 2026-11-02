import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {getConfig} from '../src/server/config.ts';
import {assertSchema,getDatabase,closeDatabase} from '../src/server/db.ts';
import {getBoss,stopJobs} from '../src/server/jobs.ts';
import {saveProviderRequestControls,saveProvider,revokeProvider} from '../src/server/providers.ts';
import {reserveRequest} from '../src/server/provider-requests.ts';
import {canonicalHash} from '../src/server/context-input.ts';
import {getRankTracker,updateRankTracker,archiveRankTracker,changeRankKeywords} from '../src/server/rank-tracking.ts';
import {prepareRankCheck,startRankCheck,getRankRun} from '../src/server/rank-execution.ts';
import {rankGroupPayload,type RankPlan} from '../src/server/rank-execution-plan.ts';
import {keywordAccountEndpoint} from '../src/server/keyword-research-input.ts';

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
    assert.equal(url,keywordAccountEndpoint);assert.equal(init?.method,'GET');assert.equal(init?.redirect,'error');assert.equal(init?.credentials,'omit');freeCalls++; return Response.json({status_code:20000,tasks_count:1,tasks_error:0,tasks:[{status_code:20000,path:['v3','appendix','user_data'],result_count:1,result:[{login:'synthetic-rank@integration.test'}]}]});
  };
  async function fixture(count=2,devices='desktop'):Promise<Fixture>{
    const f={workspace:randomUUID(),project:randomUUID(),tracker:randomUUID(),connection:''};
    await pool.query("INSERT INTO workspace(id,name) VALUES($1,'Rank execution fixture')",[f.workspace]);
    for(const [uid,role]of [[owner,'owner'],[editor,'editor'],[viewer,'viewer']])await pool.query('INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,$3)',[f.workspace,uid,role]);
    await pool.query("INSERT INTO project(id,workspace_id,name,origin,public_key,retention_next_run_at) VALUES($1,$2,'Rank execution','https://example.com',$3,'infinity')",[f.project,f.workspace,randomUUID()]);
    f.connection=(await saveProvider(f.workspace,owner,{provider:'dataforseo',name:'Synthetic account',credentials:{login:'synthetic-rank@integration.test',password:'synthetic-never-live'}})).connection.id;
    await saveProviderRequestControls(f.workspace,owner,{paused:false});
    await pool.query(`INSERT INTO rank_config(id,workspace_id,project_id,name,target_domain,location_code,location_name,location_type,country_location_code,country_iso,language_code,language_name,catalog_verified_at,devices,serp_depth,max_crawl_pages)
      VALUES($1,$2,$3,'Rank execution','example.com',2840,'United States','Country',2840,'US','en','English',clock_timestamp(),$4,100,1)`,[f.tracker,f.workspace,f.project,devices]);
    await changeRankKeywords(f.project,owner,f.tracker,'add',{requestId:randomUUID(),revision:1,keywords:Array.from({length:count},(_,i)=>i===0?'C++ %20':'term '+i),matchCase:true});
    return f;
  }
  async function quoteBody(f:Fixture,extra:Record<string,unknown>={}){const t=(await getRankTracker(f.project,owner,f.tracker)).tracker;return {requestId:randomUUID(),connectionId:f.connection,revision:t.revision,keywordsRevision:t.keywordsRevision,method:'live',...extra};}
  async function quote(f:Fixture,extra:Record<string,unknown>={},user=owner,transport=send){const result=await prepareRankCheck(f.project,user,f.tracker,await quoteBody(f,extra),transport);assert.ok(result);return result;}
  const start=(f:Fixture,id:string,requestId=randomUUID(),user=owner)=>startRankCheck(f.project,user,id,{requestId});
  async function counts(f:Fixture){return (await pool.query(`SELECT (SELECT count(*)::integer FROM provider_request WHERE workspace_id=$1) AS requests,(SELECT count(*)::integer FROM rank_dispatch WHERE project_id=$2) AS dispatch,(SELECT count(*)::integer FROM rank_task WHERE project_id=$2) AS tasks`,[f.workspace,f.project])).rows[0];}
  async function expire(id:string){await pool.query("UPDATE rank_run SET created_at=clock_timestamp()-interval '10 minutes',expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[id]);}
  async function changeRole(f:Fixture,uid:string,role:string){const c=await pool.connect();try{await c.query('BEGIN');await c.query('SELECT id FROM workspace WHERE id=$1 FOR UPDATE',[f.workspace]);await c.query('UPDATE membership SET role=$3 WHERE workspace_id=$1 AND user_id=$2',[f.workspace,uid,role]);await c.query('COMMIT');}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}
  try{
    for(const id of [owner,editor,viewer,outsider])await pool.query("INSERT INTO \"user\"(id,name,email) VALUES($1,'Rank execution fixture',$2)",[id,id+'@rank-execution.integration.test']);
    const base=await fixture(2,'both'),input=await quoteBody(base),q=await prepareRankCheck(base.project,owner,base.tracker,input,send);assert.ok(q);
    assert.equal(q.run.taskCount,4);assert.equal(q.run.dispatchCount,4);assert.equal(Object.hasOwn(q.run,'estimateUsd'),false);assert.equal(q.run.requestStatus,'not_started');assert.equal(q.run.canStart,true);assert.deepEqual(await counts(base),{requests:0,dispatch:0,tasks:0});
    assert.equal((await getRankRun(base.project,viewer,q.run.id)).run.canStart,false);await assert.rejects(getRankRun(base.project,outsider,q.run.id),failed(404));
    await assert.rejects(prepareRankCheck(base.project,viewer,base.tracker,input,send),failed(404));await assert.rejects(prepareRankCheck(base.project,editor,base.tracker,input,send),failed(409));
    await assert.rejects(prepareRankCheck(base.project,owner,base.tracker,{...input,method:'queued'},send),failed(409));
    await expire(q.run.id);const calls=freeCalls,replayed=await prepareRankCheck(base.project,owner,base.tracker,input,send);assert.ok(replayed);assert.equal(replayed.replayed,true);assert.equal(replayed.run.id,q.run.id);assert.equal(replayed.run.preparationExpired,true);assert.equal(freeCalls,calls);await assert.rejects(start(base,q.run.id),failed(409));
    const other=await fixture();await assert.rejects(getRankRun(other.project,owner,q.run.id),failed(404));await assert.rejects(prepareRankCheck(base.project,owner,base.tracker,{...await quoteBody(base),connectionId:other.connection},send),failed(404));
    console.log('PASS exact preparations, literal captured pairs, actor/project receipts and expired preparation replay without new reservations');

    const held=await fixture();let enter!:()=>void,release!:()=>void;const ready=new Promise<void>(r=>enter=r),gate=new Promise<void>(r=>release=r);
    const heldInput=await quoteBody(held),pending=prepareRankCheck(held.project,editor,held.tracker,heldInput,async(...args)=>{enter();await gate;return send(...args);});
    const denied=assert.rejects(pending,failed(404));try{await reached(ready);await changeRole(held,editor,'viewer');}finally{release();}await denied;
    assert.equal((await pool.query('SELECT 1 FROM rank_run WHERE project_id=$1',[held.project])).rowCount,0);assert.equal((await pool.query('SELECT 1 FROM project_content_request WHERE project_id=$1 AND request_id=$2',[held.project,heldInput.requestId])).rowCount,0);
    const connectionRace=await fixture();let enter2!:()=>void,release2!:()=>void;const ready2=new Promise<void>(r=>enter2=r),gate2=new Promise<void>(r=>release2=r),raceBody=await quoteBody(connectionRace);
    const race=prepareRankCheck(connectionRace.project,owner,connectionRace.tracker,raceBody,async(...args)=>{enter2();await gate2;return send(...args);}),rejected=assert.rejects(race,failed(404));try{await reached(ready2);await revokeProvider(connectionRace.workspace,owner,connectionRace.connection);}finally{release2();}await rejected;assert.equal((await pool.query('SELECT 1 FROM rank_run WHERE project_id=$1',[connectionRace.project])).rowCount,0);
    const changedDuring=await fixture();let enter3!:()=>void,release3!:()=>void;const ready3=new Promise<void>(r=>enter3=r),gate3=new Promise<void>(r=>release3=r),changedBody=await quoteBody(changedDuring);
    const changing=prepareRankCheck(changedDuring.project,owner,changedDuring.tracker,changedBody,async(...args)=>{enter3();await gate3;return send(...args);}),stale=assert.rejects(changing,failed(409));
    try{await reached(ready3);const d=await getRankTracker(changedDuring.project,owner,changedDuring.tracker);await changeRankKeywords(changedDuring.project,owner,changedDuring.tracker,'remove',{requestId:randomUUID(),revision:d.tracker.authoredRevision,keywordIds:[d.keywords[0].id]});}finally{release3();}await stale;
    assert.equal((await pool.query('SELECT 1 FROM rank_run WHERE project_id=$1',[changedDuring.project])).rowCount,0);
    console.log('PASS free-account await rechecks live actor, connection and keyword scope before persisting any preparation');

    const working=await fixture(),fresh=await quote(working),details=await getRankTracker(working.project,owner,working.tracker),t=details.tracker;
    await updateRankTracker(working.project,owner,working.tracker,{requestId:randomUUID(),revision:t.authoredRevision,name:'Metadata rename',devices:t.devices,depth:t.depth,maxCrawlPages:t.maxCrawlPages});
    await assert.rejects(start(working,fresh.run.id,randomUUID(),editor),failed(403));
    const key=randomUUID(),accepted=await start(working,fresh.run.id,key);assert.equal(accepted.run.status,'queued');assert.equal(accepted.run.requestStatus,'reserved');assert.equal(accepted.run.tasks.length,2);assert.deepEqual(await counts(working),{requests:2,dispatch:2,tasks:2});
    const jobs=(await pool.query('SELECT j.id,j.retry_limit FROM pgboss.job j JOIN rank_dispatch d ON d.id=j.id WHERE d.run_id=$1',[fresh.run.id])).rows;assert.equal(jobs.length,2);assert.ok(jobs.every(j=>j.retry_limit===0));
    await expire(fresh.run.id);await pool.query('UPDATE rank_run SET request_version=0 WHERE id=$1',[fresh.run.id]);const retry=await start(working,fresh.run.id,key);assert.equal(retry.replayed,true);assert.deepEqual(await counts(working),{requests:2,dispatch:2,tasks:2});await assert.rejects(start(working,fresh.run.id),failed(409));
    await changeRole(working,owner,'viewer');await assert.rejects(start(working,fresh.run.id,key),failed(404));await changeRole(working,owner,'owner');
    console.log('PASS atomic request/queue/tasks, metadata-independent request scope and current-authority same-key start recovery after expiry');

    for(const mutation of ['settings','keywords','archive','connection'] as const){
      const f=await fixture(),q=await quote(f),d=await getRankTracker(f.project,owner,f.tracker),t=d.tracker;
      if(mutation==='settings')await updateRankTracker(f.project,owner,f.tracker,{requestId:randomUUID(),revision:t.authoredRevision,name:t.name,devices:t.devices,depth:90,maxCrawlPages:1});
      if(mutation==='keywords')await changeRankKeywords(f.project,owner,f.tracker,'remove',{requestId:randomUUID(),revision:t.authoredRevision,keywordIds:[d.keywords[0].id]});
      if(mutation==='archive')await archiveRankTracker(f.project,owner,f.tracker,{requestId:randomUUID(),revision:t.authoredRevision,archived:true});
      if(mutation==='connection')await saveProvider(f.workspace,owner,{name:'Changed credentials',credentials:{login:'synthetic-rank@integration.test',password:'synthetic-rotated'}},f.connection);
      await assert.rejects(start(f,q.run.id),failed(409));assert.deepEqual(await counts(f),{requests:0,dispatch:0,tasks:0});
    }
    console.log('PASS current request settings, captured keyword membership, archive and connection revisions fence stale starts');

    const queued=await fixture(101),queuedQuote=await quote(queued,{method:'queued'});assert.equal(queuedQuote.run.taskCount,101);assert.equal(queuedQuote.run.dispatchCount,2);assert.equal(Object.hasOwn(queuedQuote.run,'estimateUsd'),false);
    // Pause after the first group so the real manual-pause gate rolls back every group and the pause.
    await pool.query(`CREATE FUNCTION d3_sentinel() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.workspace_id=TG_ARGV[0] AND (SELECT count(*) FROM provider_request WHERE workspace_id=NEW.workspace_id)=TG_ARGV[1]::int THEN
        UPDATE workspace_provider_control SET paused=true WHERE workspace_id=NEW.workspace_id;
      END IF; RETURN NULL; END $$`);
    await pool.query(`CREATE TRIGGER d3_sentinel AFTER INSERT ON provider_request FOR EACH ROW EXECUTE FUNCTION d3_sentinel('${queued.workspace}','1')`);
    try{await assert.rejects(start(queued,queuedQuote.run.id),(error:any)=>failed(409)(error)&&error.code==='PROVIDER_REQUESTS_PAUSED'&&/paused/.test(error.message));}finally{await pool.query('DROP TRIGGER d3_sentinel ON provider_request');await pool.query('DROP FUNCTION d3_sentinel()');}
    assert.deepEqual(await counts(queued),{requests:0,dispatch:0,tasks:0});assert.equal((await pool.query('SELECT COALESCE((SELECT paused FROM workspace_provider_control WHERE workspace_id=$1),false) AS paused',[queued.workspace])).rows[0].paused,false);
    const rolled=await fixture(),rollbackQuote=await quote(rolled),boss=await getBoss(),originalSend=boss.send.bind(boss),inserted:string[]=[];
    boss.send=(async(...args:any[])=>{const job=await(originalSend as any)(...args);assert.equal(typeof job,'string');inserted.push(job);if(inserted.length===2)throw new Error('Synthetic failure after second real queue insertion.');return job;})as typeof boss.send;
    const rollbackKey=randomUUID();try{await assert.rejects(start(rolled,rollbackQuote.run.id,rollbackKey));}finally{boss.send=originalSend;}
    assert.equal(inserted.length,2);assert.equal((await pool.query('SELECT id FROM pgboss.job WHERE id=ANY($1::uuid[])',[inserted])).rowCount,0);assert.deepEqual(await counts(rolled),{requests:0,dispatch:0,tasks:0});assert.equal((await getRankRun(rolled.project,owner,rollbackQuote.run.id)).run.status,'quoted');assert.equal((await pool.query('SELECT 1 FROM project_content_request WHERE project_id=$1 AND request_id=$2',[rolled.project,rollbackKey])).rowCount,0);
    await start(rolled,rollbackQuote.run.id,rollbackKey);assert.deepEqual(await counts(rolled),{requests:2,dispatch:2,tasks:2});
    console.log('PASS second-child reservation and actual second queue insertion failures roll back the entire start, allowing one exact retry');

    const legacy=await fixture(),legacyPrepared=await quote(legacy),stored=(await pool.query('SELECT request,request_hash,request_version,estimate_micros,price_as_of FROM rank_run WHERE id=$1',[legacyPrepared.run.id])).rows[0];
    assert.equal(stored.request_version,1);assert.equal(stored.request.version,2);assert.equal(stored.estimate_micros,null);assert.equal(stored.price_as_of,null);
    // Historical version-1 values remain inert raw snapshot data; only request_version controls new work.
    const historical={...stored.request,version:1,baseMicros:'1000',tasks:stored.request.tasks.map((task:any)=>({...task,maximumMicros:'1000'})),groups:stored.request.groups.map((group:any)=>({...group,maximumMicros:'1000'}))};
    await pool.query('UPDATE rank_run SET request=$2,request_hash=$3,request_version=0 WHERE id=$1',[legacyPrepared.run.id,JSON.stringify(historical),canonicalHash(historical)]);
    assert.equal((await getRankRun(legacy.project,owner,legacyPrepared.run.id)).run.canStart,false);await assert.rejects(start(legacy,legacyPrepared.run.id),failed(409));assert.deepEqual(await counts(legacy),{requests:0,dispatch:0,tasks:0});
    // Build coherent captured children through the production Start transaction, then retain the historical raw plan.
    await pool.query('UPDATE rank_run SET request=$2,request_hash=$3,request_version=1 WHERE id=$1',[legacyPrepared.run.id,JSON.stringify(stored.request),stored.request_hash]);
    await start(legacy,legacyPrepared.run.id);
    await pool.query("UPDATE provider_request SET status='settled' WHERE id IN(SELECT id FROM rank_dispatch WHERE run_id=$1)",[legacyPrepared.run.id]);
    await pool.query("UPDATE rank_dispatch SET phase='finished',dispatched_at=clock_timestamp(),completed_at=clock_timestamp() WHERE run_id=$1",[legacyPrepared.run.id]);
    await pool.query("UPDATE rank_task SET result_status='not_found',provider_task_id=id::text,provider_status=20000,observed_at=clock_timestamp(),retrieved_at=clock_timestamp(),checked_depth=10,returned_item_count=0 WHERE run_id=$1",[legacyPrepared.run.id]);
    const historicalHash=canonicalHash(historical);await pool.query("UPDATE rank_run SET request=$2,request_hash=$3,request_version=0,status='completed',completed_at=clock_timestamp() WHERE id=$1",[legacyPrepared.run.id,JSON.stringify(historical),historicalHash]);
    const retained=await getRankRun(legacy.project,viewer,legacyPrepared.run.id);assert.equal(retained.run.status,'completed');assert.equal(retained.run.preparedTasks.length,0);assert.equal(retained.run.tasks.length,stored.request.tasks.length);assert.ok(retained.run.tasks.every((task:any)=>task.status==='not_found'));assert.equal(Object.hasOwn(retained.run,'estimateUsd'),false);
    const unchanged=(await pool.query('SELECT request,request_hash FROM rank_run WHERE id=$1',[legacyPrepared.run.id])).rows[0];assert.deepEqual(unchanged.request,historical);assert.equal(unchanged.request_hash,historicalHash);
    console.log('PASS current request preparations omit monetary fields; unused legacy preparations are stale and completed raw legacy plans retain their exact hash/history');

    const orphan=await fixture(),oq=await quote(orphan),raw=(await pool.query('SELECT request FROM rank_run WHERE id=$1',[oq.run.id])).rows[0].request as RankPlan,group=raw.groups[0],payload=rankGroupPayload(raw,group),requestKey=randomUUID();
    await reserveRequest(orphan.workspace,owner,{connectionId:orphan.connection,requestKey:group.requestKey,operation:'rank.'+raw.method,inputHash:canonicalHash({runId:oq.run.id,method:raw.method,payload})});
    await assert.rejects(start(orphan,oq.run.id,requestKey),failed(409));assert.deepEqual(await counts(orphan),{requests:1,dispatch:0,tasks:0});assert.equal((await getRankRun(orphan.project,owner,oq.run.id)).run.status,'quoted');assert.equal((await pool.query('SELECT 1 FROM project_content_request WHERE project_id=$1 AND request_id=$2',[orphan.project,requestKey])).rowCount,0);
    console.log('PASS an identical orphan reservation cannot become a successful childless start');

    const competing=await fixture(),qa=await quote(competing),qb=await quote(competing),starts=await Promise.allSettled([start(competing,qa.run.id),start(competing,qb.run.id)]);
    assert.equal(starts.filter(r=>r.status==='fulfilled').length,1);assert.equal(starts.filter(r=>r.status==='rejected'&&failed(409)(r.reason)).length,1);assert.deepEqual(await counts(competing),{requests:2,dispatch:2,tasks:2});
    assert.equal(unexpected,0);assert.ok(freeCalls>0);assert.equal((await pool.query("SELECT count(*)::integer AS n FROM provider_request WHERE status<>'reserved' AND id NOT IN(SELECT id FROM rank_dispatch WHERE run_id=$1)",[legacyPrepared.run.id])).rows[0].n,0,'This suite never dispatches provider work.');
    console.log('PASS concurrent tracker starts serialize; no provider call or worker was invoked');
  }finally{try{await stopJobs();}finally{globalThis.fetch=priorFetch;}}
}
if(import.meta.main){try{await runRankExecutionChecks();}finally{await closeDatabase();}}
