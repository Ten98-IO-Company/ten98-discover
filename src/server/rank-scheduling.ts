import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {z} from 'zod';
import {FoundationError} from './auth.ts';
import {canonicalHash,cleanText,parse,revision} from './context-input.ts';
import {contentReceipt} from './project-context.ts';
import {withKeywordProject,keywordConnection} from './keyword-research.ts';
import {moneyInput,usdMicros} from './providers.ts';
import {microUsd} from './keyword-research-input.ts';
import {readRankPlan,rankPlanTotal,type RankPlan,type RankPlanTask} from './rank-execution-plan.ts';
import {parseRankSerpRequest} from './rank-serp-input.ts';

const readers=['owner','admin','editor','viewer'];
const calendarFields={interval:z.enum(['daily','weekly','monthly']),timezone:z.string().min(1).max(100).refine(v=>cleanText(v)&&v.trim()===v&&!/[\x00-\x1f\x7f]/.test(v)),hour:z.number().int().min(0).max(23),minute:z.number().int().min(0).max(59),weekday:z.number().int().min(0).max(6).nullable().default(null)};
const calendar=z.object(calendarFields).strict().refine(v=>v.interval==='weekly'?v.weekday!==null:v.weekday===null);
const approveInput=z.object({requestId:z.uuid(),revision,quoteId:z.uuid(),maximumUsd:z.string().max(14).refine(v=>!/[\s]/.test(v)).pipe(moneyInput).transform(v=>microUsd(usdMicros(v))),...calendarFields}).strict().refine(v=>v.interval==='weekly'?v.weekday!==null:v.weekday===null);
const disableInput=z.object({requestId:z.uuid(),revision}).strict();
type Calendar=z.output<typeof calendar>;
type Definition={target:RankPlan['target'];tasks:Pick<RankPlanTask,'keywordId'|'keyword'|'matchCase'|'device'>[]};

/** Stable paid scope, deliberately independent of fresh price/random job IDs.
 * Only the full queued definition may receive standing approval. */
export function rankApprovalRequestHash(input:Definition):string{
  if(!Array.isArray(input.tasks)||input.tasks.length<1||input.tasks.length>2000)throw new FoundationError(409,'The rank approval definition is unavailable.');
  const pairs=new Set<string>();
  const tasks=input.tasks.map(task=>{
    const keywordId=parse(z.uuid(),task.keywordId).toLowerCase(),request=parseRankSerpRequest({...input.target,keyword:task.keyword,device:task.device});
    const pair=keywordId+':'+request.device;if(pairs.has(pair)||typeof task.matchCase!=='boolean'||request.domain!==input.target.domain)throw new FoundationError(409,'The rank approval definition is inconsistent.');pairs.add(pair);
    return {keywordId,keyword:request.keyword,matchCase:task.matchCase,device:request.device};
  }).sort((a,b)=>a.keywordId<b.keywordId?-1:a.keywordId>b.keywordId?1:a.device<b.device?-1:a.device>b.device?1:0);
  return canonicalHash({version:1,method:'queued',target:input.target,tasks});
}
async function tracker(client:PoolClient,projectId:string,id:string){
  const row=(await client.query('SELECT * FROM rank_config WHERE id=$1 AND project_id=$2 FOR UPDATE',[id,projectId])).rows[0];
  if(!row)throw new FoundationError(404,'Rank tracker not found or unavailable.');return row;
}
function checkRevision(row:any,value:number){
  if(row.authored_revision!==value)throw new FoundationError(409,'This tracker changed. Reload it before saving its schedule.');
  if(row.authored_revision>=2147483646)throw new FoundationError(409,'This tracker reached its revision limit. Create another tracker.');
}
async function currentHash(client:PoolClient,row:any){
  const keywords=(await client.query('SELECT id,keyword,match_case FROM rank_keyword WHERE project_id=$1 AND config_id=$2 ORDER BY id',[row.project_id,row.id])).rows;
  if(!keywords.length||keywords.length>1000)throw new FoundationError(409,'A full current keyword set is required for a rank schedule.');
  const devices:('desktop'|'mobile')[]=row.devices==='both'?['desktop','mobile']:[row.devices];
  return rankApprovalRequestHash({target:{domain:row.target_domain,locationCode:row.location_code,languageCode:row.language_code,depth:row.serp_depth,maxCrawlPages:row.max_crawl_pages},tasks:keywords.flatMap(k=>devices.map(device=>({keywordId:k.id,keyword:k.keyword,matchCase:k.match_case,device})))});
}
async function validateZone(client:PoolClient,input:Calendar){
  if(!(await client.query('SELECT 1 FROM pg_timezone_names WHERE name=$1',[input.timezone])).rowCount)throw new FoundationError(400,'Choose a supported PostgreSQL timezone.');
}
async function occurrences(client:PoolClient,input:Calendar){
  await validateZone(client,input);
  const result=await client.query(`WITH RECURSIVE anchor AS MATERIALIZED(SELECT clock_timestamp() AS at), due(n,at) AS (
    SELECT 1,rank_next_due($1,$2,$3,$4,$5,(SELECT at FROM anchor))
    UNION ALL SELECT n+1,rank_next_due($1,$2,$3,$4,$5,at) FROM due WHERE n<5)
    SELECT (SELECT at FROM anchor) AS captured_at,at AS utc,to_char(at AT TIME ZONE $2,'YYYY-MM-DD"T"HH24:MI:SS') AS local,
    extract(epoch FROM ((at AT TIME ZONE $2)-(at AT TIME ZONE 'UTC')))::integer AS offset_seconds FROM due ORDER BY n`,[input.interval,input.timezone,input.hour,input.minute,input.weekday]);
  return {capturedAt:(result.rows[0].captured_at as Date).toISOString(),timezone:input.timezone,occurrences:result.rows.map(r=>({utc:(r.utc as Date).toISOString(),local:r.local as string,offsetSeconds:r.offset_seconds as number}))};
}
async function dto(client:PoolClient,row:any,role:string,replayed?:boolean){
  const reasons:string[]=[];let connection:any=null;
  if(!row.schedule_enabled)reasons.push('disabled');if(row.archived_at)reasons.push('archived');
  if(row.approval_id){
    if(!(await client.query("SELECT 1 FROM membership WHERE workspace_id=$1 AND user_id=$2 AND role='owner'",[row.workspace_id,row.approval_user_id])).rowCount)reasons.push('approver_no_longer_owner');
    connection=(await client.query('SELECT id,name,revision,revoked_at FROM provider_connection WHERE id=$1 AND workspace_id=$2',[row.approval_connection_id,row.workspace_id])).rows[0];
    if(!connection||connection.revoked_at||connection.revision!==row.approval_connection_revision)reasons.push('connection_changed');
    let unchanged=false;try{unchanged=row.approval_config_revision===row.revision&&row.approval_keywords_revision===row.keywords_revision&&row.approval_account_fingerprint_version===2&&await currentHash(client,row)===row.approval_request_hash;}catch(error){if(!(error instanceof FoundationError))throw error;}
    if(!unchanged)reasons.push('definition_changed');
  }
  const iso=(v:Date|null)=>v?.toISOString()??null;
  return {role,trackerId:row.id as string,authoredRevision:row.authored_revision as number,canManage:role==='owner',schedule:{enabled:row.schedule_enabled as boolean,interval:row.schedule_interval as 'manual'|'daily'|'weekly'|'monthly',timezone:row.schedule_timezone as string|null,hour:row.schedule_hour as number|null,minute:row.schedule_minute as number|null,weekday:row.schedule_weekday as number|null,nextDueAt:iso(row.next_due_at),
    approval:row.approval_id?{id:row.approval_id as string,approvedAt:iso(row.approved_at),approvedByUserId:row.approval_user_id as string,maximumUsd:microUsd(BigInt(row.approval_max_micros)),connectionId:row.approval_connection_id as string,connectionName:connection?.name as string|undefined}:null,
    approvalStale:!row.approval_id||reasons.length>0,staleReasons:reasons},...(replayed===undefined?{}:{replayed})};
}
export async function getRankSchedule(projectId:string,userId:string,trackerId:string){
  trackerId=parse(z.uuid(),trackerId);return withKeywordProject(projectId,userId,readers,async(client,_wid,role)=>dto(client,await tracker(client,projectId,trackerId),role));
}
export async function previewRankSchedule(projectId:string,userId:string,trackerId:string,raw:unknown){
  trackerId=parse(z.uuid(),trackerId);const input=parse(calendar,raw);
  return withKeywordProject(projectId,userId,['owner'],async client=>{await tracker(client,projectId,trackerId);return occurrences(client,input);});
}
export async function approveRankSchedule(projectId:string,userId:string,trackerId:string,raw:unknown){
  trackerId=parse(z.uuid(),trackerId);const input=parse(approveInput,raw);
  return withKeywordProject(projectId,userId,['owner'],async(client,wid,role)=>{
    const receipt=await contentReceipt(client,projectId,input.requestId,'rank.schedule.approve:'+trackerId,{userId,...input}),row=await tracker(client,projectId,trackerId);
    if(receipt.replayed)return dto(client,row,role,true);checkRevision(row,input.revision);
    if(row.archived_at)throw new FoundationError(409,'Reactivate this tracker and review a new quote before approving a schedule.');
    const quote=(await client.query('SELECT * FROM rank_run WHERE id=$1 AND project_id=$2 AND config_id=$3',[input.quoteId,projectId,trackerId])).rows[0];
    if(!quote)throw new FoundationError(404,'Rank quote not found or unavailable.');if(quote.user_id!==userId)throw new FoundationError(403,'Only the owner who requested this quote can approve its schedule.');
    if(quote.trigger!=='manual'||quote.method!=='queued'||quote.status!=='quoted'||quote.started_at||quote.is_subset||quote.config_revision!==row.revision||quote.keywords_revision!==row.keywords_revision||quote.account_fingerprint_version!==2)throw new FoundationError(409,'Review a current full queued quote for this schedule.');
    await keywordConnection(client,wid,quote.connection_id,quote.connection_revision);
    const plan=readRankPlan(quote.request,quote.request_hash),estimate=rankPlanTotal(plan),maximum=usdMicros(input.maximumUsd),hash=rankApprovalRequestHash(plan);
    if(plan.method!=='queued'||plan.tasks.length!==quote.task_count||estimate.toString()!==quote.estimate_micros||hash!==await currentHash(client,row))throw new FoundationError(409,'The quote no longer covers this exact full tracker definition.');
    if(maximum===0n||maximum<estimate)throw new FoundationError(400,'The per-check ceiling must cover the full quoted maximum.');
    await validateZone(client,input);const approvalId=randomUUID();
    // Expiry is checked against the database clock immediately before approval;
    // waiting for W→P→tracker locks never renews a five-minute quote.
    const saved=await client.query(`WITH approval_clock AS MATERIALIZED(SELECT clock_timestamp() AS at)
      UPDATE rank_config SET schedule_interval=$2,schedule_timezone=$3,schedule_hour=$4::integer,schedule_minute=$5::integer,schedule_weekday=$6::integer,
      schedule_enabled=true,next_due_at=rank_next_due($2,$3,$4,$5,$6,(SELECT at FROM approval_clock)),approval_id=$7,approval_user_id=$8,approval_config_revision=revision,approval_keywords_revision=keywords_revision,
      approval_request_hash=$9,approval_connection_id=$10,approval_connection_revision=$11,approval_account_fingerprint=$12,approval_account_fingerprint_version=2,
      approval_max_micros=$13,approved_at=(SELECT at FROM approval_clock),last_skip_reason=NULL,authored_revision=authored_revision+1,updated_at=(SELECT at FROM approval_clock)
      WHERE id=$1 AND $14::timestamptz>(SELECT at FROM approval_clock)`,
      [trackerId,input.interval,input.timezone,input.hour,input.minute,input.weekday,approvalId,userId,hash,quote.connection_id,quote.connection_revision,quote.account_fingerprint,maximum.toString(),quote.expires_at]);
    if(!saved.rowCount)throw new FoundationError(409,'This quote expired. Review another quote before approving a schedule.');
    await receipt.save({id:trackerId});return dto(client,await tracker(client,projectId,trackerId),role,false);
  });
}
export async function disableRankSchedule(projectId:string,userId:string,trackerId:string,raw:unknown){
  trackerId=parse(z.uuid(),trackerId);const input=parse(disableInput,raw);
  return withKeywordProject(projectId,userId,['owner'],async(client,_wid,role)=>{
    const receipt=await contentReceipt(client,projectId,input.requestId,'rank.schedule.disable:'+trackerId,{userId,...input}),row=await tracker(client,projectId,trackerId);
    if(receipt.replayed)return dto(client,row,role,true);
    if(row.authored_revision!==input.revision)throw new FoundationError(409,'This tracker changed. Reload it before disabling its schedule.');
    if(row.schedule_enabled||row.next_due_at){await client.query("UPDATE rank_config SET schedule_enabled=false,next_due_at=NULL,last_skip_reason='Disabled by an owner.',authored_revision=LEAST(authored_revision+1,2147483646),updated_at=clock_timestamp() WHERE id=$1",[trackerId]);}
    await receipt.save({id:trackerId});return dto(client,await tracker(client,projectId,trackerId),role,false);
  });
}
