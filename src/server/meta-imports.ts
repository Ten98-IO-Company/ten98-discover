import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {z} from 'zod';
import {FoundationError} from './auth.ts';
import {getDatabase} from './db.ts';
import {getBoss} from './jobs.ts';
import {canonicalHash} from './context-input.ts';
import {contentReceipt,readContentCursor,withContentProject} from './project-context.ts';
import {prepareMetaReportSource,withMetaReportSource,type MetaReportSource} from './meta-auth.ts';
import {normalizeMetaRows,type MetaDailyRow,type MetaReportKind} from './meta-report-rows.ts';

export const metaQueue='meta-report-import';
export const metaActive=['queued','submitting','waiting','reading'];
export type MetaReportDefinition={provider:'meta_ads';accountId:string;accountName:string;currency:string;timeZone:string;graphVersion:'v26.0';report:MetaReportKind;definitionVersion:1;level:'account'|'campaign';breakdowns:[];attribution:{mode:'meta_reported';requestedWindows:['7d_click','1d_view'];reportingPolicy:'meta_mixed';effectiveAdSetSettings:'unknown'}};
export type MetaImport={id:string;workspace_id:string;project_id:string;user_id:string;connection_id:string;grant_id:string;connection_revision:number;app_revision:number;request_id:string;report:MetaReportKind;definition_version:number;date_from:string;date_to:string;source:MetaReportDefinition|null;status:string;generation:string;lease_token:string|null;lease_expires_at:Date|null;provider_report_id:string|null;next_cursor:string|null;cursor_hashes:string[];poll_attempts:number;retry_attempts:number;pages:number;row_count:number;next_attempt_at:Date;deadline_at:Date;submitted_at:Date|null;completed_at:Date|null;diagnostic_code:string|null;warnings:string[];data_expired_at:Date|null;deleted_at:Date|null;payload_cleanup_completed_at:Date|null;created_at:Date;updated_at:Date};
export const metaImportFields='i.*,i.date_from::text AS date_from,i.date_to::text AS date_to';
const uuid=z.uuid(),input=z.object({requestId:uuid,revision:z.number().int().min(1).max(2147483647),report:z.enum(['account_daily','campaign_daily']),from:z.iso.date(),to:z.iso.date()}).strict();
function parse<S extends z.ZodType>(schema:S,value:unknown):z.output<S>{const result=schema.safeParse(value);if(!result.success)throw new FoundationError(400,'Check the Meta import fields.');return result.data;}
function missing():never{throw new FoundationError(404,'Meta import not found or unavailable.');}
export async function metaImportRow(client:PoolClient,id:string,lock=false){return(await client.query<MetaImport>(`SELECT ${metaImportFields} FROM meta_import i WHERE i.id=$1 ${lock?'FOR UPDATE':''}`,[id])).rows[0];}

/** Keyless local maintenance/cancel gate. No provider request or other network I/O in work. */
export async function withMetaImport<T>(id:string,work:(client:PoolClient,row:MetaImport)=>Promise<T>):Promise<T|null>{
 parse(uuid,id);const client=await getDatabase().pool.connect();
 try{await client.query('BEGIN');
  const initial=(await client.query('SELECT i.workspace_id,i.project_id,i.connection_id,f.registration_id FROM meta_import i JOIN meta_oauth_flow f ON f.id=i.grant_id WHERE i.id=$1',[id])).rows[0];
  if(!initial){await client.query('COMMIT');return null;}
  await client.query('SELECT id FROM meta_app_registration WHERE id=$1 FOR SHARE',[initial.registration_id]);
  await client.query('SELECT id FROM workspace WHERE id=$1 FOR UPDATE',[initial.workspace_id]);
  await client.query('SELECT id FROM project WHERE id=$1 AND workspace_id=$2 FOR UPDATE',[initial.project_id,initial.workspace_id]);
  await client.query('SELECT id FROM meta_connection WHERE id=$1 AND project_id=$2 FOR UPDATE',[initial.connection_id,initial.project_id]);
  const row=await metaImportRow(client,id,true);if(!row){await client.query('COMMIT');return null;}
  const result=await work(client,row);await client.query('COMMIT');return result;
 }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}finally{client.release();}
}

async function accessState(client:PoolClient,row:MetaImport){
 const state=(await client.query(`SELECT EXISTS(SELECT 1 FROM meta_oauth_flow f JOIN meta_deletion_request d
   ON d.registration_id=f.registration_id AND d.subject_hash=f.subject_hash WHERE f.id=$1 AND (d.status<>'local_deleted' OR d.fence_epoch>f.start_epoch)) AS blocked,
   ($3::timestamptz IS NOT NULL AND $3::timestamptz<=clock_timestamp()-make_interval(days=>w.derived_history_days)) AS expired
   FROM workspace w WHERE w.id=$2`,[row.grant_id,row.workspace_id,row.completed_at])).rows[0];
 return {deleted:!!row.deleted_at||!!state?.blocked,expired:!!row.data_expired_at||!!state?.expired};
}
async function dto(client:PoolClient,row:MetaImport){
 const state=await accessState(client,row),available=!state.deleted&&!state.expired&&['completed','partial'].includes(row.status);
 return {id:row.id,connectionId:row.connection_id,status:row.status,dataStatus:state.deleted?'unavailable':state.expired?'expired':available?'available':metaActive.includes(row.status)?'pending':'unavailable',source:state.deleted?null:row.source,
  from:row.date_from,to:row.date_to,requestedAt:row.created_at.toISOString(),completedAt:row.completed_at?.toISOString()??null,recordedRows:row.row_count,readableRows:available?row.row_count:null,
  coverage:available?(row.status==='completed'?'complete':'partial'):'unavailable',warnings:state.deleted?[]:row.warnings,nextRetryAt:metaActive.includes(row.status)&&!state.deleted?row.next_attempt_at.toISOString():null,diagnosticCode:state.deleted?'data_deleted':row.diagnostic_code};
}
function definition(snapshot:MetaReportSource,report:MetaReportKind):MetaReportDefinition{return {provider:'meta_ads',accountId:snapshot.account.id,accountName:snapshot.account.name,currency:snapshot.account.currency,timeZone:snapshot.account.timeZone,graphVersion:'v26.0',report,definitionVersion:1,level:report==='account_daily'?'account':'campaign',breakdowns:[],attribution:{mode:'meta_reported',requestedWindows:['7d_click','1d_view'],reportingPolicy:'meta_mixed',effectiveAdSetSettings:'unknown'}};}

export async function enqueueMetaImport(projectId:string,userId:string,connectionId:string,raw:unknown){
 parse(uuid,connectionId);const data=parse(input,raw),operation='meta.import:'+connectionId,receiptInput={userId,...data};
 const acknowledgement=(importId:string)=>({requestId:data.requestId,importId,connectionId,revision:data.revision,report:data.report,from:data.from,to:data.to});
 // A replay needs current owner authority, but never a still-usable provider grant or vault.
 const replay=await withContentProject(projectId,userId,true,async(client,p)=>{if(p.role!=='owner')missing();const receipt=await contentReceipt(client,p.id,data.requestId,operation,receiptInput);if(!receipt.replayed)return null;
  const row=await metaImportRow(client,parse(z.object({id:uuid}).strict(),receipt.result).id);if(!row||row.project_id!==p.id)missing();return {role:p.role,acknowledgement:acknowledgement(row.id),import:await dto(client,row),replayed:true};});if(replay)return replay;
 const snapshot=await prepareMetaReportSource(projectId,userId,connectionId,data.revision);
 try{normalizeMetaRows([],{report:data.report,accountId:snapshot.account.id,currency:snapshot.account.currency,from:data.from,to:data.to});}catch{throw new FoundationError(400,'Choose a valid range of at most 31 account-local calendar days.');}
 const boss=await getBoss();
 return withMetaReportSource(snapshot,userId,async client=>{
  const receipt=await contentReceipt(client,projectId,data.requestId,operation,receiptInput);if(receipt.replayed){const row=await metaImportRow(client,parse(z.object({id:uuid}).strict(),receipt.result).id);if(!row||row.project_id!==projectId)missing();return {role:'owner' as const,acknowledgement:acknowledgement(row.id),import:await dto(client,row),replayed:true};}
  const date=(await client.query<{today:string;earliest:string}>(`SELECT (clock_timestamp() AT TIME ZONE $1)::date::text AS today,((clock_timestamp() AT TIME ZONE $1)::date-interval '37 months')::date::text AS earliest`,[snapshot.account.timeZone])).rows[0];
  if(data.from<date.earliest||data.to>date.today)throw new FoundationError(400,'Choose dates within the last 37 months, ending no later than today in the account time zone.');
  if((await client.query('SELECT 1 FROM meta_import WHERE connection_id=$1 AND status=ANY($2::text[])',[connectionId,metaActive])).rowCount)throw new FoundationError(409,'This source already has an active import. Wait or cancel it before starting another.');
  const id=randomUUID(),warnings=data.to===date.today?['current_day_provisional']:[];
  const row=(await client.query<MetaImport>(`INSERT INTO meta_import AS i(id,workspace_id,project_id,user_id,connection_id,grant_id,connection_revision,app_revision,request_id,report,date_from,date_to,source,warnings)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING ${metaImportFields}`,[id,snapshot.row.workspace_id,projectId,userId,connectionId,snapshot.flow.id,data.revision,snapshot.app.revision,data.requestId,data.report,data.from,data.to,definition(snapshot,data.report),JSON.stringify(warnings)])).rows[0];
  if(!await boss.send(metaQueue,{importId:id},{retryLimit:0,expireInSeconds:240,db:{executeSql:(text,values)=>client.query(text,values)}}))throw new FoundationError(503,'The Meta import could not be queued. Retry the same request.');
  await receipt.save({id});return {role:'owner' as const,acknowledgement:acknowledgement(id),import:await dto(client,row),replayed:false};
 });
}

function oneCursor(params:URLSearchParams){if([...params.keys()].some(k=>k!=='cursor')||params.getAll('cursor').length>1)throw new FoundationError(400,'Use one Meta report page cursor.');return params.get('cursor');}
export async function listMetaImports(projectId:string,userId:string,connectionId:string,params=new URLSearchParams()){
 parse(uuid,connectionId);const value=oneCursor(params);
 return withContentProject(projectId,userId,false,async(client,p)=>{
  if(!(await client.query('SELECT id FROM meta_connection WHERE id=$1 AND project_id=$2',[connectionId,p.id])).rowCount)missing();
  const scope={projectId:p.id,connectionId,list:'meta-imports'},cursor=readContentCursor(value,scope);
  const result=await client.query<MetaImport&{createdAt:string}>(`SELECT ${metaImportFields},to_char(i.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAt" FROM meta_import i
   WHERE i.project_id=$1 AND i.connection_id=$2 AND ($3::timestamptz IS NULL OR (i.created_at,i.id)<($3::timestamptz,$4::uuid)) ORDER BY i.created_at DESC,i.id DESC LIMIT 51`,[p.id,connectionId,cursor?.at??null,cursor?.id??null]);
  const imports=[];for(const row of result.rows.slice(0,50))imports.push(await dto(client,row));const last=result.rows[49];
  return {role:p.role,imports,nextCursor:result.rows.length>50?Buffer.from(JSON.stringify({scope:canonicalHash(scope),at:last.createdAt,id:last.id})).toString('base64url'):null};
 });
}
export async function readMetaImport(projectId:string,userId:string,importId:string,params=new URLSearchParams()){
 parse(uuid,importId);const value=oneCursor(params),scope=canonicalHash({projectId,importId}),page=z.object({scope:z.literal(scope),offset:z.number().int().min(0).max(25000)}).strict();let offset=0;
 if(value){try{if(value.length>512||!/^[A-Za-z0-9_-]+$(?![\s\S])/.test(value))throw new Error();offset=parse(page,JSON.parse(Buffer.from(value,'base64url').toString('utf8'))).offset;}catch{throw new FoundationError(400,'Reload this Meta report before loading another page.');}}
 return withContentProject(projectId,userId,false,async(client,p)=>{const row=await metaImportRow(client,importId);if(!row||row.project_id!==p.id)missing();const metadata=await dto(client,row);
  const result=metadata.dataStatus==='available'?await client.query<{row:MetaDailyRow}>(`SELECT item.value AS row FROM meta_import_page p CROSS JOIN LATERAL jsonb_array_elements(p.rows) WITH ORDINALITY item(value,n)
   WHERE p.import_id=$1 AND p.project_id=$2 ORDER BY p.page,item.n LIMIT 51 OFFSET $3`,[row.id,p.id,offset]):{rows:[]};
  return {role:p.role,import:metadata,rows:result.rows.slice(0,50).map(r=>r.row),nextCursor:result.rows.length>50?Buffer.from(JSON.stringify({scope,offset:offset+50})).toString('base64url'):null};
 });
}

export async function cancelMetaImport(projectId:string,userId:string,importId:string,raw:unknown){
 parse(uuid,projectId);parse(uuid,userId);const data=parse(z.object({requestId:uuid}).strict(),raw);
 const result=await withMetaImport(importId,async(client,row)=>{if(row.project_id!==projectId||!(await client.query("SELECT 1 FROM membership WHERE workspace_id=$1 AND user_id=$2 AND role='owner'",[row.workspace_id,userId])).rowCount)missing();
  const receipt=await contentReceipt(client,projectId,data.requestId,'meta.cancel:'+importId,{userId,...data});
  if(!receipt.replayed){if(metaActive.includes(row.status))await client.query("UPDATE meta_import SET status='cancelled',completed_at=clock_timestamp(),lease_token=NULL,lease_expires_at=NULL,provider_report_id=NULL,next_cursor=NULL,cursor_hashes='{}',diagnostic_code='cancelled_locally',updated_at=clock_timestamp() WHERE id=$1",[row.id]);await receipt.save({id:row.id});}
  return {role:'owner' as const,acknowledgement:{requestId:data.requestId,importId:row.id},import:await dto(client,(await metaImportRow(client,row.id))!),replayed:receipt.replayed};
 });if(result===null)missing();return result;
}

/** Payload is hidden by the retention deadline even before this bounded physical cleanup. */
export async function expireMetaImportPages(){
 const candidate=(await getDatabase().pool.query<{id:string}>(`SELECT i.id FROM meta_import i JOIN workspace w ON w.id=i.workspace_id
  WHERE i.completed_at IS NOT NULL AND i.payload_cleanup_completed_at IS NULL AND (i.data_expired_at IS NOT NULL OR i.deleted_at IS NOT NULL OR i.completed_at<=clock_timestamp()-make_interval(days=>w.derived_history_days))
  ORDER BY i.completed_at,i.id LIMIT 1`)).rows[0];if(!candidate)return {imports:0,pages:0};
 return await withMetaImport(candidate.id,async(client,row)=>{
  const state=await accessState(client,row);if(!row.completed_at||!state.expired&&!row.deleted_at)return {imports:0,pages:0};
  await client.query('UPDATE meta_import SET data_expired_at=COALESCE(data_expired_at,clock_timestamp()),lease_token=NULL,lease_expires_at=NULL,provider_report_id=NULL,next_cursor=NULL,cursor_hashes=\'{}\',updated_at=clock_timestamp() WHERE id=$1',[row.id]);
  const deleted=await client.query('DELETE FROM meta_import_page WHERE import_id=$1 AND page IN(SELECT page FROM meta_import_page WHERE import_id=$1 ORDER BY page LIMIT 5)',[row.id]);
  if(!(await client.query('SELECT 1 FROM meta_import_page WHERE import_id=$1 LIMIT 1',[row.id])).rowCount)await client.query('UPDATE meta_import SET payload_cleanup_completed_at=clock_timestamp() WHERE id=$1',[row.id]);
  return {imports:1,pages:deleted.rowCount??0};
 })??{imports:0,pages:0};
}
