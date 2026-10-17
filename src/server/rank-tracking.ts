import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {z} from 'zod';
import {FoundationError} from './auth.ts';
import {normalizePublicHostname} from './domains.ts';
import {credentialKeys} from './credential-vault.ts';
import {canonicalHash,parse,revision,text} from './context-input.ts';
import {contentReceipt,readContentCursor,withContentProject,type ContentProject} from './project-context.ts';
import {keywordConnection,keywordCredentials} from './keyword-research.ts';
import {readRankCatalog,pageRankLocations,validateRankCatalogSelection,type RankCatalog} from './dataforseo-rank.ts';
import {parseRankKeywordAdd,parseRankKeywordRemove,parseRankKeywordPin} from './rank-keyword-input.ts';

const settings={name:text(120,1),devices:z.enum(['desktop','mobile','both']),depth:z.number().int().min(10).max(100).multipleOf(10),maxCrawlPages:z.number().int().min(1).max(10)};
const createInput=z.object({requestId:z.uuid(),connectionId:z.uuid(),...settings,domain:z.string().max(1024),countryCode:z.number().int().positive().max(2147483647),locationCode:z.number().int().positive().max(2147483647),languageCode:z.string().max(16)}).strict();
const updateInput=z.object({requestId:z.uuid(),revision,...settings}).strict();
const archiveInput=z.object({requestId:z.uuid(),revision,archived:z.boolean()}).strict();
const connectionInput=z.object({connectionId:z.uuid()}).strict();
type CachedCatalog={catalog:RankCatalog;verifiedAt:string;expiresAt:number};
// ponytail: one validated public catalog per process for10minutes. No credentials
// or user-specific content are cached; multiple processes may each fetch a copy.
let catalogCache:CachedCatalog|null=null;
let catalogLoading=false;
const iso=(value:Date|string|null)=>value===null?null:new Date(value).toISOString();
const columns=`r.*,(SELECT count(*)::integer FROM rank_keyword k WHERE k.config_id=r.id) AS keyword_count`;
export type RankTracker={id:string;name:string;domain:string;countryCode:number;countryIso:string;locationCode:number;locationName:string;locationType:string;languageCode:string;languageName:string;devices:'desktop'|'mobile'|'both';depth:number;maxCrawlPages:number;revision:number;keywordsRevision:number;authoredRevision:number;keywordCount:number;archivedAt:string|null;createdAt:string;updatedAt:string;schedule:{interval:'manual'|'daily'|'weekly'|'monthly';enabled:boolean;nextDueAt:string|null}};
export type RankKeyword={id:string;keyword:string;matchCase:boolean;pinnedAt:string|null;createdAt:string};
function tracker(row:any):RankTracker{return {id:row.id,name:row.name,domain:row.target_domain,countryCode:row.country_location_code,countryIso:row.country_iso,locationCode:row.location_code,locationName:row.location_name,locationType:row.location_type,languageCode:row.language_code,languageName:row.language_name,devices:row.devices,depth:row.serp_depth,maxCrawlPages:row.max_crawl_pages,revision:row.revision,keywordsRevision:row.keywords_revision,authoredRevision:row.authored_revision,keywordCount:row.keyword_count,archivedAt:iso(row.archived_at),createdAt:iso(row.created_at)!,updatedAt:iso(row.updated_at)!,schedule:{interval:row.schedule_interval,enabled:row.schedule_enabled,nextDueAt:iso(row.next_due_at)}};}
async function workspace(client:PoolClient,projectId:string){return (await client.query('SELECT workspace_id FROM project WHERE id=$1',[projectId])).rows[0].workspace_id as string;}
async function row(client:PoolClient,projectId:string,id:string){const found=(await client.query(`SELECT ${columns} FROM rank_config r WHERE r.project_id=$1 AND r.id=$2`,[projectId,id])).rows[0];if(!found)throw new FoundationError(404,'Rank tracker not found or unavailable.');return found;}
async function detail(client:PoolClient,project:ContentProject,id:string,replayed?:boolean){
  const current=await row(client,project.id,id),rows=(await client.query('SELECT id,keyword,match_case,pinned_at,created_at FROM rank_keyword WHERE project_id=$1 AND config_id=$2 ORDER BY pinned_at DESC NULLS LAST,created_at,id LIMIT 1001',[project.id,id])).rows;
  if(rows.length>1000)throw new FoundationError(409,'The tracker keyword limit is inconsistent. Contact the host operator.');
  const keywords:RankKeyword[]=rows.map(k=>({id:k.id,keyword:k.keyword,matchCase:k.match_case,pinnedAt:iso(k.pinned_at),createdAt:iso(k.created_at)!}));
  return {role:project.role,tracker:tracker(current),keywords,...(replayed===undefined?{}:{replayed})};
}
function cas(row:any,value:number){if(row.authored_revision!==value)throw new FoundationError(409,'This tracker changed. Reload it before saving.');}
function incrementable(row:any,paid=false,keywords=false){if(row.authored_revision>=2147483646||(paid&&row.revision>=2147483646)||(keywords&&row.keywords_revision>=2147483646))throw new FoundationError(409,'This tracker reached its revision limit. Create another tracker.');}
async function bump(client:PoolClient,current:any,paid=false,keywords=false){
  incrementable(current,paid,keywords);
  await client.query(`UPDATE rank_config SET authored_revision=authored_revision+1,revision=revision+$2::integer,keywords_revision=keywords_revision+$3::integer,updated_at=clock_timestamp(),
    schedule_enabled=CASE WHEN $2::integer+$3::integer>0 THEN false ELSE schedule_enabled END,next_due_at=CASE WHEN $2::integer+$3::integer>0 THEN NULL ELSE next_due_at END WHERE id=$1`,[current.id,Number(paid),Number(keywords)]);
}
function paramsObject(params:URLSearchParams,allowed:string[]){const value:Record<string,string>={};for(const [key,val]of params){if(!allowed.includes(key)||Object.hasOwn(value,key))throw new FoundationError(400,'Check the tracker filters and page.');value[key]=val;}return value;}

export async function listRankTrackers(projectId:string,userId:string,params=new URLSearchParams(),apiToken?:string){
  const input=parse(z.object({archived:z.enum(['active','archived','all']).default('active'),cursor:z.string().max(512).optional()}).strict(),paramsObject(params,['archived','cursor']));
  return withContentProject(projectId,userId,false,async(client,p)=>{
    const scope={projectId:p.id,list:'rank-trackers',archived:input.archived},cursor=readContentCursor(input.cursor??null,scope);
    const rows=(await client.query(`SELECT ${columns},to_char(r.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at FROM rank_config r WHERE r.project_id=$1
      AND ($2='all' OR ($2='active' AND r.archived_at IS NULL) OR ($2='archived' AND r.archived_at IS NOT NULL))
      AND ($3::timestamptz IS NULL OR (r.created_at,r.id)<($3::timestamptz,$4::uuid)) ORDER BY r.created_at DESC,r.id DESC LIMIT 51`,[p.id,input.archived,cursor?.at??null,cursor?.id??null])).rows;
    const connections=(await client.query(`SELECT c.id,c.name,c.check_status AS "checkStatus" FROM provider_connection c JOIN project p ON p.workspace_id=c.workspace_id WHERE p.id=$1 AND c.provider='dataforseo' AND c.revoked_at IS NULL ORDER BY c.created_at,c.id`,[p.id])).rows;
    // Preserve SQL microseconds in the page anchor; JS Date would skip nearby rows.
    const last=rows[49],nextCursor=rows.length>50?Buffer.from(JSON.stringify({scope:canonicalHash(scope),at:last.cursor_at,id:last.id})).toString('base64url'):null;
    // A bearer or MCP caller never sees vault state or provider-connection metadata.
    return {role:p.role,...(apiToken===undefined?{vaultConfigured:credentialKeys()!==null,connections}:{}),trackers:rows.slice(0,50).map(tracker),nextCursor};
  },apiToken,false,'rank:read');
}
export async function getRankTracker(projectId:string,userId:string,id:string,apiToken?:string){id=parse(z.uuid(),id);return withContentProject(projectId,userId,false,(client,p)=>detail(client,p,id),apiToken,false,'rank:read');}

async function catalogBefore(projectId:string,userId:string,connectionId:string){return withContentProject(projectId,userId,true,async(client,p)=>{const connection=await keywordConnection(client,await workspace(client,p.id),connectionId);return {revision:connection.revision,credentials:keywordCredentials(connection)};});}
async function catalogLoad(credentials:unknown,send:typeof fetch){
  if(catalogCache&&catalogCache.expiresAt>Date.now())return catalogCache;
  // One bounded catalog download per process; do not queue credentials on a miss.
  if(catalogLoading)throw new FoundationError(409,'The location catalog is being refreshed. Try again shortly.');
  catalogLoading=true;
  try{const catalog=await readRankCatalog(credentials,send),now=Date.now();return {catalog,verifiedAt:new Date(now).toISOString(),expiresAt:now+600_000};}
  finally{catalogLoading=false;}
}
async function catalogAfter(client:PoolClient,p:ContentProject,connectionId:string,expected:number,loaded:CachedCatalog){
  await keywordConnection(client,await workspace(client,p.id),connectionId,expected);
  if(loaded.expiresAt<=Date.now())throw new FoundationError(409,'The location catalog expired while waiting. Reload it and try again.');
  if(!catalogCache||catalogCache.expiresAt<=loaded.expiresAt)catalogCache=loaded;
}
export async function getRankCatalog(projectId:string,userId:string,raw:unknown,send:typeof fetch=fetch){
  const {connectionId}=parse(connectionInput,raw),before=await catalogBefore(projectId,userId,connectionId),loaded=await catalogLoad(before.credentials,send);
  return withContentProject(projectId,userId,true,async(client,p)=>{await catalogAfter(client,p,connectionId,before.revision,loaded);return {role:p.role,catalog:{countries:structuredClone(loaded.catalog.countries),languages:structuredClone(loaded.catalog.languages),coverage:structuredClone(loaded.catalog.coverage),verifiedAt:loaded.verifiedAt}};});
}
export async function searchRankLocations(projectId:string,userId:string,params:URLSearchParams,send:typeof fetch=fetch){
  const digits=z.string().regex(/^(?:0|[1-9]\d*)(?![\s\S])/).transform(Number);
  const input=parse(z.object({connectionId:z.uuid(),countryCode:digits.pipe(z.number().int().positive().max(2147483647)),query:z.string().max(100).default(''),offset:digits.pipe(z.number().int().min(0).max(300000)).default(0)}).strict(),paramsObject(params,['connectionId','countryCode','query','offset']));
  const before=await catalogBefore(projectId,userId,input.connectionId),loaded=await catalogLoad(before.credentials,send);
  const page=pageRankLocations(loaded.catalog,{kind:'local',countryCode:input.countryCode,query:input.query,offset:input.offset});
  return withContentProject(projectId,userId,true,async(client,p)=>{await catalogAfter(client,p,input.connectionId,before.revision,loaded);return {role:p.role,...structuredClone(page),coverage:structuredClone(loaded.catalog.coverage),verifiedAt:loaded.verifiedAt};});
}
export async function createRankTracker(projectId:string,userId:string,raw:unknown,send:typeof fetch=fetch){
  const uid=parse(z.uuid(),userId),input=parse(createInput,raw);input.domain=normalizePublicHostname(input.domain);
  const operation='rank.create',receiptInput={userId:uid,...input};
  const before=await withContentProject(projectId,uid,true,async(client,p)=>{
    const receipt=await contentReceipt(client,p.id,input.requestId,operation,receiptInput);
    if(receipt.replayed)return {replay:await detail(client,p,receipt.result.id,true)};
    const connection=await keywordConnection(client,await workspace(client,p.id),input.connectionId);
    return {revision:connection.revision,credentials:keywordCredentials(connection)};
  });
  if('replay'in before)return before.replay;
  const loaded=await catalogLoad(before.credentials,send),selection=validateRankCatalogSelection(loaded.catalog,{countryCode:input.countryCode,locationCode:input.locationCode,languageCode:input.languageCode});
  return withContentProject(projectId,uid,true,async(client,p)=>{
    const receipt=await contentReceipt(client,p.id,input.requestId,operation,receiptInput);
    if(receipt.replayed)return detail(client,p,receipt.result.id,true);
    await catalogAfter(client,p,input.connectionId,before.revision!,loaded);
    if((await client.query('SELECT id FROM rank_config WHERE project_id=$1 AND target_domain=$2 AND location_code=$3 AND language_code=$4',[p.id,input.domain,input.locationCode,input.languageCode])).rowCount)throw new FoundationError(409,'This target and market already have a tracker. Open or reactivate that tracker.');
    const id=randomUUID();await client.query(`INSERT INTO rank_config(id,workspace_id,project_id,name,target_domain,location_code,location_name,location_type,country_location_code,country_iso,language_code,language_name,catalog_verified_at,devices,serp_depth,max_crawl_pages)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,[id,await workspace(client,p.id),p.id,input.name,input.domain,selection.location.code,selection.location.name,selection.location.type,selection.country.code,selection.country.countryIso,selection.language.code,selection.language.name,loaded.verifiedAt,input.devices,input.depth,input.maxCrawlPages]);
    await receipt.save({id});return detail(client,p,id,false);
  });
}
export async function updateRankTracker(projectId:string,userId:string,id:string,raw:unknown){
  const uid=parse(z.uuid(),userId);id=parse(z.uuid(),id);const input=parse(updateInput,raw);
  return withContentProject(projectId,uid,true,async(client,p)=>{
    const receipt=await contentReceipt(client,p.id,input.requestId,'rank.update:'+id,{userId:uid,...input});if(receipt.replayed)return detail(client,p,id,true);
    const current=await row(client,p.id,id);cas(current,input.revision);
    const paid=current.devices!==input.devices||current.serp_depth!==input.depth||current.max_crawl_pages!==input.maxCrawlPages;
    if(current.archived_at&&paid)throw new FoundationError(409,'Reactivate this tracker before changing check settings.');
    if(paid||current.name!==input.name){await bump(client,current,paid);await client.query('UPDATE rank_config SET name=$2,devices=$3,serp_depth=$4,max_crawl_pages=$5 WHERE id=$1',[id,input.name,input.devices,input.depth,input.maxCrawlPages]);}
    await receipt.save({id});return detail(client,p,id,false);
  });
}
export async function archiveRankTracker(projectId:string,userId:string,id:string,raw:unknown){
  const uid=parse(z.uuid(),userId);id=parse(z.uuid(),id);const input=parse(archiveInput,raw);
  return withContentProject(projectId,uid,true,async(client,p)=>{
    const receipt=await contentReceipt(client,p.id,input.requestId,'rank.archive:'+id,{userId:uid,...input});if(receipt.replayed)return detail(client,p,id,true);
    const current=await row(client,p.id,id);cas(current,input.revision);
    if((current.archived_at!==null)!==input.archived){await bump(client,current,true);await client.query('UPDATE rank_config SET archived_at=CASE WHEN $2 THEN clock_timestamp() ELSE NULL END WHERE id=$1',[id,input.archived]);}
    await receipt.save({id});return detail(client,p,id,false);
  });
}
export async function changeRankKeywords(projectId:string,userId:string,id:string,action:'add'|'remove'|'pin',raw:unknown){
  const uid=parse(z.uuid(),userId);id=parse(z.uuid(),id);
  if(!['add','remove','pin'].includes(action))throw new FoundationError(400,'Choose a keyword action.');
  const input=action==='add'?parseRankKeywordAdd(raw):action==='remove'?parseRankKeywordRemove(raw):parseRankKeywordPin(raw);
  return withContentProject(projectId,uid,true,async(client,p)=>{
    const receipt=await contentReceipt(client,p.id,input.requestId,'rank.keywords.'+action+':'+id,{userId:uid,...input});if(receipt.replayed)return detail(client,p,id,true);
    const current=await row(client,p.id,id);cas(current,input.revision);
    if('keywords'in input){
      if(current.archived_at)throw new FoundationError(409,'Reactivate this tracker before adding keywords.');
      const existing=new Set((await client.query('SELECT keyword FROM rank_keyword WHERE config_id=$1',[id])).rows.map(k=>k.keyword)),added=input.keywords.filter(k=>!existing.has(k));
      if(existing.size+added.length>1000)throw new FoundationError(400,'A tracker supports at most1,000 current keywords. Remove some or use another tracker.');
      if(added.length){await bump(client,current,false,true);await client.query('INSERT INTO rank_keyword(id,workspace_id,project_id,config_id,keyword,match_case) SELECT incoming.id,$2,$3,$4,incoming.keyword,$6 FROM unnest($1::uuid[],$5::text[]) AS incoming(id,keyword)',[added.map(()=>randomUUID()),await workspace(client,p.id),p.id,id,added,input.matchCase]);}
    }else{
      const selected=(await client.query('SELECT id,pinned_at FROM rank_keyword WHERE config_id=$1 AND project_id=$2 AND id=ANY($3::uuid[])',[id,p.id,input.keywordIds])).rows;
      if(selected.length!==input.keywordIds.length)throw new FoundationError(404,'A selected keyword was removed or is unavailable. Reload the tracker.');
      if('pinned'in input){if(selected.some(k=>(k.pinned_at!==null)!==input.pinned)){await bump(client,current);await client.query('UPDATE rank_keyword SET pinned_at=CASE WHEN $3 THEN COALESCE(pinned_at,clock_timestamp()) ELSE NULL END WHERE config_id=$1 AND id=ANY($2::uuid[])',[id,input.keywordIds,input.pinned]);}}
      else{await bump(client,current,false,true);await client.query('DELETE FROM rank_keyword WHERE config_id=$1 AND id=ANY($2::uuid[])',[id,input.keywordIds]);}
    }
    await receipt.save({id});return detail(client,p,id,false);
  });
}
