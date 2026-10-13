import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import type {PoolClient} from 'pg';
import {getConfig} from '../src/server/config.ts';
import {assertSchema,getDatabase,closeDatabase} from '../src/server/db.ts';
import {stopJobs} from '../src/server/jobs.ts';
import {saveBudget,saveProvider} from '../src/server/providers.ts';
import {changeRankKeywords} from '../src/server/rank-tracking.ts';
import {quoteRankCheck,startRankCheck,getRankRun} from '../src/server/rank-execution.ts';
import {expireRankData,previewRankRetention} from '../src/server/rank-retention.ts';
import {getRetention,previewRetention,saveRetention,runRetentionBatch} from '../src/server/retention.ts';
import {keywordAccountEndpoint} from '../src/server/keyword-research-input.ts';

export async function runRankRetentionChecks(){
  assert.equal(process.env.TEN98_INTEGRATION_TEST,'1');assert.equal(process.env.TEN98_RANK_RETENTION_TEST,'1');
  const config=getConfig(),url=new URL(config.databaseUrl),loopback=['localhost','127.0.0.1','[::1]'];
  const ci=process.env.GITHUB_ACTIONS==='true'&&process.env.TEN98_ISOLATED_CI_DATABASE==='1'&&url.pathname==='/ten98_rank_retention_ci';
  assert.ok(loopback.includes(url.hostname)&&loopback.includes(new URL(config.appUrl).hostname));assert.equal(url.port,ci?'5432':'55501');assert.equal(url.search,'');assert.equal(url.hash,'');assert.match(url.pathname,/^\/ten98_rank_retention_[a-z0-9_]+$/);
  await assertSchema();const pool=getDatabase().pool;assert.equal((await pool.query('SELECT count(*)::int AS n FROM workspace')).rows[0].n,0,'Use a fresh owned migrated fixture.');
  const owner=randomUUID(),viewer=randomUUID(),cutoff=new Date('2026-01-01T00:00:00Z'),early=new Date('2000-01-01T00:00:00Z'),later=new Date('2026-01-02T00:00:00Z');
  const rawOnly={rawCutoff:cutoff,derivedCutoff:early},both={rawCutoff:cutoff,derivedCutoff:cutoff};
  const originalFetch=globalThis.fetch;let unexpected=0;globalThis.fetch=async()=>{unexpected++;throw new Error('External calls are forbidden in retention acceptance.');};
  const send:typeof fetch=async(input,init)=>{assert.equal(input,keywordAccountEndpoint);assert.equal(init?.method,'GET');const price=[{cost_type:'per_request',cost:0.001}];return Response.json({status_code:20000,cost:0,tasks_count:1,tasks_error:0,tasks:[{status_code:20000,cost:0,path:['v3','appendix','user_data'],result_count:1,result:[{login:'rank-retention@integration.test',price:{serp:{live:{advanced:{priority_normal:price}},task_post:{priority_normal:price},task_get:{advanced:{priority_normal:[{cost_type:'per_request',cost:0}]}}}}}]}]});};
  async function fixture(count=1,devices:'desktop'|'both'='desktop'){
    const f={workspace:randomUUID(),project:randomUUID(),tracker:randomUUID(),connection:''};
    await pool.query("INSERT INTO workspace(id,name) VALUES($1,'Rank retention fixture')",[f.workspace]);
    for(const [uid,role]of [[owner,'owner'],[viewer,'viewer']])await pool.query('INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,$3)',[f.workspace,uid,role]);
    await pool.query("INSERT INTO project(id,workspace_id,name,origin,public_key,retention_next_run_at) VALUES($1,$2,'Rank retention','https://example.com',$3,'infinity')",[f.project,f.workspace,randomUUID()]);
    f.connection=(await saveProvider(f.workspace,owner,{provider:'dataforseo',name:'Synthetic account',credentials:{login:'rank-retention@integration.test',password:'synthetic-only'},monthlyLimitUsd:'100'})).connection.id;
    await saveBudget(f.workspace,owner,{monthlyLimitUsd:'100',paused:false});
    await pool.query(`INSERT INTO rank_config(id,workspace_id,project_id,name,target_domain,location_code,location_name,location_type,country_location_code,country_iso,language_code,language_name,catalog_verified_at,devices,serp_depth,max_crawl_pages)
      VALUES($1,$2,$3,'Rank retention','example.com',2840,'United States','Country',2840,'US','en','English',clock_timestamp(),$4,100,1)`,[f.tracker,f.workspace,f.project,devices]);
    await changeRankKeywords(f.project,owner,f.tracker,'add',{requestId:randomUUID(),revision:1,keywords:Array.from({length:count},(_,i)=>'Retained term '+i),matchCase:true});
    await pool.query('UPDATE rank_keyword SET pinned_at=created_at WHERE config_id=$1',[f.tracker]);return f;
  }
  type Fixture=Awaited<ReturnType<typeof fixture>>;
  async function receipt(f:Fixture,started=true){
    const c=(await pool.query('SELECT revision,keywords_revision FROM rank_config WHERE id=$1',[f.tracker])).rows[0],quoteKey=randomUUID();
    const quoted=await quoteRankCheck(f.project,owner,f.tracker,{requestId:quoteKey,connectionId:f.connection,revision:c.revision,keywordsRevision:c.keywords_revision,method:'queued'},send);assert.ok(quoted);
    const key=randomUUID(),id=quoted.run.id;
    if(started){await startRankCheck(f.project,owner,id,{requestId:key});
      await pool.query("UPDATE provider_request SET status='settled',actual_micros=estimate_micros WHERE id IN(SELECT id FROM rank_dispatch WHERE run_id=$1)",[id]);
      await pool.query("UPDATE rank_dispatch SET phase='finished',dispatched_at=clock_timestamp(),completed_at=clock_timestamp(),charge_evidence='{\"receipt\":true}' WHERE run_id=$1",[id]);
      await pool.query(`UPDATE rank_task SET result_status='ranked',provider_task_id=id::text,provider_status=20000,position=1,rank_basis='organic',absolute_position=2,
        ranking_url='https://example.com/ranked',serp_features='["organic"]',checked_depth=10,returned_item_count=10,observed_at=clock_timestamp(),retrieved_at=clock_timestamp(),
        provisional_micros=1000,final_micros=1000,final_charge_at=clock_timestamp(),charge_evidence='{"receipt":true}',raw_evidence='{"synthetic":"provider evidence"}' WHERE run_id=$1`,[id]);
      await pool.query("UPDATE rank_run SET status='completed',completed_at=clock_timestamp() WHERE id=$1",[id]);
    }
    return {id,key,quoteKey,f};
  }
  type Receipt=Awaited<ReturnType<typeof receipt>>;
  async function age(r:Receipt,at:string='2025-12-31T23:59:59.999999Z',observed:string='2026-01-02T00:00:00Z'){
    await pool.query("UPDATE rank_run SET created_at=$2::timestamptz-interval '1 minute',started_at=$2,expires_at=$2::timestamptz+interval '4 minutes' WHERE id=$1",[r.id,at]);
    await pool.query('UPDATE rank_task SET observed_at=$2 WHERE run_id=$1',[r.id,observed]);
  }
  async function gates(client:PoolClient,f:Fixture){await client.query('BEGIN');await client.query("SET LOCAL statement_timeout='2s'");await client.query('SELECT id FROM workspace WHERE id=$1 FOR UPDATE',[f.workspace]);await client.query('SELECT id FROM project WHERE id=$1 FOR UPDATE',[f.project]);}
  async function expire(f:Fixture,cutoffs=rawOnly){const c=await pool.connect();try{await gates(c,f);const value=await expireRankData(c,f.project,cutoffs);await c.query('COMMIT');return value;}finally{await c.query('ROLLBACK').catch(()=>{});c.release();}}
  async function preview(f:Fixture,cutoffs=rawOnly){const c=await pool.connect();try{return await previewRankRetention(c,f.workspace,cutoffs);}finally{c.release();}}
  async function row(r:Receipt){return(await pool.query('SELECT * FROM rank_run WHERE id=$1',[r.id])).rows[0];}
  async function taskCounts(r:Receipt){return(await pool.query(`SELECT count(*)::int AS total,count(raw_evidence)::int AS raw,count(position)::int AS ranked,count(data_expired_at)::int AS expired,count(raw_expired_at)::int AS raw_expired FROM rank_task WHERE run_id=$1`,[r.id])).rows[0];}
  async function durable(r:Receipt){return(await pool.query(`SELECT r.request,r.request_hash,r.request_key,r.account_fingerprint,r.account_fingerprint_version,
    (SELECT jsonb_agg(jsonb_build_object('id',d.id,'request',d.request,'hash',d.request_hash,'charge',d.charge_evidence) ORDER BY d.id) FROM rank_dispatch d WHERE d.run_id=r.id) AS dispatch,
    (SELECT jsonb_agg(jsonb_build_object('id',p.id,'key',p.request_key,'status',p.status,'actual',p.actual_micros,'hash',p.input_hash) ORDER BY p.id) FROM provider_request p JOIN rank_dispatch d ON d.id=p.id WHERE d.run_id=r.id) AS ledger,
    (SELECT jsonb_agg(jsonb_build_object('id',t.id,'keyword',t.keyword,'keywordId',t.keyword_id,'status',t.result_status,'observed',t.observed_at,'retrieved',t.retrieved_at,'charge',t.charge_evidence,'final',t.final_micros,'finalAt',t.final_charge_at) ORDER BY t.id) FROM rank_task t WHERE t.run_id=r.id) AS tasks,
    (SELECT jsonb_agg(to_jsonb(k) ORDER BY k.id) FROM rank_keyword k WHERE k.config_id=r.config_id) AS authored,
    (SELECT jsonb_agg(to_jsonb(c) ORDER BY c.request_id) FROM project_content_request c WHERE c.project_id=r.project_id) AS receipts
    FROM rank_run r WHERE r.id=$1`,[r.id])).rows[0];}
  try{
    for(const id of [owner,viewer])await pool.query('INSERT INTO "user"(id,name,email) VALUES($1,$2,$3)',[id,'Rank retention fixture',id+'@integration.test']);
    const f=await fixture(),old=await receipt(f),exact=await receipt(f),newer=await receipt(f),foreign=await receipt(await fixture());
    await age(old);await age(exact,cutoff.toISOString());await age(newer,'2026-01-01T00:00:00.000001Z');await age(foreign);
    const before=await durable(old);assert.deepEqual(await preview(f),{status:'available',rawRuns:1,rawTasks:1,derivedRuns:0,derivedTasks:0,keywordMetrics:0,atLeast:false});
    assert.equal((await expire(f)).clearedRankEvidence,1);assert.deepEqual(await durable(old),before);assert.equal((await row(old)).data_expired_at,null);
    for(const r of [exact,newer,foreign])assert.equal((await taskCounts(r)).raw,1);
    assert.equal((await expire(f)).pending,false);
    console.log('PASS strict microsecond cutoff, raw-only evidence removal and immutable authored/financial/idempotency receipts');

    const individual=await receipt(await fixture(2));await age(individual,later.toISOString());
    const oldTask=(await pool.query('SELECT id FROM rank_task WHERE run_id=$1 ORDER BY id LIMIT 1',[individual.id])).rows[0].id;
    await pool.query("UPDATE rank_task SET observed_at=$2::timestamptz-interval '1 microsecond' WHERE id=$1",[oldTask,cutoff]);
    assert.equal((await expire(individual.f,both)).expiredRankTasks,1);assert.equal((await row(individual)).data_expired_at,null);assert.equal((await taskCounts(individual)).ranked,1);
    const individualDto=(await getRankRun(individual.f.project,owner,individual.id)).run;assert.equal(individualDto.tasks.filter((t:any)=>t.dataExpiredAt).length,1);
    console.log('PASS older provider observation expires independently without hiding a newer sibling in the same run');

    const batched=await receipt(await fixture(501,'both'));await age(batched);const batchedBefore=await durable(batched);
    const first=await expire(batched.f,both);assert.equal(first.expiredRankRuns,1);assert.equal(first.expiredRankTasks,1000);assert.equal(first.clearedRankEvidence,1000);assert.equal(first.pending,true);
    assert.deepEqual(await taskCounts(batched),{total:1002,raw:2,ranked:2,expired:1000,raw_expired:1000});
    const masked=(await getRankRun(batched.f.project,viewer,batched.id)).run;assert.ok(masked.dataExpiredAt);assert.equal(masked.tasks.length,1002);
    for(const t of masked.tasks){assert.ok(t.dataExpiredAt);for(const key of ['position','rankBasis','absolutePosition','rankingUrl','serpFeatures','checkedDepth','returnedItemCount'])assert.equal((t as any)[key],null);}
    assert.deepEqual(await durable(batched),batchedBefore);assert.equal(masked.costStatus,'final');assert.equal(masked.knownChargeUsd,'1.002000');
    const extension=await expire(batched.f,{rawCutoff:early,derivedCutoff:early});assert.equal(extension.pending,false);assert.equal(extension.expiredRankTasks,2);assert.equal((await taskCounts(batched)).raw,0,'An irreversible run marker finishes residual cleanup despite longer policy.');
    assert.ok((await getRankRun(batched.f.project,owner,batched.id)).run.tasks.every((t:any)=>t.dataExpiredAt));
    const last=await expire(batched.f,{rawCutoff:early,derivedCutoff:cutoff});assert.equal(last.expiredRankTasks,0);assert.equal(last.pending,false);assert.equal((await taskCounts(batched)).ranked,0);
    console.log('PASS bounded 1000-task cleanup, raw/derived policy ordering and actual member DTO masking of residual children');

    const reopened=await receipt(await fixture());await age(reopened);await pool.query("UPDATE rank_run SET status='waiting',completed_at=NULL WHERE id=$1",[reopened.id]);
    assert.equal((await expire(reopened.f,both)).expiredRankRuns,1);assert.equal((await row(reopened)).status,'waiting');assert.equal((await row(reopened)).completed_at,null);
    const t=(await pool.query('SELECT id FROM rank_task WHERE run_id=$1',[reopened.id])).rows[0].id;
    await assert.rejects(pool.query("UPDATE rank_task SET raw_evidence='{\"late\":true}' WHERE id=$1",[t]),(e:any)=>e.code==='23514');
    await pool.query("UPDATE rank_run SET status='completed',completed_at=clock_timestamp() WHERE id=$1",[reopened.id]);assert.ok((await getRankRun(reopened.f.project,owner,reopened.id)).run.dataExpiredAt);
    const unstarted=await receipt(await fixture(),false),unstartedBefore=await row(unstarted);await expire(unstarted.f,{rawCutoff:new Date(Date.now()+86400000),derivedCutoff:new Date(Date.now()+86400000)});assert.deepEqual(await row(unstarted),unstartedBefore);
    console.log('PASS reopened collection cannot renew the original retention age; unstarted idempotency quotes remain unchanged');

    const rollback=await receipt(await fixture());await age(rollback);const c=await pool.connect();try{await gates(c,rollback.f);await expireRankData(c,rollback.f.project,both);await c.query('ROLLBACK');}finally{c.release();}
    assert.equal((await taskCounts(rollback)).raw,1);assert.equal((await row(rollback)).data_expired_at,null);
    const settings=await receipt(await fixture(501,'both'));await age(settings,new Date(Date.now()-400*86400000).toISOString());
    assert.equal((await runRetentionBatch(settings.f.project))?.complete,false);const current=await getRetention(settings.f.workspace,owner);
    const proposal=await previewRetention(settings.f.workspace,owner,{revision:current.revision,settings:{...current.settings,rawProviderEvidenceDays:3650,derivedHistoryDays:3650}});assert.equal(proposal.rankEstimate.rawTasks,2);assert.equal(proposal.rankEstimate.derivedTasks,2);
    await assert.rejects(previewRetention(settings.f.workspace,viewer,{revision:current.revision,settings:current.settings}),(e:any)=>e.status===403);
    const gate=await pool.connect();let saved!:Promise<unknown>;try{await gates(gate,settings.f);let done=false;saved=saveRetention(settings.f.workspace,owner,{previewToken:proposal.previewToken}).then(x=>{done=true;return x;});await delay(30);assert.equal(done,false);assert.equal(await runRetentionBatch(settings.f.project),null);await gate.query('COMMIT');await saved;}finally{await gate.query('ROLLBACK').catch(()=>{});gate.release();}
    assert.equal((await runRetentionBatch(settings.f.project))?.complete,true);assert.equal((await taskCounts(settings)).raw,0);assert.ok((await getRankRun(settings.f.project,viewer,settings.id)).run.dataExpiredAt);
    console.log('PASS whole-pass rollback, current owner preview, live policy gate and policy extension without resurrection');

    const metric=await fixture(1000),secondConfig=randomUUID(),metricRun=randomUUID(),metricQuote=randomUUID();
    await pool.query(`INSERT INTO rank_config(id,workspace_id,project_id,name,target_domain,location_code,location_name,location_type,country_location_code,country_iso,language_code,language_name,catalog_verified_at,devices,serp_depth,max_crawl_pages)
      SELECT $2,workspace_id,project_id,'Second tracker','other.example.com',location_code,location_name,location_type,country_location_code,country_iso,language_code,language_name,catalog_verified_at,devices,serp_depth,max_crawl_pages FROM rank_config WHERE id=$1`,[metric.tracker,secondConfig]);
    await pool.query("INSERT INTO rank_keyword(id,workspace_id,project_id,config_id,keyword,pinned_at) VALUES($1,$2,$3,$4,'Other retained term',clock_timestamp())",[randomUUID(),metric.workspace,metric.project,secondConfig]);
    await pool.query(`INSERT INTO provider_request(id,workspace_id,connection_id,user_id,request_key,operation,input_hash,estimate_micros,actual_micros,connection_revision,status,budget_month)
      VALUES($1,$2,$3,$4,$5,'keyword.overview',$6,1,0,1,'settled',current_date)`,[metricRun,metric.workspace,metric.connection,owner,randomUUID(),'a'.repeat(64)]);
    await pool.query(`INSERT INTO keyword_quote(id,workspace_id,project_id,user_id,connection_id,connection_revision,request,account_fingerprint,per_task_micros,per_item_micros,estimate_micros,price_as_of,expires_at)
      VALUES($1,$2,$3,$4,$5,1,'{}',$6,0,1,1,clock_timestamp(),clock_timestamp()+interval '5 minutes')`,[metricQuote,metric.workspace,metric.project,owner,metric.connection,'b'.repeat(64)]);
    await pool.query("INSERT INTO keyword_research_run(id,workspace_id,project_id,user_id,quote_id,status,completed_at) VALUES($1,$2,$3,$4,$5,'completed',clock_timestamp())",[metricRun,metric.workspace,metric.project,owner,metricQuote]);
    await pool.query(`UPDATE rank_keyword SET metric_data='{"volume":10,"cpc":"1.200000"}',metric_source_run_id=$2,metric_source_row=0,metric_observed_at=$3::timestamptz-interval '1 microsecond',metric_fetched_at=clock_timestamp(),metric_version=8,last_metric_attempt_version=9,last_metric_attempt_status='missing',last_metric_attempt_at=clock_timestamp() WHERE project_id=$1`,[metric.project,metricRun,cutoff]);
    for(const [name,microseconds] of [['Exact metric',0],['Newer metric',1]] as const) await pool.query(`INSERT INTO rank_keyword(id,workspace_id,project_id,config_id,keyword,pinned_at,metric_data,metric_source_run_id,metric_source_row,metric_observed_at,metric_fetched_at) VALUES($1,$2,$3,$4,$5,clock_timestamp(),'{"volume":99}',$6,0,$7::timestamptz+$8*interval '1 microsecond',clock_timestamp())`,[randomUUID(),metric.workspace,metric.project,secondConfig,name,metricRun,cutoff,microseconds]);
    const authorRows=(await pool.query('SELECT id,keyword,pinned_at,created_at,metric_source_run_id,metric_source_row,metric_observed_at,metric_fetched_at,metric_version,last_metric_attempt_version,last_metric_attempt_status,last_metric_attempt_at FROM rank_keyword WHERE project_id=$1 ORDER BY id',[metric.project])).rows;
    assert.equal((await preview(metric,both)).keywordMetrics,1001);assert.equal((await expire(metric,rawOnly)).expiredRankKeywordMetrics,0);
    const metricsFirst=await expire(metric,both);assert.equal(metricsFirst.expiredRankKeywordMetrics,1000);assert.equal(metricsFirst.pending,true);assert.equal((await expire(metric,both)).expiredRankKeywordMetrics,1);assert.equal((await expire(metric,both)).pending,false);
    assert.deepEqual((await pool.query('SELECT id,keyword,pinned_at,created_at,metric_source_run_id,metric_source_row,metric_observed_at,metric_fetched_at,metric_version,last_metric_attempt_version,last_metric_attempt_status,last_metric_attempt_at FROM rank_keyword WHERE project_id=$1 ORDER BY id',[metric.project])).rows,authorRows);
    assert.ok((await pool.query('SELECT revision,authored_revision,metrics_revision FROM rank_config WHERE project_id=$1',[metric.project])).rows.every(r=>r.revision===1&&Number(r.metrics_revision)>=2));
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM rank_keyword WHERE project_id=$1 AND metric_data IS NULL AND metric_expired_at IS NOT NULL',[metric.project])).rows[0].n,1001);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM rank_keyword WHERE project_id=$1 AND metric_data IS NOT NULL',[metric.project])).rows[0].n,2);
    console.log('PASS independently aged metric snapshots, bounded cleanup and metric-only revisions preserve pins, authored identity and source receipts');

    const capped=await fixture(1000,'both');for(let n=0;n<6;n++){const r=await receipt(capped);await age(r);}
    assert.deepEqual(await preview(capped,both),{status:'available',rawRuns:6,rawTasks:10000,derivedRuns:6,derivedTasks:10000,keywordMetrics:0,atLeast:true});
    assert.deepEqual(await preview(capped,{rawCutoff:early,derivedCutoff:early}),{status:'available',rawRuns:0,rawTasks:0,derivedRuns:0,derivedTasks:0,keywordMetrics:0,atLeast:false});
    console.log('PASS capped lower-bound previews never invent exact counts beyond the 10000-row limit');
    assert.equal(unexpected,0);
  }finally{try{await stopJobs();}finally{globalThis.fetch=originalFetch;}}
}
if(import.meta.main){try{await runRankRetentionChecks();}finally{await closeDatabase();}}
