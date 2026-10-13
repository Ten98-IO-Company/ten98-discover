import {toUSVString} from 'node:util';
import type {PoolClient} from 'pg';
import {z} from 'zod';
import {FoundationError} from './auth.ts';
import {canonicalHash,parse} from './context-input.ts';
import {csvCell} from './explorer-input.ts';
import {readContentCursor,withContentProject} from './project-context.ts';
import {readRankPlan,type RankPlanTask} from './rank-execution-plan.ts';
import type {RankHistoryTarget} from './rank-history.ts';

type Device='desktop'|'mobile';
type Outcome='pending'|'ranked'|'not_found'|'failed'|'uncertain'|'cancelled'|'unavailable';
type Filters={device:Device;search:string;pinned?:'true'|'false';runLimit:number};
export type RankMatrixColumn={runId:string;status:string;trigger:string;method:string;startedAt:string;completedAt:string|null;scheduledFor:string|null;target:RankHistoryTarget;compatible:boolean;rawExpiredAt:string|null;dataExpiredAt:string|null};
export type RankMatrixCell={runId:string;taskId:string|null;state:Outcome|'not_in_run'|'expired'|'incompatible';resultStatus:Outcome|null;
  position:number|null;rankBasis:'organic'|'absolute'|null;absolutePosition:number|null;rankingUrl:string|null;
  checkedDepth:number|null;returnedItemCount:number|null;observedAt:string|null;retrievedAt:string|null;
  rawExpiredAt:string|null;dataExpiredAt:string|null;change:number|null};
export type RankMatrixRow={keywordId:string;keyword:string;matchCase:boolean;pinnedAt:string|null;cells:RankMatrixCell[]};
export type RankMatrix={role:string;trackerId:string;source:{provider:'dataforseo';engine:'google';report:'organic_search'};target:RankHistoryTarget;
  enabledDevices:Device[];asOf:string;filters:Filters;keywordCount:number;columns:RankMatrixColumn[];rows:RankMatrixRow[];nextCursor:string|null};
const filterShape={device:z.enum(['desktop','mobile']),search:z.string().max(200).refine(s=>!s.includes('\0')&&toUSVString(s)===s).default(''),pinned:z.enum(['true','false']).optional(),runLimit:z.number().int().min(1).max(26).default(12)};
const time=(column:string)=>`to_char((${column}) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
function query(params:URLSearchParams){const input:Record<string,unknown>={};for(const [key,value]of params){if(!['device','search','pinned','runLimit','cursor'].includes(key)||Object.hasOwn(input,key))throw new FoundationError(400,'Check the rank matrix filters.');input[key]=value;}
  if('runLimit'in input){if(typeof input.runLimit!=='string'||!/^[1-9]\d?(?![\s\S])/.test(input.runLimit))throw new FoundationError(400,'Check the number of recent checks.');input.runLimit=Number(input.runLimit);}
  return parse(z.object({...filterShape,cursor:z.string().max(512).optional()}).strict(),input);
}
const empty=(runId:string):RankMatrixCell=>({runId,taskId:null,state:'not_in_run',resultStatus:null,position:null,rankBasis:null,absolutePosition:null,rankingUrl:null,checkedDepth:null,returnedItemCount:null,observedAt:null,retrievedAt:null,rawExpiredAt:null,dataExpiredAt:null,change:null});
function queryError(error:unknown):never{if((error as {code?:string})?.code==='57014')throw new FoundationError(503,'This rank report took too long. Narrow the filters or number of checks.');throw error;}

// One repeatable-read snapshot supplies columns, keyword identities, retention and
// observations. Reading never reserves charges, acquires a provider key or queues work.
async function matrix(client:PoolClient,role:string,projectId:string,trackerId:string,input:Filters&{cursor?:string},all=false):Promise<RankMatrix>{
  await client.query("SET LOCAL statement_timeout='5s'");
  const config=(await client.query('SELECT * FROM rank_config WHERE project_id=$1 AND id=$2',[projectId,trackerId])).rows[0];
  if(!config)throw new FoundationError(404,'Rank tracker not found or unavailable.');
  const enabledDevices:Device[]=config.devices==='both'?['desktop','mobile']:[config.devices];
  if(!enabledDevices.includes(input.device))throw new FoundationError(400,'Choose a currently enabled device for this matrix.');
  const target:RankHistoryTarget={domain:config.target_domain,locationCode:config.location_code,languageCode:config.language_code,depth:config.serp_depth,maxCrawlPages:config.max_crawl_pages};
  const {cursor:_cursor,...filters}=input,scope={projectId,trackerId,list:'rank-matrix',filters,target,authoredRevision:config.authored_revision,keywordsRevision:config.keywords_revision};
  const after=readContentCursor(input.cursor??null,scope),asOf=(await client.query(`SELECT ${time('transaction_timestamp()')} AS at`)).rows[0].at;
  const keywordCount=(await client.query(`SELECT count(*)::int AS n FROM rank_keyword WHERE project_id=$1 AND config_id=$2 AND strpos(keyword,$3)>0 AND ($4::boolean IS NULL OR (pinned_at IS NOT NULL)=$4::boolean)`,[projectId,trackerId,input.search,input.pinned??null])).rows[0].n;
  if(keywordCount>1000)throw new FoundationError(409,'The tracker exceeds the supported reporting population.');
  const keywords=(await client.query(`SELECT id,keyword,match_case,${time('pinned_at')} AS pinned,${time('created_at')} AS cursor_at FROM rank_keyword
    WHERE project_id=$1 AND config_id=$2 AND strpos(keyword,$3)>0 AND ($4::boolean IS NULL OR (pinned_at IS NOT NULL)=$4::boolean)
    AND ($5::timestamptz IS NULL OR (created_at,id)<($5::timestamptz,$6::uuid)) ORDER BY created_at DESC,id DESC LIMIT $7`,[projectId,trackerId,input.search,input.pinned??null,after?.at??null,after?.id??null,all?1001:51])).rows;
  const shown=all?keywords:keywords.slice(0,50);
  // ponytail: at most26 immutable plans and1,000×26 export cells. No lifetime
  // history cap; older runs stay in Check history. Add summary indexes only after
  // measuring this bounded query against larger retained histories.
  const runs=(await client.query(`SELECT id,status,trigger,method,request,request_hash,task_count,${time('started_at')} AS started,${time('completed_at')} AS completed,
    ${time('scheduled_for')} AS scheduled,${time('raw_expired_at')} AS raw_expired,${time('data_expired_at')} AS data_expired
    FROM rank_run WHERE project_id=$1 AND config_id=$2 AND started_at IS NOT NULL AND NOT is_subset AND status NOT IN ('quoted','skipped')
    ORDER BY started_at DESC,id DESC LIMIT $3`,[projectId,trackerId,input.runLimit])).rows;
  const columns:RankMatrixColumn[]=[],captured=new Map<string,RankPlanTask>(),pairs=new Map<string,RankPlanTask>();
  for(const r of runs){const plan=readRankPlan(r.request,r.request_hash);if(plan.tasks.length!==r.task_count)throw new FoundationError(409,'The saved rank request is inconsistent.');
    columns.push({runId:r.id,status:r.status,trigger:r.trigger,method:r.method,startedAt:r.started,completedAt:r.completed,scheduledFor:r.scheduled,target:plan.target,compatible:canonicalHash(plan.target)===canonicalHash(target),rawExpiredAt:r.raw_expired,dataExpiredAt:r.data_expired});
    for(const task of plan.tasks)if(task.device===input.device){captured.set(r.id+':'+task.id,task);pairs.set(r.id+':'+task.keywordId,task);}
  }
  const tasks=runs.length&&shown.length?(await client.query(`SELECT t.id,t.run_id,t.keyword_id,t.keyword,t.match_case,t.device,t.result_status,
    CASE WHEN t.data_expired_at IS NULL AND r.data_expired_at IS NULL THEN t.position END AS position,
    CASE WHEN t.data_expired_at IS NULL AND r.data_expired_at IS NULL THEN t.rank_basis END AS rank_basis,
    CASE WHEN t.data_expired_at IS NULL AND r.data_expired_at IS NULL THEN t.absolute_position END AS absolute_position,
    CASE WHEN t.data_expired_at IS NULL AND r.data_expired_at IS NULL THEN t.ranking_url END AS ranking_url,
    CASE WHEN t.data_expired_at IS NULL AND r.data_expired_at IS NULL THEN t.checked_depth END AS checked_depth,
    CASE WHEN t.data_expired_at IS NULL AND r.data_expired_at IS NULL THEN t.returned_item_count END AS returned_item_count,
    ${time('t.observed_at')} AS observed,${time('t.retrieved_at')} AS retrieved,${time('COALESCE(t.raw_expired_at,r.raw_expired_at)')} AS raw_expired,
    ${time('COALESCE(t.data_expired_at,r.data_expired_at)')} AS data_expired FROM rank_task t JOIN rank_run r ON r.id=t.run_id AND r.project_id=t.project_id
    WHERE t.project_id=$1 AND r.config_id=$2 AND t.run_id=ANY($3::uuid[]) AND t.keyword_id=ANY($4::uuid[]) AND t.device=$5`,[projectId,trackerId,runs.map(r=>r.id),shown.map(k=>k.id),input.device])).rows:[];
  const byPair=new Map<string,any>();
  for(const t of tasks){const original=captured.get(t.run_id+':'+t.id);if(!original||original.keywordId!==t.keyword_id||original.keyword!==t.keyword||original.matchCase!==t.match_case||original.device!==t.device)throw new FoundationError(409,'The saved rank tasks are inconsistent.');byPair.set(t.run_id+':'+t.keyword_id,t);}
  const rows:RankMatrixRow[]=shown.map(k=>{
    const cells=columns.map(column=>{
      const cell=empty(column.runId),plan=pairs.get(column.runId+':'+k.id);if(!plan)return cell;
      const t=byPair.get(column.runId+':'+k.id);cell.taskId=plan.id;cell.resultStatus=t?.result_status??null;cell.rawExpiredAt=t?.raw_expired??column.rawExpiredAt;cell.dataExpiredAt=t?.data_expired??column.dataExpiredAt;
      cell.observedAt=t?.observed??null;cell.retrievedAt=t?.retrieved??null;
      if(cell.dataExpiredAt){cell.state='expired';return cell;}
      if(!column.compatible||plan.keyword!==k.keyword||plan.matchCase!==k.match_case){cell.state='incompatible';return cell;}
      if(!t){cell.state='unavailable';return cell;}
      cell.state=t.result_status;
      if(t.result_status==='ranked'||t.result_status==='not_found')Object.assign(cell,{position:t.position,rankBasis:t.rank_basis,absolutePosition:t.absolute_position,rankingUrl:t.ranking_url,checkedDepth:t.checked_depth,returnedItemCount:t.returned_item_count});
      return cell;
    });
    for(let i=0;i<cells.length-1;i++){const now=cells[i],prior=cells[i+1];if(now.state==='ranked'&&prior.state==='ranked'&&now.position!==null&&prior.position!==null&&now.rankBasis===prior.rankBasis&&now.observedAt!==null&&prior.observedAt!==null&&now.observedAt>prior.observedAt)now.change=prior.position-now.position;}
    return {keywordId:k.id,keyword:k.keyword,matchCase:k.match_case,pinnedAt:k.pinned,cells};
  });
  const last=shown.at(-1),nextCursor=!all&&keywords.length>50&&last?Buffer.from(JSON.stringify({scope:canonicalHash(scope),at:last.cursor_at,id:last.id})).toString('base64url'):null;
  return {role,trackerId,source:{provider:'dataforseo',engine:'google',report:'organic_search'},target,enabledDevices,asOf,filters,keywordCount,columns,rows,nextCursor};
}

export async function getRankMatrix(projectId:string,userId:string,trackerId:string,params=new URLSearchParams()):Promise<RankMatrix>{
  trackerId=parse(z.uuid(),trackerId);const input=query(params);return withContentProject(projectId,userId,false,(client,p)=>matrix(client,p.role,p.id,trackerId,input)).catch(queryError);
}
export async function exportRankMatrix(projectId:string,userId:string,trackerId:string,raw:unknown,signal?:AbortSignal){
  trackerId=parse(z.uuid(),trackerId);const input=parse(z.object(filterShape).strict(),raw),started=Date.now();
  const check=()=>{if(signal?.aborted)throw new FoundationError(499,'Export cancelled.');if(Date.now()-started>30000)throw new FoundationError(503,'Export took too long. Narrow the filters.');};
  return withContentProject(projectId,userId,false,async(client,p)=>{check();const report=await matrix(client,p.role,p.id,trackerId,input,true);check();let bytes=0,rowCount=0;const lines:string[]=[];
    const line=(values:unknown[])=>{const text=values.map(csvCell).join(',')+'\r\n';bytes+=Buffer.byteLength(text);if(bytes>16*1024*1024)throw new FoundationError(413,'Export exceeds 16 MiB. Narrow the filters or number of checks.');lines.push(text);};
    line(['As of','Provider','Engine','Report','Tracker ID','Keyword ID','Keyword','Case sensitive','Pinned','Device','Run ID','Run status','Trigger','Method','Started at','Scheduled for','Captured domain','Captured location code','Captured language','Captured depth','Captured page cap','Target compatible','State','Result status','Task ID','Position','Rank basis','Absolute position','Ranking URL','Observed organic depth','Returned items','Observed at','Retrieved at','Change vs adjacent older check','Raw expired at','Data expired at']);
    for(const row of report.rows)for(let i=0;i<report.columns.length;i++){check();const c=report.columns[i],v=row.cells[i];line([report.asOf,report.source.provider,report.source.engine,report.source.report,trackerId,row.keywordId,row.keyword,row.matchCase,row.pinnedAt!==null,input.device,c.runId,c.status,c.trigger,c.method,c.startedAt,c.scheduledFor??'',c.target.domain,c.target.locationCode,c.target.languageCode,c.target.depth,c.target.maxCrawlPages,c.compatible,v.state,v.resultStatus??'',v.taskId??'',v.position??'',v.rankBasis??'',v.absolutePosition??'',v.rankingUrl??'',v.checkedDepth??'',v.returnedItemCount??'',v.observedAt??'',v.retrievedAt??'',v.change??'',v.rawExpiredAt??'',v.dataExpiredAt??'']);rowCount++;}
    check();return {role:p.role,filename:'rank-matrix.csv',contentType:'text/csv; charset=utf-8',body:lines.join(''),rowCount,keywordCount:report.keywordCount,runCount:report.columns.length,asOf:report.asOf};
  }).catch(queryError);
}
