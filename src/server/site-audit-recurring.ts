import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import type {WorkspaceRole} from '@ten98/runtime';
import type {z} from 'zod';
import {FoundationError} from './auth.ts';
import {getDatabase} from './db.ts';
import {getBoss} from './jobs.ts';
import {parse} from './context-input.ts';
import {contentReceipt} from './project-context.ts';
import {withAuditLock,parseSiteAuditStart,selectSiteAuditOrigin,queueSiteAuditInTransaction,cancelSiteAuditInTransaction,type AuditRunRow} from './site-audits.ts';
import {openSiteAuditAccess,SiteAuditAccessUnavailable} from './site-audit-access.ts';
import {promptCalendar,type PromptCalendar} from '../lib/prompt-recurring.ts';
import {siteAuditScheduleSave,siteAuditSchedulePause,siteAuditScheduleAck,siteAuditScheduleResponse,siteAuditScheduleMutationResponse,type SiteAuditScheduleDefinition} from '../lib/site-audit-recurring.ts';

const dueText=`to_char(next_due_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
type ScheduleRow={project_id:string;workspace_id:string;revision:number;enabled:boolean;definition:SiteAuditScheduleDefinition;calendar:PromptCalendar;approval_id:string;approval_user_id:string;origin:string;domain_hostname:string|null;domain_verified_text:string|null;domain_revision:string|null;approved_at:Date;next_due_at:Date|null;last_status:string|null;due_at:string|null;is_due:boolean};
type Ack=z.infer<typeof siteAuditScheduleAck>;
async function schedule(client:PoolClient,projectId:string){
 return (await client.query<ScheduleRow>(`SELECT *,domain_verified_at::text AS domain_verified_text,domain_revision::text AS domain_revision,${dueText} AS due_at,next_due_at<=clock_timestamp() AS is_due FROM site_audit_schedule WHERE project_id=$1 FOR UPDATE`,[projectId])).rows[0]??null;
}
function checkRevision(row:ScheduleRow|null,expected:number){
 if((row?.revision??0)!==expected||(row?.revision??0)>=2147483646)throw new FoundationError(409,'This schedule changed. Reload it before making another change.');
}
async function cancelQueuedApproval(client:PoolClient,projectId:string,approvalId:string){
 // The immutable request identity still reaches queued work after history links are scrubbed.
 const runs=await client.query<AuditRunRow>(`SELECT r.* FROM site_audit_run r JOIN site_audit_occurrence o ON o.project_id=r.project_id AND o.request_id=r.request_id WHERE o.project_id=$1 AND o.approval_id=$2 AND r.status='queued' ORDER BY r.id FOR UPDATE OF r`,[projectId,approvalId]);
 for(const run of runs.rows)await cancelSiteAuditInTransaction(client,run);
}

/** Caller holds native workspace/project locks; expiry is monotonic even when retention grows. */
export async function expireSiteAuditScheduleHistory(client:PoolClient,projectId:string,derivedCutoff?:Date|string){
 await client.query(`UPDATE site_audit_schedule s SET history_retained_from=GREATEST(s.history_retained_from,clock_timestamp()-w.derived_history_days*interval '24 hours',$2::timestamptz) FROM workspace w WHERE s.project_id=$1 AND w.id=s.workspace_id`,[projectId,derivedCutoff??null]);
 const expired=await client.query(`WITH expired AS(SELECT o.id FROM site_audit_occurrence o JOIN site_audit_schedule s ON s.project_id=o.project_id WHERE o.project_id=$1 AND o.created_at<s.history_retained_from AND o.data_expired_at IS NULL ORDER BY o.created_at,o.id LIMIT 1000 FOR UPDATE OF o) UPDATE site_audit_occurrence o SET run_id=NULL,reason=NULL,data_expired_at=clock_timestamp() FROM expired e WHERE o.id=e.id`,[projectId]);
 const pending=(await client.query<{pending:boolean}>(`SELECT EXISTS(SELECT 1 FROM site_audit_occurrence o JOIN site_audit_schedule s ON s.project_id=o.project_id WHERE o.project_id=$1 AND o.created_at<s.history_retained_from AND o.data_expired_at IS NULL) AS pending`,[projectId])).rows[0].pending;
 return {expired:expired.rowCount??0,pending};
}
async function response(client:PoolClient,projectId:string,role:WorkspaceRole,ack?:Ack){
 await expireSiteAuditScheduleHistory(client,projectId);
 const row=await schedule(client,projectId);
 const occurrences=row?(await client.query(`WITH read_clock AS MATERIALIZED(SELECT clock_timestamp() AS at)
  SELECT o.id,to_char(o.scheduled_for AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "scheduledFor",
   CASE WHEN o.status='skipped' THEN 'skipped' WHEN r.id IS NULL THEN 'unavailable' ELSE r.status END AS status,
   CASE WHEN o.status='skipped' THEN NULL ELSE r.id END AS "runId",CASE WHEN o.status='skipped' OR r.id IS NOT NULL THEN o.reason ELSE NULL END AS reason
  FROM site_audit_occurrence o JOIN site_audit_schedule s ON s.project_id=o.project_id JOIN workspace w ON w.id=s.workspace_id CROSS JOIN read_clock
  LEFT JOIN site_audit_run r ON r.id=o.run_id AND r.project_id=o.project_id AND r.deleted_at IS NULL AND r.data_expired_at IS NULL AND r.created_at>=GREATEST(s.history_retained_from,read_clock.at-w.derived_history_days*interval '24 hours')
  WHERE o.project_id=$1 AND o.data_expired_at IS NULL AND o.created_at>=GREATEST(s.history_retained_from,read_clock.at-w.derived_history_days*interval '24 hours')
  ORDER BY o.scheduled_for DESC,o.id DESC LIMIT 20`,[projectId])).rows:[];
 const value={projectId,role,schedule:row?{revision:row.revision,enabled:row.enabled,calendar:row.calendar,definition:row.definition,origin:row.origin,nextDueAt:row.next_due_at?.toISOString()??null,approvedAt:row.approved_at.toISOString(),lastStatus:row.last_status,occurrences}:null};
 return ack?siteAuditScheduleMutationResponse.parse({...value,ack}):siteAuditScheduleResponse.parse(value);
}
export async function getSiteAuditSchedule(projectId:string,userId:string){
 return withAuditLock({projectId,actor:{userId,permission:'read'}},({client,role})=>response(client,projectId,role!));
}
export async function saveSiteAuditSchedule(projectId:string,userId:string,raw:unknown){
 const input=parse(siteAuditScheduleSave,raw);
 return withAuditLock({projectId,actor:{userId,permission:'manage'}},async({client,project,role})=>{
  const receipt=await contentReceipt(client,projectId,input.requestId,'audit.schedule.save',{userId,...input});
  if(receipt.replayed)return response(client,projectId,role!,siteAuditScheduleAck.parse(receipt.result));
  const row=await schedule(client,projectId);checkRevision(row,input.expectedRevision);
  const {requestId:_,...definition}=parseSiteAuditStart({...input.definition,requestId:input.requestId});
  const selected=await selectSiteAuditOrigin(client,project,definition.domainId),calendar=input.calendar;
  await openSiteAuditAccess(client,project,definition.domainId,definition.crawlerAccess,(await client.query<{at:Date}>('SELECT clock_timestamp() AS at')).rows[0].at);
  if(!(await client.query('SELECT 1 FROM pg_timezone_names WHERE name=$1',[calendar.timezone])).rowCount)throw new FoundationError(400,'Choose a supported IANA/PostgreSQL time zone.');
  if(row)await cancelQueuedApproval(client,projectId,row.approval_id);
  const revision=input.expectedRevision+1;
  await client.query(`WITH tick AS MATERIALIZED(SELECT clock_timestamp() AS at)
   INSERT INTO site_audit_schedule(project_id,workspace_id,revision,enabled,definition,calendar,approval_id,approval_user_id,origin,domain_hostname,domain_verified_at,domain_revision,approved_at,next_due_at,created_at,updated_at)
   SELECT $1,$2,$3,true,$4,$5,$6,$7,$8,$9,$10,$11,at,rank_next_due($12,$13,$14,$15,$16,at),at,at FROM tick
   ON CONFLICT(project_id) DO UPDATE SET revision=EXCLUDED.revision,enabled=true,definition=EXCLUDED.definition,calendar=EXCLUDED.calendar,approval_id=EXCLUDED.approval_id,approval_user_id=EXCLUDED.approval_user_id,origin=EXCLUDED.origin,domain_hostname=EXCLUDED.domain_hostname,domain_verified_at=EXCLUDED.domain_verified_at,domain_revision=EXCLUDED.domain_revision,approved_at=EXCLUDED.approved_at,next_due_at=EXCLUDED.next_due_at,last_status=NULL,updated_at=EXCLUDED.updated_at`,
   [projectId,project.workspaceId,revision,JSON.stringify(definition),JSON.stringify(calendar),randomUUID(),userId,selected.origin,selected.hostname,selected.verified,selected.revision,calendar.interval,calendar.timezone,calendar.hour,calendar.minute,calendar.weekday]);
  const ack:Ack={requestId:input.requestId,operation:'save',revision,...(definition.crawlerAccess?{crawlerAccess:definition.crawlerAccess}:{})};await receipt.save(ack);
  return response(client,projectId,role!,ack);
 });
}
export async function pauseSiteAuditSchedule(projectId:string,userId:string,raw:unknown){
 const input=parse(siteAuditSchedulePause,raw);
 return withAuditLock({projectId,actor:{userId,permission:'manage'}},async({client,role})=>{
  const receipt=await contentReceipt(client,projectId,input.requestId,'audit.schedule.pause',{userId,...input});
  if(receipt.replayed)return response(client,projectId,role!,siteAuditScheduleAck.parse(receipt.result));
  const row=await schedule(client,projectId);checkRevision(row,input.expectedRevision);
  if(!row)throw new FoundationError(404,'Audit schedule not found or unavailable.');
  await cancelQueuedApproval(client,projectId,row.approval_id);
  const revision=row.revision+1;
  await client.query("UPDATE site_audit_schedule SET revision=$2,enabled=false,next_due_at=NULL,last_status='Paused.',updated_at=clock_timestamp() WHERE project_id=$1",[projectId,revision]);
  const ack:Ack={requestId:input.requestId,operation:'pause',revision};await receipt.save(ack);
  return response(client,projectId,role!,ack);
 });
}
async function advance(client:PoolClient,row:ScheduleRow,status:string,disable=false){
 const calendar=parse(promptCalendar,row.calendar);
 await client.query(`WITH tick AS MATERIALIZED(SELECT clock_timestamp() AS at) UPDATE site_audit_schedule SET enabled=NOT $2,next_due_at=CASE WHEN $2 THEN NULL ELSE rank_next_due($3,$4,$5,$6,$7,(SELECT at FROM tick)) END,last_status=$8,updated_at=(SELECT at FROM tick) WHERE project_id=$1`,[row.project_id,disable,calendar.interval,calendar.timezone,calendar.hour,calendar.minute,calendar.weekday,status]);
}
export async function claimDueSiteAuditOccurrence(){
 const due=(await getDatabase().pool.query<{project_id:string;approval_id:string;due_at:string}>(`SELECT project_id,approval_id,${dueText} AS due_at FROM site_audit_schedule WHERE enabled AND next_due_at<=clock_timestamp() ORDER BY next_due_at,project_id LIMIT 1`)).rows[0];
 if(!due)return null;
 const boss=await getBoss();
 return withAuditLock({internal:true,projectId:due.project_id},async locked=>{
  const {client,project}=locked,row=await schedule(client,project.id);
  if(!row||!row.enabled||!row.is_due||row.approval_id!==due.approval_id||row.due_at!==due.due_at)return null;
  const prior=(await client.query<{id:string}>('SELECT id FROM site_audit_occurrence WHERE project_id=$1 AND scheduled_for=$2::timestamptz',[project.id,due.due_at])).rows[0];
  if(prior){await advance(client,row,'Previously recorded occurrence.');return prior.id;}
  const role=(await client.query<{role:WorkspaceRole}>('SELECT role FROM membership WHERE workspace_id=$1 AND user_id=$2',[project.workspaceId,row.approval_user_id])).rows[0]?.role??null;
  let reason:string|null=role==='owner'||role==='admin'?null:'permission_changed';
  const requestId=randomUUID();let input:ReturnType<typeof parseSiteAuditStart>|null=null;
  if(!reason){
   try{
    input=parseSiteAuditStart({...row.definition,requestId});
    const selected=await selectSiteAuditOrigin(client,project,input.domainId);
    if(selected.origin!==row.origin||selected.hostname!==row.domain_hostname||selected.verified!==row.domain_verified_text||selected.revision!==row.domain_revision)reason='scope_changed';
    if(!reason)await openSiteAuditAccess(client,project,input.domainId,input.crawlerAccess,(await client.query<{at:Date}>('SELECT clock_timestamp() AS at')).rows[0].at);
   }catch(error){if(error instanceof SiteAuditAccessUnavailable)reason=error.reason;else if(error instanceof FoundationError&&[400,404].includes(error.status))reason='scope_changed';else throw error;}
  }
  const disable=reason!==null;
  if(!reason&&(await client.query("SELECT 1 FROM site_audit_run WHERE workspace_id=$1 AND status IN('queued','running','cancelling')",[project.workspaceId])).rowCount)reason='workspace_overlap';
  let runId:string|null=null;
  if(!reason){const queued=await queueSiteAuditInTransaction({...locked,role},row.approval_user_id,input!,boss);runId=queued.run.id;}
  const id=randomUUID();
  await client.query('INSERT INTO site_audit_occurrence(id,project_id,approval_id,scheduled_for,request_id,run_id,status,reason) VALUES($1,$2,$3,$4::timestamptz,$5,$6,$7,$8)',[id,project.id,row.approval_id,due.due_at,requestId,runId,reason?'skipped':'queued',reason]);
  await advance(client,row,reason??'queued',disable);
  return id;
 });
}
