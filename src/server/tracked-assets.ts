import {createHash,randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {z} from 'zod';
import {trackedAssetInput,trackedAssetDimensions,trackedAssetLimits,trackedAssetVersion,trackedRevision,trackedUuid,trackedShareInput,trackedShareSections,type TrackedAssetFields,type TrackedAssetItem,type TrackedAssetRole,type TrackedAssetAck,type TrackedAssetWrite,type TrackedAssetShare,type TrackedAssetReport,type TrackedAssetCounts} from '../lib/tracked-assets.ts';
import {FoundationError} from './auth.ts';
import {getConfig} from './config.ts';
import {getDatabase} from './db.ts';
import {canonicalHash,cleanText,contextHost,parse} from './context-input.ts';
import {contentCursor,readContentCursor} from './project-context.ts';
import {explorerQuery} from './explorer-input.ts';
import {analyticsCalendarSql} from './analytics-scope.ts';
import {geographyProjectionSql,geographyFilterSql,geographyKeySql} from './geography-sql.ts';
import {retentionCoverage} from './retention.ts';
import {analyticsIdentity} from './native-analytics.ts';
import {extractAnalyticsPeer,resolveAnalyticsNetwork} from './analytics-network.ts';
import {analyticsEnvironment} from './analytics-environment.ts';
import {collectGeography} from './analytics-geography.ts';
import {normalizeDimensions} from './analytics-input.ts';
import {readJson} from './validation.ts';

type Asset={id:string;workspace_id:string;kind:'link'|'pixel';name:string;destination:string|null;public_key:string;revision:number;active:boolean;collection_enabled:boolean;capture_referrer:boolean;capture_geography:boolean;exclude_bots:boolean;created_at:Date;updated_at:Date;retained_from:Date|null};
type Grant={id:string;asset_id:string;label:string;scope:string;sections:typeof trackedShareSections[number][];revision:number;created_at:Date;expires_at:Date;revoked_at:Date|null};
type Limit=(key:string,maximum:number,client?:PoolClient)=>Promise<void>;
const bad=()=>new FoundationError(400,'Check the tracked asset fields, dates and supported filters.');
const missing=()=>new FoundationError(404,'Tracked asset or share not found or unavailable.');
const conflict=()=>new FoundationError(409,'This saved item changed. Reload before applying the change.');
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
const action=z.object({requestId:trackedUuid,revision:trackedRevision}).strict();
const headers={'cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer'};
const json=(value:unknown,status=200)=>Response.json(bounded(value),{status,headers});
const blank:TrackedAssetCounts={requests:null,identifiedRequests:null,unidentifiedRequests:null,estimatedVisitors:null,estimatedVisits:null};
function bounded<T>(value:T):T{if(Buffer.byteLength(JSON.stringify(value))>trackedAssetLimits.responseBytes)throw new FoundationError(503,'The result is too large. Narrow the dates or filters.');return value;}
function item(row:Asset):TrackedAssetItem{return{id:row.id,workspaceId:row.workspace_id,kind:row.kind,name:row.name,...row.kind==='link'?{destination:row.destination!}:{},publicUrl:`${getConfig().appUrl}/api/track/${row.kind}/${row.public_key}`,revision:row.revision,active:row.active,collection:{enabled:row.collection_enabled,captureReferrer:row.capture_referrer,captureGeography:row.capture_geography,excludeBots:row.exclude_bots},createdAt:row.created_at.toISOString(),updatedAt:row.updated_at.toISOString()} as TrackedAssetItem;}
function grantItem(row:Grant):TrackedAssetShare{return{id:row.id,label:row.label,scope:row.scope,sections:row.sections,revision:row.revision,createdAt:row.created_at.toISOString(),expiresAt:row.expires_at.toISOString(),revokedAt:row.revoked_at?.toISOString()??null};}
const assetRow=async(c:PoolClient,wid:string,id:string)=>(await c.query<Asset>('SELECT * FROM tracked_asset WHERE workspace_id=$1 AND id=$2 FOR SHARE',[wid,id])).rows[0];
export function trackedParams(raw:string){
 if(raw.length>22000||!cleanText(raw))throw bad();try{if(!cleanText(decodeURIComponent(raw.replaceAll('+',' '))))throw Error();}catch{throw bad();}return new URLSearchParams(raw);
}
export function trackedDestination(value:string,appUrl=getConfig().appUrl){
 if(!value||value.length>2048||!cleanText(value)||/[\u0000-\u0020\u007f\\]/u.test(value))throw bad();
 try{if(/[\u0000-\u001f\u007f]/u.test(decodeURIComponent(value)))throw Error();}catch{throw bad();}
 let url:URL;try{url=new URL(value);}catch{throw bad();}
 if(url.protocol!=='https:'||url.username||url.password)throw bad();url.hostname=contextHost(url.hostname);
 if(url.href.length>2048||url.origin===appUrl&&url.pathname.startsWith('/api/track/'))throw bad();return url.href;
}
function fields(value:unknown):TrackedAssetFields{const data=parse(trackedAssetInput,value);return data.kind==='link'?{...data,destination:trackedDestination(data.destination)}:data;}
export function trackedReportQuery(raw:string){
 const params=trackedParams(raw),allowed=new Set(['from','to','timeZone','dimension','limit','referrerMissing',...trackedAssetDimensions]);
 if(!['from','to','timeZone'].every(key=>params.has(key))||[...params.keys()].some(key=>!allowed.has(key)||params.getAll(key).length!==1))throw bad();
 const dimension=params.get('dimension')??'referrer',limit=params.get('limit')??'10',channel=params.get('channel'),referrerMissing=params.get('referrerMissing');
 if(!(trackedAssetDimensions as readonly string[]).includes(dimension)||!['5','10','20','100'].includes(limit)||channel!==null&&!['referrer_only','not_recorded'].includes(channel)||referrerMissing!==null&&(referrerMissing!=='1'||params.has('referrer')))throw bad();
 if(params.has('referrer'))params.set('referrer',contextHost(params.get('referrer')!));
 const original=new URLSearchParams(params);for(const key of ['dimension','limit','channel','referrerMissing'])params.delete(key);
 const query=explorerQuery(params),scope=new URLSearchParams({from:query.from,to:query.to,timeZone:query.timeZone});
 for(const key of trackedAssetDimensions)if(original.has(key))scope.set(key,original.get(key)!);
 if(referrerMissing)scope.set('referrerMissing','1');scope.set('dimension',dimension);scope.set('limit',limit);if(scope.toString().length>20000)throw bad();
 const filters:Partial<Record<typeof trackedAssetDimensions[number]|'referrerMissing',string>>={...query.filters,...channel?{channel}:{},...referrerMissing?{referrerMissing:'1'}:{}};
 return{...query,filters,dimension:dimension as typeof trackedAssetDimensions[number],limit:Number(limit),scope:scope.toString()};
}
async function workspace<T>(workspaceId:unknown,userId:unknown,write:boolean,share:boolean,work:(client:PoolClient,wid:string,uid:string,role:TrackedAssetRole)=>Promise<T>):Promise<T>{
 const wid=parse(trackedUuid,workspaceId),uid=parse(trackedUuid,userId),client=await getDatabase().pool.connect();
 try{await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');await client.query("SET LOCAL statement_timeout='5s';SET LOCAL lock_timeout='5s'");
  // ponytail: current membership mutations already serialize on workspace; split only after measured contention.
  await client.query(`SELECT id FROM workspace WHERE id=$1 FOR ${write?'UPDATE':'SHARE'}`,[wid]);
  const role=(await client.query<{role:TrackedAssetRole}>('SELECT role FROM membership WHERE workspace_id=$1 AND user_id=$2',[wid,uid])).rows[0]?.role;
  if(!role||write&&!['owner','admin','editor'].includes(role))throw missing();if(share&&!['owner','admin'].includes(role))throw new FoundationError(403,'Only an owner or admin can manage public shares.');
  const value=bounded(await work(client,wid,uid,role));await client.query('COMMIT');return value;
 }catch(error){await client.query('ROLLBACK').catch(()=>{});if(['57014','55P03'].includes((error as {code?:string})?.code??''))throw new FoundationError(503,'Tracked assets are busy. Retry the same request ID for an uncertain save.');throw error;}finally{client.release();}
}
async function receipt(c:PoolClient,wid:string,uid:string,requestId:string,operation:TrackedAssetAck['operation'],input:unknown){
 const inputHash=canonicalHash(input),prior=(await c.query<{actor_id:string;operation:TrackedAssetAck['operation'];input_hash:string;asset_id:string;applied_revision:number;share_id:string|null}>('SELECT * FROM tracked_asset_request WHERE workspace_id=$1 AND request_id=$2',[wid,requestId])).rows[0];
 if(prior&&(prior.actor_id!==uid||prior.operation!==operation||prior.input_hash!==inputHash))throw new FoundationError(409,'This request ID belongs to another change or actor.');
 const ack=prior?{requestId,operation,assetId:prior.asset_id,appliedRevision:prior.applied_revision,...prior.share_id?{shareId:prior.share_id}:{}}:null;
 return{ack,save:async(assetId:string,revision:number,shareId?:string)=>{await c.query('INSERT INTO tracked_asset_request(workspace_id,request_id,actor_id,operation,input_hash,asset_id,applied_revision,share_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[wid,requestId,uid,operation,inputHash,assetId,revision,shareId??null]);return{requestId,operation,assetId,appliedRevision:revision,...shareId?{shareId}:{}};}};
}
async function writeResult(c:PoolClient,wid:string,role:TrackedAssetRole,ack:TrackedAssetAck,replayed:boolean):Promise<TrackedAssetWrite>{const row=await assetRow(c,wid,ack.assetId),grant=ack.shareId?(await c.query<Grant>('SELECT * FROM tracked_asset_share WHERE id=$1 AND asset_id=$2',[ack.shareId,ack.assetId])).rows[0]:undefined;return{workspaceId:wid,role,ack,item:row?item(row):null,deleted:!row,replayed,...ack.shareId?{share:grant?grantItem(grant):null}:{}};}
export async function listTrackedAssets(wid:unknown,uid:unknown,raw:string){
 const params=trackedParams(raw);if([...params.keys()].some(key=>!['kind','cursor'].includes(key)||params.getAll(key).length!==1)||!['link','pixel'].includes(params.get('kind')??''))throw bad();const kind=params.get('kind')!;
 return workspace(wid,uid,false,false,async(c,w,_,role)=>{const scope={workspaceId:w,kind},after=readContentCursor(params.get('cursor'),scope),rows=(await c.query<Asset>('SELECT * FROM tracked_asset WHERE workspace_id=$1 AND kind=$2 AND($3::timestamptz IS NULL OR(created_at,id)<($3::timestamptz,$4::uuid)) ORDER BY created_at DESC,id DESC LIMIT 21',[w,kind,after?.at??null,after?.id??null])).rows;return{workspaceId:w,role,kind,items:rows.slice(0,20).map(item),nextCursor:rows.length>20?contentCursor({id:rows[19].id,createdAt:rows[19].created_at},scope):null};});
}
export async function getTrackedAsset(wid:unknown,uid:unknown,id:unknown){const aid=parse(trackedUuid,id);return workspace(wid,uid,false,false,async(c,w,_,role)=>{const row=await assetRow(c,w,aid);if(!row)throw missing();return{workspaceId:w,role,item:item(row)};});}
export async function saveTrackedAsset(wid:unknown,uid:unknown,raw:unknown,id?:unknown){
 const aid=id===undefined?null:parse(trackedUuid,id),input=parse(aid?z.object({requestId:trackedUuid,revision:trackedRevision,asset:trackedAssetInput}).strict():z.object({requestId:trackedUuid,asset:trackedAssetInput}).strict(),raw),asset=fields(input.asset),operation=aid?'update':'create';
 return workspace(wid,uid,true,false,async(c,w,u,role)=>{const r=await receipt(c,w,u,input.requestId,operation,{id:aid,...input,asset});if(r.ack)return writeResult(c,w,role,r.ack,true);
  const old=aid?await assetRow(c,w,aid):undefined;if(aid&&!old)throw missing();if(old&&(old.revision!==('revision'in input?input.revision:null)||old.kind!==asset.kind||old.revision===2147483647))throw conflict();
  const values=[aid??randomUUID(),w,asset.kind,asset.name,asset.kind==='link'?asset.destination:null,asset.active,asset.collection.enabled,asset.collection.captureReferrer,asset.collection.captureGeography,asset.collection.excludeBots];
  const row=(await c.query<Asset>(aid?'UPDATE tracked_asset SET name=$4,destination=$5,active=$6,collection_enabled=$7,capture_referrer=$8,capture_geography=$9,exclude_bots=$10,revision=revision+1,updated_at=clock_timestamp() WHERE id=$1 AND workspace_id=$2 AND kind=$3 RETURNING *':'INSERT INTO tracked_asset(id,workspace_id,kind,name,destination,active,collection_enabled,capture_referrer,capture_geography,exclude_bots,public_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,gen_random_uuid()) RETURNING *',values)).rows[0];
  return writeResult(c,w,role,await r.save(row.id,row.revision),false);});
}
export async function deleteTrackedAsset(wid:unknown,uid:unknown,id:unknown,raw:unknown){const aid=parse(trackedUuid,id),input=parse(action,raw);return workspace(wid,uid,true,false,async(c,w,u,role)=>{const r=await receipt(c,w,u,input.requestId,'delete',{id:aid,...input});if(r.ack)return writeResult(c,w,role,r.ack,true);const row=await assetRow(c,w,aid);if(!row)throw missing();if(row.revision!==input.revision)throw conflict();await c.query('DELETE FROM tracked_asset WHERE id=$1 AND workspace_id=$2',[aid,w]);return writeResult(c,w,role,await r.save(aid,row.revision),false);});}
export async function listTrackedAssetShares(wid:unknown,uid:unknown,id:unknown,raw:string){const aid=parse(trackedUuid,id),params=trackedParams(raw);if([...params.keys()].some(key=>key!=='cursor'||params.getAll(key).length!==1))throw bad();return workspace(wid,uid,false,true,async(c,w,_,role)=>{if(!await assetRow(c,w,aid))throw missing();const scope={workspaceId:w,assetId:aid,list:'shares'},after=readContentCursor(params.get('cursor'),scope),rows=(await c.query<Grant>('SELECT * FROM tracked_asset_share WHERE asset_id=$1 AND($2::timestamptz IS NULL OR(created_at,id)<($2::timestamptz,$3::uuid)) ORDER BY created_at DESC,id DESC LIMIT 21',[aid,after?.at??null,after?.id??null])).rows;return{workspaceId:w,assetId:aid,role,items:rows.slice(0,20).map(grantItem),nextCursor:rows.length>20?contentCursor({id:rows[19].id,createdAt:rows[19].created_at},scope):null};});}
export async function createTrackedAssetShare(wid:unknown,uid:unknown,id:unknown,raw:unknown){
 const aid=parse(trackedUuid,id),input=parse(trackedShareInput,raw),scope=trackedReportQuery(input.scope).scope;if(Buffer.from(input.token,'base64url').toString('base64url')!==input.token)throw bad();const tokenHash=hash(input.token),sections=[...input.sections].sort();
 return workspace(wid,uid,true,true,async(c,w,u,role)=>{const{token:_token,...safe}=input,r=await receipt(c,w,u,input.requestId,'share-create',{id:aid,...safe,scope,sections,tokenHash});if(r.ack)return writeResult(c,w,role,r.ack,true);const row=await assetRow(c,w,aid);if(!row)throw missing();if(row.revision!==input.assetRevision)throw conflict();
  const now=(await c.query('SELECT clock_timestamp() AS now')).rows[0].now as Date,lifetime=Date.parse(input.expiresAt)-now.getTime();if(lifetime<3600000||lifetime>365*86400000)throw bad();const shareId=randomUUID();
  try{await c.query('INSERT INTO tracked_asset_share(id,asset_id,label,token_hash,scope,sections,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7)',[shareId,aid,input.label,tokenHash,scope,sections,input.expiresAt]);}catch(error){if((error as {code?:string}).code==='23505')throw new FoundationError(409,'Generate a fresh share token for a new share.');throw error;}
  return writeResult(c,w,role,await r.save(aid,1,shareId),false);});
}
export async function revokeTrackedAssetShare(wid:unknown,uid:unknown,id:unknown,shareId:unknown,raw:unknown){const aid=parse(trackedUuid,id),sid=parse(trackedUuid,shareId),input=parse(action,raw);return workspace(wid,uid,true,true,async(c,w,u,role)=>{const r=await receipt(c,w,u,input.requestId,'share-revoke',{id:aid,shareId:sid,...input});if(r.ack)return writeResult(c,w,role,r.ack,true);if(!await assetRow(c,w,aid))throw missing();const row=(await c.query<Grant>('SELECT * FROM tracked_asset_share WHERE asset_id=$1 AND id=$2 FOR UPDATE',[aid,sid])).rows[0];if(!row)throw missing();if(row.revision!==input.revision||row.revision===2147483647)throw conflict();const revision=row.revoked_at?row.revision:row.revision+1;await c.query('UPDATE tracked_asset_share SET revoked_at=COALESCE(revoked_at,clock_timestamp()),revision=$3 WHERE asset_id=$1 AND id=$2',[aid,sid,revision]);return writeResult(c,w,role,await r.save(aid,revision,sid),false);});}

async function report(c:PoolClient,asset:Asset,query:ReturnType<typeof trackedReportQuery>,sections:readonly typeof trackedShareSections[number][]=trackedShareSections):Promise<TrackedAssetReport>{
 if(!(await c.query('SELECT 1 FROM pg_timezone_names WHERE name=$1',[query.timeZone])).rowCount)throw bad();
 const policy=(await c.query("SELECT retention_revision,clock_timestamp() AS as_of,GREATEST(a.retained_from,clock_timestamp()-raw_analytics_days*interval '24 hours')::text AS cutoff,a.retained_from::text AS watermark FROM workspace w JOIN tracked_asset a ON a.workspace_id=w.id WHERE w.id=$1 AND a.id=$2",[asset.workspace_id,asset.id])).rows[0];
 const channel="CASE WHEN NULLIF(s.dimensions->>'referrerHost','') IS NULL THEN 'not_recorded' ELSE 'referrer_only' END";
 const key=query.dimension==='channel'?`to_jsonb(${channel})`:['country','region','city'].includes(query.dimension)?geographyKeySql(query.dimension as 'country'|'region'|'city','s.geography'):`s.dimensions->'${query.dimension==='referrer'?'referrerHost':query.dimension}'`;
 const count=(a:string)=>`jsonb_build_object('requests',count(${a}.id),'identifiedRequests',count(${a}.visitor_id),'unidentifiedRequests',count(${a}.id)FILTER(WHERE ${a}.visitor_id IS NULL),'estimatedVisitors',CASE WHEN count(${a}.visitor_id)>0 THEN count(DISTINCT ${a}.visitor_id) END,'estimatedVisits',CASE WHEN count(${a}.visitor_id)>0 THEN count(DISTINCT(${a}.visitor_id,${a}.visit_id))FILTER(WHERE ${a}.visitor_id IS NOT NULL) END)`;
 const row=(await c.query(`WITH RECURSIVE ${analyticsCalendarSql}, candidates AS MATERIALIZED(
  SELECT e.*,${geographyProjectionSql('e')} AS geography FROM tracked_asset_event e CROSS JOIN bounds b WHERE asset_id=$1 AND received_at>=GREATEST(b.start,$2::timestamptz) AND received_at<b.finish AND received_at<$8::timestamptz AND(received_at AT TIME ZONE $5)::date BETWEEN $3::date AND $4::date
 ), scope AS MATERIALIZED(SELECT s.* FROM candidates s WHERE ${geographyFilterSql('$6::jsonb','s.geography')}
  AND(NOT $6::jsonb?'referrer' OR s.dimensions->>'referrerHost'=$6::jsonb->>'referrer') AND(NOT $6::jsonb?'referrerMissing' OR s.dimensions->>'referrerHost' IS NULL)
  AND(NOT $6::jsonb?'channel' OR ${channel}=$6::jsonb->>'channel')
  ${['browser','os','device'].map(k=>`AND(NOT $6::jsonb?'${k}' OR CASE WHEN $6::jsonb->>'${k}'='not-recorded' THEN s.dimensions->>'${k}' IS NULL ELSE s.dimensions->>'${k}'=$6::jsonb->>'${k}' END)`).join('\n')}
 ), grouped AS MATERIALIZED(SELECT ${key} AS key,${count('s')} AS counts FROM scope s GROUP BY 1), ranked AS(SELECT * FROM grouped ORDER BY(counts->>'requests')::bigint DESC,key::text COLLATE "C" NULLS FIRST LIMIT $7::integer)
 SELECT (SELECT start FROM bounds) AS start,(SELECT finish FROM bounds) AS finish,(SELECT CASE WHEN finish<=$2::timestamptz THEN 'unavailable' WHEN start<$2::timestamptz THEN 'partial' ELSE 'complete' END FROM bounds) AS coverage,(SELECT ${count('s')} FROM scope s) AS summary,
 (SELECT json_agg(json_build_object('date',to_char(c.day,'YYYY-MM-DD'),'start',c.start,'end',c.finish,'coverage',CASE WHEN c.finish<=$2::timestamptz THEN 'unavailable' WHEN c.start<$2::timestamptz THEN 'partial' ELSE 'complete' END,'counts',(SELECT ${count('s')} FROM scope s WHERE(s.received_at AT TIME ZONE $5)::date=c.day::date)) ORDER BY c.day) FROM calendar c WHERE c.finish IS NOT NULL) AS daily,
 (SELECT count(*) FROM grouped)::text AS groups,(SELECT COALESCE(json_agg(json_build_object('key',key,'counts',counts)ORDER BY(counts->>'requests')::bigint DESC,key::text COLLATE "C" NULLS FIRST),'[]')FROM ranked) AS rows`,[asset.id,policy.cutoff,query.from,query.to,query.timeZone,JSON.stringify(query.filters),query.limit,policy.as_of])).rows[0];
 // SQL owns submillisecond cutoff comparisons; Date is used only for display formatting.
 const start=row.start.toISOString(),end=row.finish.toISOString(),coverage={...retentionCoverage(start,end,policy.cutoff),status:row.coverage as TrackedAssetReport['coverage']['status']},unavailable=coverage.status==='unavailable';
 const groups=unavailable?[]:row.rows.map((r:{key:string|null;counts:TrackedAssetCounts})=>({key:r.key,...r.counts})),returned=groups.reduce((n:number,g:TrackedAssetCounts)=>n+(g.requests??0),0);
 const result:TrackedAssetReport={version:trackedAssetVersion,asset:{id:asset.id,kind:asset.kind,name:asset.name,revision:asset.revision},scope:query.scope,asOf:policy.as_of.toISOString(),range:{from:query.from,to:query.to,timeZone:query.timeZone,start,end},coverage,retention:{policyRevision:policy.retention_revision,watermark:policy.watermark},
  method:{measurement:'accepted-http-requests',identity:'monthly-asset-key-hour-visits',channel:'recorded-channel-tags-v1',visitorCountsAdditive:false,captureCoverage:'unknown',delivery:'not-measured',limitation:'Redirect requests and image loads can include proxies, scanners and cached or prefetched traffic. They do not prove people, email opens or delivery. Visitor keys rotate monthly per asset; visits use hourly keys without browser context. Missing network identity remains unavailable. Bot exclusion is a conservative heuristic.'},
  ...sections.includes('summary')?{summary:unavailable?blank:row.summary}:{},
  ...sections.includes('trend')?{daily:row.daily.map((d:{date:string;start:string;end:string;coverage:TrackedAssetReport['coverage']['status'];counts:TrackedAssetCounts})=>{const from=new Date(d.start).toISOString(),to=new Date(d.end).toISOString();return{date:d.date,start:from,end:to,skipped:from===to,provisional:Date.parse(to)>policy.as_of.getTime(),coverage:d.coverage,...d.coverage==='unavailable'?blank:d.counts};})}:{},
  ...sections.includes('breakdown')?{breakdown:{dimension:query.dimension,metric:'requests' as const,rows:groups,totalGroups:unavailable?null:Number(row.groups),limit:query.limit,returnedRequests:unavailable?null:returned,omittedRequests:unavailable?null:row.summary.requests-returned,truncated:!unavailable&&Number(row.groups)>groups.length}}:{}};
 const pending:unknown[]=[result];while(pending.length){const v=pending.pop();if(typeof v==='number'&&(!Number.isSafeInteger(v)||v<0))throw new FoundationError(503,'The result exceeds safe count limits.');if(v&&typeof v==='object')pending.push(...Object.values(v));}return bounded(result);
}
export async function readTrackedAssetReport(wid:unknown,uid:unknown,id:unknown,raw:string){const aid=parse(trackedUuid,id),query=trackedReportQuery(raw);return workspace(wid,uid,false,false,async(c,w,_,role)=>{const asset=await assetRow(c,w,aid);if(!asset)throw missing();return{workspaceId:w,role,report:await report(c,asset,query)};});}
export async function readTrackedAssetShare(token:string){
 if(!/^[A-Za-z0-9_-]{43}$(?![\s\S])/.test(token)||Buffer.from(token,'base64url').toString('base64url')!==token)throw missing();const client=await getDatabase().pool.connect();
 try{await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');await client.query("SET LOCAL statement_timeout='5s';SET LOCAL lock_timeout='5s'");
  const found=(await client.query<{workspace_id:string}>('SELECT a.workspace_id FROM tracked_asset_share s JOIN tracked_asset a ON a.id=s.asset_id WHERE s.token_hash=$1',[hash(token)])).rows[0];if(!found)throw missing();
  await client.query('SELECT id FROM workspace WHERE id=$1 FOR SHARE',[found.workspace_id]);
  const grant=(await client.query<Grant>('SELECT s.* FROM tracked_asset_share s JOIN tracked_asset a ON a.id=s.asset_id WHERE s.token_hash=$1 AND a.workspace_id=$2 AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() FOR SHARE OF a,s',[hash(token),found.workspace_id])).rows[0];if(!grant)throw missing();const asset=await assetRow(client,found.workspace_id,grant.asset_id);if(!asset)throw missing();
  const value={share:{id:grant.id,label:grant.label,sections:grant.sections,expiresAt:grant.expires_at.toISOString()},report:await report(client,asset,trackedReportQuery(grant.scope),grant.sections)};
  // Expiry can pass during a long aggregate, even while revocation is fenced.
  if(!(await client.query('SELECT 1 FROM tracked_asset_share WHERE id=$1 AND revoked_at IS NULL AND expires_at>clock_timestamp()',[grant.id])).rowCount)throw missing();await client.query('COMMIT');return bounded(value);
 }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}finally{client.release();}
}

export const trackedPixelBytes=Buffer.from('R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw','base64');
export function trackedHttpResponse(kind:'link'|'pixel',destination:string|null,head=false){return new Response(head||kind==='link'?null:new Uint8Array(trackedPixelBytes),{status:kind==='link'?302:200,headers:{...headers,...kind==='link'?{location:destination!,'content-length':'0'}:{'content-type':'image/gif','content-length':String(trackedPixelBytes.length),'cross-origin-resource-policy':'cross-origin'}}});}
export function trackedRequestRefused(request:Request,excludeBots:boolean){const ua=request.headers.get('user-agent')??'';return request.headers.get('dnt')==='1'||request.headers.get('sec-gpc')==='1'||/prefetch|prerender/i.test([request.headers.get('purpose'),request.headers.get('sec-purpose')].join(' '))||excludeBots&&/bot\b|crawler|spider|headless|slurp/i.test(ua);}
export async function collectTrackedAsset(request:Request,kind:'link'|'pixel',publicKey:string,limit:Limit){
 const key=parse(trackedUuid,publicKey),client=await getDatabase().pool.connect();
 try{await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');await client.query("SET LOCAL statement_timeout='1s';SET LOCAL lock_timeout='250ms'");const target=(await client.query<{workspace_id:string}>('SELECT workspace_id FROM tracked_asset WHERE public_key=$1 AND kind=$2',[key,kind])).rows[0];if(!target)throw missing();
  await client.query('SELECT id FROM workspace WHERE id=$1 FOR SHARE',[target.workspace_id]);await client.query('SELECT id FROM tracked_asset WHERE public_key=$1 AND kind=$2 FOR SHARE',[key,kind]);
  const asset=(await client.query<Asset>('SELECT * FROM tracked_asset WHERE public_key=$1 AND kind=$2 AND active',[key,kind])).rows[0];if(!asset)throw missing();
  if(request.method==='GET'&&asset.collection_enabled&&!trackedRequestRefused(request,asset.exclude_bots)){
   // A savepoint keeps the current target's workspace/asset locks when recording fails.
   await client.query('SAVEPOINT observation');
   try{await limit('tracked-assets:global',6000,client);await limit('tracked-assets:'+asset.id,3000,client);const now=(await client.query('SELECT clock_timestamp() AS now')).rows[0].now as Date,ua=request.headers.get('user-agent')??'',address=resolveAnalyticsNetwork(request,extractAnalyticsPeer(request));
    const identity=analyticsIdentity({projectId:asset.id,ip:address,userAgent:ua,now,collectionBasis:'cookieless'}),dimensions:Record<string,unknown>={...analyticsEnvironment(ua)};
    if(asset.capture_referrer&&request.headers.has('referer'))try{const normalized=normalizeDimensions({referrer:request.headers.get('referer')});dimensions.referrerHost=contextHost(normalized.referrerHost!);}catch{/* Malformed, address-literal or private-host referrers are unknown, never a failed navigation. */}
    if(asset.capture_geography)dimensions.geography=collectGeography(address);
    await client.query('INSERT INTO tracked_asset_event(asset_id,id,received_at,asset_revision,visitor_id,visit_id,dimensions,measurement_version) VALUES($1,$2,$3,$4,$5,$6,$7,\'native-asset-request-v1\')',[asset.id,randomUUID(),now,asset.revision,identity?.visitor??null,identity?.visit??null,JSON.stringify(dimensions)]);
    await client.query('RELEASE SAVEPOINT observation');
   }catch{await client.query('ROLLBACK TO SAVEPOINT observation');await client.query('RELEASE SAVEPOINT observation');}
  }
  const response=trackedHttpResponse(kind,asset.destination,request.method==='HEAD');await client.query('COMMIT');return response;
 }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}finally{client.release();}
}
export async function runTrackedAssetRetention(){const c=await getDatabase().pool.connect();try{await c.query('BEGIN');await c.query("SET LOCAL statement_timeout='5s';SET LOCAL lock_timeout='250ms'");const candidate=(await c.query<{id:string;workspace_id:string}>('SELECT id,workspace_id FROM tracked_asset WHERE next_cleanup_at<=clock_timestamp() ORDER BY next_cleanup_at,id LIMIT 1')).rows[0];if(!candidate){await c.query('COMMIT');return null;}await c.query('SELECT id FROM workspace WHERE id=$1 FOR SHARE',[candidate.workspace_id]);const asset=(await c.query<Asset>('SELECT * FROM tracked_asset WHERE id=$1 FOR UPDATE',[candidate.id])).rows[0];if(!asset){await c.query('COMMIT');return null;}const cutoff=(await c.query("SELECT GREATEST(a.retained_from,clock_timestamp()-raw_analytics_days*interval '24 hours')::text AS cutoff FROM workspace w JOIN tracked_asset a ON a.workspace_id=w.id WHERE w.id=$1 AND a.id=$2",[candidate.workspace_id,asset.id])).rows[0].cutoff;const removed=await c.query('WITH old AS(SELECT id FROM tracked_asset_event WHERE asset_id=$1 AND received_at<$2 ORDER BY received_at,id LIMIT 1000 FOR UPDATE)DELETE FROM tracked_asset_event e USING old WHERE e.asset_id=$1 AND e.id=old.id',[asset.id,cutoff]);const pending=(await c.query('SELECT EXISTS(SELECT 1 FROM tracked_asset_event WHERE asset_id=$1 AND received_at<$2) AS pending',[asset.id,cutoff])).rows[0].pending;await c.query("UPDATE tracked_asset SET retained_from=GREATEST(retained_from,$2::timestamptz),next_cleanup_at=clock_timestamp()+CASE WHEN $3::boolean THEN interval '10 seconds' ELSE interval '1 hour' END WHERE id=$1",[asset.id,cutoff,pending]);await c.query('COMMIT');return{assetId:asset.id,deletedEvents:removed.rowCount??0,pending};}catch(error){await c.query('ROLLBACK').catch(()=>{});throw error;}finally{c.release();}}

function noBody(request:Request){if(request.body!==null||request.headers.has('transfer-encoding')||request.headers.has('content-length')&&request.headers.get('content-length')?.trim()!=='0')throw bad();}
export async function handleTrackedAssetPublic(request:Request,limit:Limit):Promise<Response|null>{
 const url=new URL(request.url),ingress=/^\/api\/track\/(link|pixel)\/([0-9a-f-]{36})$/.exec(url.pathname),share=/^\/api\/tracked-shares\/([A-Za-z0-9_-]{43})$/.exec(url.pathname);if(!ingress&&!share)return null;
 if(!['GET','HEAD'].includes(request.method)||share&&request.method!=='GET')return new Response(null,{status:405,headers:{...headers,allow:share?'GET':'GET, HEAD'}});
 try{noBody(request);trackedParams(url.search.slice(1));
  if(request.headers.has('authorization')||request.headers.has('x-api-key'))throw new FoundationError(403,'Public asset URLs do not accept authentication credentials.');
  if(share){if(url.search)throw bad();await limit('tracked-share:global',600);return json(await readTrackedAssetShare(share[1]));}
  return await collectTrackedAsset(request,ingress![1] as 'link'|'pixel',ingress![2],limit);
 }catch(error){const status=error instanceof FoundationError?error.status:503;return request.method==='HEAD'?new Response(null,{status,headers}):json({error:'Tracked asset or share unavailable.'},status);}
}
export async function handleTrackedAssets(request:Request,userId:string,limit:Limit):Promise<Response|null>{
 const url=new URL(request.url),match=/^\/api\/workspaces\/([0-9a-f-]{36})\/tracked-assets(?:\/([0-9a-f-]{36})(?:\/(update|delete|report|shares)(?:\/([0-9a-f-]{36})\/(revoke))?)?)?$/.exec(url.pathname);if(!match)return null;
 const[,wid,id,operation,shareId]=match;await limit('tracked-assets:'+userId+':'+(request.method==='GET'?'read':'write'),request.method==='GET'?120:30);
 if(request.method==='GET'){noBody(request);if(operation==='update'||operation==='delete'||shareId)return json({error:'Method not allowed.'},405);if(!id)return json(await listTrackedAssets(wid,userId,url.search.slice(1)));if(operation==='report')return json(await readTrackedAssetReport(wid,userId,id,url.search.slice(1)));if(operation==='shares')return json(await listTrackedAssetShares(wid,userId,id,url.search.slice(1)));if(url.search)throw bad();return json(await getTrackedAsset(wid,userId,id));}
 if(request.method!=='POST')return json({error:'Method not allowed.'},405);if(url.search)throw bad();const body=await readJson(request,trackedAssetLimits.bodyBytes);
 if(!id)return json(await saveTrackedAsset(wid,userId,body));if(operation==='update'&&!shareId)return json(await saveTrackedAsset(wid,userId,body,id));if(operation==='delete'&&!shareId)return json(await deleteTrackedAsset(wid,userId,id,body));if(operation==='shares')return json(shareId?await revokeTrackedAssetShare(wid,userId,id,shareId,body):await createTrackedAssetShare(wid,userId,id,body));return json({error:'Method not allowed.'},405);
}
