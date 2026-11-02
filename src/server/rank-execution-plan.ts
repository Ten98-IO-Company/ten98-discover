import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {FoundationError} from './auth.ts';
import {canonicalHash,parse,revision} from './context-input.ts';
import {parseRankSerpRequest,rankSerpPayload,type RankMethod,type RankSerpRequest} from './rank-serp-input.ts';

export const rankPreparationInput=z.object({requestId:z.uuid(),connectionId:z.uuid(),revision,keywordsRevision:revision,method:z.enum(['live','queued']),keywordIds:z.array(z.uuid()).min(1).max(1000).optional()}).strict();
type Keyword={id:string;keyword:string;matchCase:boolean};
export type RankPlanTask={id:string;keywordId:string;keyword:string;matchCase:boolean;device:'desktop'|'mobile'};
export type RankPlan={version:2;method:RankMethod;target:Omit<RankSerpRequest,'keyword'|'device'>;tasks:RankPlanTask[];groups:{requestKey:string;taskIds:string[]}[]};
const storedPlan=z.object({version:z.literal(2),method:z.enum(['live','queued']),target:z.object({domain:z.string(),locationCode:z.number(),languageCode:z.string(),depth:z.number(),maxCrawlPages:z.number()}).strict(),
 tasks:z.array(z.object({id:z.uuid(),keywordId:z.uuid(),keyword:z.string(),matchCase:z.boolean(),device:z.enum(['desktop','mobile'])}).strict()).min(1).max(2000),
 groups:z.array(z.object({requestKey:z.uuid(),taskIds:z.array(z.uuid()).min(1).max(100)}).strict()).min(1).max(2000)}).strict();
const tooLarge=()=>new FoundationError(400,'This check exceeds supported keyword, task or request-size limits. Select fewer keywords.');
export function rankTaskRequest(plan:RankPlan,task:RankPlanTask):RankSerpRequest{return parseRankSerpRequest({...plan.target,keyword:task.keyword,device:task.device});}
export function rankGroupTasks(plan:RankPlan,group:RankPlan['groups'][number]){
 const byId=new Map(plan.tasks.map(task=>[task.id,task]));
 return group.taskIds.map(id=>{const task=byId.get(id);if(!task)throw new FoundationError(409,'The saved rank request is inconsistent.');return {id,request:rankTaskRequest(plan,task)};});
}
export function rankGroupPayload(plan:RankPlan,group:RankPlan['groups'][number]){return rankGroupTasks(plan,group).map(task=>rankSerpPayload(task.request,task.id,plan.method));}
export function compileRankPlan(input:{method:RankMethod;target:RankPlan['target'];devices:'desktop'|'mobile'|'both';keywords:Keyword[]}):RankPlan{
 if(!['live','queued'].includes(input.method)||!['desktop','mobile','both'].includes(input.devices)||input.keywords.length<1||input.keywords.length>1000)throw tooLarge();
 const ids=new Set<string>(),tasks:RankPlanTask[]=[];
 for(const keyword of input.keywords){
  const keywordId=parse(z.uuid(),keyword.id).toLowerCase();if(ids.has(keywordId)||typeof keyword.matchCase!=='boolean')throw tooLarge();ids.add(keywordId);
  for(const device of input.devices==='both'?['desktop','mobile'] as const:[input.devices]){
   const request=parseRankSerpRequest({...input.target,keyword:keyword.keyword,device});
   tasks.push({id:randomUUID(),keywordId,keyword:request.keyword,matchCase:keyword.matchCase,device});
  }
 }
 const {keyword:_keyword,device:_device,...target}=parseRankSerpRequest({...input.target,keyword:tasks[0].keyword,device:tasks[0].device});
 const plan:RankPlan={version:2,method:input.method,target,tasks,groups:[]};
 let group:RankPlan['groups'][number]|undefined,bytes=2;
 for(const task of tasks){
  const size=Buffer.byteLength(JSON.stringify(rankSerpPayload(rankTaskRequest(plan,task),task.id,plan.method)));
  if(size+2>131072)throw tooLarge();
  if(!group||group.taskIds.length===(plan.method==='live'?1:100)||bytes+size+1>131072){group={requestKey:randomUUID(),taskIds:[]};plan.groups.push(group);bytes=2;}
  bytes+=size+(group.taskIds.length?1:0);group.taskIds.push(task.id);
 }
 if(Buffer.byteLength(JSON.stringify(plan))>1_800_000)throw tooLarge();
 return plan;
}
export function readRankPlan(raw:unknown,hash:string):RankPlan{
 if(canonicalHash(raw)!==hash)throw new FoundationError(409,'The saved rank request is inconsistent.');
 // Historical identities remain unchanged. Only retained request scope is projected; stale plans cannot authorize new dispatch.
 let source=raw;
 if(raw&&typeof raw==='object'&&!Array.isArray(raw)&&(raw as Record<string,unknown>).version===1){
  const old=raw as Record<string,unknown>;
  const exact=(v:Record<string,unknown>,names:string[])=>Object.keys(v).length===names.length&&names.every(key=>Object.hasOwn(v,key));
  if(!exact(old,['version','method','target','baseMicros','tasks','groups'])||!Array.isArray(old.tasks)||!Array.isArray(old.groups))throw new FoundationError(409,'The historical rank request is inconsistent.');
  source={version:2,method:old.method,target:old.target,
   tasks:old.tasks.map(task=>{if(!task||typeof task!=='object'||Array.isArray(task)||!exact(task,['id','keywordId','keyword','matchCase','device','maximumMicros']))throw new FoundationError(409,'The historical rank task is inconsistent.');const {maximumMicros:_legacy,...scope}=task;return scope;}),
   groups:old.groups.map(group=>{if(!group||typeof group!=='object'||Array.isArray(group)||!exact(group,['requestKey','taskIds','maximumMicros']))throw new FoundationError(409,'The historical rank dispatch is inconsistent.');const {maximumMicros:_legacy,...scope}=group;return scope;})};
 }
 const result=storedPlan.safeParse(source);
 if(!result.success||Buffer.byteLength(JSON.stringify(result.data))>1_800_000)throw new FoundationError(409,'The saved rank request is inconsistent.');
 const plan=result.data,ids=new Set<string>(),pairs=new Set<string>(),groupKeys=new Set<string>(),assigned=new Set<string>(),identities=new Map<string,string>();
 for(const task of plan.tasks){
  const pair=task.keywordId+':'+task.device,identity=JSON.stringify([task.keyword,task.matchCase]),request=rankTaskRequest(plan,task);
  if(task.id!==task.id.toLowerCase()||task.keywordId!==task.keywordId.toLowerCase()||ids.has(task.id)||pairs.has(pair)||identities.has(task.keywordId)&&identities.get(task.keywordId)!==identity||request.domain!==plan.target.domain)throw new FoundationError(409,'The saved rank task is inconsistent.');
  identities.set(task.keywordId,identity);ids.add(task.id);pairs.add(pair);
 }
 if(identities.size>1000)throw new FoundationError(409,'The saved rank keyword set exceeds its supported size.');
 const tasks=new Map(plan.tasks.map(task=>[task.id,task]));
 for(const group of plan.groups){
  if(group.requestKey!==group.requestKey.toLowerCase()||groupKeys.has(group.requestKey)||group.taskIds.length>(plan.method==='live'?1:100))throw new FoundationError(409,'The saved rank dispatch is inconsistent.');groupKeys.add(group.requestKey);
  for(const id of group.taskIds){if(!tasks.has(id)||assigned.has(id))throw new FoundationError(409,'The saved rank dispatch is inconsistent.');assigned.add(id);}
  if(Buffer.byteLength(JSON.stringify(rankGroupPayload(plan,group)))>131072)throw new FoundationError(409,'The saved rank dispatch is inconsistent.');
 }
 if(assigned.size!==tasks.size)throw new FoundationError(409,'The saved rank request is inconsistent.');
 return plan;
}
