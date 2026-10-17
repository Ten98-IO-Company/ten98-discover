import {isDeepStrictEqual} from 'node:util';
import {providerMicros} from './keyword-research-input.ts';
import {dataforseoRefusal,dataforseoRefusalMessage,dataforseoWalletCodes} from './dataforseo-transport.ts';
import {rankSerpEndpoints,rankSerpPayload,rankTaskTag,type RankSerpRequest} from './rank-serp-input.ts';
import {parseRankObservation,type RankObservation} from './rank-observation.ts';

export type RankExpectedTask={id:string;request:RankSerpRequest;providerTaskId?:string};
export type RankProviderPhase='live'|'post'|'get';
export type RankTaskOutcome={id:string;providerTaskId:string|null;statusCode:number|null;state:'pending'|'completed'|'failed'|'uncertain'|'unavailable';
  provisionalMicros:string|null;finalMicros:string|null;observation:RankObservation|null;diagnostic:string|null};
export type RankDispatchOutcome={tasks:RankTaskOutcome[];provisionalMicros:string|null;finalMicros:string|null;diagnostic:string|null};
type RecordValue=Record<string,any>;
const object=(v:unknown):v is RecordValue=>!!v&&typeof v==='object'&&!Array.isArray(v);
const providerId=(v:unknown):v is string=>typeof v==='string'&&v.length===36&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(v);
const finalStatuses=new Set([20000,40102,40103,40106,40501,40502,40503,40504,40505,40506]);
const waitingStatuses=new Set([20100,40601,40602]);
const unknown='The provider evidence could not prove this request or its final charge. Reconcile it before starting another check.';
function invalid():never{throw new Error('Unsupported rank provider evidence.');}
function unknownTask(task:RankExpectedTask):RankTaskOutcome{return {id:task.id,providerTaskId:task.providerTaskId??null,statusCode:null,state:'uncertain',provisionalMicros:null,finalMicros:null,observation:null,diagnostic:unknown};}

export function matchesRankPayload(data:unknown,expected:RankExpectedTask,phase:RankProviderPhase):boolean{
  if(!object(data))return false;
  const payload=rankSerpPayload(expected.request,expected.id,phase==='live'?'live':'queued');
  // data echoes the authored POST representation; only result.keyword is decoded.
  if(!Object.entries(payload).every(([key,value])=>isDeepStrictEqual(data[key],value)))return false;
  if(data.api!=='serp'||data.se!=='google'||data.se_type!=='organic'||data.function!==(phase==='post'?'task_post':phase==='get'?'task_get':'live'))return false;
  // Reject unapproved semantic/paid expansion, not just known expensive flags.
  // These documented defaults do not alter our authored search definition.
  const allowed=new Set([...Object.keys(payload),'api','se','se_type','function']);
  const defaults:RecordValue={group_organic_results:true,target_search_mode:'any',ignore_targets_in:[],remove_from_url:[],postback_data:'advanced'};
  if(phase==='live')defaults.priority=1;
  return Object.keys(data).every(key=>allowed.has(key)||Object.hasOwn(defaults,key)&&isDeepStrictEqual(data[key],defaults[key]));
}
function matchesPath(task:RecordValue,phase:RankProviderPhase){
  if(!Array.isArray(task.path)||!task.path.every((p:unknown)=>typeof p==='string'))return false;
  if(phase==='get')return isDeepStrictEqual(task.path,['v3','serp','google','organic','task_get','advanced',task.id]);
  if(phase==='post')return isDeepStrictEqual(task.path,new URL(rankSerpEndpoints.queued).pathname.slice(1).split('/'));
  // The official Live response sample uses the legacy advanced/live order.
  return isDeepStrictEqual(task.path,new URL(rankSerpEndpoints.live).pathname.slice(1).split('/'))||isDeepStrictEqual(task.path,['v3','serp','google','organic','advanced','live']);
}

/** Pure response interpretation. The caller supplies only captured task definitions,
 * and must bind the HTTP credentials to the run's persisted account fingerprint.
 * Task GET repeats the original charge; never add it as a new paid reservation.
 */
export function parseRankDispatchOutcome(response:{httpStatus:number;body:unknown},phase:RankProviderPhase,expected:readonly RankExpectedTask[],now=new Date()):RankDispatchOutcome{
  if(!['live','post','get'].includes(phase)||expected.length<1||expected.length>(phase==='post'?100:1))invalid();
  const tags=new Map<string,RankExpectedTask>();
  for(const task of expected){const tag=rankTaskTag(task.id);rankSerpPayload(task.request,task.id,phase==='live'?'live':'queued');if(tags.has(tag)||(phase==='get'&&!providerId(task.providerTaskId)))invalid();tags.set(tag,task);}
  const uncertain=():RankDispatchOutcome=>({tasks:expected.map(unknownTask),provisionalMicros:null,finalMicros:null,diagnostic:unknown});
  // Owner decision D3: a whole paid response refused for wallet reasons at an explicit zero cost
  // fails every task at a final $0. Free task_get polling is never classified.
  const refused=phase==='get'?null:dataforseoRefusal(response);
  if(refused){const diagnostic=dataforseoRefusalMessage[refused];
    return {tasks:expected.map(task=>({...unknownTask(task),state:'failed',finalMicros:'0',diagnostic})),provisionalMicros:phase==='post'?'0':null,finalMicros:'0',diagnostic};}
  try{
    const body=response.body;
    if(response.httpStatus!==200||!object(body)||body.status_code!==20000||!Array.isArray(body.tasks)||body.tasks.length!==expected.length||body.tasks_count!==expected.length)invalid();
    const total=providerMicros(body.cost),seen=new Set<string>(),seenIds=new Set<string>();
    const tasks:RankTaskOutcome[]=[];let sum=0n;
    for(const raw of body.tasks){
      if(!object(raw)||!object(raw.data)||!providerId(raw.id)||!Number.isInteger(raw.status_code)||raw.status_code<10000||raw.status_code>60000)invalid();
      const task=tags.get(raw.data.tag);
      if(!task||seen.has(task.id)||seenIds.has(raw.id.toLowerCase())||!matchesPath(raw,phase)||!matchesRankPayload(raw.data,task,phase)||
        (task.providerTaskId!==undefined&&raw.id!==task.providerTaskId))invalid();
      seen.add(task.id);seenIds.add(raw.id.toLowerCase());
      const cost=providerMicros(raw.cost);sum+=cost;
      const outcome={...unknownTask(task),providerTaskId:raw.id,statusCode:raw.status_code};
      if(phase==='post'&&waitingStatuses.has(raw.status_code)){
        if(raw.result_count!==0||(raw.result!==null&&(!Array.isArray(raw.result)||raw.result.length!==0)))invalid();
        outcome.state='pending';outcome.provisionalMicros=cost.toString();outcome.diagnostic=null;
      }else if(phase==='get'&&waitingStatuses.has(raw.status_code)){
        // A polling acknowledgement does not prove a refund or final charge.
        outcome.state='pending';outcome.provisionalMicros=cost.toString();outcome.diagnostic=null;
      }else if(phase!=='get'&&dataforseoWalletCodes.has(raw.status_code)&&raw.cost===0){
        // One task of a paid batch refused for wallet reasons at an explicit zero cost; its siblings proceed.
        outcome.state='failed';outcome.finalMicros='0';outcome.diagnostic=dataforseoRefusalMessage[dataforseoWalletCodes.get(raw.status_code)!];
      }else if(finalStatuses.has(raw.status_code)){
        outcome.finalMicros=cost.toString();outcome.state='failed';outcome.diagnostic='The provider finished without a usable observation. Its final charge is recorded.';
        if(raw.status_code===20000||raw.status_code===40106){
          try{
            if(raw.result_count!==1||!Array.isArray(raw.result)||raw.result.length!==1)invalid();
            outcome.observation=parseRankObservation(raw.result[0],task.request,now);outcome.state='completed';
            outcome.diagnostic=raw.status_code===40106?'Some search-result pages were not returned. Coverage and charge reflect the partial result.':null;
          }catch{/* A verified final charge survives unusable measurement data. */}
        }
      }
      tasks.push(outcome);
    }
    if(sum!==total)invalid(); // Never settle contradictory envelope/task totals.
    const ordered=expected.map(task=>tasks.find(result=>result.id===task.id)!);
    return {tasks:ordered,provisionalMicros:phase==='post'?total.toString():null,
      finalMicros:ordered.every(task=>task.finalMicros!==null)?total.toString():null,
      diagnostic:ordered.some(task=>task.state==='uncertain')?unknown:null};
  }catch{return uncertain();}
}

/** One complete ID-list page, fetched for the same verified provider account.
 * A full1000-row page is inconclusive: there may be another matching task beyond
 * it. Never infer a zero charge from missing, expired or ambiguous metadata.
 */
export function parseRankReconciliation(response:{httpStatus:number;body:unknown},method:'live'|'queued',expected:readonly RankExpectedTask[],dispatchedAt:Date,now=new Date()):RankDispatchOutcome{
  if(!['live','queued'].includes(method)||expected.length<1||expected.length>(method==='live'?1:100)||!Number.isFinite(dispatchedAt.getTime())||!Number.isFinite(now.getTime())||
    now.getTime()-dispatchedAt.getTime()<120_000||now.getTime()-dispatchedAt.getTime()>28*86400000)invalid();
  const phase=method==='live'?'live':'post',tags=new Set(expected.map(task=>rankTaskTag(task.id)));
  if(tags.size!==expected.length)invalid();
  for(const task of expected)rankSerpPayload(task.request,task.id,method);
  const uncertain=():RankDispatchOutcome=>({tasks:expected.map(unknownTask),provisionalMicros:null,finalMicros:null,diagnostic:unknown});
  try{
    const body=response.body;
    if(response.httpStatus!==200||!object(body)||body.status_code!==20000||providerMicros(body.cost)!==0n||body.tasks_count!==1||!Array.isArray(body.tasks)||body.tasks.length!==1)invalid();
    const page=body.tasks[0];
    if(!object(page)||page.status_code!==20000||providerMicros(page.cost)!==0n||!isDeepStrictEqual(page.path,['v3','serp','id_list'])||!Array.isArray(page.result)||page.result.length>=1000||page.result_count!==page.result.length||!object(page.data))invalid();
    const stamp=(time:number)=>new Date(time).toISOString().slice(0,19).replace('T',' ')+' +00:00';
    // Require the first full-sized query of the closed dispatch window. A short
    // last page or an early query can hide an earlier/later duplicate task tag.
    if(page.data.offset!==0||page.data.limit!==1000||page.data.sort!=='asc'||page.data.include_metadata!==true||
      page.data.datetime_from!==stamp(dispatchedAt.getTime()-60_000)||page.data.datetime_to!==stamp(dispatchedAt.getTime()+120_000))invalid();
    const result:RankTaskOutcome[]=[],ids=new Set<string>();
    for(const task of expected){
      const tag=rankTaskTag(task.id),matches=page.result.filter((row:unknown)=>object(row)&&object(row.metadata)&&row.metadata.tag===tag);
      if(matches.length!==1)invalid();
      const row=matches[0];
      if(!providerId(row.id)||ids.has(row.id.toLowerCase())||(task.providerTaskId!==undefined&&task.providerTaskId!==row.id)||row.url!==new URL(rankSerpEndpoints[method]).pathname.slice(1)||!matchesRankPayload(row.metadata,task,phase)||
        typeof row.status!=='string'||!/^\d{5}(?![\s\S])/.test(row.status)||typeof row.datetime_posted!=='string'||!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \+00:00$/.test(row.datetime_posted))invalid();
      const posted=new Date(row.datetime_posted.replace(' ','T').replace(' +00:00','+00:00'));
      if(!Number.isFinite(posted.getTime())||posted.toISOString().slice(0,19)!==row.datetime_posted.slice(0,19).replace(' ','T')||posted.getTime()<dispatchedAt.getTime()-60_000||posted.getTime()>Math.min(now.getTime(),dispatchedAt.getTime()+120_000))invalid();
      ids.add(row.id.toLowerCase());const cost=providerMicros(row.cost),status=Number(row.status),outcome={...unknownTask(task),providerTaskId:row.id,statusCode:status};
      if(finalStatuses.has(status)){
        outcome.finalMicros=cost.toString();outcome.state=status===20000||status===40106?'unavailable':'failed';outcome.diagnostic='The final charge was reconciled. Retrieve the known task to recover any available observation.';
      }else if(method==='queued'&&waitingStatuses.has(status)){
        outcome.provisionalMicros=cost.toString();outcome.state='pending';outcome.diagnostic=null;
      }
      result.push(outcome);
    }
    return {tasks:result,provisionalMicros:null,finalMicros:result.every(task=>task.finalMicros!==null)?result.reduce((sum,task)=>sum+BigInt(task.finalMicros!),0n).toString():null,
      diagnostic:result.some(task=>task.state==='uncertain')?unknown:null};
  }catch{return uncertain();}
}
