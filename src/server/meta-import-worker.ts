import {randomUUID} from 'node:crypto';
import {toUSVString} from 'node:util';
import type {PoolClient} from 'pg';
import {z} from 'zod';
import {getDatabase} from './db.ts';
import {getBoss} from './jobs.ts';
import {canonicalHash} from './context-input.ts';
import {prepareMetaReportSource,inspectMetaReportSource,withMetaReportSource,type MetaReportSource} from './meta-auth.ts';
import {metaRequest,MetaRequestError,type MetaRequest,type MetaRateHints} from './meta-http.ts';
import {normalizeMetaRows} from './meta-report-rows.ts';
import {metaActive,metaQueue,metaImportFields,metaImportRow,withMetaImport,type MetaImport} from './meta-imports.ts';

const uuid=z.uuid(),decimal=z.string().regex(/^[1-9][0-9]{0,39}$(?![\s\S])/);
const text=(max:number)=>z.string().min(1).max(max).refine(s=>toUSVString(s)===s&&!/[\x00-\x1f\x7f]/.test(s));
const cursor=text(4096).refine(s=>Buffer.byteLength(s)<=4096);
class LostLease extends Error{}
class Deadline extends Error{}
function provider<S extends z.ZodType>(schema:S,value:unknown):z.output<S>{const parsed=schema.safeParse(value);if(!parsed.success)throw new MetaRequestError('invalid_response');return parsed.data;}
function matches(row:MetaImport,snapshot:MetaReportSource){
 const s=row.source,a=snapshot.account;
 return row.grant_id===snapshot.flow.id&&row.app_revision===snapshot.app.revision&&row.connection_revision===snapshot.row.revision&&s?.accountId===a.id&&s.currency===a.currency&&s.timeZone===a.timeZone&&s.accountName===a.name&&s.graphVersion==='v26.0'&&s.report===row.report&&s.definitionVersion===1&&row.definition_version===1;
}
async function lease(client:PoolClient,claim:MetaImport,deadline=true){
 const row=await metaImportRow(client,claim.id,true);
 if(!row||!metaActive.includes(row.status)||row.deleted_at||row.data_expired_at||row.generation!==claim.generation||row.lease_token!==claim.lease_token)throw new LostLease();
 if(deadline&&row.deadline_at.getTime()<=Date.now())throw new Deadline();
 if(!row.lease_expires_at||row.lease_expires_at.getTime()<=Date.now())throw new LostLease();
 return row;
}
async function finish(client:PoolClient,row:MetaImport,status:string,diagnostic:string|null,warnings=row.warnings){
 await client.query(`UPDATE meta_import SET status=$2,diagnostic_code=$3,warnings=$4,completed_at=clock_timestamp(),lease_token=NULL,lease_expires_at=NULL,
  provider_report_id=NULL,next_cursor=NULL,cursor_hashes='{}',updated_at=clock_timestamp() WHERE id=$1`,[row.id,status,diagnostic,JSON.stringify(warnings)]);
}
async function deny(initial:MetaImport,diagnostic='source_unavailable'){
 await withMetaImport(initial.id,async(client,row)=>{if(row.generation===initial.generation&&row.lease_token===initial.lease_token&&metaActive.includes(row.status)&&!row.deleted_at)await finish(client,row,'denied',diagnostic);});
}
async function retryAt(client:PoolClient,row:MetaImport,seconds:number,diagnostic:string|null,retries=row.retry_attempts){
 await client.query(`UPDATE meta_import SET next_attempt_at=LEAST(deadline_at,clock_timestamp()+make_interval(secs=>$2)),diagnostic_code=$3,retry_attempts=$4,
  lease_token=NULL,lease_expires_at=NULL,updated_at=clock_timestamp() WHERE id=$1`,[row.id,seconds,diagnostic,retries]);
}
function rateDelay(rate:MetaRateHints){return Math.max(rate.retryAfterSeconds??0,(rate.appUtilizationPercent??0)>=90||(rate.accountUtilizationPercent??0)>=90?60:0);}
function rateCode(rate:MetaRateHints){return (rate.appUtilizationPercent??0)>=90?'app_throttled':'account_throttled';}

/** One durable step. Job payload contains only the local import UUID. No handler sleeps or POST retries. */
export async function runMetaImportStep(importId:string):Promise<void>{
 if(!uuid.safeParse(importId).success)throw new Error('Invalid Meta import job.');
 const initial=(await getDatabase().pool.query<MetaImport>(`SELECT ${metaImportFields} FROM meta_import i WHERE i.id=$1`,[importId])).rows[0];
 if(!initial||!metaActive.includes(initial.status)||initial.next_attempt_at.getTime()>Date.now()||initial.lease_expires_at&&initial.lease_expires_at.getTime()>Date.now())return;
 let snapshot:MetaReportSource;
 try{snapshot=await prepareMetaReportSource(initial.project_id,initial.user_id,initial.connection_id,initial.connection_revision);if(!matches(initial,snapshot))throw new Error();}
 catch{await deny(initial);return;}
 let claim:MetaImport|undefined;
 try{
  claim=await withMetaReportSource(snapshot,initial.user_id,async client=>{
   const row=await metaImportRow(client,importId,true);if(!row||!metaActive.includes(row.status)||!matches(row,snapshot)||row.deleted_at||row.data_expired_at||row.next_attempt_at.getTime()>Date.now()||row.lease_expires_at&&row.lease_expires_at.getTime()>Date.now())return;
   // Crash after the durable submit marker is deliberately ambiguous, even if no socket was opened.
   if(row.status==='submitting'){await finish(client,row,'submission_unknown','submission_unconfirmed');return;}
   if(row.deadline_at.getTime()<=Date.now()){await finish(client,row,row.status==='reading'&&row.row_count>0?'partial':'failed','deadline_reached',[...new Set([...row.warnings,'deadline_limit'])]);return;}
   if(row.generation==='9223372036854775807'){await finish(client,row,'failed','generation_limit');return;}
   // Reuse other active import cooldown receipts without exposing foreign account/workspace existence.
   const cooldown=(await client.query<{until:Date|null}>(`SELECT max(i.next_attempt_at) AS until FROM meta_import i JOIN meta_oauth_flow f ON f.id=i.grant_id
    WHERE f.registration_id=$1 AND i.status=ANY($2::text[]) AND i.deleted_at IS NULL AND i.data_expired_at IS NULL AND i.next_attempt_at>clock_timestamp()
    AND (i.diagnostic_code='app_throttled' OR i.diagnostic_code='account_throttled' AND i.source->>'accountId'=$3)`,[snapshot.app.id,metaActive,snapshot.account.id])).rows[0]?.until;
   if(cooldown){await client.query('UPDATE meta_import SET next_attempt_at=LEAST(deadline_at,$2),updated_at=clock_timestamp() WHERE id=$1',[row.id,cooldown]);return;}
   return(await client.query<MetaImport>(`UPDATE meta_import AS i SET generation=generation+1,lease_token=$2,lease_expires_at=clock_timestamp()+interval '3 minutes',
    status=CASE WHEN status='queued' THEN 'submitting' ELSE status END,submitted_at=CASE WHEN status='queued' THEN clock_timestamp() ELSE submitted_at END,updated_at=clock_timestamp() WHERE id=$1 RETURNING ${metaImportFields}`,[row.id,randomUUID()])).rows[0];
  });
 }catch{await deny(initial);return;}
 if(!claim)return;
 const owned=claim;
 const gate=()=>withMetaReportSource(snapshot,owned.user_id,client=>lease(client,owned));
 const credentials={appId:snapshot.app.app_id,appSecret:snapshot.secrets.appSecret,token:snapshot.accessToken};
 let submitted=false;
 try{
  await inspectMetaReportSource(snapshot,owned.user_id,async client=>{await lease(client,owned);});
  // Account-local dates cannot be safely relabelled if the remote account's timezone/currency changes.
  await gate();const account=provider(z.object({id:text(44),account_id:decimal,name:text(512),currency:z.string().regex(/^[A-Z]{3}$(?![\s\S])/),timezone_name:text(120),account_status:z.number().int().nonnegative()}),(await metaRequest({operation:'account',...credentials,accountId:snapshot.account.id})).data);
  if(account.id!=='act_'+snapshot.account.id||account.account_id!==snapshot.account.id||account.currency!==snapshot.account.currency||account.timezone_name!==snapshot.account.timeZone||account.name!==snapshot.account.name)throw new MetaRequestError('invalid_response');
  await gate();let request:MetaRequest;
  if(owned.status==='submitting')request={operation:'submitReport',...credentials,accountId:snapshot.account.id,report:owned.report,from:owned.date_from,to:owned.date_to};
  else if(owned.status==='waiting'){
   if(owned.poll_attempts>=120){await withMetaReportSource(snapshot,owned.user_id,async client=>{const row=await lease(client,owned);await finish(client,row,'failed','poll_limit');});return;}
   request={operation:'reportStatus',...credentials,reportRunId:owned.provider_report_id!};
  }else if(owned.status==='reading')request={operation:'reportPage',...credentials,reportRunId:owned.provider_report_id!,report:owned.report,...(owned.next_cursor?{after:owned.next_cursor}:{})};
  else throw new LostLease();
  submitted=owned.status==='submitting';
  const response=await metaRequest(request);
  await withMetaReportSource(snapshot,owned.user_id,async client=>{
   const row=await lease(client,owned),delay=rateDelay(response.rate),diagnostic=delay?rateCode(response.rate):null;
   if(row.status==='submitting'){
    const id=provider(z.object({report_run_id:decimal}),response.data).report_run_id;
    await client.query("UPDATE meta_import SET status='waiting',provider_report_id=$2,retry_attempts=0,updated_at=clock_timestamp() WHERE id=$1",[row.id,id]);
    await retryAt(client,row,Math.max(15,delay),diagnostic,0);return;
   }
   if(row.status==='waiting'){
    const status=provider(z.object({id:decimal,account_id:decimal,async_status:z.enum(['Job Not Started','Job Started','Job Running','Job Completed','Job Failed','Job Skipped']),async_percent_completion:z.number().int().min(0).max(100),date_start:z.iso.date(),date_stop:z.iso.date()}),response.data);
    if(status.id!==row.provider_report_id||status.account_id!==snapshot.account.id||status.date_start!==row.date_from||status.date_stop!==row.date_to)throw new MetaRequestError('invalid_response');
    await client.query('UPDATE meta_import SET poll_attempts=poll_attempts+1 WHERE id=$1',[row.id]);
    if(['Job Failed','Job Skipped'].includes(status.async_status)){await finish(client,row,'failed','provider_report_failed');return;}
    if(status.async_status==='Job Completed'&&status.async_percent_completion!==100)throw new MetaRequestError('invalid_response');
    if(status.async_status==='Job Completed')await client.query("UPDATE meta_import SET status='reading' WHERE id=$1",[row.id]);
    await retryAt(client,row,Math.max(status.async_status==='Job Completed'?0:15,delay),diagnostic,0);return;
   }
   const page=provider(z.object({data:z.unknown(),paging:z.object({next:text(16000).optional(),cursors:z.object({after:cursor.optional()}).optional()}).optional()}),response.data);
   const rows=normalizeMetaRows(page.data,{report:row.report,accountId:snapshot.account.id,currency:snapshot.account.currency,from:row.date_from,to:row.date_to});
   const after=page.paging?.next?page.paging.cursors?.after:null;
   if(page.paging?.next&&(!after||!rows.length)||after&&row.cursor_hashes.includes(canonicalHash(after)))throw new MetaRequestError('invalid_response');
   if(row.pages>=50||row.row_count+rows.length>25000)throw new MetaRequestError('invalid_response');
   if((await client.query(`SELECT 1 FROM meta_import_page p CROSS JOIN LATERAL jsonb_array_elements(p.rows) old_row
    JOIN jsonb_array_elements($2::jsonb) new_row ON old_row->>'date'=new_row->>'date' AND (old_row->'campaignId')=(new_row->'campaignId') WHERE p.import_id=$1 LIMIT 1`,[row.id,JSON.stringify(rows)])).rowCount)throw new MetaRequestError('invalid_response');
   await client.query('INSERT INTO meta_import_page(import_id,project_id,workspace_id,page,rows,row_count,content_hash) VALUES($1,$2,$3,$4,$5,$6,$7)',[row.id,row.project_id,row.workspace_id,row.pages,JSON.stringify(rows),rows.length,canonicalHash(rows)]);
   const pages=row.pages+1;
   await client.query('UPDATE meta_import SET pages=$2,row_count=row_count+$3,next_cursor=$4,cursor_hashes=cursor_hashes||$5::text[],retry_attempts=0 WHERE id=$1',[row.id,pages,rows.length,after??null,after?[canonicalHash(after)]:[]]);
   if(!after)await finish(client,row,'completed',null);
   else if(pages>=50)await finish(client,row,'partial','page_limit',[...new Set([...row.warnings,'row_limit'])]);
   else await retryAt(client,row,delay,diagnostic,0);
  });
 }catch(error){
  if(error instanceof LostLease)return;
  try{await withMetaReportSource(snapshot,owned.user_id,async client=>{
   // A matching token/generation may close its expired lease; it can never close a replacement's lease.
   const row=await metaImportRow(client,owned.id,true);
   if(!row||row.generation!==owned.generation||row.lease_token!==owned.lease_token||!metaActive.includes(row.status)||row.deleted_at||row.data_expired_at)return;
   if(error instanceof MetaRequestError&&error.reauthorize)await client.query("UPDATE meta_connection SET status='reconnect',updated_at=clock_timestamp() WHERE id=$1 AND current_grant_id=$2 AND status='ready'",[row.connection_id,row.grant_id]);
   if(submitted){await finish(client,row,'submission_unknown','submission_unconfirmed');return;}
   if(error instanceof Deadline||row.deadline_at.getTime()<=Date.now()){await finish(client,row,row.status==='reading'&&row.row_count>0?'partial':'failed','deadline_reached',[...new Set([...row.warnings,'deadline_limit'])]);return;}
   if(error instanceof MetaRequestError&&error.reauthorize){await finish(client,row,'denied','provider_access_lost');return;}
   if(error instanceof MetaRequestError&&error.retryable&&row.status!=='submitting'&&row.retry_attempts<3){const delay=Math.max(15*2**row.retry_attempts,rateDelay(error.rate));await retryAt(client,row,delay,error.reason==='throttled'?rateCode(error.rate):'provider_retry',row.retry_attempts+1);return;}
   await finish(client,row,'failed',error instanceof MetaRequestError?error.reason==='invalid_response'?'invalid_provider_report':'provider_unavailable':'invalid_provider_report');
  });}catch{await deny(owned);}
 }
}

/** Recovery only enqueues identifiers; all provider authority is checked by the claimed step. */
export async function reconcileMetaImports(){
 const row=(await getDatabase().pool.query<{id:string}>(`SELECT i.id FROM meta_import i WHERE i.status=ANY($1::text[]) AND i.deleted_at IS NULL AND i.data_expired_at IS NULL
  AND i.next_attempt_at<=clock_timestamp() AND (i.lease_expires_at IS NULL OR i.lease_expires_at<=clock_timestamp())
  AND NOT EXISTS(SELECT 1 FROM pgboss.job j WHERE j.name=$2 AND j.data->>'importId'=i.id::text AND j.state IN ('created','retry','active'))
  ORDER BY i.next_attempt_at,i.id LIMIT 1`,[metaActive,metaQueue])).rows[0];if(!row)return {queued:false};
 const boss=await getBoss();return {queued:!!await boss.send(metaQueue,{importId:row.id},{retryLimit:0,expireInSeconds:240})};
}
