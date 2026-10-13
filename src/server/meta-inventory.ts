import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {z} from 'zod';
import {FoundationError} from './auth.ts';
import {getDatabase} from './db.ts';
import {getBoss} from './jobs.ts';
import {canonicalHash} from './context-input.ts';
import {csvCell} from './explorer-input.ts';
import {contentReceipt,readContentCursor,withContentProject} from './project-context.ts';
import {prepareMetaReportSource,withMetaReportSource,type MetaReportSource} from './meta-auth.ts';
import type {MetaCampaign} from './meta-campaign-rows.ts';

export const metaInventoryQueue='meta-campaign-inventory';
export const metaInventoryActive=['queued','reading'];
export const metaCampaignStatuses=['ACTIVE','PAUSED','ARCHIVED','DELETED','IN_PROCESS','WITH_ISSUES'] as const;
export type MetaInventoryDefinition={provider:'meta_ads';accountId:string;accountName:string;currency:string;timeZone:string;graphVersion:'v26.0';definitionVersion:1;kind:'campaign_inventory';effectiveStatuses:typeof metaCampaignStatuses};
export type MetaInventoryStatus='queued'|'reading'|'completed'|'partial'|'failed'|'denied'|'cancelled';
export type MetaInventoryWarning='capacity_limit'|'deadline_reached';
export type MetaInventory={id:string;workspace_id:string;project_id:string;user_id:string;connection_id:string;grant_id:string;connection_revision:number;app_revision:number;request_id:string;source:MetaInventoryDefinition|null;status:MetaInventoryStatus;generation:string;lease_token:string|null;lease_expires_at:Date|null;next_cursor:string|null;cursor_hashes:string[];retry_attempts:number;pages:number;row_count:number;next_attempt_at:Date;deadline_at:Date;first_fetched_at:Date|null;last_fetched_at:Date|null;completed_at:Date|null;diagnostic_code:string|null;warnings:MetaInventoryWarning[];data_expired_at:Date|null;deleted_at:Date|null;payload_cleanup_completed_at:Date|null;created_at:Date;updated_at:Date};
export type MetaInventoryMetadata={id:string;connectionId:string;status:MetaInventoryStatus;dataStatus:'pending'|'available'|'expired'|'unavailable';source:MetaInventoryDefinition|null;requestedAt:string;completedAt:string|null;firstFetchedAt:string|null;lastFetchedAt:string|null;recordedRows:number;readableRows:number|null;coverage:'complete'|'partial'|'unavailable';warnings:MetaInventoryWarning[];nextRetryAt:string|null;diagnosticCode:string|null;revision:string};
const uuid=z.uuid(),hex=z.string().regex(/^[a-f0-9]{64}$(?![\s\S])/);
function parse<S extends z.ZodType>(schema:S,value:unknown):z.output<S>{const result=schema.safeParse(value);if(!result.success)throw new FoundationError(400,'Check the Meta campaign inventory fields.');return result.data;}
function missing():never{throw new FoundationError(404,'Meta campaign inventory not found or unavailable.');}
function queryError(error:unknown):never{if((error as {code?:string})?.code==='57014')throw new FoundationError(503,'The campaign inventory took too long. Try again later.');throw error;}
export async function metaInventoryRow(client:PoolClient,id:string,lock=false){return(await client.query<MetaInventory>(`SELECT * FROM meta_campaign_inventory WHERE id=$1 ${lock?'FOR UPDATE':''}`,[id])).rows[0];}

/** Keyless maintenance admission preserves registration → workspace → project → connection → receipt order. */
export async function withMetaInventory<T>(id:string,work:(client:PoolClient,row:MetaInventory)=>Promise<T>):Promise<T|null>{
 parse(uuid,id);const client=await getDatabase().pool.connect();try{await client.query('BEGIN');await client.query("SET LOCAL statement_timeout='5s'");
  const initial=(await client.query('SELECT i.workspace_id,i.project_id,i.connection_id,f.registration_id FROM meta_campaign_inventory i JOIN meta_oauth_flow f ON f.id=i.grant_id WHERE i.id=$1',[id])).rows[0];
  if(!initial){await client.query('COMMIT');return null;}
  await client.query('SELECT id FROM meta_app_registration WHERE id=$1 FOR SHARE',[initial.registration_id]);
  await client.query('SELECT id FROM workspace WHERE id=$1 FOR UPDATE',[initial.workspace_id]);
  await client.query('SELECT id FROM project WHERE id=$1 AND workspace_id=$2 FOR UPDATE',[initial.project_id,initial.workspace_id]);
  await client.query('SELECT id FROM meta_connection WHERE id=$1 AND project_id=$2 FOR UPDATE',[initial.connection_id,initial.project_id]);
  const row=await metaInventoryRow(client,id,true);if(!row){await client.query('COMMIT');return null;}
  const result=await work(client,row);await client.query('COMMIT');return result;
 }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}finally{client.release();}
}
async function visibility(client:PoolClient,row:MetaInventory){
 const state=(await client.query(`SELECT EXISTS(SELECT 1 FROM meta_oauth_flow f JOIN meta_deletion_request d ON d.registration_id=f.registration_id AND d.subject_hash=f.subject_hash
  WHERE f.id=$1 AND (d.status<>'local_deleted' OR d.fence_epoch>f.start_epoch)) AS deleted,
  ($3::timestamptz IS NOT NULL AND $3::timestamptz<=transaction_timestamp()-make_interval(days=>w.derived_history_days)) AS expired FROM workspace w WHERE w.id=$2`,[row.grant_id,row.workspace_id,row.completed_at])).rows[0];
 return {deleted:!!row.deleted_at||!!state?.deleted,expired:!!row.data_expired_at||!!state?.expired};
}
async function metadata(client:PoolClient,row:MetaInventory):Promise<MetaInventoryMetadata>{
 const state=await visibility(client,row),available=!state.deleted&&!state.expired&&['completed','partial'].includes(row.status);
 const data:Omit<MetaInventoryMetadata,'revision'>={id:row.id,connectionId:row.connection_id,status:row.status,dataStatus:state.deleted?'unavailable':state.expired?'expired':available?'available':metaInventoryActive.includes(row.status)?'pending':'unavailable',source:state.deleted?null:row.source,
  requestedAt:row.created_at.toISOString(),completedAt:row.completed_at?.toISOString()??null,firstFetchedAt:state.deleted?null:row.first_fetched_at?.toISOString()??null,lastFetchedAt:state.deleted?null:row.last_fetched_at?.toISOString()??null,
  recordedRows:row.row_count,readableRows:available?row.row_count:null,coverage:available?(row.status==='completed'?'complete':'partial'):'unavailable',warnings:state.deleted?[]:row.warnings,nextRetryAt:metaInventoryActive.includes(row.status)&&!state.deleted?row.next_attempt_at.toISOString():null,diagnosticCode:state.deleted?'data_deleted':row.diagnostic_code};
 return {...data,revision:canonicalHash(data)};
}
function definition(s:MetaReportSource):MetaInventoryDefinition{return {provider:'meta_ads',accountId:s.account.id,accountName:s.account.name,currency:s.account.currency,timeZone:s.account.timeZone,graphVersion:'v26.0',definitionVersion:1,kind:'campaign_inventory',effectiveStatuses:metaCampaignStatuses};}

export async function enqueueMetaInventory(projectId:string,userId:string,connectionId:string,raw:unknown){
 parse(uuid,connectionId);const data=parse(z.object({requestId:uuid,revision:z.number().int().min(1).max(2147483647)}).strict(),raw),op='meta.inventory:'+connectionId,body={userId,...data};
 const ack=(id:string)=>({requestId:data.requestId,inventoryId:id,connectionId,revision:data.revision});
 const replay=await withContentProject(projectId,userId,true,async(client,p)=>{if(p.role!=='owner')missing();const r=await contentReceipt(client,p.id,data.requestId,op,body);if(!r.replayed)return null;const row=await metaInventoryRow(client,parse(z.object({id:uuid}).strict(),r.result).id);if(!row||row.project_id!==p.id)missing();return {role:p.role,acknowledgement:ack(row.id),inventory:await metadata(client,row),replayed:true};});if(replay)return replay;
 const snapshot=await prepareMetaReportSource(projectId,userId,connectionId,data.revision),boss=await getBoss();
 return withMetaReportSource(snapshot,userId,async client=>{
  const receipt=await contentReceipt(client,projectId,data.requestId,op,body);if(receipt.replayed){const row=await metaInventoryRow(client,parse(z.object({id:uuid}).strict(),receipt.result).id);if(!row||row.project_id!==projectId)missing();return {role:'owner' as const,acknowledgement:ack(row.id),inventory:await metadata(client,row),replayed:true};}
  if((await client.query('SELECT 1 FROM meta_campaign_inventory WHERE connection_id=$1 AND status=ANY($2::text[])',[connectionId,metaInventoryActive])).rowCount)throw new FoundationError(409,'This source already has an active inventory. Wait or cancel it.');
  const id=randomUUID(),row=(await client.query<MetaInventory>(`INSERT INTO meta_campaign_inventory(id,workspace_id,project_id,user_id,connection_id,grant_id,connection_revision,app_revision,request_id,source)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,[id,snapshot.row.workspace_id,projectId,userId,connectionId,snapshot.flow.id,data.revision,snapshot.app.revision,data.requestId,definition(snapshot)])).rows[0];
  if(!await boss.send(metaInventoryQueue,{inventoryId:id},{retryLimit:0,expireInSeconds:240,db:{executeSql:(text,values)=>client.query(text,values)}}))throw new FoundationError(503,'The campaign inventory could not be queued. Retry the same request.');
  await receipt.save({id});return {role:'owner' as const,acknowledgement:ack(id),inventory:await metadata(client,row),replayed:false};
 });
}
function cursorParam(params:URLSearchParams){if([...params.keys()].some(k=>k!=='cursor')||params.getAll('cursor').length>1)throw new FoundationError(400,'Use one campaign inventory cursor.');return params.get('cursor');}
export async function listMetaInventories(projectId:string,userId:string,connectionId:string,params=new URLSearchParams()){
 parse(uuid,connectionId);const value=cursorParam(params);return withContentProject(projectId,userId,false,async(client,p)=>{
  if(!(await client.query('SELECT id FROM meta_connection WHERE id=$1 AND project_id=$2',[connectionId,p.id])).rowCount)missing();
  const scope={projectId:p.id,connectionId,list:'meta-inventories'},cursor=readContentCursor(value,scope);
  const rows=(await client.query<MetaInventory&{at:string}>(`SELECT i.*,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at FROM meta_campaign_inventory i
   WHERE project_id=$1 AND connection_id=$2 AND ($3::timestamptz IS NULL OR (created_at,id)<($3::timestamptz,$4::uuid)) ORDER BY created_at DESC,id DESC LIMIT 51`,[p.id,connectionId,cursor?.at??null,cursor?.id??null])).rows;
  const inventories=[];for(const row of rows.slice(0,50))inventories.push(await metadata(client,row));const last=rows[49];return {role:p.role,inventories,nextCursor:rows.length>50?Buffer.from(JSON.stringify({scope:canonicalHash(scope),at:last.at,id:last.id})).toString('base64url'):null};
 }).catch(queryError);
}
const rowsSql=`SELECT item AS row FROM meta_campaign_inventory_page p CROSS JOIN LATERAL jsonb_array_elements(p.rows) item
 WHERE p.inventory_id=$1 AND p.project_id=$2 AND ($3::text IS NULL OR (item->>'id') COLLATE "C">$3 COLLATE "C") ORDER BY (item->>'id') COLLATE "C"`;
async function page(client:PoolClient,row:MetaInventory|null,scope:unknown,value:string|null){
 const data=row?await metadata(client,row):null,hash=canonicalHash(scope);let after:string|null=null;
 if(value!==null){let decoded:unknown;try{if(value.length>1024||!/^[A-Za-z0-9_-]+$(?![\s\S])/.test(value))throw new Error();decoded=JSON.parse(Buffer.from(value,'base64url').toString('utf8'));}catch{throw new FoundationError(400,'Reload this inventory before loading another page.');}
  const c=parse(z.object({scope:hex,revision:hex,id:z.string().regex(/^[1-9][0-9]{0,39}$(?![\s\S])/)}).strict(),decoded);if(c.scope!==hash)throw new FoundationError(400,'This inventory page belongs to another selection.');if(c.revision!==data?.revision)throw new FoundationError(409,'This inventory changed or expired. Reload it.');after=c.id;
 }
 const rows=data?.dataStatus==='available'?(await client.query<{row:MetaCampaign}>(rowsSql+' LIMIT 51',[row!.id,row!.project_id,after])).rows.map(r=>r.row):[];
 return {inventory:data,rows:rows.slice(0,50),nextCursor:rows.length>50?Buffer.from(JSON.stringify({scope:hash,revision:data!.revision,id:rows[49].id})).toString('base64url'):null};
}
export async function readMetaInventory(projectId:string,userId:string,inventoryId:string,params=new URLSearchParams()){
 parse(uuid,inventoryId);const cursor=cursorParam(params);return withContentProject(projectId,userId,false,async(client,p)=>{const row=await metaInventoryRow(client,inventoryId);if(!row||row.project_id!==p.id)missing();return {role:p.role,...await page(client,row,{projectId:p.id,inventoryId},cursor)};}).catch(queryError);
}
export async function readLatestMetaInventory(projectId:string,userId:string,connectionId:string,params=new URLSearchParams()){
 parse(uuid,connectionId);const cursor=cursorParam(params);return withContentProject(projectId,userId,false,async(client,p)=>{
  if(!(await client.query('SELECT id FROM meta_connection WHERE id=$1 AND project_id=$2',[connectionId,p.id])).rowCount)missing();
  const latest=(await client.query<MetaInventory>("SELECT * FROM meta_campaign_inventory WHERE project_id=$1 AND connection_id=$2 AND status='completed' ORDER BY created_at DESC,id DESC LIMIT 1",[p.id,connectionId])).rows[0]??null;
  const attempt=(await client.query<MetaInventory>('SELECT * FROM meta_campaign_inventory WHERE project_id=$1 AND connection_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1',[p.id,connectionId])).rows[0];
  return {role:p.role,...await page(client,latest,{projectId:p.id,connectionId,latest:true},cursor),latestAttempt:attempt?await metadata(client,attempt):null};
 }).catch(queryError);
}
export async function cancelMetaInventory(projectId:string,userId:string,inventoryId:string,raw:unknown){
 parse(uuid,projectId);parse(uuid,userId);const data=parse(z.object({requestId:uuid}).strict(),raw);
 const result=await withMetaInventory(inventoryId,async(client,row)=>{if(row.project_id!==projectId||!(await client.query("SELECT 1 FROM membership WHERE workspace_id=$1 AND user_id=$2 AND role='owner'",[row.workspace_id,userId])).rowCount)missing();
  const receipt=await contentReceipt(client,projectId,data.requestId,'meta.inventory.cancel:'+inventoryId,{userId,...data});
  if(!receipt.replayed){if(metaInventoryActive.includes(row.status))await client.query("UPDATE meta_campaign_inventory SET status='cancelled',completed_at=clock_timestamp(),lease_token=NULL,lease_expires_at=NULL,next_cursor=NULL,cursor_hashes='{}',generation=LEAST(generation::numeric+1,9223372036854775807)::bigint,diagnostic_code='cancelled_locally',updated_at=clock_timestamp() WHERE id=$1",[row.id]);await receipt.save({id:row.id});}
  return {role:'owner' as const,acknowledgement:{requestId:data.requestId,inventoryId:row.id},inventory:await metadata(client,(await metaInventoryRow(client,row.id))!),replayed:receipt.replayed};
 });if(result===null)missing();return result;
}
export async function exportMetaInventory(projectId:string,userId:string,inventoryId:string,raw:unknown,signal?:AbortSignal){
 parse(uuid,inventoryId);const {expectedRevision}=parse(z.object({expectedRevision:hex}).strict(),raw),start=Date.now();
 const check=()=>{if(signal?.aborted)throw new FoundationError(499,'Export cancelled.');if(Date.now()-start>30000)throw new FoundationError(503,'Campaign export took too long. Try again.');};check();
 return withContentProject(projectId,userId,false,async(client,p)=>{check();const row=await metaInventoryRow(client,inventoryId);if(!row||row.project_id!==p.id)missing();const m=await metadata(client,row);check();
  if(m.revision!==expectedRevision)throw new FoundationError(409,'This inventory changed or expired. Reload it before exporting.');if(m.dataStatus!=='available'||!m.source)throw new FoundationError(409,'This inventory has no available snapshot to export.');
  const lines:string[]=[];let bytes=0,rowCount=0;const line=(values:unknown[])=>{check();const text=values.map(csvCell).join(',')+'\r\n';bytes+=Buffer.byteLength(text);if(bytes>16*1024*1024)throw new FoundationError(413,'Campaign export exceeds 16 MiB.');lines.push(text);};
  line(['Record type','Inventory ID','Connection ID','Requested at','Completed at','First fetched at','Last fetched at','Coverage','Recorded rows','Account ID','Account name','Currency','Time zone','Definition JSON','Campaign ID','Campaign name','Name available','Configured status','Effective status']);
  const prefix=[m.id,m.connectionId,m.requestedAt,m.completedAt,m.firstFetchedAt,m.lastFetchedAt,m.coverage,m.recordedRows,m.source.accountId,m.source.accountName,m.source.currency,m.source.timeZone,JSON.stringify(m.source)];
  line(['coverage',...prefix,'','','','','']);
  await client.query('DECLARE meta_inventory_export NO SCROLL CURSOR FOR '+rowsSql,[row.id,p.id,null]);
  while(true){check();const rows=(await client.query<{row:MetaCampaign}>('FETCH FORWARD 50 FROM meta_inventory_export')).rows;check();if(!rows.length)break;
   for(const {row:r} of rows){line(['campaign',...prefix,r.id,r.name??'',r.name!==null,r.status??'',r.effectiveStatus??'']);rowCount++;if(rowCount>5000)throw new FoundationError(413,'Campaign export exceeds the record limit.');}
  }await client.query('CLOSE meta_inventory_export');check();return {role:p.role,filename:'meta-campaign-inventory.csv',contentType:'text/csv; charset=utf-8',body:lines.join(''),rowCount,revision:m.revision};
 }).catch(queryError);
}
/** Mark first, erase at most five pages; irreversible expiry continues after policy extension. */
export async function expireMetaInventoryPages(){
 const candidate=(await getDatabase().pool.query<{id:string}>(`SELECT i.id FROM meta_campaign_inventory i JOIN workspace w ON w.id=i.workspace_id WHERE i.completed_at IS NOT NULL AND i.payload_cleanup_completed_at IS NULL
  AND (i.data_expired_at IS NOT NULL OR i.deleted_at IS NOT NULL OR i.completed_at<=clock_timestamp()-make_interval(days=>w.derived_history_days)) ORDER BY i.completed_at,i.id LIMIT 1`)).rows[0];if(!candidate)return {inventories:0,pages:0};
 return await withMetaInventory(candidate.id,async(client,row)=>{const state=await visibility(client,row);if(!row.completed_at||!state.expired&&!row.deleted_at)return {inventories:0,pages:0};
  await client.query("UPDATE meta_campaign_inventory SET data_expired_at=COALESCE(data_expired_at,clock_timestamp()),app_cooldown_until=NULL,account_cooldown_until=NULL,lease_token=NULL,lease_expires_at=NULL,next_cursor=NULL,cursor_hashes='{}',updated_at=clock_timestamp() WHERE id=$1",[row.id]);
  const erased=await client.query('DELETE FROM meta_campaign_inventory_page WHERE inventory_id=$1 AND page IN(SELECT page FROM meta_campaign_inventory_page WHERE inventory_id=$1 ORDER BY page LIMIT 5)',[row.id]);
  if(!(await client.query('SELECT 1 FROM meta_campaign_inventory_page WHERE inventory_id=$1 LIMIT 1',[row.id])).rowCount)await client.query('UPDATE meta_campaign_inventory SET payload_cleanup_completed_at=clock_timestamp() WHERE id=$1',[row.id]);return {inventories:1,pages:erased.rowCount??0};
 })??{inventories:0,pages:0};
}
