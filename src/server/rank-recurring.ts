import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {z} from 'zod';
import {FoundationError} from './auth.ts';
import {InputError} from './validation.ts';
import {getDatabase} from './db.ts';
import {getBoss} from './jobs.ts';
import {canonicalHash} from './context-input.ts';
import {keywordCredentials} from './keyword-research.ts';
import {readRankAccount} from './dataforseo-rank.ts';
import {parseRankBasePrices} from './rank-serp-input.ts';
import {compileRankPlan,rankPlanTotal,type RankPlan} from './rank-execution-plan.ts';
import {enqueueRankPlan} from './rank-execution.ts';
import {rankApprovalRequestHash} from './rank-scheduling.ts';

const approvalInput=z.object({version:z.literal(1),approvalId:z.uuid(),userId:z.uuid(),configRevision:z.number().int().positive(),keywordsRevision:z.number().int().positive(),requestHash:z.string().regex(/^[a-f0-9]{64}(?![\s\S])/),connectionId:z.uuid(),connectionRevision:z.number().int().positive(),accountFingerprint:z.string().regex(/^[a-f0-9]{64}(?![\s\S])/),accountFingerprintVersion:z.literal(2),maximumMicros:z.string().regex(/^[1-9]\d{0,12}(?![\s\S])/).refine(v=>BigInt(v)<=1_000_000_000_000n),approvedAt:z.iso.datetime(),calendar:z.object({interval:z.enum(['daily','weekly','monthly']),timezone:z.string().min(1).max(100),hour:z.number().int().min(0).max(23),minute:z.number().int().min(0).max(59),weekday:z.number().int().min(0).max(6).nullable()}).strict()}).strict();
export type RankApprovalSnapshot=z.infer<typeof approvalInput>;
export type RankRecurringRun={trigger:string;approval_id:string|null;approval_snapshot:unknown;scheduled_for:Date|string|null;workspace_id:string;project_id:string;config_id:string;user_id:string;config_revision:number;keywords_revision:number;connection_id:string;connection_revision:number;account_fingerprint:string;account_fingerprint_version:number;run_estimate:string};
export type RankOccurrenceResult={status:'idle'|'superseded'|'started'|'skipped';runId?:string};
type Due={id:string;workspace_id:string;project_id:string;approval_id:string;due_at:string};
type Reason='authority_changed'|'definition_changed'|'connection_changed'|'empty'|'overlap'|'provider_unavailable'|'account_changed'|'price_above_approval'|'budget';
const messages:Record<Reason,string>={authority_changed:'Skipped: the approving user is no longer a workspace owner. Approval was disabled.',definition_changed:'Skipped: the approved tracker definition changed. Approval was disabled.',connection_changed:'Skipped: the approved provider connection changed. Approval was disabled.',empty:'Skipped: the approved keyword set is empty. Approval was disabled.',overlap:'Skipped: another check is still active for this tracker.',provider_unavailable:'Skipped: current provider account or prices could not be verified. No paid request was sent.',account_changed:'Skipped: the approved provider account changed. Approval was disabled.',price_above_approval:'Skipped: the current full check estimate exceeds the standing per-check ceiling.',budget:'Skipped: paid work is paused or an earlier charge is uncertain. No paid request was sent.'};
const disables=new Set<Reason>(['authority_changed','definition_changed','connection_changed','empty','account_changed']);
const dueSql=`to_char(next_due_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
function denied():never{throw new FoundationError(409,'This scheduled check no longer has its original standing approval.');}
function target(row:any):RankPlan['target']{return {domain:row.target_domain,locationCode:row.location_code,languageCode:row.language_code,depth:row.serp_depth,maxCrawlPages:row.max_crawl_pages};}
function snapshot(row:any):RankApprovalSnapshot{
  const parsed=approvalInput.safeParse({version:1,approvalId:row.approval_id,userId:row.approval_user_id,configRevision:row.approval_config_revision,keywordsRevision:row.approval_keywords_revision,requestHash:row.approval_request_hash,connectionId:row.approval_connection_id,connectionRevision:row.approval_connection_revision,accountFingerprint:row.approval_account_fingerprint,accountFingerprintVersion:row.approval_account_fingerprint_version,maximumMicros:row.approval_max_micros,approvedAt:row.approved_at?.toISOString(),calendar:{interval:row.schedule_interval,timezone:row.schedule_timezone,hour:row.schedule_hour,minute:row.schedule_minute,weekday:row.schedule_weekday}});
  if(!parsed.success)denied();return parsed.data;
}
async function grant(client:PoolClient,row:any){
  const connection=(await client.query("SELECT * FROM provider_connection WHERE id=$1 AND workspace_id=$2 AND provider='dataforseo'",[row.approval_connection_id,row.workspace_id])).rows[0];
  let reason:Reason|null=null;
  if(!row.schedule_enabled||row.archived_at||row.approval_config_revision!==row.revision||row.approval_keywords_revision!==row.keywords_revision||row.approval_account_fingerprint_version!==2)reason='definition_changed';
  else if(!(await client.query("SELECT 1 FROM membership WHERE workspace_id=$1 AND user_id=$2 AND role='owner'",[row.workspace_id,row.approval_user_id])).rowCount)reason='authority_changed';
  else if(!connection||connection.revoked_at||connection.revision!==row.approval_connection_revision)reason='connection_changed';
  const keywords=(await client.query('SELECT id,keyword,match_case AS "matchCase" FROM rank_keyword WHERE project_id=$1 AND config_id=$2 ORDER BY id LIMIT 1001',[row.project_id,row.id])).rows as {id:string;keyword:string;matchCase:boolean}[];
  if(!reason&&!keywords.length)reason='empty';
  if(!reason){try{const devices:('desktop'|'mobile')[]=row.devices==='both'?['desktop','mobile']:[row.devices];if(keywords.length>1000||rankApprovalRequestHash({target:target(row),tasks:keywords.flatMap(k=>devices.map(device=>({keywordId:k.id,keyword:k.keyword,matchCase:k.matchCase,device})))})!==row.approval_request_hash)reason='definition_changed';}catch{reason='definition_changed';}}
  return {reason,connection,keywords};
}

/** Caller holds W -> P -> tracker. Used at both paid worker authorization gates;
 * free collection of already-incurred work deliberately does not call this. */
export async function assertRankRecurringAuthority(client:PoolClient,run:RankRecurringRun,plan:RankPlan):Promise<void>{
  if(run.trigger==='manual')return;
  if(run.trigger!=='scheduled'||!run.approval_id||!run.scheduled_for||plan.method!=='queued')denied();
  const row=(await client.query('SELECT * FROM rank_config WHERE id=$1 AND project_id=$2 AND workspace_id=$3 FOR UPDATE',[run.config_id,run.project_id,run.workspace_id])).rows[0];
  if(!row||row.approval_id!==run.approval_id||row.approval_user_id!==run.user_id)denied();
  const proof=approvalInput.safeParse(run.approval_snapshot);if(!proof.success||canonicalHash(proof.data)!==canonicalHash(snapshot(row)))denied();
  const approval=proof.data;
  if(run.config_revision!==approval.configRevision||run.keywords_revision!==approval.keywordsRevision||run.connection_id!==approval.connectionId||run.connection_revision!==approval.connectionRevision||run.account_fingerprint_version!==2||run.account_fingerprint!==approval.accountFingerprint||rankApprovalRequestHash(plan)!==approval.requestHash||rankPlanTotal(plan).toString()!==run.run_estimate||rankPlanTotal(plan)>BigInt(approval.maximumMicros))denied();
  if((await grant(client,row)).reason)denied();
}
async function gated<T>(due:Due,work:(client:PoolClient,row:any)=>Promise<T>):Promise<T|null>{
  const client=await getDatabase().pool.connect();try{await client.query('BEGIN');await client.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='10s'");
    await client.query('SELECT id FROM workspace WHERE id=$1 FOR UPDATE',[due.workspace_id]);await client.query('SELECT id FROM project WHERE id=$1 AND workspace_id=$2 FOR UPDATE',[due.project_id,due.workspace_id]);
    const row=(await client.query(`SELECT *,${dueSql} AS due_at,next_due_at<=clock_timestamp() AS due FROM rank_config WHERE id=$1 AND project_id=$2 AND workspace_id=$3 FOR UPDATE`,[due.id,due.project_id,due.workspace_id])).rows[0];
    const result=row?.schedule_enabled&&row.due&&row.approval_id===due.approval_id&&row.due_at===due.due_at?await work(client,row):null;
    await client.query('COMMIT');return result;
  }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}finally{client.release();}
}
async function advance(client:PoolClient,row:any,reason:Reason|null){
  // An overdue occurrence is handled once. No interval-by-interval catch-up, even
  // when a price lookup spans another nominal occurrence or a DST transition.
  const disable=reason!==null&&disables.has(reason);
  await client.query(`WITH tick AS MATERIALIZED(SELECT clock_timestamp() AS at) UPDATE rank_config SET
    schedule_enabled=NOT $2::boolean,next_due_at=CASE WHEN $2 THEN NULL ELSE rank_next_due(schedule_interval,schedule_timezone,schedule_hour,schedule_minute,schedule_weekday,(SELECT at FROM tick)) END,
    last_skip_reason=$3,authored_revision=CASE WHEN $2 THEN LEAST(authored_revision+1,2147483646) ELSE authored_revision END,updated_at=(SELECT at FROM tick) WHERE id=$1`,[row.id,disable,reason?messages[reason]:null]);
}
async function skip(client:PoolClient,row:any,due:Due,reason:Reason,connection?:any):Promise<RankOccurrenceResult>{
  const id=randomUUID(),approval=snapshot(row),request={version:1,target:target(row),skipped:true};
  await client.query(`INSERT INTO rank_run(id,workspace_id,project_id,config_id,user_id,trigger,method,status,config_revision,keywords_revision,connection_id,connection_revision,account_fingerprint,account_fingerprint_version,connection_name,request,request_hash,task_count,estimate_micros,price_as_of,approval_id,scheduled_for,approval_snapshot,completed_at,diagnostic)
    VALUES($1,$2,$3,$4,$5,'scheduled','queued','skipped',$6,$7,$8,$9,$10,2,$11,$12,$13,0,0,clock_timestamp(),$14,$15,$16,clock_timestamp(),$17)`,
    [id,row.workspace_id,row.project_id,row.id,approval.userId,approval.configRevision,approval.keywordsRevision,approval.connectionId,approval.connectionRevision,approval.accountFingerprint,connection?.name??'DataForSEO connection',JSON.stringify(request),canonicalHash(request),approval.approvalId,due.due_at,JSON.stringify(approval),messages[reason]]);
  await advance(client,row,reason);return {status:'skipped',runId:id};
}
async function active(client:PoolClient,row:any){return !!(await client.query("SELECT 1 FROM rank_run WHERE config_id=$1 AND project_id=$2 AND status IN ('queued','running','waiting')",[row.id,row.project_id])).rowCount;}

/** One candidate per non-overlapping worker tick. Only free account lookup occurs
 * here; paid requests remain separate durable jobs with no automatic POST retry. */
export async function claimDueRankOccurrence(send:typeof fetch=fetch):Promise<RankOccurrenceResult>{
  const due=(await getDatabase().pool.query<Due>(`SELECT id,workspace_id,project_id,approval_id,${dueSql} AS due_at FROM rank_config WHERE schedule_enabled AND next_due_at<=clock_timestamp() ORDER BY next_due_at,id LIMIT 1`)).rows[0];
  if(!due)return {status:'idle'};
  const before=await gated(due,async(client,row)=>{
    const checked=await grant(client,row);if(checked.reason)return {result:await skip(client,row,due,checked.reason,checked.connection)};
    if(await active(client,row))return {result:await skip(client,row,due,'overlap',checked.connection)};
    return {connection:checked.connection};
  });
  if(!before)return {status:'superseded'};if(before.result)return before.result;
  let verified:{fingerprint:string;base:bigint;at:Date}|null=null;
  try{const account=await readRankAccount(keywordCredentials(before.connection),send),prices=parseRankBasePrices(account);verified={fingerprint:account.fingerprint,base:prices.queuedMicros,at:new Date()};}catch{/* A durable skip follows a fresh scope check; no error/credential text escapes. */}
  const boss=verified?await getBoss():null;
  return await gated(due,async(client,row)=>{
    const checked=await grant(client,row);if(checked.reason)return skip(client,row,due,checked.reason,checked.connection);
    if(await active(client,row))return skip(client,row,due,'overlap',checked.connection);
    if(!verified||!(await client.query("SELECT 1 WHERE $1::timestamptz+interval '5 minutes'>clock_timestamp()",[verified.at])).rowCount)return skip(client,row,due,'provider_unavailable',checked.connection);
    if(verified.fingerprint!==row.approval_account_fingerprint)return skip(client,row,due,'account_changed',checked.connection);
    let plan:RankPlan;try{plan=compileRankPlan({method:'queued',target:target(row),devices:row.devices,keywords:checked.keywords,baseMicros:verified.base});}catch(error){if((error instanceof FoundationError||error instanceof InputError)&&error.status===400)return skip(client,row,due,'price_above_approval',checked.connection);throw error;}
    const maximum=rankPlanTotal(plan),approval=snapshot(row);if(maximum>BigInt(approval.maximumMicros))return skip(client,row,due,'price_above_approval',checked.connection);
    const id=randomUUID();await client.query('SAVEPOINT rank_occurrence');
    try{
      await client.query(`INSERT INTO rank_run(id,workspace_id,project_id,config_id,user_id,trigger,method,status,config_revision,keywords_revision,connection_id,connection_revision,account_fingerprint,account_fingerprint_version,connection_name,request,request_hash,task_count,estimate_micros,price_as_of,approval_id,scheduled_for,approval_snapshot,started_at)
        VALUES($1,$2,$3,$4,$5,'scheduled','queued','queued',$6,$7,$8,$9,$10,2,$11,$12,$13,$14,$15,$16,$17,$18,$19,clock_timestamp())`,
        [id,row.workspace_id,row.project_id,row.id,approval.userId,approval.configRevision,approval.keywordsRevision,approval.connectionId,approval.connectionRevision,approval.accountFingerprint,checked.connection.name,JSON.stringify(plan),canonicalHash(plan),plan.tasks.length,maximum.toString(),verified.at,approval.approvalId,due.due_at,JSON.stringify(approval)]);
      await enqueueRankPlan(client,boss!,{runId:id,workspaceId:row.workspace_id,projectId:row.project_id,userId:approval.userId,connectionId:approval.connectionId,plan});
      await client.query('RELEASE SAVEPOINT rank_occurrence');
    }catch(error){await client.query('ROLLBACK TO SAVEPOINT rank_occurrence');await client.query('RELEASE SAVEPOINT rank_occurrence');if(error instanceof FoundationError&&'code'in error&&error.code==='SPENDING_BUDGET')return skip(client,row,due,'budget',checked.connection);throw error;}
    await advance(client,row,null);return {status:'started',runId:id} as RankOccurrenceResult;
  })??{status:'superseded'};
}
