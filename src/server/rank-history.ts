import {toUSVString} from 'node:util';
import type {PoolClient} from 'pg';
import {z} from 'zod';
import {FoundationError} from './auth.ts';
import {canonicalHash,parse} from './context-input.ts';
import {readContentCursor} from './project-context.ts';
import {withKeywordProject} from './keyword-research.ts';
import {microUsd} from './keyword-research-input.ts';

const readers=['owner','admin','editor','viewer'];
const devices=['desktop','mobile'] as const;
type Device=typeof devices[number];
export type RankHistoryTarget={domain:string;locationCode:number;languageCode:string;depth:number;maxCrawlPages:number};
export type RankHistoryObservation={
  taskId:string;runId:string;device:Device;status:string;runStatus:string;isSubset:boolean;compatible:boolean;
  target:RankHistoryTarget;attemptedAt:string;observedAt:string|null;retrievedAt:string|null;
  position:number|null;rankBasis:'organic'|'absolute'|null;absolutePosition:number|null;rankingUrl:string|null;
  serpFeatures:string[]|null;checkedDepth:number|null;returnedItemCount:number|null;
  rawExpiredAt:string|null;dataExpiredAt:string|null;diagnostic:string|null;
};
export type RankRunSummary={id:string;status:string;trigger:string;method:string;isSubset:boolean;taskCount:number;
  createdAt:string;startedAt:string|null;completedAt:string|null;quoteExpired:boolean;rawExpiredAt:string|null;dataExpiredAt:string|null;
  costStatus:'not_started'|'pending'|'uncertain'|'final';estimateUsd:string;knownChargeUsd:string;diagnostic:string|null};
export type RankBaseline={days:1|7|30|90;targetAt:string;source:'at_or_before'|'earliest_available'|'unavailable';
  observation:RankHistoryObservation|null;change:number|null};
export type RankLatestRow={keywordId:string;keyword:string;matchCase:boolean;pinnedAt:string|null;device:Device;
  latestAttempt:RankHistoryObservation|null;latestObservation:RankHistoryObservation|null;
  observationStatus:'available'|'expired'|'not_checked'|'unavailable'|'incompatible';baselines:RankBaseline[]};
function fields(params:URLSearchParams,allowed:string[]){const out:Record<string,string>={};for(const [key,value] of params){if(!allowed.includes(key)||Object.hasOwn(out,key))throw new FoundationError(400,'Check the rank history filters and page.');out[key]=value;}return out;}
const page=z.string().max(512).optional();
const deviceInput=z.enum(['desktop','mobile','both']).default('both');
const iso=(value:Date|null)=>value?.toISOString()??null;
const sqlTime=(column:string)=>`to_char((${column}) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
function cursor(rows:any[],scope:unknown){const last=rows[49];return rows.length>50?Buffer.from(JSON.stringify({scope:canonicalHash(scope),at:last.cursor_at,id:last.id})).toString('base64url'):null;}
async function tracker(client:PoolClient,projectId:string,id:string){const row=(await client.query('SELECT * FROM rank_config WHERE project_id=$1 AND id=$2',[projectId,id])).rows[0];if(!row)throw new FoundationError(404,'Rank tracker not found or unavailable.');return row;}
function target(row:any):RankHistoryTarget{return {domain:row.target_domain,locationCode:row.location_code,languageCode:row.language_code,depth:row.serp_depth,maxCrawlPages:row.max_crawl_pages};}
// Every predicate also binds project/config/UUID. Mutable names and pins never alter compatibility.
const compatible=`r.request->'target'=$4::jsonb AND t.keyword=k.keyword AND t.match_case=k.match_case`;
const taskColumns=`t.id AS "taskId",r.id AS "runId",t.device,t.result_status AS status,r.status AS "runStatus",r.is_subset AS "isSubset",
  (${compatible}) AS compatible,r.request->'target' AS target,${sqlTime('COALESCE(r.started_at,r.created_at)')} AS "attemptedAt",
  ${sqlTime('t.observed_at')} AS "observedAt",${sqlTime('t.retrieved_at')} AS "retrievedAt",
  CASE WHEN t.data_expired_at IS NULL AND r.data_expired_at IS NULL THEN t.position END AS position,
  CASE WHEN t.data_expired_at IS NULL AND r.data_expired_at IS NULL THEN t.rank_basis END AS "rankBasis",
  CASE WHEN t.data_expired_at IS NULL AND r.data_expired_at IS NULL THEN t.absolute_position END AS "absolutePosition",
  CASE WHEN t.data_expired_at IS NULL AND r.data_expired_at IS NULL THEN t.ranking_url END AS "rankingUrl",
  CASE WHEN t.data_expired_at IS NULL AND r.data_expired_at IS NULL THEN t.serp_features END AS "serpFeatures",
  CASE WHEN t.data_expired_at IS NULL AND r.data_expired_at IS NULL THEN t.checked_depth END AS "checkedDepth",
  CASE WHEN t.data_expired_at IS NULL AND r.data_expired_at IS NULL THEN t.returned_item_count END AS "returnedItemCount",
  ${sqlTime('COALESCE(t.raw_expired_at,r.raw_expired_at)')} AS "rawExpiredAt",${sqlTime('COALESCE(t.data_expired_at,r.data_expired_at)')} AS "dataExpiredAt",t.diagnostic`;

export async function listRankRuns(projectId:string,userId:string,trackerId:string,params=new URLSearchParams()){
  trackerId=parse(z.uuid(),trackerId);const input=parse(z.object({cursor:page}).strict(),fields(params,['cursor']));
  return withKeywordProject(projectId,userId,readers,async(client,_wid,role)=>{
    await tracker(client,projectId,trackerId);const scope={projectId,trackerId,list:'rank-runs'},after=readContentCursor(input.cursor??null,scope);
    const rows=(await client.query(`SELECT r.id,r.status,r.trigger,r.method,r.is_subset,r.task_count,r.created_at,r.started_at,r.completed_at,r.expires_at,r.raw_expired_at,r.data_expired_at,r.diagnostic,r.estimate_micros,
      ${sqlTime('r.created_at')} AS cursor_at,c.* FROM rank_run r LEFT JOIN LATERAL (
      SELECT count(*)::int AS charge_count,bool_or(p.status='uncertain' OR d.phase='uncertain') AS uncertain,bool_or(p.status IN ('reserved','dispatched')) AS pending,
      COALESCE(sum(p.actual_micros) FILTER(WHERE p.status='settled'),0)::text AS known_micros FROM rank_dispatch d JOIN provider_request p ON p.id=d.id AND p.workspace_id=d.workspace_id WHERE d.run_id=r.id) c ON true
      WHERE r.project_id=$1 AND r.config_id=$2 AND ($3::timestamptz IS NULL OR (r.created_at,r.id)<($3::timestamptz,$4::uuid))
      ORDER BY r.created_at DESC,r.id DESC LIMIT 51`,[projectId,trackerId,after?.at??null,after?.id??null])).rows;
    const runs:RankRunSummary[]=rows.slice(0,50).map(r=>({id:r.id,status:r.status,trigger:r.trigger,method:r.method,isSubset:r.is_subset,taskCount:r.task_count,
      createdAt:iso(r.created_at)!,startedAt:iso(r.started_at),completedAt:iso(r.completed_at),quoteExpired:r.status==='quoted'&&r.expires_at.getTime()<=Date.now(),
      rawExpiredAt:iso(r.raw_expired_at),dataExpiredAt:iso(r.data_expired_at),diagnostic:r.diagnostic,estimateUsd:microUsd(BigInt(r.estimate_micros)),knownChargeUsd:microUsd(BigInt(r.known_micros)),
      costStatus:r.uncertain?'uncertain':r.pending?'pending':r.charge_count?'final':'not_started'}));
    return {role,trackerId,runs,nextCursor:cursor(rows,scope)};
  });
}

export async function getLatestRankResults(projectId:string,userId:string,trackerId:string,params=new URLSearchParams()){
  trackerId=parse(z.uuid(),trackerId);
  const input=parse(z.object({cursor:page,device:deviceInput,search:z.string().max(200).refine(s=>!s.includes('\0')&&toUSVString(s)===s).default(''),pinned:z.enum(['true','false']).optional()}).strict(),fields(params,['cursor','device','search','pinned']));
  return withKeywordProject(projectId,userId,readers,async(client,_wid,role)=>{
    await client.query("SET LOCAL statement_timeout='5s'");
    const config=await tracker(client,projectId,trackerId),currentTarget=target(config),scope={projectId,trackerId,list:'rank-latest',device:input.device,search:input.search,pinned:input.pinned??null,target:currentTarget},after=readContentCursor(input.cursor??null,scope);
    const keywords=(await client.query(`SELECT id,keyword,match_case,pinned_at,${sqlTime('created_at')} AS cursor_at FROM rank_keyword WHERE project_id=$1 AND config_id=$2
      AND strpos(keyword,$3)>0 AND ($4::boolean IS NULL OR (pinned_at IS NOT NULL)=$4::boolean)
      AND ($5::timestamptz IS NULL OR (created_at,id)<($5::timestamptz,$6::uuid)) ORDER BY created_at DESC,id DESC LIMIT 51`,[projectId,trackerId,input.search,input.pinned??null,after?.at??null,after?.id??null])).rows;
    const asOf=(await client.query('SELECT clock_timestamp() AS now')).rows[0].now as Date;
    const pairs=input.device==='both'?[...devices]:[input.device];
    // ponytail: scan lightweight history for at most50 keyword IDs under a5s bound;
    // add indexed summary storage only if larger retained histories justify it.
    // Select lightweight IDs once; projecting the large captured request on every
    // history probe repeatedly decompresses its full task plan. Only retained run
    // definitions and the bounded selected observations need that projection.
    const picks=keywords.length?(await client.query(`WITH candidates AS MATERIALIZED (
      SELECT t.id,t.run_id,t.keyword_id,t.keyword,t.match_case,t.device,t.result_status,t.observed_at,t.data_expired_at
      FROM rank_task t WHERE t.project_id=$1 AND t.keyword_id=ANY($3::uuid[]) AND t.device=ANY($5::text[])
    ), runs AS MATERIALIZED (
      SELECT r.id,COALESCE(r.started_at,r.created_at) AS attempted_at,r.data_expired_at,
        CASE WHEN r.data_expired_at IS NULL AND c.has_observation THEN r.request->'target'=$4::jsonb ELSE false END AS target_matches
      FROM rank_run r JOIN (SELECT run_id,bool_or(result_status IN ('ranked','not_found') AND observed_at IS NOT NULL AND data_expired_at IS NULL) AS has_observation FROM candidates GROUP BY run_id) c ON c.run_id=r.id
      WHERE r.project_id=$1 AND r.config_id=$2
    ), scoped AS (
      SELECT t.id,t.keyword_id,t.device,t.observed_at,r.attempted_at,
        (r.target_matches AND r.data_expired_at IS NULL AND t.data_expired_at IS NULL AND t.result_status IN ('ranked','not_found') AND t.observed_at IS NOT NULL AND t.keyword=k.keyword AND t.match_case=k.match_case) AS eligible
      FROM candidates t JOIN runs r ON r.id=t.run_id JOIN rank_keyword k ON k.id=t.keyword_id AND k.project_id=$1 AND k.config_id=$2
    ) SELECT keyword_id,device,
      (array_agg(id ORDER BY attempted_at DESC,id DESC))[1] AS attempt,
      (array_agg(id ORDER BY observed_at DESC,id DESC) FILTER(WHERE eligible))[1] AS observation,
      (array_agg(id ORDER BY observed_at,id) FILTER(WHERE eligible))[1] AS earliest,
      (array_agg(id ORDER BY observed_at DESC,id DESC) FILTER(WHERE eligible AND observed_at<=$6::timestamptz-interval '24 hours'))[1] AS day1,
      (array_agg(id ORDER BY observed_at DESC,id DESC) FILTER(WHERE eligible AND observed_at<=$6::timestamptz-interval '168 hours'))[1] AS day7,
      (array_agg(id ORDER BY observed_at DESC,id DESC) FILTER(WHERE eligible AND observed_at<=$6::timestamptz-interval '720 hours'))[1] AS day30,
      (array_agg(id ORDER BY observed_at DESC,id DESC) FILTER(WHERE eligible AND observed_at<=$6::timestamptz-interval '2160 hours'))[1] AS day90
      FROM scoped GROUP BY keyword_id,device`,[projectId,trackerId,keywords.slice(0,50).map(k=>k.id),JSON.stringify(currentTarget),pairs,asOf])).rows:[];
    const selected=[...new Set(picks.flatMap(r=>[r.attempt,r.observation,r.earliest,r.day1,r.day7,r.day30,r.day90]).filter(Boolean))];
    const observations:RankHistoryObservation[]=selected.length?(await client.query(`SELECT ${taskColumns} FROM rank_task t JOIN rank_run r ON r.id=t.run_id AND r.project_id=t.project_id
      JOIN rank_keyword k ON k.id=t.keyword_id AND k.project_id=$1 AND k.config_id=$2
      WHERE t.project_id=$1 AND r.config_id=$2 AND t.id=ANY($3::uuid[])`,[projectId,trackerId,selected,JSON.stringify(currentTarget)])).rows:[];
    const byTask=new Map(observations.map(r=>[r.taskId,r])),byPair=new Map(picks.map(r=>[r.keyword_id+':'+r.device,r]));
    const results:RankLatestRow[]=keywords.slice(0,50).flatMap(k=>pairs.map(device=>{
      const picked=byPair.get(k.id+':'+device),latest=byTask.get(picked?.observation)??null,attempt=byTask.get(picked?.attempt)??null;
      return {keywordId:k.id,keyword:k.keyword,matchCase:k.match_case,pinnedAt:iso(k.pinned_at),device,latestAttempt:attempt,latestObservation:latest,
        observationStatus:latest?'available':!attempt?'not_checked':!attempt.compatible?'incompatible':attempt.dataExpiredAt?'expired':'unavailable',
        baselines:([1,7,30,90] as const).map(days=>{const id=picked?.['day'+days],observation=byTask.get(id??picked?.earliest)??null;return {days,targetAt:new Date(asOf.getTime()-days*86400000).toISOString(),source:id?'at_or_before':observation?'earliest_available':'unavailable',observation,
          change:latest?.status==='ranked'&&observation?.status==='ranked'&&latest.rankBasis===observation.rankBasis&&latest.taskId!==observation.taskId?observation.position!-latest.position!:null};})};
    }));
    return {role,trackerId,target:currentTarget,enabledDevices:config.devices,asOf:asOf.toISOString(),rows:results,nextCursor:cursor(keywords,scope)};
  });
}

export async function getRankKeywordHistory(projectId:string,userId:string,trackerId:string,keywordId:string,params=new URLSearchParams()){
  trackerId=parse(z.uuid(),trackerId);keywordId=parse(z.uuid(),keywordId);
  const input=parse(z.object({cursor:page,device:deviceInput}).strict(),fields(params,['cursor','device']));
  return withKeywordProject(projectId,userId,readers,async(client,_wid,role)=>{
    await client.query("SET LOCAL statement_timeout='5s'");const config=await tracker(client,projectId,trackerId),currentTarget=target(config);
    let keyword=(await client.query('SELECT keyword,match_case FROM rank_keyword WHERE project_id=$1 AND config_id=$2 AND id=$3',[projectId,trackerId,keywordId])).rows[0];const removed=!keyword;
    if(!keyword)keyword=(await client.query(`SELECT t.keyword,t.match_case FROM rank_task t JOIN rank_run r ON r.id=t.run_id AND r.project_id=t.project_id WHERE t.project_id=$1 AND r.config_id=$2 AND t.keyword_id=$3 ORDER BY COALESCE(r.started_at,r.created_at) DESC,t.id DESC LIMIT 1`,[projectId,trackerId,keywordId])).rows[0];
    if(!keyword)throw new FoundationError(404,'Tracked keyword history not found or unavailable.');
    const scope={projectId,trackerId,keywordId,list:'rank-keyword-history',device:input.device,target:currentTarget},after=readContentCursor(input.cursor??null,scope);
    const rows=(await client.query(`SELECT ${taskColumns},t.id,${sqlTime('COALESCE(r.started_at,r.created_at)')} AS cursor_at FROM rank_task t JOIN rank_run r ON r.id=t.run_id AND r.project_id=t.project_id
      CROSS JOIN (SELECT $8::text AS keyword,$9::boolean AS match_case) k WHERE t.project_id=$1 AND r.config_id=$2 AND t.keyword_id=$3 AND ($5='both' OR t.device=$5)
      AND ($6::timestamptz IS NULL OR (COALESCE(r.started_at,r.created_at),t.id)<($6::timestamptz,$7::uuid)) ORDER BY COALESCE(r.started_at,r.created_at) DESC,t.id DESC LIMIT 51`,[projectId,trackerId,keywordId,JSON.stringify(currentTarget),input.device,after?.at??null,after?.id??null,keyword.keyword,keyword.match_case])).rows;
    const observations:RankHistoryObservation[]=rows.slice(0,50).map(({id,cursor_at,...r})=>r as RankHistoryObservation);
    return {role,trackerId,keyword:{id:keywordId,keyword:keyword.keyword,matchCase:keyword.match_case,removed},target:currentTarget,observations,nextCursor:cursor(rows,scope)};
  });
}
