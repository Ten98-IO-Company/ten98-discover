import {z} from 'zod';
import {FoundationError} from './auth.ts';
import {canonicalHash,parse} from './context-input.ts';
import {withContentProject,type ContentProject} from './project-context.ts';
import {readRankPlan,type RankPlanTask} from './rank-execution-plan.ts';
import {parseRankSerpRequest} from './rank-serp-input.ts';
import type {RankHistoryTarget} from './rank-history.ts';

type Device='desktop'|'mobile';
export type RankDistributionCounts={organic1To3:number;organic4To10:number;organic11To20:number;organic21To100:number;
  organicAbove100:number;absoluteRanked:number;notFoundThrough100:number;limitedCoverage:number;
  neverChecked:number;expired:number;pending:number;unavailable:number;incompatible:number};
type Totals={denominator:number;counts:RankDistributionCounts;observedCoverage:{count:number;complete:boolean};top100Comparable:{count:number;complete:boolean}};
export type RankDistribution={role:ContentProject['role'];trackerId:string;mode:'latest'|'run';
  source:{provider:'dataforseo';engine:'google';report:'organic_search'};target:RankHistoryTarget;
  enabledDevices:Device[];selectedDevices:Device[];asOf:string;keywordCount:number;
  run:null|{id:string;status:string;isSubset:boolean;createdAt:string;startedAt:string|null;completedAt:string|null;dataExpiredAt:string|null};
  observationDates:{earliestObservedAt:string|null;latestObservedAt:string|null;earliestRetrievedAt:string|null;latestRetrievedAt:string|null};
  totals:Totals;byDevice:({device:Device}&Totals)[]};
type Cell={device:Device;taskId?:string|null;category?:keyof RankDistributionCounts;status?:string;position?:number|null;basis?:string|null;depth?:number|null;
  observed?:string|null;retrieved?:string|null};
const devices=['desktop','mobile'] as const;
const time=(column:string)=>`to_char((${column}) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
function blank():RankDistributionCounts{return {organic1To3:0,organic4To10:0,organic11To20:0,organic21To100:0,organicAbove100:0,
  absoluteRanked:0,notFoundThrough100:0,limitedCoverage:0,neverChecked:0,expired:0,pending:0,unavailable:0,incompatible:0};}
function summarize(cells:Cell[],requestedDepth:number):Totals{
  const counts=blank();for(const cell of cells){let category=cell.category;
    if(!category&&cell.status==='ranked'&&cell.position!==null&&cell.position!==undefined&&cell.position>0){
      category=cell.basis==='absolute'?'absoluteRanked':cell.basis==='organic'?
        cell.position<=3?'organic1To3':cell.position<=10?'organic4To10':cell.position<=20?'organic11To20':cell.position<=100?'organic21To100':'organicAbove100':'unavailable';
    }else if(!category&&cell.status==='not_found')category=cell.depth!==null&&cell.depth!==undefined&&Math.min(cell.depth,requestedDepth)>=100?'notFoundThrough100':'limitedCoverage';
    counts[category??'unavailable']++;
  }
  const comparable=counts.organic1To3+counts.organic4To10+counts.organic11To20+counts.organic21To100+counts.organicAbove100+counts.notFoundThrough100;
  const observed=comparable+counts.absoluteRanked+counts.limitedCoverage;
  return {denominator:cells.length,counts,observedCoverage:{count:observed,complete:cells.length>0&&observed===cells.length},
    top100Comparable:{count:comparable,complete:cells.length>0&&comparable===cells.length}};
}

/** A read-only partition, never a sum of overlapping runs or an invented rank0.
 * Latest mode uses current stable keyword UUIDs × enabled devices and exact
 * domain/location/language/depth/page-cap/text/case compatibility. It chooses the
 * latest retained observation by observed_at then task UUID (both descending).
 * Failed/pending newer attempts do not erase usable observations. Without one,
 * precedence is expired compatible observation, latest compatible pending or
 * unavailable attempt, incompatible history, then never checked.
 * Run mode uses the immutable captured pairs, even after removal/config edits.
 * Expiry wins over residual children; absent started children are unavailable.
 * observedCoverage means readable ranked/not_found results, NOT coverage to100:
 * top100Comparable additionally excludes shallow negatives and absolute ranks.
 * Both completeness flags are false for empty sets. Dates cover ONLY the chosen
 * readable observations; a latest-mode distribution is not one complete check.
 * Current membership and every read share one repeatable-read snapshot. A later
 * committed revocation applies to the next request, without blocking writers.
 * All counters partition each selected device and the total. No raw SERP, actor,
 * connection, provider task ID, or credential is returned. No provider is called.
 */
export async function getRankDistribution(projectId:string,userId:string,trackerId:string,params=new URLSearchParams(),apiToken?:string):Promise<RankDistribution>{
  trackerId=parse(z.uuid(),trackerId);const raw:Record<string,string>={};
  for(const [key,value]of params){if(!['device','runId'].includes(key)||Object.hasOwn(raw,key))throw new FoundationError(400,'Check the rank distribution filters.');raw[key]=value;}
  const input=parse(z.object({device:z.enum(['desktop','mobile','both']).default('both'),runId:z.uuid().optional()}).strict(),raw);
  return withContentProject<RankDistribution>(projectId,userId,false,async(client,{role})=>{
    await client.query("SET LOCAL statement_timeout='5s'");
    const config=(await client.query('SELECT target_domain,location_code,language_code,serp_depth,max_crawl_pages,devices FROM rank_config WHERE project_id=$1 AND id=$2',[projectId,trackerId])).rows[0];
    if(!config)throw new FoundationError(404,'Rank tracker not found or unavailable.');
    const asOf=(await client.query(`SELECT ${time('transaction_timestamp()')} AS at`)).rows[0].at as string;
    let target:RankHistoryTarget={domain:config.target_domain,locationCode:config.location_code,languageCode:config.language_code,depth:config.serp_depth,maxCrawlPages:config.max_crawl_pages};
    let enabled:Device[]=config.devices==='both'?[...devices]:[config.devices],selected:Device[],cells:Cell[],keywordCount:number,run:RankDistribution['run']=null;
    const choose=()=>{if(input.device!=='both'&&!enabled.includes(input.device))throw new FoundationError(400,'That device is not part of this rank distribution.');return input.device==='both'?[...enabled]:[input.device];};
    if(input.runId){
      const saved=(await client.query(`SELECT id,status,is_subset,request,request_hash,task_count,trigger,
        ${time('created_at')} AS created,${time('started_at')} AS started,${time('completed_at')} AS completed,${time('data_expired_at')} AS expired
        FROM rank_run WHERE project_id=$1 AND config_id=$2 AND id=$3`,[projectId,trackerId,input.runId])).rows[0];
      if(!saved)throw new FoundationError(404,'Rank check not found or unavailable.');
      let captured:RankPlanTask[];
      if(saved.status==='skipped'){
        if(saved.trigger!=='scheduled'||saved.task_count!==0||saved.request?.version!==1||saved.request?.skipped!==true||canonicalHash(saved.request)!==saved.request_hash)throw new FoundationError(409,'The saved rank request is inconsistent.');
        const {keyword:_keyword,device:_device,...scope}=parseRankSerpRequest({...saved.request.target,keyword:'scope',device:'desktop'});target=scope;captured=[];
      }else{const plan=readRankPlan(saved.request,saved.request_hash);if(plan.tasks.length!==saved.task_count)throw new FoundationError(409,'The saved rank request is inconsistent.');target=plan.target;captured=plan.tasks;}
      enabled=devices.filter(device=>captured.some(task=>task.device===device));selected=choose();
      run={id:saved.id,status:saved.status,isSubset:saved.is_subset,createdAt:saved.created,startedAt:saved.started,completedAt:saved.completed,dataExpiredAt:saved.expired};
      const tasks=(await client.query(`SELECT id,keyword_id,keyword,match_case,device,result_status AS status,position,rank_basis AS basis,checked_depth AS depth,
        ${time('observed_at')} AS observed,${time('retrieved_at')} AS retrieved,data_expired_at IS NOT NULL AS expired
        FROM rank_task WHERE project_id=$1 AND run_id=$2 LIMIT 2001`,[projectId,saved.id])).rows;
      const capturedById=new Map(captured.map(task=>[task.id,task]));
      for(const task of tasks){const expected=capturedById.get(task.id);if(!expected||task.keyword_id!==expected.keywordId||task.keyword!==expected.keyword||task.match_case!==expected.matchCase||task.device!==expected.device)throw new FoundationError(409,'The saved rank tasks are inconsistent.');}
      const byId=new Map(tasks.map(task=>[task.id,task]));const pairs=captured.filter(task=>selected.includes(task.device));keywordCount=new Set(pairs.map(task=>task.keywordId)).size;
      cells=pairs.map(pair=>{const task=byId.get(pair.id);if(saved.expired||task?.expired)return {device:pair.device,category:'expired'};
        if(!task)return {device:pair.device,category:saved.status==='quoted'?'neverChecked':'unavailable'};
        if(task.status==='ranked'||task.status==='not_found')return {device:pair.device,...task};
        return {device:pair.device,category:task.status==='pending'?'pending':'unavailable'};});
    }else{
      selected=choose();
      const keywords=(await client.query('SELECT id,keyword,match_case FROM rank_keyword WHERE project_id=$1 AND config_id=$2 ORDER BY id LIMIT 1001',[projectId,trackerId])).rows;
      if(keywords.length>1000)throw new FoundationError(409,'The tracker has more keywords than a distribution can safely include.');keywordCount=keywords.length;
      // ponytail: one bounded cell set (<=2,000), one set-based history scan and a
      //5s statement limit. Project each large captured target once per run, not
      //per task/probe. Add indexed rollups only if measured larger histories need it.
      cells=keywords.length?(await client.query(`WITH keywords AS MATERIALIZED (
        SELECT id,keyword,match_case FROM rank_keyword WHERE project_id=$1 AND config_id=$2
      ), candidates AS MATERIALIZED (
        SELECT t.id,t.run_id,t.keyword_id,t.keyword,t.match_case,t.device,t.result_status,t.observed_at,t.data_expired_at
        FROM rank_task t JOIN keywords k ON k.id=t.keyword_id WHERE t.project_id=$1 AND t.device=ANY($4::text[])
      ), runs AS MATERIALIZED (
        SELECT r.id,COALESCE(r.started_at,r.created_at) AS attempted_at,r.data_expired_at,r.request->'target'=$3::jsonb AS target_matches
        FROM rank_run r JOIN (SELECT DISTINCT run_id FROM candidates) c ON c.run_id=r.id WHERE r.project_id=$1 AND r.config_id=$2
      ), scoped AS MATERIALIZED (
        SELECT t.id,t.keyword_id,t.device,t.result_status,t.observed_at,r.attempted_at,(r.target_matches AND t.keyword=k.keyword AND t.match_case=k.match_case) AS compatible,
          (r.data_expired_at IS NOT NULL OR t.data_expired_at IS NOT NULL) AS expired
        FROM candidates t JOIN runs r ON r.id=t.run_id JOIN keywords k ON k.id=t.keyword_id
      ), observations AS MATERIALIZED (
        SELECT DISTINCT ON(keyword_id,device) id,keyword_id,device FROM scoped WHERE compatible AND NOT expired AND result_status IN ('ranked','not_found') AND observed_at IS NOT NULL
        ORDER BY keyword_id,device,observed_at DESC,id DESC
      ), history AS MATERIALIZED (
        SELECT keyword_id,device,bool_or(compatible AND expired AND result_status IN ('ranked','not_found')) AS expired_observation FROM scoped GROUP BY keyword_id,device
      ), unresolved AS MATERIALIZED (
        SELECT h.keyword_id,h.device FROM history h LEFT JOIN observations o ON o.keyword_id=h.keyword_id AND o.device=h.device WHERE o.id IS NULL AND NOT h.expired_observation
      ), attempts AS (
        SELECT DISTINCT ON(s.keyword_id,s.device) s.keyword_id,s.device,s.result_status FROM scoped s JOIN unresolved u ON u.keyword_id=s.keyword_id AND u.device=s.device
        WHERE s.compatible ORDER BY s.keyword_id,s.device,s.attempted_at DESC,s.id DESC
      ) SELECT d.device,o.id AS "taskId",
        CASE WHEN o.id IS NOT NULL THEN NULL WHEN h.expired_observation THEN 'expired' WHEN a.result_status='pending' THEN 'pending'
          WHEN a.result_status IS NOT NULL THEN 'unavailable' WHEN h.keyword_id IS NOT NULL THEN 'incompatible' ELSE 'neverChecked' END AS category
        FROM keywords k CROSS JOIN unnest($4::text[]) AS d(device) LEFT JOIN observations o ON o.keyword_id=k.id AND o.device=d.device
        LEFT JOIN attempts a ON a.keyword_id=k.id AND a.device=d.device LEFT JOIN history h ON h.keyword_id=k.id AND h.device=d.device`,[projectId,trackerId,JSON.stringify(target),selected])).rows:[];
      // Fetch only selected measurements, avoiding wide sorts over full history.
      const ids=cells.flatMap(cell=>cell.taskId?[cell.taskId]:[]);
      if(ids.length){const measured=(await client.query(`SELECT id,result_status AS status,position,rank_basis AS basis,checked_depth AS depth,
        ${time('observed_at')} AS observed,${time('retrieved_at')} AS retrieved FROM rank_task WHERE project_id=$1 AND id=ANY($2::uuid[])`,[projectId,ids])).rows;
        const byId=new Map(measured.map(row=>[row.id,row]));cells=cells.map(cell=>({...cell,...byId.get(cell.taskId)}));}
    }
    const observed=cells.filter(cell=>!cell.category&&(cell.status==='ranked'||cell.status==='not_found'));
    const range=(key:'observed'|'retrieved')=>{const values=observed.map(cell=>cell[key]).filter((value):value is string=>typeof value==='string').sort();return [values[0]??null,values.at(-1)??null];};
    const [earliestObservedAt,latestObservedAt]=range('observed'),[earliestRetrievedAt,latestRetrievedAt]=range('retrieved');
    return {role,trackerId,mode:input.runId?'run':'latest',source:{provider:'dataforseo',engine:'google',report:'organic_search'},target,
      enabledDevices:enabled,selectedDevices:selected,asOf,run,keywordCount,observationDates:{earliestObservedAt,latestObservedAt,earliestRetrievedAt,latestRetrievedAt},
      totals:summarize(cells,target.depth),byDevice:selected.map(device=>({device,...summarize(cells.filter(cell=>cell.device===device),target.depth)}))};
  },apiToken,false,'rank:read').catch((error:unknown)=>{if(error&&typeof error==='object'&&'code'in error&&error.code==='57014')throw new FoundationError(503,'The rank distribution took too long. Try one device or a saved check.');throw error;});
}
