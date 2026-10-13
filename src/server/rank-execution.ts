import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {z} from 'zod';
import {FoundationError} from './auth.ts';
import {canonicalHash,parse} from './context-input.ts';
import {contentReceipt} from './project-context.ts';
import {withKeywordProject,keywordConnection,keywordCredentials} from './keyword-research.ts';
import {getBoss} from './jobs.ts';
import {reserveSpendInTransaction} from './spending.ts';
import {microUsd} from './keyword-research-input.ts';
import {readRankAccount} from './dataforseo-rank.ts';
import {parseRankBasePrices,parseRankSerpRequest} from './rank-serp-input.ts';
import {rankRecoverableSql} from './rank-worker.ts';
import {compileRankPlan,rankQuoteInput,rankPlanTotal,readRankPlan,rankGroupPayload,type RankPlan} from './rank-execution-plan.ts';

export const rankQueue='rank-dispatch';
const writers=['owner','admin','editor'],readers=[...writers,'viewer'];
const runInput=z.object({requestId:z.uuid()}).strict();
async function config(client:PoolClient,projectId:string,id:string){
  const row=(await client.query('SELECT * FROM rank_config WHERE id=$1 AND project_id=$2 FOR UPDATE',[id,projectId])).rows[0];
  if(!row)throw new FoundationError(404,'Rank tracker not found or unavailable.');return row;
}
function currentConfig(row:any,revision:number,keywordsRevision:number){
  if(row.archived_at||row.revision!==revision||row.keywords_revision!==keywordsRevision)throw new FoundationError(409,'The tracker or keywords changed. Prepare a new check quote.');
}
async function runRow(client:PoolClient,projectId:string,id:string){
  const row=(await client.query('SELECT * FROM rank_run WHERE id=$1 AND project_id=$2',[id,projectId])).rows[0];
  if(!row)throw new FoundationError(404,'Rank check not found or unavailable.');return row;
}
async function runDto(client:PoolClient,row:any,userId:string,role:string){
  const charges=(await client.query(`SELECT count(*)::integer AS total,count(*) FILTER(WHERE p.status='reserved')::integer AS reserved,
    count(*) FILTER(WHERE p.status='uncertain' OR d.phase='uncertain')::integer AS uncertain,count(*) FILTER(WHERE p.status='dispatched')::integer AS pending,
    COALESCE(sum(p.actual_micros) FILTER(WHERE p.status='settled'),0)::text AS known_micros,
    count(*) FILTER(WHERE p.status='cancelled')::integer AS cancelled
    FROM rank_dispatch d JOIN provider_request p ON p.id=d.id WHERE d.run_id=$1`,[row.id])).rows[0];
  let plan:Pick<RankPlan,'target'|'tasks'|'groups'>;
  if(row.status==='skipped'){
    if(row.trigger!=='scheduled'||row.task_count!==0||row.estimate_micros!=='0'||charges.total!==0||row.request?.version!==1||row.request?.skipped!==true||canonicalHash(row.request)!==row.request_hash)throw new FoundationError(409,'The skipped rank receipt is inconsistent.');
    const {keyword:_keyword,device:_device,...target}=parseRankSerpRequest({...row.request.target,keyword:'scope',device:'desktop'});
    plan={target,tasks:[],groups:[]};
  }else plan=readRankPlan(row.request,row.request_hash);
  const dispatches=(await client.query(`SELECT d.id,d.ordinal,d.phase,d.task_count AS "taskCount",d.dispatched_at AS "dispatchedAt",d.completed_at AS "completedAt",d.diagnostic,
    ($2::boolean AND d.dispatched_at<=clock_timestamp()-interval '2 minutes' AND d.dispatched_at>=clock_timestamp()-interval '28 days' AND (${rankRecoverableSql})) IS TRUE AS "canReconcile",
    CASE WHEN d.phase='uncertain' THEN 'uncertain' ELSE p.status END AS "costStatus",
    p.estimate_micros,p.actual_micros FROM rank_dispatch d JOIN provider_request p ON p.id=d.id JOIN rank_run r ON r.id=d.run_id JOIN workspace w ON w.id=r.workspace_id WHERE d.run_id=$1 ORDER BY d.ordinal`,[row.id,role==='owner'])).rows.map(({estimate_micros,actual_micros,...dispatch})=>({...dispatch,estimateUsd:microUsd(BigInt(estimate_micros)),actualUsd:actual_micros===null?null:microUsd(BigInt(actual_micros))}));
  // Run tombstones take effect immediately, including children awaiting a bounded
  // cleanup batch. Expired observations must never leak through a detail read.
  const tasks=(await client.query(`SELECT id,keyword_id AS "keywordId",keyword,match_case AS "matchCase",device,result_status AS status,
    CASE WHEN $2::timestamptz IS NULL AND data_expired_at IS NULL THEN position END AS position,
    CASE WHEN $2::timestamptz IS NULL AND data_expired_at IS NULL THEN rank_basis END AS "rankBasis",
    CASE WHEN $2::timestamptz IS NULL AND data_expired_at IS NULL THEN absolute_position END AS "absolutePosition",
    CASE WHEN $2::timestamptz IS NULL AND data_expired_at IS NULL THEN ranking_url END AS "rankingUrl",
    CASE WHEN $2::timestamptz IS NULL AND data_expired_at IS NULL THEN serp_features END AS "serpFeatures",
    CASE WHEN $2::timestamptz IS NULL AND data_expired_at IS NULL THEN checked_depth END AS "checkedDepth",
    CASE WHEN $2::timestamptz IS NULL AND data_expired_at IS NULL THEN returned_item_count END AS "returnedItemCount",
    observed_at AS "observedAt",retrieved_at AS "retrievedAt",diagnostic,
    COALESCE(raw_expired_at,$3::timestamptz) AS "rawExpiredAt",COALESCE(data_expired_at,$2::timestamptz) AS "dataExpiredAt"
    FROM rank_task WHERE run_id=$1 ORDER BY keyword,keyword_id,device`,[row.id,row.data_expired_at,row.raw_expired_at])).rows;
  return {id:row.id,trackerId:row.config_id,status:row.status,method:row.method,trigger:row.trigger,isSubset:row.is_subset,
    target:plan.target,connectionName:row.connection_name,taskCount:row.task_count,dispatchCount:plan.groups.length,
    estimateUsd:microUsd(BigInt(row.estimate_micros)),knownChargeUsd:microUsd(BigInt(charges.known_micros)),
    costStatus:charges.uncertain?'uncertain':charges.pending||charges.reserved?'pending':charges.total?'final':'not_started',
    priceAsOf:row.status==='skipped'?null:row.price_as_of,expiresAt:row.expires_at,createdAt:row.created_at,scheduledFor:row.scheduled_for,startedAt:row.started_at,completedAt:row.completed_at,
    quoteExpired:row.status==='quoted'&&row.expires_at.getTime()<=Date.now(),
    canStart:row.status==='quoted'&&row.user_id===userId&&writers.includes(role)&&row.expires_at.getTime()>Date.now(),
    canCancel:!!charges.reserved&&writers.includes(role)&&(row.user_id===userId||role==='owner'),diagnostic:row.diagnostic,rawExpiredAt:row.raw_expired_at,dataExpiredAt:row.data_expired_at,
    quotedTasks:row.status==='quoted'?plan.tasks.map(task=>({keywordId:task.keywordId,keyword:task.keyword,device:task.device,maximumUsd:microUsd(BigInt(task.maximumMicros))})):[],dispatches,tasks};
}
export async function getRankRun(projectId:string,userId:string,id:string){
  id=parse(z.uuid(),id);return withKeywordProject(projectId,userId,readers,async(client,_wid,role)=>({role,run:await runDto(client,await runRow(client,projectId,id),userId,role)}));
}
export async function quoteRankCheck(projectId:string,userId:string,configId:string,raw:unknown,send:typeof fetch=fetch){
  configId=parse(z.uuid(),configId);const input=parse(rankQuoteInput,raw),receiptInput={userId,...input};
  if(input.keywordIds&&new Set(input.keywordIds).size!==input.keywordIds.length)throw new FoundationError(400,'Choose each keyword only once.');
  const before=await withKeywordProject(projectId,userId,writers,async(client,wid,role)=>{
    const receipt=await contentReceipt(client,projectId,input.requestId,'rank.quote:'+configId,receiptInput);
    if(receipt.replayed)return {replay:{role,run:await runDto(client,await runRow(client,projectId,receipt.result.id),userId,role),replayed:true}};
    const tracker=await config(client,projectId,configId);currentConfig(tracker,input.revision,input.keywordsRevision);
    const rows=(await client.query('SELECT id,keyword,match_case AS "matchCase" FROM rank_keyword WHERE config_id=$1 AND project_id=$2 AND ($3::uuid[] IS NULL OR id=ANY($3::uuid[])) ORDER BY created_at,id',[configId,projectId,input.keywordIds??null])).rows;
    if(!rows.length||rows.length>1000||input.keywordIds&&rows.length!==input.keywordIds.length)throw new FoundationError(409,'Some selected keywords are unavailable. Reload the tracker before quoting.');
    const connection=await keywordConnection(client,wid,input.connectionId);
    return {tracker,keywords:rows,revision:connection.revision,name:connection.name,credentials:keywordCredentials(connection)};
  });
  if('replay'in before)return before.replay;
  // Free account/price lookup occurs outside SQL locks. No reservation or job exists.
  const account=await readRankAccount(before.credentials,send),prices=parseRankBasePrices(account),priceAsOf=new Date();
  const target={domain:before.tracker.target_domain,locationCode:before.tracker.location_code,languageCode:before.tracker.language_code,depth:before.tracker.serp_depth,maxCrawlPages:before.tracker.max_crawl_pages};
  const plan=compileRankPlan({method:input.method,target,devices:before.tracker.devices,keywords:before.keywords,baseMicros:input.method==='live'?prices.liveMicros:prices.queuedMicros});
  return withKeywordProject(projectId,userId,writers,async(client,wid,role)=>{
    const receipt=await contentReceipt(client,projectId,input.requestId,'rank.quote:'+configId,receiptInput);
    if(receipt.replayed)return {role,run:await runDto(client,await runRow(client,projectId,receipt.result.id),userId,role),replayed:true};
    await keywordConnection(client,wid,input.connectionId,before.revision);
    currentConfig(await config(client,projectId,configId),input.revision,input.keywordsRevision);
    // A slow lock wait cannot extend the lifetime of old price evidence.
    const expiresAt=new Date(priceAsOf.getTime()+300_000);
    if(expiresAt.getTime()<=Date.now())throw new FoundationError(409,'The price quote expired while waiting. Prepare another quote.');
    const id=randomUUID();
    await client.query(`INSERT INTO rank_run(id,workspace_id,project_id,config_id,user_id,trigger,method,status,config_revision,keywords_revision,
      connection_id,connection_revision,account_fingerprint,account_fingerprint_version,connection_name,request,request_hash,task_count,
      estimate_micros,price_as_of,expires_at,is_subset)
      VALUES($1,$2,$3,$4,$5,'manual',$6,'quoted',$7,$8,$9,$10,$11,2,$12,$13,$14,$15,$16,$17,$18,$19)`,
      [id,wid,projectId,configId,userId,input.method,input.revision,input.keywordsRevision,input.connectionId,before.revision,account.fingerprint,before.name,JSON.stringify(plan),canonicalHash(plan),plan.tasks.length,rankPlanTotal(plan).toString(),priceAsOf,expiresAt,!!input.keywordIds]);
    await receipt.save({id});return {role,run:await runDto(client,await runRow(client,projectId,id),userId,role),replayed:false};
  });
}
/** Internal transaction seam. Caller holds W→P→tracker and has validated the
 * immutable run and current authority. A failed child always rolls back all work. */
export async function enqueueRankPlan(client:PoolClient,boss:Awaited<ReturnType<typeof getBoss>>,input:{runId:string;workspaceId:string;projectId:string;userId:string;connectionId:string;plan:RankPlan}):Promise<void>{
  const {runId:id,workspaceId:wid,projectId,userId,connectionId,plan}=input,tasks=new Map(plan.tasks.map(task=>[task.id,task]));
  for(const [ordinal,group] of plan.groups.entries()){
    const payload=rankGroupPayload(plan,group),hash=canonicalHash({runId:id,method:plan.method,payload});
    const reservation=await reserveSpendInTransaction(client,wid,userId,{connectionId,requestKey:group.requestKey,operation:'rank.'+plan.method,inputHash:hash,estimateUsd:microUsd(BigInt(group.maximumMicros))},async(client,dispatchId)=>{
      await client.query(`INSERT INTO rank_dispatch(id,workspace_id,project_id,run_id,ordinal,method,task_count,request,request_hash,phase)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'reserved')`,[dispatchId,wid,projectId,id,ordinal,plan.method,group.taskIds.length,JSON.stringify(payload),hash]);
      for(const taskId of group.taskIds){const task=tasks.get(taskId)!;
        await client.query(`INSERT INTO rank_task(id,workspace_id,project_id,run_id,dispatch_id,keyword_id,keyword,match_case,device,result_status)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending')`,[task.id,wid,projectId,id,dispatchId,task.keywordId,task.keyword,task.matchCase,task.device]);
      }
      const job=await boss.send(rankQueue,{dispatchId},{id:dispatchId,retryLimit:0,expireInSeconds:360,db:{executeSql:(text,values)=>client.query(text,values)}});
      if(!job)throw new Error('Rank check could not be queued.');
    });
    // A valid retry is handled by the parent receipt. An orphan ledger must not
    // silently skip child rows/jobs and leave a permanently queued run.
    if(!reservation.created)throw new FoundationError(409,'A reservation already exists for this quote. Ask the host operator to review it before proceeding.');
  }
}
export async function startRankCheck(projectId:string,userId:string,id:string,raw:unknown){
  id=parse(z.uuid(),id);const input=parse(runInput,raw),receiptInput={userId,...input};
  await withKeywordProject(projectId,userId,writers,async(client)=>{const row=await runRow(client,projectId,id);if(row.user_id!==userId)throw new FoundationError(403,'Only the user who requested this quote can start it.');});
  const boss=await getBoss();
  return withKeywordProject(projectId,userId,writers,async(client,wid,role)=>{
    const receipt=await contentReceipt(client,projectId,input.requestId,'rank.start:'+id,receiptInput);
    if(receipt.replayed)return {role,run:await runDto(client,await runRow(client,projectId,id),userId,role),replayed:true};
    const row=await runRow(client,projectId,id);
    if(row.user_id!==userId||row.status!=='quoted'||row.expires_at.getTime()<=Date.now())throw new FoundationError(409,'This quote was already started or expired. Reload it before proceeding.');
    currentConfig(await config(client,projectId,row.config_id),row.config_revision,row.keywords_revision);
    await keywordConnection(client,wid,row.connection_id,row.connection_revision);
    if((await client.query("SELECT id FROM rank_run WHERE config_id=$1 AND status IN('queued','running','waiting')",[row.config_id])).rowCount)throw new FoundationError(409,'This tracker already has a check in progress.');
    const plan=readRankPlan(row.request,row.request_hash);
    if(plan.method!==row.method||plan.tasks.length!==row.task_count||rankPlanTotal(plan).toString()!==row.estimate_micros)throw new FoundationError(409,'The saved quote is inconsistent.');
    await enqueueRankPlan(client,boss,{runId:id,workspaceId:wid,projectId,userId,connectionId:row.connection_id,plan});
    await client.query("UPDATE rank_run SET status='queued',request_key=$2,started_at=clock_timestamp() WHERE id=$1",[id,input.requestId]);
    await receipt.save({id});return {role,run:await runDto(client,await runRow(client,projectId,id),userId,role),replayed:false};
  });
}
