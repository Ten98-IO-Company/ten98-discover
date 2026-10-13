import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {FoundationError} from './auth.ts';
import {canonicalHash,parse,revision} from './context-input.ts';
import {parseRankSerpRequest,rankEstimateMicros,rankSerpPayload,type RankMethod,type RankSerpRequest} from './rank-serp-input.ts';

export const rankQuoteInput=z.object({requestId:z.uuid(),connectionId:z.uuid(),revision,keywordsRevision:revision,method:z.enum(['live','queued']),keywordIds:z.array(z.uuid()).min(1).max(1000).optional()}).strict();
type Keyword={id:string;keyword:string;matchCase:boolean};
export type RankPlanTask={id:string;keywordId:string;keyword:string;matchCase:boolean;device:'desktop'|'mobile';maximumMicros:string};
export type RankPlan={version:1;method:RankMethod;target:Omit<RankSerpRequest,'keyword'|'device'>;baseMicros:string;tasks:RankPlanTask[];groups:{requestKey:string;taskIds:string[];maximumMicros:string}[]};
const amount=z.string().regex(/^[1-9]\d{0,12}(?![\s\S])/).refine(v=>BigInt(v)<=1_000_000_000_000n);
const storedPlan=z.object({version:z.literal(1),method:z.enum(['live','queued']),target:z.object({domain:z.string(),locationCode:z.number(),languageCode:z.string(),depth:z.number(),maxCrawlPages:z.number()}).strict(),baseMicros:amount,
  tasks:z.array(z.object({id:z.uuid(),keywordId:z.uuid(),keyword:z.string(),matchCase:z.boolean(),device:z.enum(['desktop','mobile']),maximumMicros:amount}).strict()).min(1).max(2000),
  groups:z.array(z.object({requestKey:z.uuid(),taskIds:z.array(z.uuid()).min(1).max(100),maximumMicros:amount}).strict()).min(1).max(2000)}).strict();
const tooLarge=()=>new FoundationError(400,'This check exceeds the supported request or charge size. Select fewer keywords or a lower page limit.');
export function rankTaskRequest(plan:RankPlan,task:RankPlanTask):RankSerpRequest{return parseRankSerpRequest({...plan.target,keyword:task.keyword,device:task.device});}
export function rankGroupTasks(plan:RankPlan,group:RankPlan['groups'][number]){
  const byId=new Map(plan.tasks.map(task=>[task.id,task]));
  return group.taskIds.map(id=>{const task=byId.get(id);if(!task)throw new FoundationError(409,'The saved rank request is inconsistent.');return {id,request:rankTaskRequest(plan,task)};});
}
export function rankGroupPayload(plan:RankPlan,group:RankPlan['groups'][number]){return rankGroupTasks(plan,group).map(task=>rankSerpPayload(task.request,task.id,plan.method));}

/** Captures exact keyword/device identities and conservative per-dispatch ceilings.
 * Count and encoded-byte limits both apply; a queued batch is never truncated.
 */
export function compileRankPlan(input:{method:RankMethod;target:RankPlan['target'];devices:'desktop'|'mobile'|'both';keywords:Keyword[];baseMicros:bigint}):RankPlan{
  if(!['live','queued'].includes(input.method)||!['desktop','mobile','both'].includes(input.devices)||input.keywords.length<1||input.keywords.length>1000)throw tooLarge();
  const ids=new Set<string>(),tasks:RankPlanTask[]=[];
  for(const keyword of input.keywords){
    const keywordId=parse(z.uuid(),keyword.id).toLowerCase();if(ids.has(keywordId)||typeof keyword.matchCase!=='boolean')throw tooLarge();ids.add(keywordId);
    for(const device of input.devices==='both'?['desktop','mobile'] as const:[input.devices]){
      const request=parseRankSerpRequest({...input.target,keyword:keyword.keyword,device});
      const maximum=rankEstimateMicros(input.baseMicros,request).maximumMicros;
      tasks.push({id:randomUUID(),keywordId,keyword:request.keyword,matchCase:keyword.matchCase,device,maximumMicros:maximum.toString()});
    }
  }
  const normalized=parseRankSerpRequest({...input.target,keyword:tasks[0].keyword,device:tasks[0].device});
  const {keyword:_keyword,device:_device,...target}=normalized;
  const plan:RankPlan={version:1,method:input.method,target,baseMicros:input.baseMicros.toString(),tasks,groups:[]};
  let group:RankPlan['groups'][number]|undefined,bytes=2,total=0n;
  for(const task of tasks){
    const size=Buffer.byteLength(JSON.stringify(rankSerpPayload(rankTaskRequest(plan,task),task.id,plan.method)));
    if(size+2>131072)throw tooLarge();
    if(!group||group.taskIds.length===(plan.method==='live'?1:100)||bytes+size+1>131072){group={requestKey:randomUUID(),taskIds:[],maximumMicros:'0'};plan.groups.push(group);bytes=2;}
    bytes+=size+(group.taskIds.length?1:0);group.taskIds.push(task.id);group.maximumMicros=(BigInt(group.maximumMicros)+BigInt(task.maximumMicros)).toString();total+=BigInt(task.maximumMicros);
  }
  // Leave room for PostgreSQL jsonb's whitespace in the persisted2MiB constraint.
  if(total>1_000_000_000_000n||Buffer.byteLength(JSON.stringify(plan))>1_800_000)throw tooLarge();
  return plan;
}
export function rankPlanTotal(plan:RankPlan){return plan.groups.reduce((sum,group)=>sum+BigInt(group.maximumMicros),0n);}
export function readRankPlan(raw:unknown,hash:string):RankPlan{
  const result=storedPlan.safeParse(raw);
  if(!result.success||canonicalHash(result.data)!==hash)throw new FoundationError(409,'The saved rank request is inconsistent.');
  const plan=result.data,ids=new Set<string>(),pairs=new Set<string>(),groupKeys=new Set<string>(),assigned=new Set<string>(),identities=new Map<string,string>();
  for(const task of plan.tasks){
    const pair=task.keywordId+':'+task.device;
    const identity=JSON.stringify([task.keyword,task.matchCase]),request=rankTaskRequest(plan,task);
    if(task.id!==task.id.toLowerCase()||task.keywordId!==task.keywordId.toLowerCase()||ids.has(task.id)||pairs.has(pair)||
      identities.has(task.keywordId)&&identities.get(task.keywordId)!==identity||request.domain!==plan.target.domain||
      rankEstimateMicros(BigInt(plan.baseMicros),request).maximumMicros.toString()!==task.maximumMicros)throw new FoundationError(409,'The saved rank task is inconsistent.');
    identities.set(task.keywordId,identity);
    ids.add(task.id);pairs.add(pair);
  }
  const tasks=new Map(plan.tasks.map(task=>[task.id,task]));
  for(const group of plan.groups){
    if(group.requestKey!==group.requestKey.toLowerCase()||groupKeys.has(group.requestKey)||group.taskIds.length>(plan.method==='live'?1:100))throw new FoundationError(409,'The saved rank dispatch is inconsistent.');groupKeys.add(group.requestKey);
    let total=0n;
    for(const id of group.taskIds){const task=tasks.get(id);if(!task||assigned.has(id))throw new FoundationError(409,'The saved rank dispatch is inconsistent.');assigned.add(id);total+=BigInt(task.maximumMicros);}
    if(total.toString()!==group.maximumMicros||Buffer.byteLength(JSON.stringify(rankGroupPayload(plan,group)))>131072)throw new FoundationError(409,'The saved rank dispatch is inconsistent.');
  }
  if(assigned.size!==tasks.size||rankPlanTotal(plan)>1_000_000_000_000n)throw new FoundationError(409,'The saved rank request is inconsistent.');
  return plan;
}
