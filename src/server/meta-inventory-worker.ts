import {randomUUID} from 'node:crypto';
import {toUSVString} from 'node:util';
import type {PoolClient} from 'pg';
import {z} from 'zod';
import {getDatabase} from './db.ts';
import {getBoss} from './jobs.ts';
import {canonicalHash} from './context-input.ts';
import {prepareMetaReportSource,inspectMetaReportSource,withMetaReportSource,type MetaReportSource} from './meta-auth.ts';
import {metaRequest,MetaRequestError,type MetaRateHints} from './meta-http.ts';
import {normalizeMetaCampaigns,MetaCampaignRowsError} from './meta-campaign-rows.ts';
import {observedMetaCooldown,recordMetaCooldown,MetaCooldown} from './meta-imports.ts';
import {metaInventoryActive,metaInventoryQueue,metaInventoryRow,withMetaInventory,metaCampaignStatuses,type MetaInventory,type MetaInventoryStatus,type MetaInventoryWarning} from './meta-inventory.ts';

const text=(max:number)=>z.string().min(1).max(max).refine(s=>toUSVString(s)===s&&!/[\x00-\x1f\x7f]/.test(s));
const cursor=text(4096).refine(s=>Buffer.byteLength(s)<=4096),decimal=z.string().regex(/^[1-9][0-9]{0,39}$(?![\s\S])/);
class LostLease extends Error{} class Deadline extends Error{}
function provider<S extends z.ZodType>(schema:S,raw:unknown):z.output<S>{const value=schema.safeParse(raw);if(!value.success)throw new MetaRequestError('invalid_response');return value.data;}
function matches(row:MetaInventory,s:MetaReportSource){const a=s.account,d=row.source;return row.grant_id===s.flow.id&&row.app_revision===s.app.revision&&row.connection_revision===s.row.revision&&d?.accountId===a.id&&d.accountName===a.name&&d.currency===a.currency&&d.timeZone===a.timeZone&&d.graphVersion==='v26.0'&&d.definitionVersion===1&&d.kind==='campaign_inventory'&&canonicalHash(d.effectiveStatuses)===canonicalHash(metaCampaignStatuses);}
async function lease(client:PoolClient,claim:MetaInventory,checkDeadline=true){
 const row=await metaInventoryRow(client,claim.id,true);if(!row||!metaInventoryActive.includes(row.status)||row.deleted_at||row.data_expired_at||row.generation!==claim.generation||row.lease_token!==claim.lease_token)throw new LostLease();
 if(checkDeadline&&row.deadline_at.getTime()<=Date.now())throw new Deadline();if(!row.lease_expires_at||row.lease_expires_at.getTime()<=Date.now())throw new LostLease();return row;
}
async function finish(client:PoolClient,row:MetaInventory,status:MetaInventoryStatus,diagnostic:string|null,warnings:MetaInventoryWarning[]=row.warnings){
 await client.query(`UPDATE meta_campaign_inventory SET status=$2,diagnostic_code=$3,warnings=$4,completed_at=clock_timestamp(),lease_token=NULL,lease_expires_at=NULL,next_cursor=NULL,cursor_hashes='{}',updated_at=clock_timestamp() WHERE id=$1`,[row.id,status,diagnostic,JSON.stringify(warnings)]);
}
async function deadline(client:PoolClient,row:MetaInventory){await finish(client,row,row.pages>0?'partial':'failed','deadline_reached',[...new Set([...row.warnings,'deadline_reached' as const])]);}
async function deny(claim:MetaInventory){await withMetaInventory(claim.id,async(client,row)=>{if(row.generation===claim.generation&&row.lease_token===claim.lease_token&&metaInventoryActive.includes(row.status)&&!row.deleted_at)await finish(client,row,'denied','source_unavailable');});}
async function retry(client:PoolClient,row:MetaInventory,seconds:number,diagnostic:string|null,retries=row.retry_attempts){await client.query(`UPDATE meta_campaign_inventory SET next_attempt_at=LEAST(deadline_at,clock_timestamp()+make_interval(secs=>$2)),diagnostic_code=$3,retry_attempts=$4,lease_token=NULL,lease_expires_at=NULL,updated_at=clock_timestamp() WHERE id=$1`,[row.id,seconds,diagnostic,retries]);}
const delay=(r:MetaRateHints)=>Math.max(r.retryAfterSeconds??0,(r.appUtilizationPercent??0)>=90||(r.accountUtilizationPercent??0)>=90?60:0);
const rateCode=(r:MetaRateHints)=>(r.appUtilizationPercent??0)>=90?'app_throttled':'account_throttled';

/** One free, restartable page step. The fixed cursor is safe to GET again after a
 * crash; the lease/generation and page transaction prevent duplicate publication. */
export async function runMetaInventoryStep(inventoryId:string):Promise<void>{
 if(!z.uuid().safeParse(inventoryId).success)throw new Error('Invalid Meta inventory job.');
 const initial=(await getDatabase().pool.query<MetaInventory>('SELECT * FROM meta_campaign_inventory WHERE id=$1',[inventoryId])).rows[0];
 if(!initial||!metaInventoryActive.includes(initial.status)||initial.next_attempt_at.getTime()>Date.now()||initial.lease_expires_at&&initial.lease_expires_at.getTime()>Date.now())return;
 let snapshot:MetaReportSource;try{snapshot=await prepareMetaReportSource(initial.project_id,initial.user_id,initial.connection_id,initial.connection_revision);if(!matches(initial,snapshot))throw new Error();}catch{await deny(initial);return;}
 let claim:MetaInventory|undefined;
 try{claim=await withMetaReportSource(snapshot,initial.user_id,async client=>{
  const row=await metaInventoryRow(client,inventoryId,true);if(!row||!metaInventoryActive.includes(row.status)||!matches(row,snapshot)||row.deleted_at||row.data_expired_at||row.next_attempt_at.getTime()>Date.now()||row.lease_expires_at&&row.lease_expires_at.getTime()>Date.now())return;
  if(row.deadline_at.getTime()<=Date.now()){await deadline(client,row);return;}if(row.generation==='9223372036854775807'){await finish(client,row,'failed','generation_limit');return;}
  const cooldown=await observedMetaCooldown(client,snapshot.app.id,snapshot.account.id);if(cooldown){await client.query('UPDATE meta_campaign_inventory SET next_attempt_at=LEAST(deadline_at,$2),updated_at=clock_timestamp() WHERE id=$1',[row.id,cooldown]);return;}
  return(await client.query<MetaInventory>(`UPDATE meta_campaign_inventory SET status='reading',generation=generation+1,lease_token=$2,lease_expires_at=clock_timestamp()+interval '3 minutes',updated_at=clock_timestamp() WHERE id=$1 RETURNING *`,[row.id,randomUUID()])).rows[0];
 });}catch{await deny(initial);return;}if(!claim)return;const owned=claim;
 const admission=async(client:PoolClient)=>{await lease(client,owned);const until=await observedMetaCooldown(client,snapshot.app.id,snapshot.account.id);if(until)throw new MetaCooldown(until);};
 const gate=()=>withMetaReportSource(snapshot,owned.user_id,admission),credentials={appId:snapshot.app.app_id,appSecret:snapshot.secrets.appSecret,token:snapshot.accessToken};
 let lastRate:MetaRateHints|undefined;
 try{
  await inspectMetaReportSource(snapshot,owned.user_id,admission,async rate=>{lastRate=rate;await withMetaReportSource(snapshot,owned.user_id,async client=>{await lease(client,owned,false);await recordMetaCooldown(client,'inventory',owned.id,rate);});});
  await gate();const accountResponse=await metaRequest({operation:'account',...credentials,accountId:snapshot.account.id});lastRate=accountResponse.rate;
  const a=provider(z.object({id:text(44),account_id:decimal,name:text(512),currency:z.string().regex(/^[A-Z]{3}$(?![\s\S])/),timezone_name:text(120),account_status:z.number().int().nonnegative()}),accountResponse.data);
  if(a.id!=='act_'+snapshot.account.id||a.account_id!==snapshot.account.id||a.name!==snapshot.account.name||a.currency!==snapshot.account.currency||a.timezone_name!==snapshot.account.timeZone||a.account_status!==snapshot.account.status)throw new MetaRequestError('invalid_response');
  await withMetaReportSource(snapshot,owned.user_id,async client=>{await lease(client,owned,false);await recordMetaCooldown(client,'inventory',owned.id,accountResponse.rate);});
  await gate();const response=await metaRequest({operation:'campaigns',...credentials,accountId:snapshot.account.id,...(owned.next_cursor?{after:owned.next_cursor}:{})});lastRate=response.rate;
  const p=provider(z.object({data:z.unknown(),paging:z.object({next:text(16000).optional(),cursors:z.object({after:cursor.optional()}).optional()}).optional()}),response.data);
  const rows=normalizeMetaCampaigns(p.data,snapshot.account.id),after=p.paging?.next?p.paging.cursors?.after:null;
  if(p.paging?.next&&!after)throw new MetaRequestError('invalid_response');
  await withMetaReportSource(snapshot,owned.user_id,async client=>{
   // Validate the whole received page before a deadline can preserve a partial
   // prefix. A malformed/contradictory response invalidates the entire attempt.
   const row=await lease(client,owned,false);await recordMetaCooldown(client,'inventory',row.id,response.rate);if(after&&row.cursor_hashes.includes(canonicalHash(after))||row.pages>=50||row.row_count+rows.length>5000)throw new MetaRequestError('invalid_response');
   if((await client.query(`SELECT 1 FROM meta_campaign_inventory_page p CROSS JOIN LATERAL jsonb_array_elements(p.rows) old_row JOIN jsonb_array_elements($2::jsonb) new_row ON old_row->>'id'=new_row->>'id' WHERE p.inventory_id=$1 LIMIT 1`,[row.id,JSON.stringify(rows)])).rowCount)throw new MetaRequestError('invalid_response');
   if(row.deadline_at.getTime()<=Date.now())throw new Deadline();
   const accepted=(await client.query<{fetched_at:Date}>('INSERT INTO meta_campaign_inventory_page(inventory_id,project_id,workspace_id,page,rows,row_count,content_hash) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING fetched_at',[row.id,row.project_id,row.workspace_id,row.pages,JSON.stringify(rows),rows.length,canonicalHash(rows)])).rows[0];
   const pages=row.pages+1;
   await client.query('UPDATE meta_campaign_inventory SET pages=$2,row_count=row_count+$3,next_cursor=$4,cursor_hashes=cursor_hashes||$5::text[],retry_attempts=0,first_fetched_at=COALESCE(first_fetched_at,$6),last_fetched_at=$6 WHERE id=$1',[row.id,pages,rows.length,after??null,after?[canonicalHash(after)]:[],accepted.fetched_at]);
   if(!after)await finish(client,row,'completed',null);else if(pages>=50)await finish(client,row,'partial','capacity_limit',['capacity_limit']);else await retry(client,row,delay(response.rate),delay(response.rate)?rateCode(response.rate):null,0);
  });
 }catch(error){if(error instanceof LostLease)return;
  try{await withMetaReportSource(snapshot,owned.user_id,async client=>{const row=await metaInventoryRow(client,owned.id,true);
   if(!row||row.generation!==owned.generation||row.lease_token!==owned.lease_token||!metaInventoryActive.includes(row.status)||row.deleted_at||row.data_expired_at)return;
   if(lastRate)await recordMetaCooldown(client,'inventory',row.id,lastRate);
   if(error instanceof MetaRequestError)await recordMetaCooldown(client,'inventory',row.id,error.rate);
   if(error instanceof MetaRequestError&&error.reauthorize){await client.query("UPDATE meta_connection SET status='reconnect',updated_at=clock_timestamp() WHERE id=$1 AND current_grant_id=$2 AND status='ready'",[row.connection_id,row.grant_id]);await finish(client,row,'denied','provider_access_lost');return;}
   if(error instanceof MetaCampaignRowsError||error instanceof MetaRequestError&&error.reason==='invalid_response'){await finish(client,row,'failed','invalid_provider_inventory');return;}
   if(error instanceof Deadline||row.deadline_at.getTime()<=Date.now()){await deadline(client,row);return;}
   if(error instanceof MetaCooldown){await retry(client,row,Math.max(0,Math.ceil((error.until.getTime()-Date.now())/1000)),'observed_cooldown');return;}
   if(error instanceof MetaRequestError&&error.retryable&&row.retry_attempts<3){await retry(client,row,Math.max(15*2**row.retry_attempts,delay(error.rate)),error.reason==='throttled'?rateCode(error.rate):'provider_retry',row.retry_attempts+1);return;}
   await finish(client,row,'failed',error instanceof MetaRequestError&&error.reason!=='invalid_response'?'provider_unavailable':'invalid_provider_inventory');
  });}catch{await deny(owned);}
 }
}
/** Recovery resumes admitted work only; it never creates a new refresh. */
export async function reconcileMetaInventories(){
 const row=(await getDatabase().pool.query<{id:string}>(`SELECT i.id FROM meta_campaign_inventory i WHERE i.status=ANY($1::text[]) AND i.deleted_at IS NULL AND i.data_expired_at IS NULL
  AND i.next_attempt_at<=clock_timestamp() AND (i.lease_expires_at IS NULL OR i.lease_expires_at<=clock_timestamp())
  AND NOT EXISTS(SELECT 1 FROM pgboss.job j WHERE j.name=$2 AND j.data->>'inventoryId'=i.id::text AND j.state IN ('created','retry','active')) ORDER BY i.next_attempt_at,i.id LIMIT 1`,[metaInventoryActive,metaInventoryQueue])).rows[0];if(!row)return {queued:false};
 return {queued:!!await(await getBoss()).send(metaInventoryQueue,{inventoryId:row.id},{retryLimit:0,expireInSeconds:240})};
}
