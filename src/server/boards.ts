import {parseGeographyKey,serializeGeographyKey,type GeoField} from '../lib/analytics-geography.ts';
import {readBoardShareExplorer,exploreAnalytics} from './explorer.ts';
import {readBoardShareRealtime,projectRealtime} from './realtime.ts';
import {readBoardShareRevenue,projectRevenue} from './revenue.ts';
import {readBoardShareAnalysis,runAnalysis} from './funnels.ts';
import {analyticsCalendarSql,boardShareSqlBudget,type BoardShareReadContext} from './analytics-scope.ts';
import {decodePublicBoardCard,decodePublicBoardManifest,boardShareCreate,boardSharePublish,boardShareRevoke,boardShareRead,type BoardShareAck,type BoardShareItem,type BoardShareWriteResult,boardDefinition,boardLimits,boardRevision,boardPreviewInput,type BoardPreviewInput,type BoardDefinition,type BoardCard,type BoardEntity,type BoardItem,type BoardRole,type BoardAck,type BoardWriteResult} from '../lib/boards.ts';
import {randomUUID,createHash} from 'node:crypto';
import type {PoolClient} from 'pg';
import {z} from 'zod';
import {FoundationError} from './auth.ts';
import {getDatabase} from './db.ts';
import {canonicalHash,cleanText,parse} from './context-input.ts';
import {contentCursor,readContentCursor} from './project-context.ts';
import {explorerFilters,explorerQuery} from './explorer-input.ts';
import {boardActivity,boardDimension,boardSummary} from './board-activity.ts';
import {readTrackedAssetBoardReport,trackedReportQuery} from './tracked-assets.ts';
import {trackedAssetDimensions,type TrackedAssetReport} from '../lib/tracked-assets.ts';

const uuid=z.uuid().transform(v=>v.toLowerCase()),request={requestId:uuid};
const missing=()=>new FoundationError(404,'Board or workspace not found or unavailable.');
const conflict=()=>new FoundationError(409,'This board changed. Reload the saved board before applying this change.');
type Row={id:string;workspace_id:string;definition:BoardDefinition;revision:number;created_at:Date;updated_at:Date};
const columns='id,workspace_id,definition,revision,created_at,updated_at';
const dto=(row:Row):BoardItem=>({id:row.id,workspaceId:row.workspace_id,definition:row.definition,revision:row.revision,createdAt:row.created_at.toISOString(),updatedAt:row.updated_at.toISOString()});
const find=async(client:PoolClient,wid:string,id:string)=>(await client.query<Row>(`SELECT ${columns} FROM custom_board WHERE workspace_id=$1 AND id=$2`,[wid,id])).rows[0];
export function boardParams(raw:string){
 if(raw.length>22000||!cleanText(raw))throw new FoundationError(400,'Check the board query and its size.');
 try{if(!cleanText(decodeURIComponent(raw.replaceAll('+',' '))))throw Error();}catch{throw new FoundationError(400,'Use valid percent-encoded UTF-8 board parameters.');}
 return new URLSearchParams(raw);
}
export function boardScope(raw:string){
 const params=boardParams(raw),allowed=new Set(['from','to','timeZone',...explorerFilters,'propertyKey','propertyType','propertyValue']);
 if(!['from','to','timeZone'].every(key=>params.has(key))||[...params.keys()].some(key=>!allowed.has(key)))throw new FoundationError(400,'Boards require explicit dates, timezone and supported exact field or typed event-property filters.');
 const query=explorerQuery(params),canonical=new URLSearchParams({from:query.from,to:query.to,timeZone:query.timeZone});
 for(const key of explorerFilters)if(Object.hasOwn(query.filters,key))canonical.set(key,query.filters[key]);
 if(query.property){canonical.set('propertyKey',query.property.key);canonical.set('propertyType',query.property.type);if(query.property.type!=='missing')canonical.set('propertyValue',JSON.stringify(query.property.value));}
 const scope=canonical.toString();if(scope.length>20000||Buffer.byteLength(scope)>20000)throw new FoundationError(400,'The canonical board scope is too large.');
 return{query,scope,params:canonical};
}
export function parseBoardDefinition(raw:unknown):BoardDefinition{
 const definition=parse(boardDefinition,raw),scope=boardScope(definition.scope).scope,result={...definition,scope};
 if(Buffer.byteLength(JSON.stringify(result))>boardLimits.bodyBytes)throw new FoundationError(413,'The board configuration is too large.');return result;
}
export function parseBoardPreview(raw:unknown):BoardPreviewInput{
 const input=parse(boardPreviewInput,raw),result=parse(boardPreviewInput,{...input,scope:boardScope(input.scope).scope});
 if(Buffer.byteLength(JSON.stringify(result))>boardLimits.previewBodyBytes)throw new FoundationError(413,'The card preview is too large. Shorten its text or filters.');return result;
}
function bounded<T>(result:T):T{if(Buffer.byteLength(JSON.stringify(result))>boardLimits.responseBytes)throw new FoundationError(503,'The board result is too large. Narrow the dates or filters.');return result;}
async function withBoardWorkspace<T>(workspaceId:unknown,userId:unknown,write:boolean,work:(client:PoolClient,wid:string,uid:string,role:BoardRole)=>Promise<T>):Promise<T>{
 const wid=parse(uuid,workspaceId),uid=parse(uuid,userId),client=await getDatabase().pool.connect();
 try{
  await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');await client.query("SET LOCAL statement_timeout='5s';SET LOCAL lock_timeout='5s'");
  // ponytail: workspace serialization reuses current membership writers; split only after measured contention.
  await client.query(`SELECT id FROM workspace WHERE id=$1 FOR ${write?'UPDATE':'SHARE'}`,[wid]);
  const role=(await client.query<{role:BoardRole}>('SELECT role FROM membership WHERE workspace_id=$1 AND user_id=$2',[wid,uid])).rows[0]?.role;
  if(!role||write&&!['owner','admin','editor'].includes(role))throw missing();
  const result=bounded(await work(client,wid,uid,role));await client.query('COMMIT');return result;
 }catch(error){await client.query('ROLLBACK').catch(()=>{});if(['57014','55P03'].includes((error as {code?:string})?.code??''))throw new FoundationError(503,'Boards are busy. Retry the same request ID for an uncertain save.');throw error;}finally{client.release();}
}
const cards=(definition:BoardDefinition)=>definition.rows.flatMap(row=>row.cards.filter((card):card is BoardCard=>card!==null));
const entity=(definition:BoardDefinition,card:BoardCard):BoardEntity|null=>card.type==='TextBlock'?null:card.entity??definition.defaultEntity;
async function validateReferences(client:PoolClient,wid:string,definition:BoardDefinition,old?:BoardDefinition){
 const prior=new Set(old?[old.defaultEntity,...cards(old).map(card=>entity(old,card))].map(ref=>canonicalHash(ref)):[]);
 for(const ref of [definition.defaultEntity,...cards(definition).map(card=>entity(definition,card))]){
  if(!ref)continue;
  const exists=ref.kind==='website'?await client.query('SELECT 1 FROM project WHERE workspace_id=$1 AND id=$2',[wid,ref.id]):await client.query('SELECT 1 FROM tracked_asset WHERE workspace_id=$1 AND id=$2 AND kind=$3',[wid,ref.id,ref.kind]);if(!exists.rowCount&&!prior.has(canonicalHash(ref)))throw new FoundationError(404,'A selected entity is not in this workspace or is unavailable.');
 }
 for(const card of cards(definition))if(card.type==='Goal'||card.type==='Funnel'){
  const ref=entity(definition,card)!;
  if(old&&cards(old).some(previous=>(previous.type==='Goal'||previous.type==='Funnel')&&previous.type===card.type&&previous.analysisId===card.analysisId&&previous.analysisRevision===card.analysisRevision&&canonicalHash(entity(old,previous))===canonicalHash(ref)))continue;
  if(!(await client.query('SELECT 1 FROM analytics_definition d JOIN project p ON p.id=d.project_id WHERE p.workspace_id=$1 AND d.project_id=$2 AND d.id=$3 AND d.kind=$4 AND d.revision=$5',[wid,ref.id,card.analysisId,card.type==='Goal'?'goal':'funnel',card.analysisRevision])).rowCount)throw new FoundationError(409,'Choose the current saved goal or funnel in the selected website.');
 }
}
async function receipt(client:PoolClient,wid:string,uid:string,requestId:string,operation:BoardAck['operation'],input:unknown){
 const hash=canonicalHash(input),prior=(await client.query<{actor_id:string;operation:BoardAck['operation'];input_hash:string;board_id:string;applied_revision:number}>('SELECT actor_id,operation,input_hash,board_id,applied_revision FROM custom_board_request WHERE workspace_id=$1 AND request_id=$2',[wid,requestId])).rows[0];
 if(prior&&(prior.actor_id!==uid||prior.operation!==operation||prior.input_hash!==hash))throw new FoundationError(409,'This request ID belongs to a different actor or board change.');
 return{prior,save:async(id:string,revision:number)=>{await client.query('INSERT INTO custom_board_request(workspace_id,request_id,actor_id,operation,input_hash,board_id,applied_revision) VALUES($1,$2,$3,$4,$5,$6,$7)',[wid,requestId,uid,operation,hash,id,revision]);}};
}
async function acknowledged(client:PoolClient,wid:string,role:BoardRole,ack:BoardAck,replayed:boolean):Promise<BoardWriteResult>{const row=await find(client,wid,ack.boardId);return{workspaceId:wid,role,ack,item:row?dto(row):null,deleted:!row,replayed};}
export async function listBoards(workspaceId:unknown,userId:unknown,rawQuery=''){
 const params=boardParams(rawQuery);if([...params.keys()].some(k=>k!=='cursor')||params.getAll('cursor').length>1)throw new FoundationError(400,'Use one board list cursor.');
 return withBoardWorkspace(workspaceId,userId,false,async(client,wid,_uid,role)=>{
  const scope={workspaceId:wid,list:'boards'},after=readContentCursor(params.get('cursor'),scope);
  // New table timestamps are millisecond precision: the existing cursor is lossless, including a deleted anchor.
  const rows=(await client.query<Row>(`SELECT ${columns} FROM custom_board WHERE workspace_id=$1 AND ($2::timestamptz IS NULL OR (created_at,id)<($2::timestamptz,$3::uuid)) ORDER BY created_at DESC,id DESC LIMIT 21`,[wid,after?.at??null,after?.id??null])).rows;
  return{workspaceId:wid,role,items:rows.slice(0,20).map(row=>({id:row.id,name:row.definition.name,description:row.definition.description,revision:row.revision,createdAt:row.created_at.toISOString(),updatedAt:row.updated_at.toISOString()})),nextCursor:rows.length>20?contentCursor({id:rows[19].id,createdAt:rows[19].created_at},scope):null};
 });
}
export async function getBoard(workspaceId:unknown,userId:unknown,boardId:unknown){const id=parse(uuid,boardId);return withBoardWorkspace(workspaceId,userId,false,async(client,wid,_uid,role)=>{const row=await find(client,wid,id);if(!row)throw missing();return{workspaceId:wid,role,item:dto(row)};});}
export async function saveBoard(workspaceId:unknown,userId:unknown,raw:unknown,boardId?:unknown):Promise<BoardWriteResult>{
 const id=boardId===undefined?null:parse(uuid,boardId),input=parse(id?z.object({...request,revision:boardRevision,definition:z.unknown()}).strict():z.object({...request,definition:z.unknown()}).strict(),raw),definition=parseBoardDefinition(input.definition),operation=id?'update':'create';
 return withBoardWorkspace(workspaceId,userId,true,async(client,wid,uid,role)=>{
  const accepted=await receipt(client,wid,uid,input.requestId,operation,{id,...input,definition});
  if(accepted.prior)return acknowledged(client,wid,role,{requestId:input.requestId,operation,boardId:accepted.prior.board_id,appliedRevision:accepted.prior.applied_revision},true);
  const old=id?await find(client,wid,id):undefined;if(id&&!old)throw missing();if(old&&(old.revision!==('revision'in input?input.revision:null)||old.revision===2147483647))throw conflict();
  await validateReferences(client,wid,definition,old?.definition);
  const row=id?(await client.query<Row>(`UPDATE custom_board SET definition=$3,revision=revision+1,updated_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2 RETURNING ${columns}`,[wid,id,JSON.stringify(definition)])).rows[0]:(await client.query<Row>(`INSERT INTO custom_board(id,workspace_id,definition) VALUES($1,$2,$3) RETURNING ${columns}`,[randomUUID(),wid,JSON.stringify(definition)])).rows[0];
  await accepted.save(row.id,row.revision);return acknowledged(client,wid,role,{requestId:input.requestId,operation,boardId:row.id,appliedRevision:row.revision},false);
 });
}
export async function cloneBoard(workspaceId:unknown,userId:unknown,boardId:unknown,raw:unknown):Promise<BoardWriteResult>{
 const id=parse(uuid,boardId),input=parse(z.object({...request,revision:boardRevision,name:boardDefinition.shape.name}).strict(),raw);
 return withBoardWorkspace(workspaceId,userId,true,async(client,wid,uid,role)=>{
  const accepted=await receipt(client,wid,uid,input.requestId,'clone',{id,...input});
  if(accepted.prior)return acknowledged(client,wid,role,{requestId:input.requestId,operation:'clone',boardId:accepted.prior.board_id,appliedRevision:accepted.prior.applied_revision},true);
  const old=await find(client,wid,id);if(!old)throw missing();if(old.revision!==input.revision)throw conflict();
  const definition=parseBoardDefinition({...old.definition,name:input.name});await validateReferences(client,wid,definition,old.definition);
  const created=(await client.query<Row>(`INSERT INTO custom_board(id,workspace_id,definition) VALUES($1,$2,$3) RETURNING ${columns}`,[randomUUID(),wid,JSON.stringify(definition)])).rows[0];
  await accepted.save(created.id,created.revision);return acknowledged(client,wid,role,{requestId:input.requestId,operation:'clone',boardId:created.id,appliedRevision:created.revision},false);
 });
}
export async function deleteBoard(workspaceId:unknown,userId:unknown,boardId:unknown,raw:unknown):Promise<BoardWriteResult>{
 const id=parse(uuid,boardId),input=parse(z.object({...request,revision:boardRevision}).strict(),raw);
 return withBoardWorkspace(workspaceId,userId,true,async(client,wid,uid,role)=>{
  const accepted=await receipt(client,wid,uid,input.requestId,'delete',{id,...input});
  if(accepted.prior)return acknowledged(client,wid,role,{requestId:input.requestId,operation:'delete',boardId:accepted.prior.board_id,appliedRevision:accepted.prior.applied_revision},true);
  const old=await find(client,wid,id);if(!old)throw missing();if(old.revision!==input.revision)throw conflict();await client.query('DELETE FROM custom_board WHERE workspace_id=$1 AND id=$2',[wid,id]);
  await accepted.save(id,old.revision);return acknowledged(client,wid,role,{requestId:input.requestId,operation:'delete',boardId:id,appliedRevision:old.revision},false);
 });
}

const metricField={path:'path',referrer:'referrer',country:'country',region:'region',city:'city',browser:'browser',os:'os',device:'device',language:'language',utmSource:'campaignSource',utmMedium:'campaignMedium',utmCampaign:'campaignName',utmContent:'campaignContent',utmTerm:'campaignTerm',event:'event'} as const;
type NativeCardData={source:'analytics';data:Awaited<ReturnType<typeof boardSummary>>}|{source:'explorer';data:Omit<Awaited<ReturnType<typeof exploreAnalytics>>,'csv'>}|{source:'realtime';data:Awaited<ReturnType<typeof projectRealtime>>}|{source:'revenue';data:Awaited<ReturnType<typeof projectRevenue>>}|{source:'analysis';data:Awaited<ReturnType<typeof runAnalysis>>|Awaited<ReturnType<typeof readBoardShareAnalysis>>}|{source:'activity';data:Awaited<ReturnType<typeof boardActivity>>}|{source:'dimensions';data:Awaited<ReturnType<typeof boardDimension>>}|{source:'text';data:{text:string}}|{source:'tracked-asset';data:TrackedAssetReport};
type CardBase={workspaceId:string;boardId:string;boardRevision:number;cardId:string;cardType:BoardCard['type'];entity:BoardEntity|null;role:BoardRole;scope:string;effectiveWindow:'historical'|'fixed-live'|'none'};
type CardOutcome={status:'ready'}&NativeCardData|{status:'unsupported';reason:'entity_dependency'|'scope'|'not_collected'|'reader_unavailable';message:string};
export type BoardCardResult=CardBase&CardOutcome;
type PreviewBase=Omit<CardBase,'boardId'|'boardRevision'>&{previewId:string;request:BoardPreviewInput};
export type BoardPreviewResult=PreviewBase&CardOutcome;
type CardBinding={kind:'website';retained:string|null;policy:number}|{kind:'link'|'pixel';retained:string|null;policy:number;revision:number}|null;
async function readCardBinding(client:PoolClient,wid:string,ref:BoardEntity|null):Promise<CardBinding>{
 if(!ref)return null;
 if(ref.kind==='website'){const binding=(await client.query<{retained:string|null;policy:number}>('SELECT p.analytics_retained_from::text AS retained,w.retention_revision AS policy FROM project p JOIN workspace w ON w.id=p.workspace_id WHERE p.workspace_id=$1 AND p.id=$2',[wid,ref.id])).rows[0];if(!binding)throw new FoundationError(404,'The card website is unavailable.');return{kind:'website',...binding};}
 const binding=(await client.query<{retained:string|null;policy:number;revision:number}>('SELECT a.retained_from::text AS retained,w.retention_revision AS policy,a.revision FROM tracked_asset a JOIN workspace w ON w.id=a.workspace_id WHERE a.workspace_id=$1 AND a.id=$2 AND a.kind=$3 FOR SHARE OF a',[wid,ref.id,ref.kind])).rows[0];if(!binding)throw new FoundationError(404,'The card tracked asset is unavailable.');return{kind:ref.kind,...binding};
}
export function boardAssetQuery(card:BoardCard,scope:ReturnType<typeof boardScope>){
 if(!['WebsiteMetricsBar','WebsiteChart','MetricsTable','WorldMap'].includes(card.type)||card.type==='MetricsTable'&&!(trackedAssetDimensions as readonly string[]).includes(card.dimension)||scope.query.property||Object.keys(scope.query.filters).some(key=>!(trackedAssetDimensions as readonly string[]).includes(key)))return null;
 const query=new URLSearchParams(scope.params);query.set('dimension',card.type==='WorldMap'?'country':card.type==='MetricsTable'?card.dimension:'referrer');query.set('limit',card.type==='WorldMap'?'100':card.type==='MetricsTable'?String(card.limit):'10');
 try{return trackedReportQuery(query.toString());}catch(error){if(error instanceof Error&&'status'in error&&error.status===400)return null;throw error;}
}
type CardAdmission<T>={base:T;card:BoardCard;ref:BoardEntity|null;scope:ReturnType<typeof boardScope>;uid:string;wid:string;live:boolean;binding:CardBinding;borrowed?:{client:PoolClient;context:BoardShareReadContext}};
export async function previewBoardCard(workspaceId:unknown,userId:unknown,raw:unknown):Promise<BoardPreviewResult>{
 const input=parseBoardPreview(raw),admitted=await withBoardWorkspace(workspaceId,userId,false,async(client,wid,uid,role)=>{
  const card=input.card,ref=card.type==='TextBlock'?null:card.entity??input.defaultEntity,scope=boardScope(input.scope),live=card.type.startsWith('Realtime');
  const base:PreviewBase={workspaceId:wid,previewId:input.previewId,request:input,cardId:card.id,cardType:card.type,entity:ref,role,scope:scope.scope,effectiveWindow:card.type==='TextBlock'?'none':live?'fixed-live':'historical'};
  return{base,card,ref,scope,uid,wid,live,binding:await readCardBinding(client,wid,ref)};
 });
 return bounded(await dispatchBoardCard(admitted));
}
export async function readBoardCard(workspaceId:unknown,userId:unknown,boardId:unknown,cardId:unknown,rawQuery:string):Promise<BoardCardResult>{
 const id=parse(uuid,boardId),cid=parse(uuid,cardId),params=boardParams(rawQuery);
 if([...params.keys()].some(k=>!['revision','scope'].includes(k))||[...params.keys()].some(k=>params.getAll(k).length!==1)||! /^[1-9][0-9]{0,9}$/.test(params.get('revision')??''))throw new FoundationError(400,'Choose the saved board revision and one optional applied scope.');
 const revision=parse(boardRevision,Number(params.get('revision'))),override=params.has('scope')?boardScope(params.get('scope')!):null;
 const admitted=await withBoardWorkspace(workspaceId,userId,false,async(client,wid,uid,role)=>{
  const row=await find(client,wid,id);if(!row)throw missing();if(row.revision!==revision)throw conflict();const card=cards(row.definition).find(c=>c.id===cid);if(!card)throw missing();
  const ref=entity(row.definition,card),scope=override??boardScope(row.definition.scope),live=card.type.startsWith('Realtime');
  const base:CardBase={workspaceId:wid,boardId:id,boardRevision:revision,cardId:cid,cardType:card.type,entity:ref,role,scope:scope.scope,effectiveWindow:card.type==='TextBlock'?'none':live?'fixed-live':'historical'};
  const binding=await readCardBinding(client,wid,ref);
  return{base,card,ref,scope,uid,wid,live,binding};
 });
 return bounded(await dispatchBoardCard(admitted,async client=>{const row=await find(client,admitted.wid,id);if(!row)throw missing();if(row.revision!==revision)throw conflict();}));
}
async function dispatchBoardCard<T extends Omit<CardBase,'boardId'|'boardRevision'|'role'>&{role?:BoardRole}>(admitted:CardAdmission<T>,savedCurrent?:(client:PoolClient)=>Promise<void>):Promise<T&CardOutcome>{
 const{base,card,ref,scope,uid,wid,live,borrowed}=admitted;
 const inWorkspace=(work:(client:PoolClient)=>Promise<T&CardOutcome>):Promise<T&CardOutcome>=>borrowed?work(borrowed.client):withBoardWorkspace(wid,uid,false,async(client,_wid,_uid,role)=>({...await work(client),role}));
 const unsupported=(reason:'entity_dependency'|'scope'|'not_collected'|'reader_unavailable',message:string):T&CardOutcome=>({...base,status:'unsupported',reason,message});
 if(card.type==='TextBlock')return{...base,status:'ready',source:'text',data:{text:card.text}};
 if(!ref)throw missing();
 const current=async(client:PoolClient)=>{if(borrowed)await assertBoardShareCurrent(client,borrowed.context);else await savedCurrent?.(client);const binding=await readCardBinding(client,wid,ref);if(canonicalHash(binding)!==canonicalHash(admitted.binding))throw new FoundationError(409,'Retention changed while this card was loading. Reload its result.');};
  if(ref.kind!=='website'){
   const kind=ref.kind,query=boardAssetQuery(card,scope);if(!query)return inWorkspace(async(client):Promise<T&CardOutcome>=>{await current(client);return{...unsupported('scope','This tracked asset card supports dates, timezone and native referrer, browser, operating-system, device and location filters only. No website, event or property scope was substituted.' )};});
   return inWorkspace(async(client):Promise<T&CardOutcome>=>{await current(client);const data=await readTrackedAssetBoardReport(client,wid,ref.id,kind,query.scope,[card.type==='WebsiteMetricsBar'?'summary':card.type==='WebsiteChart'?'trend':'breakdown']);return{...base,status:'ready',source:'tracked-asset',data};});
  }
  const report=new URLSearchParams(scope.params),{query}=scope;
  let value:NativeCardData;
  if(live){if(Object.keys(query.filters).length||query.property)return unsupported('scope','Live cards use the native fixed30-minute window and do not support board filters.');value={source:'realtime',data:borrowed?await readBoardShareRealtime(borrowed.client,borrowed.context):await projectRealtime(ref.id,{kind:'session',userId:uid},new URLSearchParams())};}
  else if(card.type==='WebsiteMetricsBar'){
   if(borrowed)value={source:'analytics',data:await boardSummary(borrowed.client,ref.id,uid,scope.scope,query,borrowed.context)};else{const client=await getDatabase().pool.connect();try{await client.query('BEGIN');await client.query("SET LOCAL statement_timeout='5s';SET LOCAL lock_timeout='5s'");value={source:'analytics',data:await boardSummary(client,ref.id,uid,scope.scope,query)};await client.query('COMMIT');}catch(error){await client.query('ROLLBACK').catch(()=>{});if(['57014','55P03'].includes((error as {code?:string})?.code??''))throw new FoundationError(503,'The summary is busy. Narrow its dates or retry the read.');throw error;}finally{client.release();}}
  }
  else if(card.type==='Goal'||card.type==='Funnel'){report.set('revision',String(card.analysisRevision));value={source:'analysis',data:borrowed?await readBoardShareAnalysis(borrowed.client,borrowed.context,card.type==='Goal'?'goal':'funnel',card.analysisId,report):await runAnalysis(ref.id,uid,card.type==='Goal'?'goal':'funnel',card.analysisId,report)};}
  else if(card.type==='RevenueMetricsBar'||card.type==='RevenueChart'||card.type==='RevenueMetricsTable'){report.set('currency',card.currency);value={source:'revenue',data:borrowed?await readBoardShareRevenue(borrowed.client,borrowed.context,report):await projectRevenue(ref.id,{kind:'session',userId:uid},report)};}
  else if(card.type==='WebsiteChart'||card.type==='WeeklyTraffic'||card.type==='EventsChart')return inWorkspace(async(client):Promise<T&CardOutcome>=>{await current(client);return{...base,status:'ready',source:'activity',data:await boardActivity(client,ref.id,uid,scope.scope,query,card.type==='WebsiteChart'?'visitors':card.type==='WeeklyTraffic'?'weekly':'events',card.type==='EventsChart'?card.limit:10,borrowed?.context)};});
  else{
   report.set('kind',card.type==='EventsMetricsBar'||card.type==='MetricsTable'&&card.dimension==='event'?'custom':'pageviews');
   if(card.type==='MetricsTable'){
    if(['fullPath','query','title'].includes(card.dimension))return unsupported('not_collected','Full URLs, query strings and page titles are not collected by the current native analytics privacy contract.');
    if(card.dimension==='entry'||card.dimension==='exit'||card.dimension==='channel'||card.dimension==='hostname'){const dimension=card.dimension;return inWorkspace(async(client):Promise<T&CardOutcome>=>{await current(client);return{...base,status:'ready',source:'dimensions',data:await boardDimension(client,ref.id,uid,scope.scope,query,dimension,card.limit,borrowed?.context)};});}
    if(card.dimension==='screen')report.set('fields',JSON.stringify(['screenWidth','screenHeight']));else report.set('groupBy',metricField[card.dimension as keyof typeof metricField]);
   }else report.set('groupBy',card.type==='UTM'?card.parameter:card.type==='WorldMap'?'country':'event');
   // A card snapshot has its configured row bound; do not attach the original wider Explorer CSV.
   const{csv:_csv,...data}=await(borrowed?readBoardShareExplorer(borrowed.client,borrowed.context,report):exploreAnalytics(ref.id,uid,report));
   if(card.type==='UTM'||card.type==='MetricsTable'){const groups=data.breakdown.groups.slice(0,card.limit);data.breakdown={...data.breakdown,groups,returnedGroupEvents:data.coverage.status==='unavailable'?null:groups.reduce((n,g)=>n+g.events,0),truncated:data.breakdown.truncated||groups.length<data.breakdown.groups.length};}
   if(data.coverage.status==='unavailable')data.breakdown={...data.breakdown,groups:[],totalGroups:null,returnedGroupEvents:null,truncated:false};
   value={source:'explorer',data};
  }
  // Existing readers own their connection/authorization. Recheck publication without borrowing two pool clients.
  return inWorkspace(async(client):Promise<T&CardOutcome>=>{await current(client);return{...base,status:'ready',...value};});
}

type ShareRow={id:string;board_id:string;slug_label:string;label:string;theme:'light'|'dark';token_hash:string;board_revision:number;
 selected_card_ids:string[];scope:string;allow_filter:boolean;ongoing_live:boolean;revision:number;created_at:Date;updated_at:Date;expires_at:Date;revoked_at:Date|null};
const shareHash=(token:string)=>createHash('sha256').update(token).digest('hex');
const shareManager=(role:BoardRole)=>{if(role!=='owner'&&role!=='admin')throw missing();};
const shareItem=(r:ShareRow):BoardShareItem=>({id:r.id,boardId:r.board_id,label:r.label,theme:r.theme,revision:r.revision,boardRevision:r.board_revision,
 selectedCardIds:r.selected_card_ids,scope:r.scope,allowFilter:r.allow_filter,ongoingLive:r.ongoing_live,createdAt:r.created_at.toISOString(),updatedAt:r.updated_at.toISOString(),
 expiresAt:r.expires_at.toISOString(),revokedAt:r.revoked_at?.toISOString()??null,slug:r.slug_label+'-'+r.id});
async function shareRow(c:PoolClient,wid:string,bid:string,sid:string){return(await c.query<ShareRow>('SELECT s.* FROM board_share s JOIN custom_board b ON b.id=s.board_id WHERE b.workspace_id=$1 AND b.id=$2 AND s.id=$3 FOR SHARE OF s',[wid,bid,sid])).rows[0];}
export function permittedBoardShareScope(granted:string,requested:string,allowFilter:boolean){
 const base=boardScope(granted),next=boardScope(requested);
 if(next.query.timeZone!==base.query.timeZone||next.query.from<base.query.from||next.query.to>base.query.to)throw new FoundationError(403,'The requested dates or timezone exceed this share.');
 if(!allowFilter&&next.scope!==base.scope)throw new FoundationError(403,'This share does not permit changed filters.');
 for(const[key,value]of Object.entries(base.query.filters))if(next.query.filters[key]!==value)throw new FoundationError(403,'A granted filter cannot be removed or replaced.');
 if(base.query.property&&canonicalHash(next.query.property)!==canonicalHash(base.query.property))throw new FoundationError(403,'The granted property condition cannot be removed or replaced.');
 return next;
}
async function shareReceipt(c:PoolClient,wid:string,uid:string,id:string,operation:BoardShareAck['operation'],input:unknown){
 const hash=canonicalHash(input),prior=(await c.query<{actor_id:string;operation:BoardShareAck['operation'];input_hash:string;share_id:string;applied_grant_revision:number;applied_board_revision:number}>('SELECT * FROM board_share_request WHERE workspace_id=$1 AND request_id=$2',[wid,id])).rows[0];
 if(prior&&(prior.actor_id!==uid||prior.operation!==operation||prior.input_hash!==hash))throw new FoundationError(409,'This share request ID belongs to different changes or another actor.');
 return{ack:prior?{requestId:id,operation,shareId:prior.share_id,appliedGrantRevision:prior.applied_grant_revision,appliedBoardRevision:prior.applied_board_revision}:null,
 save:async(shareId:string,revision:number,boardRevision:number):Promise<BoardShareAck>=>{await c.query('INSERT INTO board_share_request(workspace_id,request_id,actor_id,operation,input_hash,share_id,applied_grant_revision,applied_board_revision)VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[wid,id,uid,operation,hash,shareId,revision,boardRevision]);return{requestId:id,operation,shareId,appliedGrantRevision:revision,appliedBoardRevision:boardRevision};}};
}
async function shareAcknowledged(c:PoolClient,wid:string,bid:string,role:BoardRole,ack:BoardShareAck,replayed:boolean):Promise<BoardShareWriteResult>{
 const current=await shareRow(c,wid,bid,ack.shareId);return{workspaceId:wid,boardId:bid,role,ack,item:current?shareItem(current):null,replayed};
}
async function validateShareSelection(c:PoolClient,wid:string,board:Row,input:{selectedCardIds:string[];scope:string;ongoingLive:boolean}){
 const selected=cards(board.definition).filter(card=>input.selectedCardIds.includes(card.id));
 if(selected.length!==input.selectedCardIds.length)throw missing();const scope=boardScope(input.scope);
 for(const card of selected){if(card.type==='TextBlock')continue;const ref=entity(board.definition,card);if(!ref)throw missing();
  if(ref.kind==='website'){if(!(await c.query('SELECT 1 FROM project WHERE workspace_id=$1 AND id=$2 FOR SHARE',[wid,ref.id])).rowCount)throw missing();}
  else if(!(await c.query('SELECT 1 FROM tracked_asset WHERE workspace_id=$1 AND id=$2 AND kind=$3 FOR SHARE',[wid,ref.id,ref.kind])).rowCount)throw missing();
  if(card.type==='Goal'||card.type==='Funnel')if(!(await c.query('SELECT 1 FROM analytics_definition WHERE project_id=$1 AND id=$2 AND kind=$3 AND revision=$4 FOR SHARE',[ref.id,card.analysisId,card.type==='Goal'?'goal':'funnel',card.analysisRevision])).rowCount)throw conflict();
  if(card.type.startsWith('Realtime')&&(!input.ongoingLive||Object.keys(scope.query.filters).length||scope.query.property))throw new FoundationError(400,'Live sharing needs explicit ongoing-window permission and cannot discard filters.');
 }
 return scope.scope;
}
export async function listBoardShares(workspaceId:unknown,userId:unknown,boardId:unknown,rawQuery=''){
 const bid=parse(uuid,boardId),params=boardParams(rawQuery);for(const key of params.keys())if(key!=='cursor'||params.getAll(key).length!==1)throw new FoundationError(400,'Use one share cursor.');
 return withBoardWorkspace(workspaceId,userId,false,async(c,wid,_uid,role)=>{shareManager(role);if(!await find(c,wid,bid))throw missing();const scope={workspaceId:wid,boardId:bid,list:'board-shares'},after=readContentCursor(params.get('cursor'),scope);
  const rows=(await c.query<ShareRow>('SELECT * FROM board_share WHERE board_id=$1 AND($2::timestamptz IS NULL OR(created_at,id)<($2::timestamptz,$3::uuid))ORDER BY created_at DESC,id DESC LIMIT 21',[bid,after?.at??null,after?.id??null])).rows;
  return{workspaceId:wid,boardId:bid,role,items:rows.slice(0,20).map(shareItem),nextCursor:rows.length>20?contentCursor({id:rows[19].id,createdAt:rows[19].created_at},scope):null};
 });
}
export async function getBoardShare(workspaceId:unknown,userId:unknown,boardId:unknown,shareId:unknown){const bid=parse(uuid,boardId),sid=parse(uuid,shareId);return withBoardWorkspace(workspaceId,userId,false,async(c,wid,_uid,role)=>{shareManager(role);const row=await shareRow(c,wid,bid,sid);if(!row)throw missing();return{workspaceId:wid,boardId:bid,role,item:shareItem(row)};});}
export async function createBoardShare(workspaceId:unknown,userId:unknown,boardId:unknown,raw:unknown):Promise<BoardShareWriteResult>{
 const bid=parse(uuid,boardId),input=parse(boardShareCreate,raw);if(Buffer.from(input.token,'base64url').toString('base64url')!==input.token)throw new FoundationError(400,'Generate a canonical share token.');
 const{token:_secret,...safe}=input,tokenHash=shareHash(input.token),scope=boardScope(input.scope).scope;
 return withBoardWorkspace(workspaceId,userId,true,async(c,wid,uid,role)=>{shareManager(role);const receipt=await shareReceipt(c,wid,uid,input.requestId,'create',{boardId:bid,...safe,scope,tokenHash});if(receipt.ack)return shareAcknowledged(c,wid,bid,role,receipt.ack,true);
  const board=await find(c,wid,bid);if(!board)throw missing();if(board.revision!==input.boardRevision)throw conflict();await validateShareSelection(c,wid,board,{...input,scope});
  const now=(await c.query<{now:Date}>('SELECT clock_timestamp()AS now')).rows[0].now.getTime(),ttl=Date.parse(input.expiresAt)-now;if(ttl<3600000||ttl>365*86400000)throw new FoundationError(400,'Choose an expiry from one hour to365days.');
  const id=randomUUID(),slug=board.definition.name.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,48).replace(/-$/,'')||'board';
  try{await c.query('INSERT INTO board_share(id,board_id,slug_label,label,theme,token_hash,board_revision,selected_card_ids,scope,allow_filter,ongoing_live,expires_at)VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',[id,bid,slug,input.label,input.theme,tokenHash,board.revision,input.selectedCardIds,scope,input.allowFilter,input.ongoingLive,input.expiresAt]);}catch(error){if((error as{code?:string})?.code==='23505')throw new FoundationError(409,'Use a new token for a different share.');throw error;}
  return shareAcknowledged(c,wid,bid,role,await receipt.save(id,1,board.revision),false);
 });
}
export async function publishBoardShare(workspaceId:unknown,userId:unknown,boardId:unknown,shareId:unknown,raw:unknown):Promise<BoardShareWriteResult>{
 const bid=parse(uuid,boardId),sid=parse(uuid,shareId),input=parse(boardSharePublish,raw),scope=boardScope(input.scope).scope;
 return withBoardWorkspace(workspaceId,userId,true,async(c,wid,uid,role)=>{shareManager(role);const receipt=await shareReceipt(c,wid,uid,input.requestId,'publish',{boardId:bid,shareId:sid,...input,scope});if(receipt.ack)return shareAcknowledged(c,wid,bid,role,receipt.ack,true);
  const board=await find(c,wid,bid);if(!board)throw missing();if(board.revision!==input.boardRevision)throw conflict();await validateShareSelection(c,wid,board,{...input,scope});const old=(await c.query<ShareRow>('SELECT * FROM board_share WHERE board_id=$1 AND id=$2 AND revoked_at IS NULL AND expires_at>clock_timestamp() FOR UPDATE',[bid,sid])).rows[0];if(!old)throw missing();if(old.revision!==input.revision||old.revision===2147483647||board.revision!==input.boardRevision)throw conflict();
  const now=(await c.query<{now:Date}>('SELECT clock_timestamp()AS now')).rows[0].now.getTime(),ttl=Date.parse(input.expiresAt)-now;if(ttl<3600000||ttl>365*86400000)throw new FoundationError(400,'Choose an expiry from one hour to365days.');
  const changed=await c.query('UPDATE board_share SET label=$3,theme=$4,board_revision=$5,selected_card_ids=$6,scope=$7,allow_filter=$8,ongoing_live=$9,expires_at=$10,revision=revision+1,updated_at=clock_timestamp() WHERE board_id=$1 AND id=$2 AND revoked_at IS NULL AND expires_at>clock_timestamp()',[bid,sid,input.label,input.theme,board.revision,input.selectedCardIds,scope,input.allowFilter,input.ongoingLive,input.expiresAt]);if(!changed.rowCount)throw missing();
  return shareAcknowledged(c,wid,bid,role,await receipt.save(sid,old.revision+1,board.revision),false);
 });
}
export async function revokeBoardShare(workspaceId:unknown,userId:unknown,boardId:unknown,shareId:unknown,raw:unknown):Promise<BoardShareWriteResult>{
 const bid=parse(uuid,boardId),sid=parse(uuid,shareId),input=parse(boardShareRevoke,raw);
 return withBoardWorkspace(workspaceId,userId,true,async(c,wid,uid,role)=>{shareManager(role);const receipt=await shareReceipt(c,wid,uid,input.requestId,'revoke',{boardId:bid,shareId:sid,...input});if(receipt.ack)return shareAcknowledged(c,wid,bid,role,receipt.ack,true);
  const old=(await c.query<ShareRow>('SELECT * FROM board_share WHERE board_id=$1 AND id=$2 FOR UPDATE',[bid,sid])).rows[0];if(!old)throw missing();if(old.revision!==input.revision)throw conflict();const revision=old.revoked_at?old.revision:Math.min(2147483647,old.revision+1);
  await c.query('UPDATE board_share SET revoked_at=COALESCE(revoked_at,clock_timestamp()),revision=$3,updated_at=clock_timestamp() WHERE board_id=$1 AND id=$2',[bid,sid,revision]);
  return shareAcknowledged(c,wid,bid,role,await receipt.save(sid,revision,old.board_revision),false);
 });
}
const shareRange=(v:{from:string;to:string;timeZone:string;start:string;end:string})=>({from:v.from,to:v.to,timeZone:v.timeZone,start:v.start,end:v.end});
const shareCoverage=(v:{status:'complete'|'partial'|'unavailable';retainedFrom:string|null})=>({status:v.status,retainedFrom:v.retainedFrom});
function shareAtom(value:unknown,geography?:GeoField):unknown{
 if(geography){const canonical=typeof value==='string'?parseGeographyKey(geography,value):null,encoded=serializeGeographyKey(geography,canonical??value);if(encoded===null)throw new FoundationError(503,'The shared group could not be verified.');return JSON.parse(encoded);}
 if(value===null||typeof value==='string'&&value.length<=2048||typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value))return value;
 if(Array.isArray(value)&&value.length===2)return value.map(atom=>{if(!atom||typeof atom!=='object'||Array.isArray(atom)||Object.keys(atom).sort().join(',')!=='type,value'||!['missing','string','number','boolean'].includes(atom.type)||atom.value!==null&&!['string','number','boolean'].includes(typeof atom.value))throw new FoundationError(503,'The shared tuple could not be verified.');return{type:atom.type,value:shareAtom(atom.value)};});
 throw new FoundationError(503,'The shared value could not be verified.');
}
const shareMoney=(v:{sales:string;refunds:string;net:string;saleObservations:number;refundObservations:number})=>({sales:v.sales,refunds:v.refunds,net:v.net,saleObservations:v.saleObservations,refundObservations:v.refundObservations});
export function projectBoardShareCard(card:BoardCard,value:CardOutcome){
 if(value.status==='unsupported')return{status:'unsupported' as const,reason:value.reason,message:value.message};
 const invalid=():never=>{throw new FoundationError(503,'This shared card could not be verified.');};
 switch(value.source){
  case'text':if(card.type!=='TextBlock')return invalid();return{status:'ready' as const,data:{text:value.data.text}};
  case'analytics':{if(card.type!=='WebsiteMetricsBar')return invalid();const d=value.data;return{status:'ready' as const,data:{range:shareRange(d.range),coverage:shareCoverage(d.coverage),pageViews:d.totals.pageViews,visitors:d.measurement.visitors,visits:d.measurement.visits,bounceRate:d.measurement.bounceRate,averageVisitSeconds:d.measurement.averageVisitSeconds}};}
  case'realtime':{const d=value.data,range={start:d.range.start,end:d.range.end,timeZone:d.range.timeZone,seconds:d.range.seconds};
   if(card.type==='RealtimeActiveUsers')return{status:'ready' as const,data:{asOf:d.asOf,window:{start:d.activeWindow.start,end:d.activeWindow.end,seconds:d.activeWindow.seconds},coverage:shareCoverage(d.active.coverage),estimatedVisitors:d.active.estimatedVisitors}};
   if(card.type==='RealtimeChart')return{status:'ready' as const,data:{asOf:d.asOf,range,minutes:d.minutes.map(v=>({start:v.start,end:v.end,partial:v.partial,pageViews:v.pageViews,customEvents:v.customEvents,estimatedVisitors:v.estimatedVisitors,coverage:v.coverage}))}};
   if(card.type!=='RealtimeHeader')return invalid();return{status:'ready' as const,data:{asOf:d.asOf,range,coverage:shareCoverage(d.coverage),pageViews:d.totals.pageViews,customEvents:d.totals.customEvents,estimatedVisitors:d.totals.estimatedVisitors,knownCountryGroups:d.geography.countries.totalGroups===null?null:d.geography.countries.rows.filter(v=>v.key.state==='known').length}};
  }
  case'analysis':{if(card.type!=='Goal'&&card.type!=='Funnel')return invalid();const d=value.data,definition=d.item.definition,match=(v:{type:string;match:string;value:string})=>({type:v.type,match:v.match,value:v.value});
   if(definition.kind==='goal'&&card.type==='Goal')return{status:'ready' as const,data:{range:shareRange(d.range),coverage:shareCoverage(d.coverage),definition:{kind:definition.kind,name:definition.name,description:definition.description,condition:match(definition.condition)},analysisRevision:d.item.revision,goal:d.goal?{visitors:d.goal.visitors,totalVisitors:d.goal.totalVisitors,rate:d.goal.rate}:null}};
   if(definition.kind!=='funnel'||card.type!=='Funnel')return invalid();return{status:'ready' as const,data:{range:shareRange(d.range),coverage:shareCoverage(d.coverage),definition:{kind:definition.kind,name:definition.name,description:definition.description,windowMinutes:definition.windowMinutes,steps:definition.steps.map(v=>({condition:match(v),pageViewsOnly:v.pageViewsOnly,properties:v.properties.map(p=>p.operator==='missing'?{key:p.key,operator:p.operator}:{key:p.key,operator:p.operator,type:p.type,value:p.value})}))},analysisRevision:d.item.revision,steps:d.steps.map(v=>({step:v.step,visitors:v.visitors,dropped:v.dropped,conversionRate:v.conversionRate,remainingRate:v.remainingRate}))}};
  }
  case'activity':{const d=value.data;if(card.type==='WeeklyTraffic')return{status:'ready' as const,data:{range:shareRange(d.range),coverage:shareCoverage(d.coverage),weekly:d.weekly.map(v=>({weekday:v.weekday,hour:v.hour,coverage:v.coverage,estimatedVisitors:v.estimatedVisitors})),method:{weeklyRepeatedHours:d.method.weeklyRepeatedHours,visitorCountsAdditive:d.method.visitorCountsAdditive}}};
   const daily=d.daily.map(v=>({date:v.date,start:v.start,end:v.end,skipped:v.skipped,coverage:v.coverage}));if(card.type==='WebsiteChart')return{status:'ready' as const,data:{range:shareRange(d.range),coverage:shareCoverage(d.coverage),daily:d.daily.map((v,i)=>({...daily[i],pageViews:v.events,estimatedVisitors:v.estimatedVisitors}))}};
   if(card.type!=='EventsChart')return invalid();return{status:'ready' as const,data:{range:shareRange(d.range),coverage:shareCoverage(d.coverage),daily,series:d.series.map(v=>({name:v.name,events:v.events,daily:v.daily.map(day=>({date:day.date,events:day.events}))})),eventNames:d.eventNames?{total:d.eventNames.total,returned:d.eventNames.returned,omitted:d.eventNames.omitted,otherEvents:d.eventNames.otherEvents,otherDaily:d.eventNames.otherDaily.map(v=>({date:v.date,events:v.events}))}:null}};
  }
  case'dimensions':{if(card.type!=='MetricsTable')return invalid();const d=value.data;return{status:'ready' as const,data:{range:shareRange(d.range),coverage:shareCoverage(d.coverage),dimension:d.dimension,metric:d.method.metric,rows:d.breakdown.rows.map(v=>({key:v.key,units:v.units,estimatedVisitors:v.estimatedVisitors})),totalGroups:d.breakdown.totalGroups,returnedUnits:d.breakdown.returnedUnits,omittedUnits:d.breakdown.omittedUnits,limit:d.breakdown.limit,truncated:d.breakdown.truncated,evidence:{matchingPageviews:d.evidence.matchingPageviews,anonymousPageviews:d.evidence.anonymousPageviews,retainedVisitPageviews:d.evidence.retainedVisitPageviews,windowClippedVisits:d.evidence.windowClippedVisits,orderingTieVisits:d.evidence.orderingTieVisits,retentionClippedVisits:d.evidence.retentionClippedVisits}}};}
  case'explorer':{const d=value.data;if(card.type==='EventsMetricsBar')return{status:'ready' as const,data:{range:shareRange(d.range),coverage:shareCoverage(d.coverage),customEvents:d.totals.events,visitors:d.totals.visitors,visits:d.totals.visits,eventNames:d.breakdown.totalGroups}};
   if(card.type!=='UTM'&&card.type!=='MetricsTable'&&card.type!=='WorldMap')return invalid();const field=card.type==='WorldMap'?'country':card.type==='MetricsTable'&&['country','region','city'].includes(card.dimension)?card.dimension as GeoField:undefined;
   return{status:'ready' as const,data:{range:shareRange(d.range),coverage:shareCoverage(d.coverage),dimension:card.type==='WorldMap'?'country':card.type==='UTM'?card.parameter:card.dimension,groups:d.breakdown.groups.map(v=>({type:v.type,value:shareAtom(v.value,field),events:v.events,visitors:v.visitors})),totalGroups:d.breakdown.totalGroups,returnedEvents:d.breakdown.returnedGroupEvents,truncated:d.breakdown.truncated,...card.type==='WorldMap'&&d.geographyProvenance?{geographyProvenance:{source:d.geographyProvenance.source,scope:d.geographyProvenance.scope,databaseCount:d.geographyProvenance.databaseCount,oldestDatabaseBuild:d.geographyProvenance.oldestDatabaseBuild,newestDatabaseBuild:d.geographyProvenance.newestDatabaseBuild}}:{}}};
  }
  case'revenue':{const d=value.data,base={range:shareRange(d.range),coverage:shareCoverage(d.coverage),currency:d.query.currency,evidenceIncomplete:d.selection.evidenceIncomplete};
   if(card.type==='RevenueMetricsBar')return{status:'ready' as const,data:{...base,net:d.money?.net??null,averageSale:d.money?.averageSale??null,keyedNetPerQualifiedKey:d.money?.keyedNetPerQualifiedKey??null,saleObservations:d.money?.saleObservations??null,revenueKeys:d.identity.revenueKeys}};
   if(card.type==='RevenueChart')return{status:'ready' as const,data:{...base,available:d.money!==null,daily:d.daily?.map(v=>({date:v.date,state:v.state,totals:v.totals?shareMoney(v.totals):null}))??null,series:d.series?.map(v=>({eventName:v.eventName,daily:v.daily.map(m=>m?shareMoney(m):null)}))??null}};
   if(card.type!=='RevenueMetricsTable')return invalid();const field=card.dimension==='referrer'?'referrers':card.dimension==='channel'?'channels':card.dimension==='country'?'countries':'regions',b=d.dimensions?.[field];return{status:'ready' as const,data:{...base,dimension:card.dimension,sales:d.money?.sales??null,breakdown:b?{rows:b.rows.map(v=>({key:shareAtom(v.key,card.dimension==='country'?'country':card.dimension==='region'?'region':undefined),totals:shareMoney(v.totals),saleShare:v.saleShare})),totalGroups:b.totalGroups,limit:b.limit,truncated:b.truncated,displayed:shareMoney(b.displayed),omitted:shareMoney(b.omitted)}:null}};
  }
  case'tracked-asset':{const d=value.data,base={range:shareRange(d.range),coverage:shareCoverage(d.coverage),measurement:'accepted-http-requests' as const,kind:d.asset.kind};
   const counts=(v:NonNullable<typeof d.summary>)=>({requests:v.requests,identifiedRequests:v.identifiedRequests,unidentifiedRequests:v.unidentifiedRequests,estimatedVisitors:v.estimatedVisitors,estimatedVisits:v.estimatedVisits});
   if(card.type==='WebsiteMetricsBar'&&d.summary)return{status:'ready' as const,data:{...base,summary:counts(d.summary)}};
   if(card.type==='WebsiteChart'&&d.daily)return{status:'ready' as const,data:{...base,daily:d.daily.map(v=>({date:v.date,start:v.start,end:v.end,coverage:v.coverage,skipped:v.skipped,provisional:v.provisional,...counts(v)}))}};
   if((card.type==='MetricsTable'||card.type==='WorldMap')&&d.breakdown){const b=d.breakdown,field=card.type==='WorldMap'?'country':card.dimension;return{status:'ready' as const,data:{...base,dimension:b.dimension,groups:b.rows.map(v=>({key:shareAtom(v.key,['country','region','city'].includes(field)?field as GeoField:undefined),...counts(v)})),totalGroups:b.totalGroups,limit:b.limit,returnedRequests:b.returnedRequests,omittedRequests:b.omittedRequests,truncated:b.truncated}};}return invalid();
  }
 }
}
async function assertBoardShareCurrent(c:PoolClient,context:BoardShareReadContext){
 const current=(await c.query('SELECT 1 FROM board_share s JOIN custom_board b ON b.id=s.board_id WHERE b.workspace_id=$1 AND b.id=$2 AND b.revision=$3 AND s.id=$4 AND s.revision=$5 AND s.board_revision=b.revision AND s.token_hash=$6 AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() AND $7::uuid=ANY(s.selected_card_ids)',[context.workspaceId,context.boardId,context.boardRevision,context.shareId,context.grantRevision,context.tokenHash,context.cardId])).rowCount;
 if(!current)throw missing();
}
async function shareCalendarContained(c:PoolClient,granted:ReturnType<typeof boardScope>,next:ReturnType<typeof boardScope>){
 const calendar=(offset:number)=>analyticsCalendarSql.replace(/\$(3|4|5)\b/g,(_,n)=>'$'+(Number(n)-2+offset));
 const valid=(await c.query(`WITH requested AS MATERIALIZED(WITH RECURSIVE ${calendar(0)} SELECT start,finish FROM bounds),
 granted AS MATERIALIZED(WITH RECURSIVE ${calendar(3)} SELECT start,finish FROM bounds)
 SELECT r.start>=g.start AND r.finish<=g.finish AS valid FROM requested r CROSS JOIN granted g`,[next.query.from,next.query.to,next.query.timeZone,granted.query.from,granted.query.to,granted.query.timeZone])).rows[0]?.valid;
 if(!valid)throw new FoundationError(403,'The requested native calendar exceeds this share.');
}
async function withPublicBoardShare<T>(shareId:unknown,token:string,cardId:unknown|null,raw:unknown,work:(c:PoolClient,board:Row,grant:ShareRow,selected:BoardCard[],context:BoardShareReadContext,scope:ReturnType<typeof boardScope>,names:Map<string,string>)=>Promise<T>):Promise<T>{
 const sid=parse(uuid,shareId),cid=cardId===null?null:parse(uuid,cardId);
 if(!/^[A-Za-z0-9_-]{43}$(?![\s\S])/.test(token)||Buffer.from(token,'base64url').toString('base64url')!==token)throw missing();
 const tokenHash=shareHash(token),deadline=Date.now()+20000,timeout=()=>new FoundationError(503,'This shared board read exceeded its time limit.');
 let owned:PoolClient|undefined,released=false,expired=false,connectionFailed=false,timer:ReturnType<typeof setTimeout>|undefined;
 const connectionError=()=>{connectionFailed=true;release(true);};
 const release=(destroy=false)=>{if(owned&&!released){released=true;owned.removeListener('error',connectionError);owned.release(destroy);}};
 const currentBudget=()=>{if(expired||Date.now()>=deadline)throw timeout();};
 const operation=(async()=>{const c=await getDatabase().pool.connect().catch(()=>{throw new FoundationError(503,'The shared board is temporarily busy.');});owned=c;c.on('error',connectionError);
 if(expired){release(true);throw timeout();}
 try{currentBudget();await c.query('BEGIN ISOLATION LEVEL READ COMMITTED');currentBudget();
  // PostgreSQL18 is the supported pinned deployment. SQL owns the remaining transaction deadline.
  const remaining=deadline-Date.now();if(remaining<=0)throw timeout();
  await c.query("SELECT set_config('transaction_timeout',$1,true),set_config('statement_timeout',$2,true),set_config('lock_timeout',$2,true),set_config('TimeZone','UTC',true)",[remaining+'ms',Math.min(5000,remaining)+'ms']);
  const locator=(await c.query<{workspace_id:string;board_id:string}>('SELECT b.workspace_id,b.id AS board_id FROM board_share s JOIN custom_board b ON b.id=s.board_id WHERE s.id=$1 AND s.token_hash=$2',[sid,tokenHash])).rows[0];if(!locator)throw missing();
  await c.query('SELECT id FROM workspace WHERE id=$1 FOR SHARE',[locator.workspace_id]);currentBudget();
  const board=(await c.query<Row>(`SELECT ${columns} FROM custom_board WHERE workspace_id=$1 AND id=$2 FOR SHARE`,[locator.workspace_id,locator.board_id])).rows[0];if(!board)throw missing();
  const observed=(await c.query<ShareRow>('SELECT * FROM board_share WHERE id=$1 AND board_id=$2 AND token_hash=$3 AND revoked_at IS NULL AND expires_at>clock_timestamp()',[sid,board.id,tokenHash])).rows[0];if(!observed)throw missing();if(observed.board_revision!==board.revision)throw conflict();
  const selected=cards(board.definition).filter(card=>observed.selected_card_ids.includes(card.id)&&(cid===null||card.id===cid));if(!selected.length||cid===null&&selected.length!==observed.selected_card_ids.length)throw missing();
  const names=new Map<string,string>(),ordered=[...selected].sort((a,b)=>{const x=entity(board.definition,a),y=entity(board.definition,b);return((x?.kind??'')+':'+(x?.id??'')).localeCompare((y?.kind??'')+':'+(y?.id??''));});
  for(const card of ordered){currentBudget();const ref=entity(board.definition,card);if(ref){const found=ref.kind==='website'?(await c.query<{name:string}>('SELECT name FROM project WHERE id=$1 AND workspace_id=$2 FOR SHARE',[ref.id,locator.workspace_id])).rows[0]:(await c.query<{name:string}>('SELECT name FROM tracked_asset WHERE id=$1 AND workspace_id=$2 AND kind=$3 FOR SHARE',[ref.id,locator.workspace_id,ref.kind])).rows[0];if(!found)throw missing();names.set(card.id,found.name);
    if(card.type==='Goal'||card.type==='Funnel')if(!(await c.query('SELECT 1 FROM analytics_definition WHERE project_id=$1 AND id=$2 AND kind=$3 AND revision=$4 FOR SHARE',[ref.id,card.analysisId,card.type==='Goal'?'goal':'funnel',card.analysisRevision])).rowCount)throw conflict();
   }}
  const grant=(await c.query<ShareRow>('SELECT * FROM board_share WHERE id=$1 AND board_id=$2 AND token_hash=$3 AND revoked_at IS NULL AND expires_at>clock_timestamp() FOR SHARE',[sid,board.id,tokenHash])).rows[0];if(!grant||grant.revision!==observed.revision||grant.board_revision!==board.revision)throw missing();
  const admitted=boardScope(grant.scope),input=cid===null?null:parse(boardShareRead,raw);if(input&&(input.grantRevision!==grant.revision||input.boardRevision!==board.revision))throw conflict();
  const scope=input?permittedBoardShareScope(grant.scope,input.scope,grant.allow_filter):admitted;await shareCalendarContained(c,admitted,scope);
  const card=selected[0],ref=entity(board.definition,card);
  if(selected.some(card=>card.type.startsWith('Realtime'))&&(!grant.ongoing_live||Object.keys(scope.query.filters).length||scope.query.property))throw new FoundationError(403,'This share does not grant an unfiltered ongoing live window.');
  const context:BoardShareReadContext={workspaceId:locator.workspace_id,boardId:board.id,boardRevision:board.revision,shareId:grant.id,grantRevision:grant.revision,cardId:card.id,cardType:card.type,entityId:ref?.id??'',entityKind:ref?.kind??'none',tokenHash,deadline,...card.type==='Goal'||card.type==='Funnel'?{analysisId:card.analysisId,analysisRevision:card.analysisRevision}:{}};
  currentBudget();const result=await work(c,board,grant,selected,context,scope,names);currentBudget();await assertBoardShareCurrent(c,context);currentBudget();
  await c.query('COMMIT');return bounded(result);
 }catch(error){const code=(error as{code?:string})?.code??'',terminated=expired||connectionFailed||['25P04','57P01','08006'].includes(code);if(!terminated)await c.query('ROLLBACK').catch(()=>{});if(terminated)release(true);if(terminated||['57014','55P03'].includes(code))throw new FoundationError(503,'The shared board is temporarily busy.');throw error;}finally{release();}
 })();
 try{return await Promise.race([operation,new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>{expired=true;release(true);reject(timeout());},Math.max(1,deadline-Date.now()));})]);}
 finally{if(timer)clearTimeout(timer);}
}
function sharedCardDefinition(card:BoardCard,label:string|null,kind:BoardEntity['kind']|null){
 const common={id:card.id,type:card.type,...card.title?{title:card.title}:{},...card.description?{description:card.description}:{}};
 if(card.type==='TextBlock')return{...common,text:card.text};
 return{...common,entityKind:kind,entityLabel:label,...'currency'in card?{currency:card.currency}:{},...'dimension'in card?{dimension:card.dimension}:{},...'parameter'in card?{parameter:card.parameter}:{},...'limit'in card?{limit:card.limit}:{}};
}
export async function getPublicBoardManifest(shareId:unknown,token:string){return withPublicBoardShare(shareId,token,null,null,async(c,board,grant,selected,_context,_scope,names)=>{
 const ids=new Set(selected.map(card=>card.id)),readAt=(await c.query<{at:Date}>('SELECT clock_timestamp()AS at')).rows[0].at.toISOString();
 const result={version:'public-board-share-v1' as const,shareId:grant.id,grantRevision:grant.revision,boardRevision:board.revision,label:grant.label,theme:grant.theme,expiresAt:grant.expires_at.toISOString(),allowFilter:grant.allow_filter,ongoingLive:grant.ongoing_live,scope:grant.scope,readAt,
 rows:board.definition.rows.filter(row=>row.cards.some(card=>card&&ids.has(card.id))).map(row=>({id:row.id,minHeight:row.minHeight,...row.widths?{widths:[...row.widths]}:{},cards:row.cards.map(card=>card&&ids.has(card.id)?sharedCardDefinition(card,names.get(card.id)??null,entity(board.definition,card)?.kind??null):null)}))};
 const decoded=decodePublicBoardManifest(result,grant.id);if(!decoded)throw new FoundationError(503,'The shared manifest could not be verified.');return decoded;
 });}
export async function readPublicBoardCard(shareId:unknown,token:string,cardId:unknown,raw:unknown){return withPublicBoardShare(shareId,token,cardId,raw,async(c,board,grant,selected,context,scope)=>{
 const card=selected[0],ref=entity(board.definition,card),binding=await readCardBinding(c,context.workspaceId,ref);
 const base={workspaceId:context.workspaceId,cardId:card.id,cardType:card.type,entity:ref,scope:scope.scope,effectiveWindow:card.type==='TextBlock'?'none' as const:card.type.startsWith('Realtime')?'fixed-live' as const:'historical' as const};
 await boardShareSqlBudget(c,context);const data=await dispatchBoardCard({base,card,ref,scope,uid:JSON.stringify(context),wid:context.workspaceId,live:card.type.startsWith('Realtime'),binding,borrowed:{client:c,context}});
 if(canonicalHash(binding)!==canonicalHash(await readCardBinding(c,context.workspaceId,ref)))throw new FoundationError(409,'Shared retention changed. Reload this card.');
 const projected=projectBoardShareCard(card,data),readAt=(await c.query<{at:Date}>('SELECT clock_timestamp()AS at')).rows[0].at.toISOString();
 const result={version:'public-board-card-v1' as const,shareId:grant.id,grantRevision:grant.revision,boardRevision:board.revision,cardId:card.id,cardType:card.type,scope:scope.scope,effectiveWindow:base.effectiveWindow,readAt,...projected};
 const decoded=decodePublicBoardCard(result,{shareId:grant.id,grantRevision:grant.revision,boardRevision:board.revision,cardId:card.id,cardType:card.type,scope:scope.scope,entityKind:ref?.kind??'none'});if(!decoded)throw new FoundationError(503,'The shared card could not be verified.');return decoded;
 });}