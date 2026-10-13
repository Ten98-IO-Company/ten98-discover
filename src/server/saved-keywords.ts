import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {z} from 'zod';
import {FoundationError} from './auth.ts';
import {canonicalHash,parse} from './context-input.ts';
import {withContentProject,contentReceipt,type ContentProject} from './project-context.ts';
import {csvCell} from './explorer-input.ts';
import type {KeywordResult,KeywordRow} from './keyword-research-input.ts';
import {normalizeSavedKeyword,savedKeywordRefreshable,parseSavedKeywordSave,parseSavedKeywordTagChange,parseSavedKeywordRemove,parseSavedTagUpdate,parseSavedTagDelete,parseSavedKeywordList,parseSavedKeywordExport,parseSavedKeywordFilters,
  type SavedKeywordFilters,type SavedKeywordSelection,type SavedTagInput,type SavedTagColor} from './saved-keyword-input.ts';

type Role=ContentProject['role'];
export type SavedKeywordTag={id:string;name:string;color:SavedTagColor|null;assignmentCount:number};
export type SavedKeywordTarget={id:string;keyword:string;locationCode:number;languageCode:string;eligible:boolean;reason:string|null};
export type SavedKeywordRow={id:string;keyword:string;locationCode:number;languageCode:string;createdAt:string;updatedAt:string;tags:Pick<SavedKeywordTag,'id'|'name'|'color'>[];
  metrics:{status:'available'|'unavailable'|'expired';row:KeywordRow|null;sourceRunId:string|null;sourceRowIndex:number|null;source:string|null;fetchedAt:string|null;observedAt:string|null};
  refresh:{eligible:boolean;reason:string|null;lastAttemptStatus:string|null;lastAttemptAt:string|null}};
export type SavedKeywordMutation={role:Role;revision:number;metricRevision:string;replayed:boolean;ids:string[];missingIds:string[];inserted:number;existing:number;skippedOlder:number;metricsUpdated:number;affected:number;tag?:SavedKeywordTag;tagId?:string};
type State={revision:number;metricRevision:string;retentionRevision:number;cutoff:string;expiredCount:string};
type Stored={id:string;project_id:string;keyword:string;location_code:number;language_code:string;created_at:Date;updated_at:Date;metric_data:KeywordRow|null;metric_source_run_id:string|null;metric_source_row:number|null;metric_source:string|null;metric_fetched_at:Date|null;metric_observed_at:Date|null;metric_expired_at:Date|null;last_attempt_status:string|null;last_attempt_at:Date|null;metrics_status:SavedKeywordRow['metrics']['status']};
type ReceiptResult={ids:string[];inserted?:number;existing?:number;skippedOlder?:number;metricsUpdated?:number;affected?:number;tagId?:string};
const unavailable=():never=>{throw new FoundationError(404,'Saved keyword or tag not found or unavailable.');};
const conflict=(message:string):never=>{throw new FoundationError(409,message);};
function queryError(error:unknown):never {
  if((error as {code?:string})?.code==='57014')throw new FoundationError(503,'This saved keyword query took too long. Narrow the filters and try again.');
  throw error;
}
const iso=(value:Date|null)=>value?.toISOString()??null;
const id=(value:unknown)=>parse(z.uuid(),value).toLowerCase();

async function state(client:PoolClient,projectId:string):Promise<State>{
  const row=(await client.query(`WITH time AS MATERIALIZED (SELECT clock_timestamp() AS now),settings AS (
    SELECT p.saved_keywords_revision AS revision,p.saved_keyword_metrics_revision::text AS "metricRevision",w.retention_revision AS "retentionRevision",
      time.now-make_interval(days=>w.derived_history_days) AS cutoff FROM project p JOIN workspace w ON w.id=p.workspace_id CROSS JOIN time WHERE p.id=$1)
    SELECT revision,"metricRevision","retentionRevision",cutoff::text,
      (SELECT count(*)::text FROM saved_keyword k WHERE k.project_id=$1 AND k.metric_data IS NOT NULL AND k.metric_observed_at<settings.cutoff) AS "expiredCount" FROM settings`,[projectId])).rows[0];
  if(!row)unavailable();return row;
}
async function bump(client:PoolClient,projectId:string,authored=false){
  if(authored){const updated=await client.query('UPDATE project SET saved_keywords_revision=saved_keywords_revision+1 WHERE id=$1 AND saved_keywords_revision<2147483647',[projectId]);if(!updated.rowCount)conflict('This saved list reached its revision limit.');}
  else await client.query('UPDATE project SET saved_keyword_metrics_revision=saved_keyword_metrics_revision+1 WHERE id=$1',[projectId]);
}
async function version(client:PoolClient){return (await client.query("SELECT nextval('saved_keyword_version_seq')::text AS version")).rows[0].version as string;}
function target(row:Pick<Stored,'id'|'keyword'|'location_code'|'language_code'>):SavedKeywordTarget{
  const eligible=savedKeywordRefreshable(row.keyword);return {id:row.id,keyword:row.keyword,locationCode:row.location_code,languageCode:row.language_code,eligible,reason:eligible?null:'This saved keyword exceeds the current overview adapter limits.'};
}
async function assertIds(client:PoolClient,projectId:string,ids:string[],tags=false){
  const rows=await client.query(`SELECT id FROM ${tags?'saved_keyword_tag':'saved_keyword'} WHERE project_id=$1 AND id=ANY($2::uuid[])`,[projectId,ids]);
  if(rows.rowCount!==ids.length)unavailable();
}

// Opaque cursors carry no metric values. The anchor is always resolved in the
// authorized current query; a cursor is never an authority to access a row.
const cursorInput=z.object({s:z.string().regex(/^[a-f0-9]{64}$/),r:z.number().int(),m:z.string(),e:z.string(),i:z.uuid()}).strict();
function scopeHash(projectId:string,filters:unknown){return canonicalHash({projectId,filters});}
function expiryHash(s:State){return canonicalHash({policy:s.retentionRevision,expired:s.expiredCount});}
function readCursor(value:string|null,projectId:string,filters:unknown,s:State,metrics=true){
  if(!value)return null;
  if(value.length>512||!/^[A-Za-z0-9_-]+(?![\s\S])/.test(value))throw new FoundationError(400,'Reload this saved list before continuing.');
  let raw:unknown;try{raw=JSON.parse(Buffer.from(value,'base64url').toString('utf8'));}catch{throw new FoundationError(400,'Reload this saved list before continuing.');}
  const cursor=parse(cursorInput,raw);if(cursor.s!==scopeHash(projectId,filters))throw new FoundationError(400,'This cursor belongs to another saved-keyword scope.');
  if(cursor.r!==s.revision||(metrics&&(cursor.m!==s.metricRevision||cursor.e!==expiryHash(s))))conflict('The saved list or its metrics changed. Reload before continuing.');
  return cursor.i;
}
function cursorFor(last:string,projectId:string,filters:unknown,s:State){return Buffer.from(JSON.stringify({s:scopeHash(projectId,filters),r:s.revision,m:s.metricRevision,e:expiryHash(s),i:last})).toString('base64url');}

const sorts={createdAt:'created_at',keyword:'keyword',searchVolume:'search_volume',cpcUsd:'cpc_usd',competition:'competition',keywordDifficulty:'difficulty',fetchedAt:'fetched_at'} as const;
function population(projectId:string,filters:SavedKeywordFilters,s:State,ids?:string[]){
  const values:unknown[]=[projectId,s.cutoff],bind=(value:unknown)=>{values.push(value);return '$'+values.length;};
  const terms=[`strpos(b.keyword,${bind(filters.search)})>0`,
    `NOT EXISTS(SELECT 1 FROM unnest(${bind(filters.includeTerms)}::text[]) t WHERE strpos(b.keyword,t)=0)`,
    `NOT EXISTS(SELECT 1 FROM unnest(${bind(filters.excludeTerms)}::text[]) t WHERE strpos(b.keyword,t)>0)`];
  if(filters.locationCode!==null)terms.push(`b.location_code=${bind(filters.locationCode)}`);
  if(filters.languageCode!==null)terms.push(`b.language_code=${bind(filters.languageCode)}`);
  if(filters.tagIds.length)terms.push(`EXISTS(SELECT 1 FROM saved_keyword_tag_assignment a WHERE a.project_id=b.project_id AND a.keyword_id=b.id AND a.tag_id=ANY(${bind(filters.tagIds)}::uuid[]))`);
  for(const [column,min,max]of [['search_volume',filters.minVolume,filters.maxVolume],['difficulty',filters.minDifficulty,filters.maxDifficulty],['cpc_usd',filters.minCpcUsd,filters.maxCpcUsd]] as const){
    if(min!==null)terms.push(`b.${column}>=${bind(min)}::numeric`);if(max!==null)terms.push(`b.${column}<=${bind(max)}::numeric`);
  }
  if(filters.metrics!=='all')terms.push(`b.metrics_status=${bind(filters.metrics)}`);
  if(ids)terms.push(`b.id=ANY(${bind(ids)}::uuid[])`);
  const text=`WITH visible AS MATERIALIZED (
    SELECT k.*,CASE WHEN metric_expired_at IS NOT NULL OR (metric_observed_at IS NOT NULL AND metric_observed_at<$2::timestamptz) THEN 'expired'
      WHEN metric_data IS NOT NULL THEN 'available' ELSE 'unavailable' END AS metrics_status FROM saved_keyword k WHERE project_id=$1
    ),base AS MATERIALIZED (
      SELECT v.*,CASE WHEN metrics_status='available' THEN (metric_data->>'searchVolume')::numeric END AS search_volume,
        CASE WHEN metrics_status='available' THEN (metric_data->>'cpcUsd')::numeric END AS cpc_usd,
        CASE WHEN metrics_status='available' THEN (metric_data->>'competition')::numeric END AS competition,
        CASE WHEN metrics_status='available' THEN (metric_data->>'keywordDifficulty')::numeric END AS difficulty,
        CASE WHEN metrics_status='available' THEN metric_fetched_at END AS fetched_at FROM visible v
    ),filtered AS (SELECT * FROM base b WHERE ${terms.join(' AND ')})`;
  return {text,values,bind};
}
async function rows(client:PoolClient,projectId:string,filters:SavedKeywordFilters,s:State,limit:number,after:string|null=null,ids?:string[]){
  const sql=population(projectId,filters,s,ids),column=sorts[filters.sort],direction=filters.order==='asc'?'ASC':'DESC',comparison=filters.order==='asc'?'>':'<';
  let condition='true';
  if(after){
    const anchor=sql.bind(after);
    if(!(await client.query(`${sql.text} SELECT 1 FROM filtered WHERE id=${anchor}::uuid`,sql.values)).rowCount)conflict('The saved-keyword page anchor changed. Reload this list.');
    condition=`(b.${column} IS NULL AND a.${column} IS NOT NULL) OR (b.${column} IS NOT NULL AND a.${column} IS NOT NULL AND b.${column}${comparison}a.${column}) OR (b.${column} IS NOT DISTINCT FROM a.${column} AND b.id${comparison}a.id)`;
    return (await client.query<Stored>(`${sql.text} SELECT b.* FROM filtered b CROSS JOIN (SELECT * FROM filtered WHERE id=${anchor}::uuid) a WHERE ${condition} ORDER BY b.${column} ${direction} NULLS LAST,b.id ${direction} LIMIT ${sql.bind(limit)}`,sql.values)).rows;
  }
  return (await client.query<Stored>(`${sql.text} SELECT b.* FROM filtered b ORDER BY b.${column} ${direction} NULLS LAST,b.id ${direction} LIMIT ${sql.bind(limit)}`,sql.values)).rows;
}
async function count(client:PoolClient,projectId:string,filters:SavedKeywordFilters,s:State,ids?:string[]){
  const sql=population(projectId,filters,s,ids);return Number((await client.query(`${sql.text} SELECT count(*)::text AS count FROM filtered`,sql.values)).rows[0].count);
}
async function rowDtos(client:PoolClient,projectId:string,stored:Stored[]):Promise<SavedKeywordRow[]>{
  const tags=await client.query('SELECT a.keyword_id,t.id,t.name,t.color FROM saved_keyword_tag_assignment a JOIN saved_keyword_tag t ON t.project_id=a.project_id AND t.id=a.tag_id WHERE a.project_id=$1 AND a.keyword_id=ANY($2::uuid[]) ORDER BY t.normalized_name,t.id',[projectId,stored.map(row=>row.id)]);
  return stored.map(row=>{const refresh=target(row);return {id:row.id,keyword:row.keyword,locationCode:row.location_code,languageCode:row.language_code,createdAt:row.created_at.toISOString(),updatedAt:row.updated_at.toISOString(),
    tags:tags.rows.filter(tag=>tag.keyword_id===row.id).map(({id,name,color})=>({id,name,color})),
    metrics:{status:row.metrics_status,row:row.metrics_status==='available'?row.metric_data:null,sourceRunId:row.metric_source_run_id,sourceRowIndex:row.metric_source_row,source:row.metric_source,fetchedAt:iso(row.metric_fetched_at),observedAt:iso(row.metric_observed_at)},
    refresh:{eligible:refresh.eligible,reason:refresh.reason,lastAttemptStatus:row.last_attempt_status,lastAttemptAt:iso(row.last_attempt_at)}};});
}
async function tagPage(client:PoolClient,projectId:string,s:State,cursor:string|null=null){
  const anchor=readCursor(cursor,projectId,{tags:true},s,false);
  if(anchor)await assertIds(client,projectId,[anchor],true);
  const tags=(await client.query<SavedKeywordTag>(`SELECT t.id,t.name,t.color,(SELECT count(*)::int FROM saved_keyword_tag_assignment a WHERE a.project_id=t.project_id AND a.tag_id=t.id) AS "assignmentCount"
    FROM saved_keyword_tag t WHERE t.project_id=$1 AND ($2::uuid IS NULL OR (t.normalized_name,t.id)>(SELECT normalized_name,id FROM saved_keyword_tag WHERE project_id=$1 AND id=$2)) ORDER BY t.normalized_name,t.id LIMIT 251`,[projectId,anchor])).rows;
  return {tags:tags.slice(0,250),nextCursor:tags.length>250?cursorFor(tags[249].id,projectId,{tags:true},s):null};
}
export async function listSavedKeywordTags(projectId:unknown,userId:unknown,raw:unknown){
  const input=parse(z.object({cursor:z.string().min(1).max(512).optional()}).strict(),raw);
  return withContentProject(projectId,userId,false,async(client,p)=>{await client.query("SET LOCAL statement_timeout='5s'");const s=await state(client,p.id);return {role:p.role,revision:s.revision,metricRevision:s.metricRevision,...await tagPage(client,p.id,s,input.cursor??null)};}).catch(queryError);
}
export async function listSavedKeywords(projectId:unknown,userId:unknown,raw:unknown){
  const input=parseSavedKeywordList(raw);
  return withContentProject(projectId,userId,false,async(client,p)=>{
    await client.query("SET LOCAL statement_timeout='5s'");const s=await state(client,p.id);await assertIds(client,p.id,input.filters.tagIds,true);
    const anchor=readCursor(input.cursor,p.id,input.filters,s),found=await rows(client,p.id,input.filters,s,input.pageSize+1,anchor),page=found.slice(0,input.pageSize),tags=await tagPage(client,p.id,s);
    return {role:p.role,revision:s.revision,metricRevision:s.metricRevision,filters:input.filters,total:await count(client,p.id,input.filters,s),rows:await rowDtos(client,p.id,page),tags:tags.tags,tagsNextCursor:tags.nextCursor,tagsTruncated:tags.nextCursor!==null,
      nextCursor:found.length>input.pageSize?cursorFor(page.at(-1)!.id,p.id,input.filters,s):null};
  }).catch(queryError);
}

async function revision(client:PoolClient,projectId:string,expected:number){const s=await state(client,projectId);if(s.revision!==expected)conflict('The saved keyword list changed. Reload before applying these changes.');return s;}
async function tagIds(client:PoolClient,projectId:string,tags:SavedTagInput[]){
  if(!tags.length)return [];
  for(const tag of tags)await client.query('INSERT INTO saved_keyword_tag(id,project_id,name,normalized_name) VALUES($1,$2,$3,$4) ON CONFLICT(project_id,normalized_name) DO NOTHING',[randomUUID(),projectId,tag.name,tag.normalizedName]);
  return (await client.query<{id:string}>('SELECT id FROM saved_keyword_tag WHERE project_id=$1 AND normalized_name=ANY($2::text[])',[projectId,tags.map(t=>t.normalizedName)])).rows.map(t=>t.id);
}
async function assignTags(client:PoolClient,projectId:string,keywords:string[],tags:string[],replace=false){
  if(replace)await client.query('DELETE FROM saved_keyword_tag_assignment WHERE project_id=$1 AND keyword_id=ANY($2::uuid[])',[projectId,keywords]);
  if(tags.length)await client.query('INSERT INTO saved_keyword_tag_assignment(project_id,keyword_id,tag_id) SELECT $1,k,t FROM unnest($2::uuid[]) k CROSS JOIN unnest($3::uuid[]) t ON CONFLICT DO NOTHING',[projectId,keywords,tags]);
}
async function mutation(client:PoolClient,p:ContentProject,result:ReceiptResult,replayed:boolean):Promise<SavedKeywordMutation>{
  const s=await state(client,p.id),present=(await client.query<{id:string}>('SELECT id FROM saved_keyword WHERE project_id=$1 AND id=ANY($2::uuid[])',[p.id,result.ids])).rows.map(r=>r.id);
  const response:SavedKeywordMutation={role:p.role,revision:s.revision,metricRevision:s.metricRevision,replayed,ids:result.ids,missingIds:result.ids.filter(value=>!present.includes(value)),inserted:result.inserted??0,existing:result.existing??0,skippedOlder:result.skippedOlder??0,metricsUpdated:result.metricsUpdated??0,affected:result.affected??0};
  if(result.tagId){response.tagId=result.tagId;const tag=(await client.query<SavedKeywordTag>('SELECT t.id,t.name,t.color,(SELECT count(*)::int FROM saved_keyword_tag_assignment a WHERE a.project_id=t.project_id AND a.tag_id=t.id) AS "assignmentCount" FROM saved_keyword_tag t WHERE t.project_id=$1 AND t.id=$2',[p.id,result.tagId])).rows[0];if(tag)response.tag=tag;}
  return response;
}
type Observation={runId:string;rowIndex:number;row:KeywordRow;source:string;fetchedAt:string;observedAt:string};
function observationMap(result:KeywordResult){
  const found=new Map<string,{row:KeywordRow;index:number;hash:string}>(),ambiguous=new Set<string>();
  if(!result||!Array.isArray(result.rows)||result.rows.length>100)conflict('This source result cannot be used for saved metrics.');
  result.rows.forEach((row,index)=>{const keyword=normalizeSavedKeyword(row.keyword),hash=canonicalHash({...row,keyword});const old=found.get(keyword);if(old&&old.hash!==hash)ambiguous.add(keyword);else if(!old)found.set(keyword,{row,index,hash});});
  return {found,ambiguous};
}
async function applyObservation(client:PoolClient,projectId:string,keywordId:string,observation:Observation,selectedVersion:string){
  const changed=await client.query(`UPDATE saved_keyword SET metric_data=$3,metric_source_run_id=$4,metric_source_row=$5,metric_source=$6,metric_fetched_at=$7,metric_observed_at=$8,
    metric_expired_at=NULL,metric_version=$9 WHERE project_id=$1 AND id=$2 AND (metric_observed_at IS NULL OR metric_observed_at<=$8::timestamptz) AND (metric_expired_at IS NULL OR metric_observed_at<$8::timestamptz) AND metric_version<=$9::bigint AND last_attempt_version<=$9::bigint`,
    [projectId,keywordId,JSON.stringify(observation.row),observation.runId,observation.rowIndex,observation.source,observation.fetchedAt,observation.observedAt,selectedVersion]);return !!changed.rowCount;
}
export async function saveSavedKeywords(projectId:unknown,userId:unknown,raw:unknown){
  const input=parseSavedKeywordSave(raw),uid=id(userId);
  return withContentProject(projectId,uid,true,async(client,p)=>{
    const receipt=await contentReceipt(client,p.id,input.requestId,'saved-keywords.save',{userId:uid,...input});if(receipt.replayed)return mutation(client,p,receipt.result,true);
    const s=await revision(client,p.id,input.revision);let keywords:string[],locationCode:number,languageCode:string,observations=new Map<string,Observation>();
    if(input.source.type==='manual'){({keywords,locationCode,languageCode}=input.source);}
    else{
      const source=(await client.query(`SELECT r.status,r.result,r.result_purged_at,r.completed_at::text AS observed_at,r.completed_at>=$3::timestamptz AS retained,q.request
        FROM keyword_research_run r JOIN keyword_quote q ON q.id=r.quote_id AND q.project_id=r.project_id WHERE r.project_id=$1 AND r.id=$2`,[p.id,input.source.runId,s.cutoff])).rows[0];
      if(!source)unavailable();if(source.status!=='completed'||!source.result||source.result_purged_at||!source.retained)conflict('The source metrics are unavailable or expired. Save the keywords manually instead.');
      const result=source.result as KeywordResult;({locationCode,languageCode}=source.request);const mapping=observationMap(result);keywords=[];
      for(const index of input.source.rowIndexes){const row=result.rows[index];if(!row)throw new FoundationError(400,'Choose existing source result rows.');const keyword=normalizeSavedKeyword(row.keyword);
        if(mapping.ambiguous.has(keyword))conflict('The source has conflicting metrics for a normalized keyword. Resolve the source before saving.');
        if(!observations.has(keyword)){keywords.push(keyword);observations.set(keyword,{runId:input.source.runId,rowIndex:index,row,source:result.source,fetchedAt:result.retrievedAt,observedAt:source.observed_at});}}
    }
    const inserted=await client.query(`INSERT INTO saved_keyword(id,project_id,keyword,location_code,language_code) SELECT gen_random_uuid(),$1,k,$3,$4 FROM unnest($2::text[]) k ON CONFLICT(project_id,keyword,location_code,language_code) DO NOTHING RETURNING id`,[p.id,keywords,locationCode,languageCode]);
    const selected=(await client.query<Stored>('SELECT * FROM saved_keyword WHERE project_id=$1 AND keyword=ANY($2::text[]) AND location_code=$3 AND language_code=$4',[p.id,keywords,locationCode,languageCode])).rows;
    const ids=selected.map(row=>row.id);await assignTags(client,p.id,ids,await tagIds(client,p.id,input.tags),input.tagMode==='replace');
    let metricsUpdated=0,skippedOlder=0;
    if(observations.size){const v=await version(client);for(const row of selected){if(await applyObservation(client,p.id,row.id,observations.get(row.keyword)!,v))metricsUpdated++;else skippedOlder++;}if(metricsUpdated)await bump(client,p.id);}
    await client.query('UPDATE saved_keyword SET updated_at=clock_timestamp() WHERE project_id=$1 AND id=ANY($2::uuid[])',[p.id,ids]);await bump(client,p.id,true);
    const result={ids,inserted:inserted.rowCount??0,existing:ids.length-(inserted.rowCount??0),metricsUpdated,skippedOlder,affected:ids.length};await receipt.save(result);return mutation(client,p,result,false);
  });
}
export async function changeSavedKeywordTags(projectId:unknown,userId:unknown,raw:unknown){
  const input=parseSavedKeywordTagChange(raw),uid=id(userId);
  return withContentProject(projectId,uid,true,async(client,p)=>{const receipt=await contentReceipt(client,p.id,input.requestId,'saved-keywords.tags',{userId:uid,...input});if(receipt.replayed)return mutation(client,p,receipt.result,true);
    await revision(client,p.id,input.revision);await assertIds(client,p.id,input.keywordIds);
    if(input.operation==='add'||input.operation==='replace')await assignTags(client,p.id,input.keywordIds,await tagIds(client,p.id,input.tags),input.operation==='replace');
    else if(input.operation==='clear')await assignTags(client,p.id,input.keywordIds,[],true);
    else if(input.operation==='remove'){await assertIds(client,p.id,input.tagIds,true);await client.query('DELETE FROM saved_keyword_tag_assignment WHERE project_id=$1 AND keyword_id=ANY($2::uuid[]) AND tag_id=ANY($3::uuid[])',[p.id,input.keywordIds,input.tagIds]);}
    await client.query('UPDATE saved_keyword SET updated_at=clock_timestamp() WHERE project_id=$1 AND id=ANY($2::uuid[])',[p.id,input.keywordIds]);await bump(client,p.id,true);
    const result={ids:input.keywordIds,affected:input.keywordIds.length};await receipt.save(result);return mutation(client,p,result,false);});
}
export async function removeSavedKeywords(projectId:unknown,userId:unknown,raw:unknown){
  const input=parseSavedKeywordRemove(raw),uid=id(userId);
  return withContentProject(projectId,uid,true,async(client,p)=>{const receipt=await contentReceipt(client,p.id,input.requestId,'saved-keywords.remove',{userId:uid,...input});if(receipt.replayed)return mutation(client,p,receipt.result,true);
    await revision(client,p.id,input.revision);await assertIds(client,p.id,input.keywordIds);await client.query('DELETE FROM saved_keyword WHERE project_id=$1 AND id=ANY($2::uuid[])',[p.id,input.keywordIds]);await bump(client,p.id,true);
    const result={ids:input.keywordIds,affected:input.keywordIds.length};await receipt.save(result);return mutation(client,p,result,false);});
}
export async function updateSavedKeywordTag(projectId:unknown,userId:unknown,tagId:unknown,raw:unknown){
  const input=parseSavedTagUpdate(raw),uid=id(userId),tid=id(tagId);
  return withContentProject(projectId,uid,true,async(client,p)=>{const receipt=await contentReceipt(client,p.id,input.requestId,'saved-keywords.tag.update:'+tid,{userId:uid,...input});if(receipt.replayed)return mutation(client,p,receipt.result,true);
    await revision(client,p.id,input.revision);await assertIds(client,p.id,[tid],true);
    if(input.name&&(await client.query('SELECT 1 FROM saved_keyword_tag WHERE project_id=$1 AND normalized_name=$2 AND id<>$3',[p.id,input.name.normalizedName,tid])).rowCount)conflict('A tag with that normalized name already exists. Tags are not merged automatically.');
    if(input.name)await client.query('UPDATE saved_keyword_tag SET name=$3,normalized_name=$4 WHERE project_id=$1 AND id=$2',[p.id,tid,input.name.name,input.name.normalizedName]);
    if('color'in input)await client.query('UPDATE saved_keyword_tag SET color=$3 WHERE project_id=$1 AND id=$2',[p.id,tid,input.color]);await bump(client,p.id,true);
    const result={ids:[],tagId:tid,affected:1};await receipt.save(result);return mutation(client,p,result,false);});
}
export async function deleteSavedKeywordTag(projectId:unknown,userId:unknown,tagId:unknown,raw:unknown){
  const input=parseSavedTagDelete(raw),uid=id(userId),tid=id(tagId);
  return withContentProject(projectId,uid,true,async(client,p)=>{const receipt=await contentReceipt(client,p.id,input.requestId,'saved-keywords.tag.delete:'+tid,{userId:uid,...input});if(receipt.replayed)return mutation(client,p,receipt.result,true);
    await revision(client,p.id,input.revision);await assertIds(client,p.id,[tid],true);const assigned=Number((await client.query('SELECT count(*)::text AS count FROM saved_keyword_tag_assignment WHERE project_id=$1 AND tag_id=$2',[p.id,tid])).rows[0].count);
    if(assigned)conflict(`This tag is assigned to ${assigned} saved keywords. Remove those assignments before deleting it.`);
    await client.query('DELETE FROM saved_keyword_tag WHERE project_id=$1 AND id=$2',[p.id,tid]);await bump(client,p.id,true);const result={ids:[],tagId:tid,affected:1};await receipt.save(result);return mutation(client,p,result,false);});
}

export async function exportSavedKeywords(projectId:unknown,userId:unknown,raw:unknown,signal?:AbortSignal){
  const input=parseSavedKeywordExport(raw),started=Date.now();
  function check(){if(signal?.aborted)throw new FoundationError(499,'Export cancelled.');if(Date.now()-started>30_000)throw new FoundationError(503,'Export took too long. Narrow the filters and try again.');}
  return withContentProject(projectId,userId,false,async(client,p)=>{
    check();await client.query("SET LOCAL statement_timeout='5s'");const s=await state(client,p.id),filters=input.selection.type==='filtered'?input.selection.filters:parseSavedKeywordFilters({}),ids=input.selection.type==='ids'?input.selection.keywordIds:undefined;
    if(ids)await assertIds(client,p.id,ids);await assertIds(client,p.id,filters.tagIds,true);const total=await count(client,p.id,filters,s,ids);if(total>10000)throw new FoundationError(413,'Export exceeds 10,000 rows. Narrow the filters.');
    const lines:string[]=[];let bytes=0;
    function line(cells:unknown[]){const tsv=(value:unknown)=>{let text=String(value??'');if(/^[\s\uFEFF]*[=+@-]/u.test(text)||/^[\t\r\n]/.test(text))text="'"+text;return text.replace(/[\t\r\n]/g,' ');};
      const text=cells.map(input.format==='csv'?csvCell:tsv).join(input.format==='csv'?',':'\t')+'\n';bytes+=Buffer.byteLength(text);if(bytes>16*1024*1024)throw new FoundationError(413,'Export exceeds 16 MiB. Narrow the filters.');lines.push(text);}
    line(['Keyword','Location code','Language','Search volume','CPC USD','Competition','Competition level','Keyword difficulty','Intent','Monthly searches','Tags','Provider keyword','Source','Source run','Source row','Fetched at','Observed at','Metrics updated at','Intent updated at','Data status']);
    let after:string|null=null,exported=0;
    while(exported<total){check();const page=await rows(client,p.id,filters,s,250,after,ids);if(!page.length)throw new Error('Export population changed inside its snapshot.');
      for(const row of await rowDtos(client,p.id,page)){const metric=row.metrics.row;line([row.keyword,row.locationCode,row.languageCode,metric?.searchVolume??'',metric?.cpcUsd??'',metric?.competition??'',metric?.competitionLevel??'',metric?.keywordDifficulty??'',metric?.intent??'',metric?JSON.stringify(metric.monthlySearches):'',JSON.stringify(row.tags.map(t=>t.name)),metric?.keyword??'',row.metrics.source??'',row.metrics.sourceRunId??'',row.metrics.sourceRowIndex??'',row.metrics.fetchedAt??'',row.metrics.observedAt??'',metric?.metricsUpdatedAt??'',metric?.intentUpdatedAt??'',row.metrics.status]);}
      exported+=page.length;after=page.at(-1)!.id;
    }
    check();return {role:p.role,revision:s.revision,metricRevision:s.metricRevision,format:input.format,filename:'saved-keywords.'+input.format,contentType:input.format==='csv'?'text/csv; charset=utf-8':'text/tab-separated-values; charset=utf-8',body:lines.join(''),rowCount:exported};
  }).catch(queryError);
}

// Refresh helpers require the caller's existing workspace -> project gate.
export async function resolveSavedRefreshTargets(client:PoolClient,projectId:string,selection:SavedKeywordSelection){
  await client.query("SET LOCAL statement_timeout='5s'");
  const s=await state(client,projectId),filters=selection.type==='filtered'?selection.filters:parseSavedKeywordFilters({}),ids=selection.type==='ids'?selection.keywordIds:undefined;
  if(ids)await assertIds(client,projectId,ids);await assertIds(client,projectId,filters.tagIds,true);const found=await rows(client,projectId,filters,s,2001,null,ids);
  if(found.length>2000)throw new FoundationError(413,'A refresh approval supports at most 2,000 keywords. Narrow the selection.');
  if(!found.length)throw new FoundationError(400,'Choose at least one saved keyword.');
  return {revision:s.revision,metricRevision:s.metricRevision,targets:found.map(target)};
}
export async function assertSavedRefreshTargets(client:PoolClient,projectId:string,targets:SavedKeywordTarget[]){
  const stored=(await client.query<Stored>('SELECT id,keyword,location_code,language_code FROM saved_keyword WHERE project_id=$1 AND id=ANY($2::uuid[])',[projectId,targets.map(t=>t.id)])).rows;
  if(stored.length!==targets.length||targets.some(t=>!stored.some(row=>row.id===t.id&&row.keyword===t.keyword&&row.location_code===t.locationCode&&row.language_code===t.languageCode)))conflict('Saved keywords changed or were removed. Prepare a new refresh approval.');
}
export async function markSavedRefreshAttempt(client:PoolClient,projectId:string,targets:SavedKeywordTarget[],selectedVersion:string,status:string,at:Date){
  const changed=await client.query(`UPDATE saved_keyword k SET last_attempt_version=$3,last_attempt_status=$4,last_attempt_at=$5
    FROM jsonb_to_recordset($2::jsonb) t(id uuid,keyword text,"locationCode" integer,"languageCode" text)
    WHERE k.project_id=$1 AND k.id=t.id AND k.keyword=t.keyword AND k.location_code=t."locationCode" AND k.language_code=t."languageCode"
      AND k.last_attempt_version<=$3::bigint AND (k.last_attempt_version<$3::bigint OR k.last_attempt_status IS DISTINCT FROM $4)`,[projectId,JSON.stringify(targets),selectedVersion,status,at]);
  if(changed.rowCount)await bump(client,projectId);return changed.rowCount??0;
}
export async function publishSavedKeywordMetrics(client:PoolClient,projectId:string,targets:SavedKeywordTarget[],input:{runId:string;version:string;observedAt:Date;result:KeywordResult|null;status:string}){
  const run=(await client.query(`SELECT r.result,r.completed_at::text AS observed_at,r.result_purged_at,r.status,m.role
    FROM keyword_research_run r LEFT JOIN membership m ON m.workspace_id=r.workspace_id AND m.user_id=r.user_id WHERE r.project_id=$1 AND r.id=$2`,[projectId,input.runId])).rows[0];
  const s=await state(client,projectId);let updated=0,missing=0,skipped=0,expired=0;
  const canPublish=run&&['owner','admin','editor'].includes(run.role)&&run.status==='completed'&&run.result&&!run.result_purged_at;
  let mapping:ReturnType<typeof observationMap>|null=null;
  if(canPublish){try{mapping=observationMap(run.result);}catch{mapping=null;}}
  const retained=run?.observed_at&&(await client.query('SELECT $1::timestamptz>=$2::timestamptz AS retained',[run.observed_at,s.cutoff])).rows[0].retained;
  for(const selected of targets){
    const row=(await client.query<Stored>('SELECT * FROM saved_keyword WHERE project_id=$1 AND id=$2 AND keyword=$3 AND location_code=$4 AND language_code=$5',[projectId,selected.id,selected.keyword,selected.locationCode,selected.languageCode])).rows[0];
    if(!row){skipped++;continue;}let status=input.status;
    if(!canPublish||!mapping){if(input.status==='completed')status='skipped';skipped++;}
    else if(!retained){status='skipped';expired++;}
    else if(mapping.ambiguous.has(selected.keyword)){status='skipped';skipped++;}
    else{const value=mapping.found.get(selected.keyword);if(!value){status='missing';missing++;}
      else if(await applyObservation(client,projectId,selected.id,{runId:input.runId,rowIndex:value.index,row:value.row,source:run.result.source,fetchedAt:run.result.retrievedAt,observedAt:run.observed_at},input.version)){updated++;status='completed';}
      else{status='skipped';skipped++;}}
    await markSavedRefreshAttempt(client,projectId,[selected],input.version,status,input.observedAt);
  }
  if(updated)await bump(client,projectId);return {updated,missing,skipped,expired};
}
