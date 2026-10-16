import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {z} from 'zod';
import {boardDefinition,boardLimits,boardRevision,boardPreviewInput,type BoardPreviewInput,type BoardDefinition,type BoardCard,type BoardEntity,type BoardItem,type BoardRole,type BoardAck,type BoardWriteResult} from '../lib/boards.ts';
import {FoundationError} from './auth.ts';
import {getDatabase} from './db.ts';
import {canonicalHash,cleanText,parse} from './context-input.ts';
import {contentCursor,readContentCursor} from './project-context.ts';
import {explorerFilters,explorerQuery} from './explorer-input.ts';
import {exploreAnalytics} from './explorer.ts';

import {projectRealtime} from './realtime.ts';
import {projectRevenue} from './revenue.ts';
import {runAnalysis} from './funnels.ts';
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
 return{query,scope:canonical.toString(),params:canonical};
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
type NativeCardData={source:'analytics';data:Awaited<ReturnType<typeof boardSummary>>}|{source:'explorer';data:Omit<Awaited<ReturnType<typeof exploreAnalytics>>,'csv'>}|{source:'realtime';data:Awaited<ReturnType<typeof projectRealtime>>}|{source:'revenue';data:Awaited<ReturnType<typeof projectRevenue>>}|{source:'analysis';data:Awaited<ReturnType<typeof runAnalysis>>}|{source:'activity';data:Awaited<ReturnType<typeof boardActivity>>}|{source:'dimensions';data:Awaited<ReturnType<typeof boardDimension>>}|{source:'text';data:{text:string}}|{source:'tracked-asset';data:TrackedAssetReport};
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
type CardAdmission<T>={base:T;card:BoardCard;ref:BoardEntity|null;scope:ReturnType<typeof boardScope>;uid:string;wid:string;live:boolean;binding:CardBinding};
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
async function dispatchBoardCard<T extends Omit<CardBase,'boardId'|'boardRevision'>>(admitted:CardAdmission<T>,savedCurrent?:(client:PoolClient)=>Promise<void>):Promise<T&CardOutcome>{
 const{base,card,ref,scope,uid,wid,live}=admitted;
 const unsupported=(reason:'entity_dependency'|'scope'|'not_collected'|'reader_unavailable',message:string):T&CardOutcome=>({...base,status:'unsupported',reason,message});
 if(card.type==='TextBlock')return{...base,status:'ready',source:'text',data:{text:card.text}};
 if(!ref)throw missing();
 const current=async(client:PoolClient)=>{await savedCurrent?.(client);const binding=await readCardBinding(client,wid,ref);if(canonicalHash(binding)!==canonicalHash(admitted.binding))throw new FoundationError(409,'Retention changed while this card was loading. Reload its result.');};
  if(ref.kind!=='website'){
   const kind=ref.kind,query=boardAssetQuery(card,scope);if(!query)return withBoardWorkspace(wid,uid,false,async(client,_wid,_uid,role):Promise<T&CardOutcome>=>{await current(client);return{...unsupported('scope','This tracked asset card supports dates, timezone and native referrer, browser, operating-system, device and location filters only. No website, event or property scope was substituted.'),role};});
   return withBoardWorkspace(wid,uid,false,async(client,_wid,_uid,role):Promise<T&CardOutcome>=>{await current(client);const data=await readTrackedAssetBoardReport(client,wid,ref.id,kind,query.scope,[card.type==='WebsiteMetricsBar'?'summary':card.type==='WebsiteChart'?'trend':'breakdown']);return{...base,role,status:'ready',source:'tracked-asset',data};});
  }
  const report=new URLSearchParams(scope.params),{query}=scope;
  let value:NativeCardData;
  if(live){if(Object.keys(query.filters).length||query.property)return unsupported('scope','Live cards use the native fixed30-minute window and do not support board filters.');value={source:'realtime',data:await projectRealtime(ref.id,{kind:'session',userId:uid},new URLSearchParams())};}
  else if(card.type==='WebsiteMetricsBar'){
   const client=await getDatabase().pool.connect();try{await client.query('BEGIN');await client.query("SET LOCAL statement_timeout='5s';SET LOCAL lock_timeout='5s'");value={source:'analytics',data:await boardSummary(client,ref.id,uid,scope.scope,query)};await client.query('COMMIT');}catch(error){await client.query('ROLLBACK').catch(()=>{});if(['57014','55P03'].includes((error as {code?:string})?.code??''))throw new FoundationError(503,'The summary is busy. Narrow its dates or retry the read.');throw error;}finally{client.release();}
  }
  else if(card.type==='Goal'||card.type==='Funnel'){report.set('revision',String(card.analysisRevision));value={source:'analysis',data:await runAnalysis(ref.id,uid,card.type==='Goal'?'goal':'funnel',card.analysisId,report)};}
  else if(card.type==='RevenueMetricsBar'||card.type==='RevenueChart'||card.type==='RevenueMetricsTable'){report.set('currency',card.currency);value={source:'revenue',data:await projectRevenue(ref.id,{kind:'session',userId:uid},report)};}
  else if(card.type==='WebsiteChart'||card.type==='WeeklyTraffic'||card.type==='EventsChart')return withBoardWorkspace(wid,uid,false,async(client,_wid,_uid,role):Promise<T&CardOutcome>=>{await current(client);return{...base,role,status:'ready',source:'activity',data:await boardActivity(client,ref.id,uid,scope.scope,query,card.type==='WebsiteChart'?'visitors':card.type==='WeeklyTraffic'?'weekly':'events',card.type==='EventsChart'?card.limit:10)};});
  else{
   report.set('kind',card.type==='EventsMetricsBar'||card.type==='MetricsTable'&&card.dimension==='event'?'custom':'pageviews');
   if(card.type==='MetricsTable'){
    if(['fullPath','query','title'].includes(card.dimension))return unsupported('not_collected','Full URLs, query strings and page titles are not collected by the current native analytics privacy contract.');
    if(card.dimension==='entry'||card.dimension==='exit'||card.dimension==='channel'||card.dimension==='hostname'){const dimension=card.dimension;return withBoardWorkspace(wid,uid,false,async(client,_wid,_uid,role):Promise<T&CardOutcome>=>{await current(client);return{...base,role,status:'ready',source:'dimensions',data:await boardDimension(client,ref.id,uid,scope.scope,query,dimension,card.limit)};});}
    if(card.dimension==='screen')report.set('fields',JSON.stringify(['screenWidth','screenHeight']));else report.set('groupBy',metricField[card.dimension as keyof typeof metricField]);
   }else report.set('groupBy',card.type==='UTM'?card.parameter:card.type==='WorldMap'?'country':'event');
   // A card snapshot has its configured row bound; do not attach the original wider Explorer CSV.
   const{csv:_csv,...data}=await exploreAnalytics(ref.id,uid,report);
   if(card.type==='UTM'||card.type==='MetricsTable'){const groups=data.breakdown.groups.slice(0,card.limit);data.breakdown={...data.breakdown,groups,returnedGroupEvents:data.coverage.status==='unavailable'?null:groups.reduce((n,g)=>n+g.events,0),truncated:data.breakdown.truncated||groups.length<data.breakdown.groups.length};}
   if(data.coverage.status==='unavailable')data.breakdown={...data.breakdown,groups:[],totalGroups:null,returnedGroupEvents:null,truncated:false};
   value={source:'explorer',data};
  }
  // Existing readers own their connection/authorization. Recheck publication without borrowing two pool clients.
  return withBoardWorkspace(wid,uid,false,async(client,_wid,_uid,role):Promise<T&CardOutcome>=>{await current(client);return{...base,role,status:'ready',...value};});
}
