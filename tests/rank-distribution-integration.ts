import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {getConfig} from '../src/server/config.ts';
import {assertSchema,getDatabase,closeDatabase} from '../src/server/db.ts';
import {FoundationError} from '../src/server/auth.ts';
import {canonicalHash} from '../src/server/context-input.ts';
import {saveProvider} from '../src/server/providers.ts';
import {createApiKey} from '../src/server/api-keys.ts';
import {compileRankPlan,rankGroupPayload,rankPlanTotal,type RankPlan} from '../src/server/rank-execution-plan.ts';
import {getRankDistribution,type RankDistribution} from '../src/server/rank-distribution.ts';

/** Opt-in only: provision and migrate a NEW loopback fixture externally. Never
 * point this suite at a user database. No HTTP service, worker or provider needed. */
export async function runRankDistributionChecks(){
  assert.equal(process.env.TEN98_INTEGRATION_TEST,'1');assert.equal(process.env.TEN98_RANK_DISTRIBUTION_TEST,'1');
  const config=getConfig(),url=new URL(config.databaseUrl),loopback=['localhost','127.0.0.1','[::1]'];
  const ci=process.env.GITHUB_ACTIONS==='true'&&process.env.TEN98_ISOLATED_CI_DATABASE==='1';
  assert.ok(loopback.includes(url.hostname)&&loopback.includes(new URL(config.appUrl).hostname));assert.equal(url.port,ci?'5432':'55501');assert.equal(url.search,'');assert.equal(url.hash,'');assert.match(url.pathname,/^\/ten98_rank_distribution_[a-z0-9_]+$/);
  await assertSchema();const pool=getDatabase().pool;assert.equal((await pool.query('SELECT count(*)::int AS n FROM workspace')).rows[0].n,0,'Use a fresh owned migrated distribution fixture.');
  const originalFetch=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;throw new Error('Distribution must not request a provider.');};
  const owner=randomUUID(),viewer=randomUUID(),outsider=randomUUID(),now=Date.now();const at=(days:number)=>new Date(now-days*86400000).toISOString();
  const fails=(status:number)=>(error:unknown)=>error instanceof FoundationError&&error.status===status;
  for(const id of [owner,viewer,outsider])await pool.query('INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,$2,$3,true,now(),now())',[id,'Synthetic distribution reader',id+'@integration.test']);
  type Keyword={id:string;keyword:string;matchCase:boolean};
  async function fixture(terms:string[],devices:'desktop'|'mobile'|'both'='both'){
    const f={workspace:randomUUID(),project:randomUUID(),tracker:randomUUID(),connection:'',keywords:terms.map(keyword=>({id:randomUUID(),keyword,matchCase:true}))};
    await pool.query("INSERT INTO workspace(id,name) VALUES($1,'Rank distribution fixture')",[f.workspace]);
    for(const [uid,role]of [[owner,'owner'],[viewer,'viewer']])await pool.query('INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,$3)',[f.workspace,uid,role]);
    await pool.query("INSERT INTO project(id,workspace_id,name,origin,public_key,retention_next_run_at) VALUES($1,$2,'Distribution','https://example.com',$3,'infinity')",[f.project,f.workspace,randomUUID()]);
    f.connection=(await saveProvider(f.workspace,owner,{provider:'dataforseo',name:'Synthetic distribution account',credentials:{login:'distribution@integration.test',password:'synthetic-only'},monthlyLimitUsd:'100'})).connection.id;
    await pool.query(`INSERT INTO rank_config(id,workspace_id,project_id,name,target_domain,location_code,location_name,location_type,country_location_code,country_iso,language_code,language_name,catalog_verified_at,devices,serp_depth,max_crawl_pages)
      VALUES($1,$2,$3,'Distribution tracker','example.com',2840,'United States','Country',2840,'US','en','English',clock_timestamp(),$4,100,1)`,[f.tracker,f.workspace,f.project,devices]);
    await pool.query(`INSERT INTO rank_keyword(id,workspace_id,project_id,config_id,keyword,match_case)
      SELECT k.id,$2,$3,$4,k.keyword,k."matchCase" FROM jsonb_to_recordset($1::jsonb) k(id uuid,keyword text,"matchCase" boolean)`,[JSON.stringify(f.keywords),f.workspace,f.project,f.tracker]);return f;
  }
  type Fixture=Awaited<ReturnType<typeof fixture>>;
  type Observation={status?:'ranked'|'not_found'|'failed'|'pending'|'uncertain'|'cancelled'|'unavailable';position?:number;basis?:'organic'|'absolute';depth?:number;observed?:string;retrieved?:string};
  type Options={devices?:'desktop'|'mobile'|'both';keywords?:Keyword[];target?:Partial<RankPlan['target']>;created?:string;started?:string;subset?:boolean;quote?:boolean;runStatus?:'completed'|'partial'|'failed'|'waiting';observation?:Observation|((keyword:Keyword,device:'desktop'|'mobile')=>Observation)};
  async function run(f:Fixture,opt:Options={}){
    const id=randomUUID(),created=opt.created??at(0),keywords=opt.keywords??f.keywords;
    const plan=compileRankPlan({method:'queued',target:{domain:'example.com',locationCode:2840,languageCode:'en',depth:100,maxCrawlPages:1,...opt.target},devices:opt.devices??'desktop',keywords,baseMicros:1000n});
    const status=opt.quote?'quoted':opt.runStatus??'completed';
    await pool.query(`INSERT INTO rank_run(id,workspace_id,project_id,config_id,user_id,trigger,method,status,config_revision,keywords_revision,connection_id,connection_revision,account_fingerprint,connection_name,request,request_hash,task_count,estimate_micros,price_as_of,expires_at,request_key,is_subset,created_at,started_at,completed_at)
      VALUES($1,$2,$3,$4,$5,'manual','queued',$6,1,1,$7,1,$8,'Synthetic',$9,$10,$11,$12,$13::timestamptz,$13::timestamptz+interval '5 minutes',$14,$15,$13,$16,$17)`,
      [id,f.workspace,f.project,f.tracker,owner,status,f.connection,'a'.repeat(64),JSON.stringify(plan),canonicalHash(plan),plan.tasks.length,rankPlanTotal(plan).toString(),created,opt.quote?null:randomUUID(),opt.subset??false,opt.quote?null:opt.started??created,opt.quote||status==='waiting'?null:created]);
    if(!opt.quote)for(const [ordinal,group]of plan.groups.entries()){
      const dispatch=randomUUID(),payload=rankGroupPayload(plan,group);
      await pool.query(`INSERT INTO provider_request(id,workspace_id,connection_id,user_id,request_key,operation,input_hash,estimate_micros,actual_micros,connection_revision,status,budget_month)
        VALUES($1,$2,$3,$4,$5,'rank.queued',$6,$7,$7,1,'settled',date_trunc('month',now())::date)`,[dispatch,f.workspace,f.connection,owner,randomUUID(),'b'.repeat(64),group.maximumMicros]);
      await pool.query(`INSERT INTO rank_dispatch(id,workspace_id,project_id,run_id,ordinal,method,task_count,request,request_hash,phase,dispatched_at,completed_at)
        VALUES($1,$2,$3,$4,$5,'queued',$6,$7,$8,'finished',$9,$9)`,[dispatch,f.workspace,f.project,id,ordinal,group.taskIds.length,JSON.stringify(payload),canonicalHash(payload),created]);
      const taskIds=new Set(group.taskIds),rows=plan.tasks.filter(task=>taskIds.has(task.id)).map(task=>{
        const observation=typeof opt.observation==='function'?opt.observation({id:task.keywordId,keyword:task.keyword,matchCase:task.matchCase},task.device):opt.observation??{},state=observation.status??'ranked',measured=state==='ranked'||state==='not_found',ranked=state==='ranked';
        return {...task,status:state,position:ranked?observation.position??8:null,basis:ranked?observation.basis??'organic':null,depth:measured?observation.depth??100:null,
          observed:measured?observation.observed??created:null,retrieved:measured?observation.retrieved??created:null};});
      await pool.query(`INSERT INTO rank_task(id,workspace_id,project_id,run_id,dispatch_id,keyword_id,keyword,match_case,device,result_status,position,rank_basis,absolute_position,ranking_url,serp_features,checked_depth,returned_item_count,observed_at,retrieved_at,raw_evidence)
        SELECT t.id,$2,$3,$4,$5,t."keywordId",t.keyword,t."matchCase",t.device,t.status,t.position,t.basis,t.position,
          CASE WHEN t.status='ranked' THEN 'https://example.com/result' END,CASE WHEN t.observed IS NOT NULL THEN '["organic"]'::jsonb END,t.depth,
          CASE WHEN t.observed IS NOT NULL THEN 100 END,t.observed,t.retrieved,CASE WHEN t.observed IS NOT NULL THEN '{}'::jsonb END
        FROM jsonb_to_recordset($1::jsonb) t(id uuid,"keywordId" uuid,keyword text,"matchCase" boolean,device text,status text,position integer,basis text,depth integer,observed timestamptz,retrieved timestamptz)`,[JSON.stringify(rows),f.workspace,f.project,id,dispatch]);
    }
    return {id,plan,tasks:plan.tasks.map(task=>task.id)};
  }
  const distribution=(f:Fixture,query:Record<string,string>={})=>getRankDistribution(f.project,viewer,f.tracker,new URLSearchParams(query));
  function reconciles(result:RankDistribution){
    assert.equal(Object.values(result.totals.counts).reduce((sum,n)=>sum+n,0),result.totals.denominator);
    assert.equal(result.byDevice.reduce((sum,row)=>sum+row.denominator,0),result.totals.denominator);
    for(const row of result.byDevice)assert.equal(Object.values(row.counts).reduce((sum,n)=>sum+n,0),row.denominator);
    for(const key of Object.keys(result.totals.counts) as (keyof RankDistribution['totals']['counts'])[])assert.equal(result.byDevice.reduce((sum,row)=>sum+row.counts[key],0),result.totals.counts[key]);
  }
  try{
    const positions=[1,3,4,10,11,20,21,100,101],f=await fixture([...positions.map(n=>'Organic '+n),'Absolute','Deep negative','Shallow negative','Zero coverage','Failed','Pending','Never checked']);
    const first=await run(f,{keywords:f.keywords.slice(0,-1),subset:true,runStatus:'partial',created:at(1),observation:keyword=>{
      const index=f.keywords.findIndex(k=>k.id===keyword.id);if(index<positions.length)return {position:positions[index]};
      return index===9?{position:2,basis:'absolute'}:index===10?{status:'not_found'}:index===11?{status:'not_found',depth:99}:index===12?{status:'not_found',depth:0}:index===13?{status:'failed'}:{status:'pending'};
    }});
    const all=await distribution(f),desktop=await distribution(f,{device:'desktop'});reconciles(all);reconciles(desktop);
    assert.equal(all.keywordCount,16);assert.equal(all.totals.denominator,32);assert.equal(all.byDevice[1].counts.neverChecked,16);
    assert.deepEqual(desktop.totals.counts,{organic1To3:2,organic4To10:2,organic11To20:2,organic21To100:2,organicAbove100:1,absoluteRanked:1,notFoundThrough100:1,limitedCoverage:2,neverChecked:1,expired:0,pending:1,unavailable:1,incompatible:0});
    assert.deepEqual(desktop.totals.observedCoverage,{count:13,complete:false});assert.deepEqual(desktop.totals.top100Comparable,{count:10,complete:false});
    assert.equal(desktop.observationDates.earliestObservedAt?.slice(0,23),at(1).slice(0,23));assert.equal(desktop.observationDates.latestObservedAt,desktop.observationDates.earliestObservedAt);
    assert.deepEqual(desktop.source,{provider:'dataforseo',engine:'google',report:'organic_search'});assert.equal(desktop.role,'viewer');assert.equal(desktop.mode,'latest');assert.equal(desktop.run,null);
    console.log('PASS disjoint boundary buckets, depth-aware negatives, separate absolute ranks, source dates and per-device/total reconciliation');

    const order=await fixture(['Observed order','Equal timestamps','Expired versus failure','Expired versus pending'],'desktop');
    await run(order,{keywords:[order.keywords[0]],created:at(2),observation:{position:3,observed:'2026-01-01T00:00:00.000002Z'}});
    await run(order,{keywords:[order.keywords[0]],created:at(1),observation:{position:30,observed:'2026-01-01T00:00:00.000001Z'}});
    await run(order,{keywords:[order.keywords[0]],created:at(.1),observation:{status:'failed'}});
    const tiedA=await run(order,{keywords:[order.keywords[1]],created:at(2),observation:{position:4,observed:'2026-02-01T00:00:00.000001Z'}}),tiedB=await run(order,{keywords:[order.keywords[1]],created:at(1),observation:{position:11,observed:'2026-02-01T00:00:00.000001Z'}});
    const expired=await run(order,{keywords:order.keywords.slice(2),created:at(3),observation:{position:1}});
    await pool.query('UPDATE rank_run SET data_expired_at=clock_timestamp() WHERE id=$1',[expired.id]);
    await run(order,{keywords:[order.keywords[2]],created:at(1),observation:{status:'failed'}});await run(order,{keywords:[order.keywords[3]],created:at(.5),observation:{status:'pending'}});
    const ordered=await distribution(order);assert.equal(ordered.totals.counts.organic1To3,1);assert.equal(ordered.totals.counts.expired,2);
    assert.equal(ordered.totals.counts[tiedA.tasks[0]>tiedB.tasks[0]?'organic4To10':'organic11To20'],1);assert.equal(ordered.observationDates.earliestObservedAt,'2026-01-01T00:00:00.000002Z');
    const retry=await distribution(order);assert.deepEqual(retry.totals,ordered.totals);assert.equal((await pool.query('SELECT count(*)::int AS n FROM rank_task WHERE run_id=$1',[expired.id])).rows[0].n,2);
    await assert.rejects(distribution(order,{device:'mobile'}),fails(400));
    console.log('PASS latest observation by microsecond/source time, deterministic ties, later failed attempts, read retries, expired evidence precedence and disabled device rejection');

    const incompatible=await fixture(['Domain','Location','Language','Depth','Pages','Captured text','Case','Compatible fallback'],'desktop');
    const changes:Partial<RankPlan['target']>[]=[{domain:'other.example.com'},{locationCode:2826},{languageCode:'fr'},{depth:50},{maxCrawlPages:2}];
    for(let i=0;i<changes.length;i++)await run(incompatible,{keywords:[incompatible.keywords[i]],target:changes[i],observation:{position:1}});
    await run(incompatible,{keywords:[{...incompatible.keywords[5],keyword:'Former captured text'}]});await run(incompatible,{keywords:[{...incompatible.keywords[6],matchCase:false}]});
    await run(incompatible,{keywords:[incompatible.keywords[7]],created:at(2),observation:{position:20}});await run(incompatible,{keywords:[incompatible.keywords[7]],created:at(1),target:{depth:50},observation:{position:1}});
    const incompatibleResult=await distribution(incompatible);assert.equal(incompatibleResult.totals.counts.incompatible,7);assert.equal(incompatibleResult.totals.counts.organic11To20,1);reconciles(incompatibleResult);
    const replaced=await fixture(['Stable identity'],'desktop'),historical=await run(replaced,{observation:{position:3}});
    await pool.query('DELETE FROM rank_keyword WHERE id=$1',[replaced.keywords[0].id]);const freshId=randomUUID();await pool.query('INSERT INTO rank_keyword(id,workspace_id,project_id,config_id,keyword,match_case) VALUES($1,$2,$3,$4,$5,true)',[freshId,replaced.workspace,replaced.project,replaced.tracker,'Stable identity']);
    assert.equal((await distribution(replaced)).totals.counts.neverChecked,1);const captured=await distribution(replaced,{runId:historical.id});assert.equal(captured.totals.counts.organic1To3,1);assert.equal(captured.totals.observedCoverage.complete,true);
    await pool.query("UPDATE rank_config SET target_domain='changed.example.com',location_code=2826,language_code='fr',devices='mobile',serp_depth=50,max_crawl_pages=2 WHERE id=$1",[replaced.tracker]);
    const unchanged=await distribution(replaced,{runId:historical.id});assert.deepEqual(unchanged.target,{domain:'example.com',locationCode:2840,languageCode:'en',depth:100,maxCrawlPages:1});assert.deepEqual(unchanged.selectedDevices,['desktop']);assert.deepEqual(unchanged.totals,captured.totals);await assert.rejects(distribution(replaced,{runId:historical.id,device:'mobile'}),fails(400));
    console.log('PASS exact target/text/case compatibility and stable UUIDs; historical run keeps its immutable target and removed captured pairs');

    const runResult=await distribution(f,{runId:first.id});assert.equal(runResult.run?.status,'partial');assert.equal(runResult.run?.isSubset,true);assert.equal(runResult.keywordCount,15);assert.equal(runResult.totals.denominator,15);assert.equal(runResult.totals.counts.neverChecked,0);reconciles(runResult);
    const truth=await fixture(['One','Two'],'both');const shallow=await run(truth,{devices:'both',observation:(_keyword,device)=>device==='desktop'?{position:1}:{status:'not_found',depth:10}});
    let truthResult=await distribution(truth,{runId:shallow.id});assert.deepEqual(truthResult.totals.observedCoverage,{count:4,complete:true});assert.deepEqual(truthResult.totals.top100Comparable,{count:2,complete:false});
    await pool.query("UPDATE rank_task SET raw_evidence=NULL,raw_expired_at=clock_timestamp() WHERE run_id=$1",[shallow.id]);assert.deepEqual((await distribution(truth,{runId:shallow.id})).totals,truthResult.totals);
    await pool.query('UPDATE rank_run SET data_expired_at=clock_timestamp() WHERE id=$1',[shallow.id]);truthResult=await distribution(truth,{runId:shallow.id});assert.equal(truthResult.totals.counts.expired,4);assert.equal(truthResult.totals.observedCoverage.count,0);assert.equal(truthResult.observationDates.latestObservedAt,null);assert.ok(truthResult.run?.dataExpiredAt);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM rank_task WHERE run_id=$1 AND position IS NOT NULL',[shallow.id])).rows[0].n,2,'Tombstone masks residual payload before physical cleanup.');assert.equal((await distribution(truth)).totals.counts.expired,4);
    const taskExpired=await fixture(['Expired task'],'desktop'),expiredTask=await run(taskExpired);await pool.query('UPDATE rank_task SET position=NULL,rank_basis=NULL,absolute_position=NULL,ranking_url=NULL,serp_features=NULL,raw_evidence=NULL,data_expired_at=now() WHERE id=$1',[expiredTask.tasks[0]]);
    assert.equal((await distribution(taskExpired,{runId:expiredTask.id})).totals.counts.expired,1);assert.equal((await distribution(taskExpired)).totals.counts.expired,1);
    await run(taskExpired,{created:at(2),observation:{position:10}});assert.equal((await distribution(taskExpired)).totals.counts.organic4To10,1,'Latest available observation can predate an expired observation.');
    const missing=await fixture(['Missing child'],'desktop'),missingRun=await run(missing);await pool.query('DELETE FROM rank_task WHERE id=$1',[missingRun.tasks[0]]);
    const missingResult=await distribution(missing,{runId:missingRun.id});assert.equal(missingResult.run?.status,'completed');assert.equal(missingResult.totals.counts.unavailable,1);assert.equal(missingResult.totals.observedCoverage.complete,false);
    const shallowRequest=await run(missing,{target:{depth:50},observation:{status:'not_found',depth:100}});
    assert.equal((await distribution(missing,{runId:shallowRequest.id})).totals.counts.limitedCoverage,1,'Stored coverage cannot assert more than the immutable requested depth.');
    const quote=await run(truth,{quote:true,devices:'both'}),quoted=await distribution(truth,{runId:quote.id});assert.equal(quoted.run?.status,'quoted');assert.equal(quoted.totals.denominator,4);assert.equal(quoted.totals.counts.neverChecked,4);assert.equal(quoted.totals.observedCoverage.complete,false);
    const skippedId=randomUUID(),request={version:1,skipped:true,target:quote.plan.target};
    await pool.query(`INSERT INTO rank_run(id,workspace_id,project_id,config_id,user_id,trigger,method,status,config_revision,keywords_revision,connection_id,connection_revision,account_fingerprint,connection_name,request,request_hash,task_count,estimate_micros,price_as_of,completed_at,approval_id,scheduled_for,approval_snapshot)
      VALUES($1,$2,$3,$4,$5,'scheduled','queued','skipped',1,1,$6,1,$7,'Synthetic',$8,$9,0,0,now(),now(),$10,now(),'{}')`,[skippedId,truth.workspace,truth.project,truth.tracker,owner,truth.connection,'a'.repeat(64),JSON.stringify(request),canonicalHash(request),randomUUID()]);
    const skipped=await distribution(truth,{runId:skippedId});assert.equal(skipped.run?.status,'skipped');assert.equal(skipped.totals.denominator,0);assert.equal(skipped.totals.observedCoverage.complete,false);assert.equal(skipped.totals.top100Comparable.complete,false);assert.deepEqual(skipped.enabledDevices,[]);reconciles(skipped);await assert.rejects(distribution(truth,{runId:skippedId,device:'desktop'}),fails(400));
    const empty=await fixture([]);assert.equal((await distribution(empty)).totals.denominator,0);assert.equal((await distribution(empty)).totals.observedCoverage.complete,false);
    console.log('PASS partial/subset run, raw-only expiry, run/task tombstones, shallow complete observations, quotes, skipped receipts and empty tracker without false complete coverage');

    const outsiderFixture=await fixture(['Foreign'],'desktop'),foreignRun=await run(outsiderFixture);
    for(const action of [()=>getRankDistribution(f.project,outsider,f.tracker),()=>distribution({...f,tracker:outsiderFixture.tracker}),()=>distribution(f,{runId:foreignRun.id})])await assert.rejects(action(),fails(404));
    for(const query of ['unknown=1','device=tablet','device=desktop&device=mobile','runId='+first.id+'&runId='+first.id,'runId=not-a-uuid','search=One','pinned=true'])await assert.rejects(getRankDistribution(f.project,viewer,f.tracker,new URLSearchParams(query)),fails(400));
    const publicResult=JSON.stringify(await distribution(f));for(const privateField of ['account_fingerprint','connectionId','synthetic-only','raw_evidence','ranking_url','request_hash','keywordId','provider_task_id'])assert.ok(!publicResult.includes(privateField));
    const lock=await pool.connect();try{
      await lock.query('BEGIN');await lock.query('LOCK TABLE rank_config IN ACCESS EXCLUSIVE MODE');
      // Admission reads membership before the tracker read is held. Observe that
      //actual wait, then commit a different target, expiry and role in one writer.
      const held=distribution(outsiderFixture);let waiting=false;
      for(let i=0;i<100;i++){waiting=(await pool.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND state='active' AND wait_event_type='Lock' AND query LIKE 'SELECT target_domain,%') AS waiting")).rows[0].waiting;if(waiting)break;await delay(20);}
      assert.equal(waiting,true,'The admitted read must actually wait before the concurrent commit.');
      await lock.query("UPDATE rank_config SET target_domain='later.example.com' WHERE id=$1",[outsiderFixture.tracker]);
      await lock.query('UPDATE rank_run SET data_expired_at=clock_timestamp() WHERE id=$1',[foreignRun.id]);
      await lock.query('DELETE FROM membership WHERE workspace_id=$1 AND user_id=$2',[outsiderFixture.workspace,viewer]);await lock.query('COMMIT');
      const snapshot=await held;assert.equal(snapshot.target.domain,'example.com');assert.equal(snapshot.totals.counts.organic4To10,1);assert.equal(snapshot.totals.counts.expired,0);
      await assert.rejects(distribution(outsiderFixture),fails(404));
      const fresh=await getRankDistribution(outsiderFixture.project,owner,outsiderFixture.tracker);assert.equal(fresh.target.domain,'later.example.com');assert.equal(fresh.totals.counts.incompatible,1);assert.ok(fresh.asOf>snapshot.asOf);
    }finally{await lock.query('ROLLBACK').catch(()=>{});lock.release();}
    const integrity=await fixture(['Integrity'],'desktop'),integrityRun=await run(integrity);await pool.query("UPDATE rank_task SET keyword='Mismatched task' WHERE id=$1",[integrityRun.tasks[0]]);await assert.rejects(distribution(integrity,{runId:integrityRun.id}),fails(409));
    const timeout=await pool.connect();try{await timeout.query('BEGIN');await timeout.query('LOCK TABLE rank_config IN ACCESS EXCLUSIVE MODE');
      await assert.rejects(distribution(f),error=>error instanceof FoundationError&&error.status===503&&error.message==='The rank distribution took too long. Try one device or a saved check.');
    }finally{await timeout.query('ROLLBACK');timeout.release();}
    const rankReader=await createApiKey(f.workspace,owner,{name:'Rank reader',scopes:['rank:read']}),noScope=await createApiKey(f.workspace,owner,{name:'No rank scope',scopes:['projects:read']}),comparable=(value:RankDistribution)=>({...value,asOf:null});
    assert.deepEqual(comparable(await getRankDistribution(f.project,owner,f.tracker,new URLSearchParams(),rankReader.token)),comparable(await getRankDistribution(f.project,owner,f.tracker)),'A rank:read key reads the same distribution as its issuer.');
    await assert.rejects(getRankDistribution(f.project,owner,f.tracker,new URLSearchParams(),noScope.token),fails(403));await assert.rejects(getRankDistribution(f.project,viewer,f.tracker,new URLSearchParams(),rankReader.token),fails(404),'The key binds its issuer.');
    assert.equal(calls,0);console.log('PASS current viewer/tenant scope, coherent admitted snapshot across concurrent target/expiry/removal and next-request denial, strict filters, bearer parity and secret-free/no-provider reads');

    const perf=await fixture(Array.from({length:1000},(_,index)=>'Distribution load '+index));
    const days=process.env.TEN98_RANK_DISTRIBUTION_SCALE_TEST==='1'?365:20;
    for(let i=0;i<days;i++)await run(perf,{devices:'both',created:at(i+.01),observation:{position:(i%100)+1}});
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM rank_task WHERE project_id=$1',[perf.project])).rows[0].n,days*2000);
    await pool.query('ANALYZE rank_keyword');await pool.query('ANALYZE rank_run');await pool.query('ANALYZE rank_task');
    const timings:number[]=[];for(let i=0;i<3;i++){const start=performance.now(),result=await distribution(perf);timings.push(performance.now()-start);assert.equal(result.totals.denominator,2000);assert.equal(result.totals.counts.organic1To3,2000);assert.equal(result.totals.observedCoverage.complete,true);assert.equal(result.totals.top100Comparable.complete,true);reconciles(result);}
    await pool.query('UPDATE rank_run SET data_expired_at=now() WHERE project_id=$1',[perf.project]);const start=performance.now(),expiredAll=await distribution(perf);assert.equal(expiredAll.totals.counts.expired,2000);assert.equal(expiredAll.totals.observedCoverage.complete,false);assert.equal(expiredAll.observationDates.latestObservedAt,null);reconciles(expiredAll);
    assert.equal(calls,0);console.log('PASS analyzed full2,000-cell distribution over'+(days*2000)+' observations; timings ms='+timings.map(n=>n.toFixed(1)).join(',')+'; tombstone ms='+(performance.now()-start).toFixed(1));
  }finally{globalThis.fetch=originalFetch;}
}
if(import.meta.main){try{await runRankDistributionChecks();}finally{await closeDatabase();}}
