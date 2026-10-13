import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import type {PoolClient} from 'pg';
import {z} from 'zod';
import {FoundationError} from './auth.ts';
import {getDatabase} from './db.ts';
import {getBoss} from './jobs.ts';
import {canonicalHash,parse} from './context-input.ts';
import {contentReceipt} from './project-context.ts';
import {withKeywordProject,keywordConnection,keywordCredentials} from './keyword-research.ts';
import {dispatchSpend,settleSpend} from './spending.ts';
import {microUsd} from './keyword-research-input.ts';
import {rankQueue,getRankRun} from './rank-execution.ts';
import {readRankPlan,rankGroupTasks,rankGroupPayload,rankPlanTotal,type RankPlan} from './rank-execution-plan.ts';
import {parseRankBasePrices,type RankMethod} from './rank-serp-input.ts';
import {readRankAccount,requestRankTasks,readRankTask} from './dataforseo-rank.ts';
import {parseRankDispatchOutcome,type RankDispatchOutcome,type RankExpectedTask} from './rank-provider-outcome.ts';
import type {DataforseoResponse} from './dataforseo-transport.ts';

export const rankPollQueue='rank-poll';
export type RankRecoveryBinding={connectionId:string;connectionRevision:number;approvedBy:string};
const recoveryInput=z.object({connectionId:z.uuid(),connectionRevision:z.number().int().positive(),approvedBy:z.uuid(),approvedAt:z.iso.datetime()}).strict();
function collectionBinding(row:RankDispatchSnapshot){
  if(row.charge_evidence&&Object.hasOwn(row.charge_evidence,'recovery')){const value=parse(recoveryInput,row.charge_evidence.recovery);return {id:value.connectionId,revision:value.connectionRevision};}
  return {id:row.connection_id,revision:row.connection_revision};
}
const writers=['owner','admin','editor'];
const uncertainMessage='The provider charge or result could not be confirmed. An owner must reconcile this check; it will not be sent again.';
const cancelledMessage='This check was cancelled before dispatch because its permissions, settings, connection or spending approval changed.';
export type RankDispatchSnapshot={id:string;workspace_id:string;project_id:string;run_id:string;ordinal:number;method:RankMethod;task_count:number;request:unknown;request_hash:string;phase:string;generation:string;lease_owner:string|null;lease_expires_at:Date|null;lease_current:boolean;dispatched_at:Date|null;collect_deadline:Date|null;next_poll_at:Date|null;poll_attempts:number;charge_evidence:Record<string,unknown>|null;
  user_id:string;connection_id:string;connection_revision:number;account_fingerprint:string;account_fingerprint_version:number;config_id:string;config_revision:number;keywords_revision:number;run_request:unknown;run_hash:string;run_estimate:string;run_task_count:number;run_status:string;run_created_at:Date;run_started_at:Date|null;run_raw_expired_at:Date|null;run_data_expired_at:Date|null;expires_at:Date;ledger_status:string;estimate_micros:string;actual_micros:string|null;ledger_hash:string};
export async function rankDispatchSnapshot(client:PoolClient,id:string):Promise<RankDispatchSnapshot|null>{
  return (await client.query<RankDispatchSnapshot>(`SELECT d.*,d.generation::text,COALESCE(d.lease_expires_at>clock_timestamp(),false) AS lease_current,
    r.user_id,r.connection_id,r.connection_revision,r.account_fingerprint,r.account_fingerprint_version,r.config_id,r.config_revision,r.keywords_revision,r.request AS run_request,r.request_hash AS run_hash,r.estimate_micros AS run_estimate,r.task_count AS run_task_count,r.status AS run_status,r.created_at AS run_created_at,r.started_at AS run_started_at,r.raw_expired_at AS run_raw_expired_at,r.data_expired_at AS run_data_expired_at,r.expires_at,
    p.status AS ledger_status,p.estimate_micros,p.actual_micros,p.input_hash AS ledger_hash
    FROM rank_dispatch d JOIN rank_run r ON r.id=d.run_id JOIN provider_request p ON p.id=d.id WHERE d.id=$1`,[id])).rows[0]??null;
}
async function locked<T>(id:string,work:(client:PoolClient,row:RankDispatchSnapshot)=>Promise<T>):Promise<T|null>{
  const pool=getDatabase().pool,hint=(await pool.query('SELECT workspace_id,project_id FROM rank_dispatch WHERE id=$1',[id])).rows[0];if(!hint)return null;
  const client=await pool.connect();try{await client.query('BEGIN');await client.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='10s'");
    await client.query('SELECT id FROM workspace WHERE id=$1 FOR UPDATE',[hint.workspace_id]);await client.query('SELECT id FROM project WHERE id=$1 AND workspace_id=$2 FOR UPDATE',[hint.project_id,hint.workspace_id]);
    const row=await rankDispatchSnapshot(client,id);const result=row?await work(client,row):null;await client.query('COMMIT');return result;
  }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}finally{client.release();}
}
function binding(row:RankDispatchSnapshot){
  const plan=readRankPlan(row.run_request,row.run_hash),group=plan.groups[row.ordinal];
  if(!group||plan.method!==row.method||plan.tasks.length!==row.run_task_count||rankPlanTotal(plan).toString()!==row.run_estimate||group.taskIds.length!==row.task_count||group.maximumMicros!==row.estimate_micros||
    !isDeepStrictEqual(rankGroupPayload(plan,group),row.request)||canonicalHash({runId:row.run_id,method:row.method,payload:row.request})!==row.request_hash||row.request_hash!==row.ledger_hash)throw new FoundationError(409,'The saved rank dispatch is inconsistent.');
  return {plan,group};
}
async function expectedTasks(client:PoolClient,row:RankDispatchSnapshot):Promise<RankExpectedTask[]>{
  const {plan,group}=binding(row),captured=new Map(plan.tasks.map(task=>[task.id,task])),stored=(await client.query('SELECT * FROM rank_task WHERE dispatch_id=$1',[row.id])).rows;
  if(stored.length!==group.taskIds.length)throw new FoundationError(409,'The saved rank tasks are inconsistent.');
  const byId=new Map(stored.map(task=>[task.id,task]));
  return rankGroupTasks(plan,group).map(task=>{const saved=byId.get(task.id),original=captured.get(task.id)!;
    if(!saved||saved.keyword_id!==original.keywordId||saved.keyword!==original.keyword||saved.match_case!==original.matchCase||saved.device!==original.device)throw new FoundationError(409,'The saved rank tasks are inconsistent.');
    return {...task,...(saved.provider_task_id?{providerTaskId:saved.provider_task_id}:{})};
  });
}
async function paidEligibility(client:PoolClient,row:RankDispatchSnapshot){
  const role=(await client.query('SELECT role FROM membership WHERE workspace_id=$1 AND user_id=$2',[row.workspace_id,row.user_id])).rows[0]?.role;
  const config=(await client.query('SELECT * FROM rank_config WHERE id=$1 AND project_id=$2 FOR UPDATE',[row.config_id,row.project_id])).rows[0];
  if(!writers.includes(role)||!config||config.archived_at||config.revision!==row.config_revision||config.keywords_revision!==row.keywords_revision||!['queued','running','waiting'].includes(row.run_status))throw new FoundationError(409,cancelledMessage);
  const {plan}=binding(row),ids=[...new Set(plan.tasks.map(task=>task.keywordId))],current=(await client.query('SELECT id,keyword,match_case FROM rank_keyword WHERE config_id=$1 AND project_id=$2 AND id=ANY($3::uuid[])',[row.config_id,row.project_id,ids])).rows;
  const map=new Map(current.map(item=>[item.id,item]));
  if(current.length!==ids.length||plan.tasks.some(task=>{const item=map.get(task.keywordId);return !item||item.keyword!==task.keyword||item.match_case!==task.matchCase;}))throw new FoundationError(409,cancelledMessage);
  await expectedTasks(client,row);return keywordConnection(client,row.workspace_id,row.connection_id,row.connection_revision);
}
export async function aggregateRankRun(client:PoolClient,runId:string){
  const rows=(await client.query('SELECT phase FROM rank_dispatch WHERE run_id=$1',[runId])).rows;if(!rows.length)return;
  const tasks=(await client.query('SELECT result_status FROM rank_task WHERE run_id=$1',[runId])).rows;
  const active=rows.some(r=>['reserved','dispatched','collecting'].includes(r.phase));
  const successes=tasks.filter(t=>['ranked','not_found'].includes(t.result_status)).length;
  const status=active?(rows.some(r=>r.phase==='dispatched')?'running':rows.some(r=>r.phase==='collecting')?'waiting':'queued'):rows.every(r=>r.phase==='cancelled')?'cancelled':successes===tasks.length?'completed':successes?'partial':'failed';
  await client.query(`UPDATE rank_run SET status=$2,completed_at=CASE WHEN $3 THEN NULL ELSE COALESCE(completed_at,clock_timestamp()) END,
    diagnostic=CASE WHEN EXISTS(SELECT 1 FROM rank_dispatch WHERE run_id=$1 AND phase='uncertain') THEN $4 ELSE NULL END WHERE id=$1 AND started_at IS NOT NULL`,[runId,status,active,uncertainMessage]);
}
async function markUncertain(client:PoolClient,row:RankDispatchSnapshot,message=uncertainMessage,conflictingCharge=false){
  if(row.ledger_status==='settled'&&!conflictingCharge){
    const diagnostic='The final charge is recorded, but remaining result evidence could not be collected.';
    await client.query("UPDATE rank_dispatch SET phase='finished',generation=generation+1,lease_owner=NULL,lease_expires_at=NULL,next_poll_at=NULL,completed_at=COALESCE(completed_at,clock_timestamp()),diagnostic=$2 WHERE id=$1",[row.id,diagnostic]);
    await client.query("UPDATE rank_task SET result_status='unavailable',diagnostic=$2 WHERE dispatch_id=$1 AND result_status IN('pending','uncertain','unavailable')",[row.id,diagnostic]);await aggregateRankRun(client,row.run_id);return;
  }
  if(['dispatched','uncertain'].includes(row.ledger_status))await settleSpend(client,row.workspace_id,row.id,null);
  else await client.query('UPDATE workspace_budget SET paused=true,updated_at=clock_timestamp() WHERE workspace_id=$1',[row.workspace_id]);
  await client.query("UPDATE rank_dispatch SET phase='uncertain',generation=generation+1,lease_owner=NULL,lease_expires_at=NULL,next_poll_at=NULL,completed_at=COALESCE(completed_at,clock_timestamp()),diagnostic=$2 WHERE id=$1",[row.id,message]);
  await client.query("UPDATE rank_task SET result_status='uncertain',diagnostic=$2 WHERE dispatch_id=$1 AND final_micros IS NULL AND result_status='pending'",[row.id,message]);await aggregateRankRun(client,row.run_id);
}
async function cancelUndispatched(client:PoolClient,row:RankDispatchSnapshot,message=cancelledMessage){
  if(row.phase!=='reserved'||!['reserved','cancelled'].includes(row.ledger_status))return;
  await client.query("UPDATE provider_request SET status='cancelled',updated_at=clock_timestamp() WHERE id=$1 AND status='reserved'",[row.id]);
  await client.query("UPDATE rank_dispatch SET phase='cancelled',generation=generation+1,lease_owner=NULL,lease_expires_at=NULL,completed_at=COALESCE(completed_at,clock_timestamp()),diagnostic=$2 WHERE id=$1",[row.id,message]);
  await client.query("UPDATE rank_task SET result_status='cancelled',diagnostic=$2 WHERE dispatch_id=$1 AND result_status='pending'",[row.id,message]);await aggregateRankRun(client,row.run_id);
}
const owns=(row:RankDispatchSnapshot,claim:{owner:string;generation:string})=>row.lease_owner===claim.owner&&row.generation===claim.generation&&row.lease_current;
async function queuePoll(client:PoolClient,id:string){
  const due=(await client.query("UPDATE rank_dispatch SET next_poll_at=clock_timestamp()+interval '5 seconds',lease_owner=NULL,lease_expires_at=NULL WHERE id=$1 RETURNING next_poll_at,generation::text",[id])).rows[0];
  const boss=await getBoss(),job=await boss.send(rankPollQueue,{dispatchId:id,generation:due.generation},{id:randomUUID(),retryLimit:0,expireInSeconds:120,startAfter:due.next_poll_at,db:{executeSql:(text,values)=>client.query(text,values)}});
  if(!job)throw new Error('Rank result collection could not be queued.');
}
function rawResult(response:DataforseoResponse|undefined,providerTaskId:string|null){
  if(!providerTaskId)return null;
  const body=response?.body as {tasks?:Array<{id?:string;result?:unknown}>}|undefined;
  if(!body||!Array.isArray(body.tasks))return null;const task=body.tasks.find(t=>t&&t.id===providerTaskId);
  if(!task||task.result==null)return null;
  const text=JSON.stringify({result:task.result});
  // PostgreSQL JSON cannot store NUL or lone UTF-16 surrogates. Do not roll back
  // a verified charge merely because optional raw evidence is unrepresentable.
  if(Buffer.byteLength(text)>33_554_432||/\\u0000|\\u[dD][89a-fA-F][a-fA-F0-9]{2}/.test(text))return null;return text;
}
async function applyOutcome(client:PoolClient,row:RankDispatchSnapshot,outcome:RankDispatchOutcome,response?:DataforseoResponse){
  const expected=await expectedTasks(client,row),allowed=new Map(expected.map(task=>[task.id,task])),seen=new Set<string>();
  for(const item of outcome.tasks){if(!allowed.has(item.id)||seen.has(item.id)||allowed.get(item.id)!.providerTaskId&&allowed.get(item.id)!.providerTaskId!==item.providerTaskId)throw new FoundationError(409,'The rank evidence no longer matches the saved task.');seen.add(item.id);}
  const retention=(await client.query(`SELECT clock_timestamp()-raw_provider_evidence_days*interval '24 hours' AS raw_cutoff,clock_timestamp()-derived_history_days*interval '24 hours' AS derived_cutoff FROM workspace WHERE id=$1`,[row.workspace_id])).rows[0];
  for(const item of outcome.tasks){
    const old=(await client.query('SELECT * FROM rank_task WHERE id=$1 AND dispatch_id=$2',[item.id,row.id])).rows[0];
    if(old.final_micros!==null&&item.finalMicros!==null&&item.finalMicros!==old.final_micros){await markUncertain(client,row,'The provider reported conflicting final charge evidence. An owner must review the saved charge; spending is paused.',true);return;}
    const start=row.run_started_at??row.run_created_at,anchor=new Date(Math.min(start.getTime(),item.observation?new Date(item.observation.observedAt).getTime():start.getTime(),old.observed_at?new Date(old.observed_at).getTime():start.getTime()));
    const derivedExpired=!!old.data_expired_at||!!row.run_data_expired_at||anchor<retention.derived_cutoff,rawExpired=derivedExpired||!!old.raw_expired_at||!!row.run_raw_expired_at||anchor<retention.raw_cutoff;
    const priorObservation=['ranked','not_found'].includes(old.result_status),observation=priorObservation?null:item.observation;
    const status=priorObservation?old.result_status:observation?.status??(item.state==='completed'?'unavailable':item.state==='pending'?'pending':item.state==='failed'?'failed':item.state==='unavailable'?'unavailable':'uncertain');
    const ranked=status==='ranked',keep=priorObservation&&!derivedExpired;
    const evidence={source:response?'provider-response':'serp/id_list',statusCode:item.statusCode,providerTaskId:item.providerTaskId,provisionalMicros:item.provisionalMicros,finalMicros:item.finalMicros??old.final_micros};
    await client.query(`UPDATE rank_task SET provider_task_id=COALESCE(provider_task_id,$2),provider_status=$3,result_status=$4,provisional_micros=CASE WHEN $5::bigint IS NULL THEN provisional_micros ELSE GREATEST(COALESCE(provisional_micros,0),$5::bigint) END,final_micros=COALESCE($6,final_micros),final_charge_at=CASE WHEN $6::bigint IS NULL THEN final_charge_at ELSE COALESCE(final_charge_at,clock_timestamp()) END,
      position=$7,rank_basis=$8,absolute_position=$9,ranking_url=$10,serp_features=$11,checked_depth=$12,returned_item_count=$13,observed_at=$14,retrieved_at=$15,charge_evidence=$16,
      raw_evidence=CASE WHEN $17 THEN NULL ELSE COALESCE($18::jsonb,raw_evidence) END,raw_expired_at=CASE WHEN $17 THEN COALESCE(raw_expired_at,clock_timestamp()) ELSE raw_expired_at END,
      data_expired_at=CASE WHEN $19 THEN COALESCE(data_expired_at,clock_timestamp()) ELSE data_expired_at END,diagnostic=$20 WHERE id=$1`,
      [item.id,item.providerTaskId,item.statusCode,status,item.provisionalMicros,item.finalMicros,
        derivedExpired?null:keep?old.position:ranked?observation?.position??null:null,
        derivedExpired?null:keep?old.rank_basis:ranked?observation?.rankBasis??null:null,
        derivedExpired?null:keep?old.absolute_position:ranked?observation?.absolutePosition??null:null,
        derivedExpired?null:keep?old.ranking_url:ranked?observation?.rankingUrl??null:null,
        derivedExpired?null:keep?JSON.stringify(old.serp_features):observation?JSON.stringify(observation.serpFeatures):null,
        derivedExpired?null:keep?old.checked_depth:observation?.checkedDepth??null,derivedExpired?null:keep?old.returned_item_count:observation?.returnedItemCount??null,
        old.observed_at??observation?.observedAt??null,old.retrieved_at??observation?.retrievedAt??null,JSON.stringify(old.final_micros!==null&&item.finalMicros===null?old.charge_evidence:evidence),rawExpired,rawExpired||priorObservation?null:rawResult(response,item.providerTaskId),derivedExpired,priorObservation?old.diagnostic:item.diagnostic]);
  }
  const all=(await client.query('SELECT final_micros,provisional_micros,result_status,provider_task_id,data_expired_at FROM rank_task WHERE dispatch_id=$1',[row.id])).rows;
  const final=all.every(task=>task.final_micros!==null),sum=all.reduce((total,task)=>total+BigInt(task.final_micros??task.provisional_micros??0),0n);
  if(sum>BigInt(row.estimate_micros))await client.query('UPDATE workspace_budget SET paused=true,updated_at=clock_timestamp() WHERE workspace_id=$1',[row.workspace_id]);
  if(final){
    if(row.ledger_status==='settled'&&row.actual_micros!==sum.toString()){await markUncertain(client,row,uncertainMessage,true);return;}
    const settled=await settleSpend(client,row.workspace_id,row.id,microUsd(sum));
    if(settled.reconciliationRequired){await markUncertain(client,{...row,ledger_status:'uncertain'});return;}
  }
  if(final&&all.some(task=>task.result_status==='uncertain')){await markUncertain(client,{...row,ledger_status:'settled',actual_micros:sum.toString()});return;}
  const unfinished=all.some(task=>['pending','unavailable'].includes(task.result_status)&&task.provider_task_id&&(task.final_micros===null||!task.data_expired_at&&!row.run_data_expired_at));
  const unknown=all.some(task=>task.final_micros===null&&task.result_status!=='pending');
  if(unknown||!final&&!unfinished){await markUncertain(client,row);return;}
  if(unfinished){
    const deadline=(await client.query('SELECT collect_deadline>clock_timestamp() AS valid FROM rank_dispatch WHERE id=$1',[row.id])).rows[0]?.valid;
    if(!deadline){await markUncertain(client,{...row,ledger_status:final?'settled':row.ledger_status,actual_micros:final?sum.toString():row.actual_micros});return;}
    await client.query("UPDATE rank_dispatch SET phase='collecting',completed_at=NULL,diagnostic=NULL WHERE id=$1",[row.id]);await queuePoll(client,row.id);
  }else await client.query("UPDATE rank_dispatch SET phase='finished',completed_at=COALESCE(completed_at,clock_timestamp()),lease_owner=NULL,lease_expires_at=NULL,next_poll_at=NULL,diagnostic=NULL WHERE id=$1",[row.id]);
  await aggregateRankRun(client,row.run_id);
}

export async function executeRankDispatch(id:string,send:typeof fetch=fetch){
  if(!z.uuid().safeParse(id).success)throw new Error('Invalid rank dispatch.');
  const owner=randomUUID();
  const saved=await locked(id,async(client,row)=>{
    if(row.phase!=='reserved'||row.lease_current)return null;
    if(row.ledger_status==='cancelled'){await cancelUndispatched(client,row);return null;}
    if(row.ledger_status!=='reserved')return null;
    try{const connection=await paidEligibility(client,row);const updated=(await client.query("UPDATE rank_dispatch SET generation=generation+1,lease_owner=$2,lease_expires_at=clock_timestamp()+interval '90 seconds' WHERE id=$1 RETURNING generation::text",[id,owner])).rows[0];return {row,credentials:keywordCredentials(connection),token:{owner,generation:updated.generation as string},...binding(row)};}
    catch{await cancelUndispatched(client,row);return null;}
  });
  if(!saved)return;const token=saved.token;
  let expected:RankExpectedTask[]=[];
  try{
    const account=await readRankAccount(saved.credentials,send),prices=parseRankBasePrices(account),base=saved.row.method==='live'?prices.liveMicros:prices.queuedMicros;
    if(account.fingerprint!==saved.row.account_fingerprint||base>BigInt(saved.plan.baseMicros))throw new FoundationError(409,cancelledMessage);
    await dispatchSpend(saved.row.workspace_id,saved.row.user_id,id,async client=>{
      await client.query('SELECT id FROM project WHERE id=$1 AND workspace_id=$2 FOR UPDATE',[saved.row.project_id,saved.row.workspace_id]);
      const row=await rankDispatchSnapshot(client,id);if(!row||row.phase!=='reserved'||!owns(row,token))throw new FoundationError(409,cancelledMessage);
      await paidEligibility(client,row);if(row.connection_revision!==saved.row.connection_revision||row.account_fingerprint!==account.fingerprint)throw new FoundationError(409,cancelledMessage);
      expected=await expectedTasks(client,row);
      await client.query("UPDATE rank_dispatch SET phase='dispatched',dispatched_at=clock_timestamp(),lease_expires_at=clock_timestamp()+interval '240 seconds',collect_deadline=clock_timestamp()+interval '15 minutes' WHERE id=$1",[id]);await aggregateRankRun(client,row.run_id);
    });
  }catch{
    await locked(id,async(client,row)=>{if(row.lease_owner!==token.owner||row.generation!==token.generation)return;if(row.phase==='reserved')await cancelUndispatched(client,row);else if(row.phase==='dispatched')await markUncertain(client,row);});return;
  }
  let response:DataforseoResponse;try{response=await requestRankTasks(saved.credentials,saved.row.method,expected.map(({id,request})=>({id,request})),send);}catch{response={httpStatus:0,body:null};}
  const outcome=parseRankDispatchOutcome(response,saved.row.method==='live'?'live':'post',expected);
  await locked(id,async(client,row)=>{if(row.phase!=='dispatched'||!owns(row,token))return;await applyOutcome(client,row,outcome,response);});
}

export async function pollRankDispatch(id:string,generation?:string,send:typeof fetch=fetch){
  if(!z.uuid().safeParse(id).success||generation!==undefined&&!/^[1-9]\d*$/.test(generation))throw new Error('Invalid rank collection job.');
  const owner=randomUUID();
  const saved=await locked(id,async(client,row)=>{
    if(row.phase!=='collecting'||row.lease_current||generation!==undefined&&row.generation!==generation)return null;
    if(!row.collect_deadline||row.collect_deadline.getTime()<=Date.now()){await markUncertain(client,row);return null;}
    const expected=await expectedTasks(client,row),pending=(await client.query("SELECT id FROM rank_task WHERE dispatch_id=$1 AND provider_task_id IS NOT NULL AND result_status IN('pending','unavailable') AND (final_micros IS NULL OR data_expired_at IS NULL AND NOT $2::boolean) ORDER BY id",[id,!!row.run_data_expired_at])).rows;
    if(!pending.length){await markUncertain(client,row);return null;}
    try{const binding=collectionBinding(row),connection=await keywordConnection(client,row.workspace_id,binding.id,binding.revision),task=expected.find(task=>task.id===pending[row.poll_attempts%pending.length].id)!;
      const lease=(await client.query("UPDATE rank_dispatch SET generation=generation+1,lease_owner=$2,lease_expires_at=clock_timestamp()+interval '90 seconds',poll_attempts=poll_attempts+1,next_poll_at=NULL WHERE id=$1 RETURNING generation::text",[id,owner])).rows[0];return {row,task,binding,credentials:keywordCredentials(connection),token:{owner,generation:lease.generation as string}};
    }catch{await markUncertain(client,row);return null;}
  });
  if(!saved)return;
  let response:DataforseoResponse;
  try{
    const account=await readRankAccount(saved.credentials,send);if(account.fingerprint!==saved.row.account_fingerprint)throw new Error('Provider account changed.');parseRankBasePrices(account); // A collection GET must still be priced at zero.
    const permitted=await locked(id,async(client,row)=>{if(row.phase!=='collecting'||!owns(row,saved.token))return false;const binding=collectionBinding(row);if(binding.id!==saved.binding.id||binding.revision!==saved.binding.revision)return false;await keywordConnection(client,row.workspace_id,binding.id,binding.revision);if(row.account_fingerprint!==account.fingerprint||!row.collect_deadline||row.collect_deadline.getTime()<=Date.now())return false;return true;});
    if(!permitted)throw new Error('Collection authorization changed.');response=await readRankTask(saved.credentials,saved.task.providerTaskId!,send);
  }catch{await locked(id,async(client,row)=>{if(row.phase==='collecting'&&owns(row,saved.token))await markUncertain(client,row);});return;}
  const outcome=parseRankDispatchOutcome(response,'get',[saved.task]);
  await locked(id,async(client,row)=>{if(row.phase!=='collecting'||!owns(row,saved.token))return;await applyOutcome(client,row,outcome,response);});
}

/** Internal owner-recovery seam: caller holds W→P and rechecks the selected active
 * credentials/account and owner after its free metadata lookup. Never call from
 * an unverified HTTP body. Only parsed, captured-task-bound evidence is admitted. */
// Shared by the owner gate and the UI capability query; aliases d,p,r,w are fixed
// server SQL, never user input. Keep eligibility in one place as recovery evolves.
export const rankRecoverableSql=`(d.phase='uncertain' AND p.status IN('uncertain','settled')) OR
  (d.phase='finished' AND p.status='settled' AND r.data_expired_at IS NULL AND EXISTS(
    SELECT 1 FROM rank_task t WHERE t.dispatch_id=d.id AND t.result_status='unavailable' AND t.provider_task_id IS NOT NULL AND t.data_expired_at IS NULL
    AND LEAST(COALESCE(t.observed_at,r.started_at,r.created_at),COALESCE(r.started_at,r.created_at))>=clock_timestamp()-w.derived_history_days*interval '24 hours'))`;
export async function rankRecoveryAvailable(client:PoolClient,row:RankDispatchSnapshot){
  return !!(await client.query(`SELECT 1 FROM rank_dispatch d JOIN provider_request p ON p.id=d.id
    JOIN rank_run r ON r.id=d.run_id JOIN workspace w ON w.id=r.workspace_id WHERE d.id=$1 AND (${rankRecoverableSql})`,[row.id])).rowCount;
}
export async function applyReconciledRankOutcome(client:PoolClient,id:string,generation:string,outcome:RankDispatchOutcome,recovery:RankRecoveryBinding){
  const row=await rankDispatchSnapshot(client,id);if(!row||row.generation!==generation||!await rankRecoveryAvailable(client,row))throw new FoundationError(409,'The rank charge changed during reconciliation. Reload it.');
  if(outcome.tasks.length!==row.task_count)throw new FoundationError(409,'The rank reconciliation is incomplete.');
  const accepted=parse(recoveryInput,{...recovery,approvedAt:new Date().toISOString()});
  const owner=(await client.query("SELECT 1 FROM membership WHERE workspace_id=$1 AND user_id=$2 AND role='owner'",[row.workspace_id,accepted.approvedBy])).rowCount;if(!owner)throw new FoundationError(404,'Workspace not found or unavailable.');
  await keywordConnection(client,row.workspace_id,accepted.connectionId,accepted.connectionRevision);
  await client.query("UPDATE rank_dispatch SET charge_evidence=COALESCE(charge_evidence,'{}'::jsonb)||jsonb_build_object('recovery',$2::jsonb) WHERE id=$1",[id,JSON.stringify(accepted)]);
  await client.query("UPDATE rank_dispatch SET generation=generation+1,collect_deadline=clock_timestamp()+interval '15 minutes',lease_owner=NULL,lease_expires_at=NULL WHERE id=$1",[id]);
  await applyOutcome(client,row,outcome);
}

export async function cancelRankRun(projectId:string,userId:string,runId:string,raw:unknown){
  runId=parse(z.uuid(),runId);const input=parse(z.object({requestId:z.uuid()}).strict(),raw);
  await withKeywordProject(projectId,userId,writers,async(client,_wid,role)=>{
    const run=(await client.query('SELECT * FROM rank_run WHERE id=$1 AND project_id=$2',[runId,projectId])).rows[0];if(!run)throw new FoundationError(404,'Rank check not found or unavailable.');
    if(run.user_id!==userId&&role!=='owner')throw new FoundationError(403,'Only the initiating user or owner can cancel this check.');
    const receipt=await contentReceipt(client,projectId,input.requestId,'rank.cancel:'+runId,{userId,...input});if(receipt.replayed)return;
    const rows=(await client.query("SELECT d.id FROM rank_dispatch d JOIN provider_request p ON p.id=d.id WHERE d.run_id=$1 AND d.phase='reserved' AND p.status IN('reserved','cancelled')",[runId])).rows;
    if(!rows.length)throw new FoundationError(409,'Only work that has not been dispatched can be cancelled.');
    for(const item of rows){const row=await rankDispatchSnapshot(client,item.id);if(row)await cancelUndispatched(client,row,'Cancelled before dispatch.');}
    await client.query('UPDATE rank_run SET cancel_requested_at=COALESCE(cancel_requested_at,clock_timestamp()) WHERE id=$1',[runId]);await receipt.save({id:runId});
  });return getRankRun(projectId,userId,runId);
}

export async function reconcileRankJobs(){
  const boss=await getBoss();
  const rows=(await getDatabase().pool.query(`SELECT d.id FROM rank_dispatch d LEFT JOIN pgboss.job j ON j.id=d.id AND j.name=$1
    WHERE (d.phase='reserved' AND (j.id IS NULL OR j.state IN('failed','cancelled','completed') OR d.lease_expires_at<clock_timestamp()))
    OR (d.phase='dispatched' AND (d.lease_expires_at<clock_timestamp() OR j.id IS NULL OR j.state IN('failed','cancelled','completed')))
    OR (d.phase='collecting' AND (d.lease_expires_at<clock_timestamp() OR d.collect_deadline<=clock_timestamp() OR d.lease_owner IS NULL AND d.next_poll_at<=clock_timestamp())) ORDER BY d.created_at,d.id LIMIT 50`,[rankQueue])).rows;
  for(const item of rows)await locked(item.id,async(client,row)=>{
    if(row.phase==='reserved'||row.phase==='dispatched'){
      const job=(await client.query('SELECT state FROM pgboss.job WHERE id=$1 AND name=$2',[row.id,rankQueue])).rows[0];
      if(row.lease_current&&job&&!['failed','cancelled','completed'].includes(job.state))return;
      if(row.phase==='reserved')await cancelUndispatched(client,row);else await markUncertain(client,row);return;
    }
    if(row.phase!=='collecting')return;
    if(!row.collect_deadline||row.collect_deadline.getTime()<=Date.now()){await markUncertain(client,row);return;}
    if(row.lease_current)return;
    const live=(await client.query("SELECT 1 FROM pgboss.job WHERE name=$1 AND data->>'dispatchId'=$2 AND state IN('created','retry','active') LIMIT 1",[rankPollQueue,row.id])).rowCount;
    if(live&&!row.lease_owner)return;
    await client.query('UPDATE rank_dispatch SET generation=generation+1,lease_owner=NULL,lease_expires_at=NULL WHERE id=$1',[row.id]);await queuePoll(client,row.id);
  });
  void boss; // Queue schema exists before the bounded recovery scan.
}
