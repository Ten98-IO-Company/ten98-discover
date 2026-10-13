import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {z} from 'zod';
import {FoundationError} from './auth.ts';
import {parse} from './context-input.ts';
import {contentCursor,contentReceipt,readContentCursor,withContentProject} from './project-context.ts';
import {explorerFilters,explorerQuery} from './explorer-input.ts';
import {analyticsScopeSql,analyticsScopeValues} from './analytics-scope.ts';
import {retentionCoverage} from './retention.ts';
import {parseAnalysisDefinition,type AnalysisDefinition,type Match,type PropertyPredicate} from './funnel-input.ts';

export type AnalysisKind='funnel'|'goal';
type Role='owner'|'admin'|'editor'|'viewer';
export type AnalysisItem={id:string;projectId:string;revision:number;definition:AnalysisDefinition;createdAt:string;updatedAt:string};
export type AnalysisResult={
  role:Role;item:AnalysisItem;range:{from:string;to:string;timeZone:string;start:string;end:string};query:ReturnType<typeof explorerQuery>;
  generatedAt:string;method:typeof analysisMethod;coverage:{status:'complete'|'partial'|'unavailable';retainedFrom:string|null;countsAreLowerBounds:boolean};
  identity:{status:'complete'|'partial'|'unavailable';identifiedEvents:number|null;unidentifiedEvents:number|null;visitors:number|null};
  steps:{step:number;visitors:number|null;dropped:number|null;conversionRate:number|null;remainingRate:number|null}[];
  goal:{visitors:number|null;totalVisitors:number|null;rate:number|null}|null;
};
export type AnalysisWitnessResult=AnalysisResult&{step:number;witnesses:{events:Evidence[]}[];nextCursor:string|null};
type DefinitionRow={id:string;project_id:string;kind:AnalysisKind;definition:AnalysisDefinition;revision:number;created_at:Date;updated_at:Date};
const columns='id,project_id,kind,definition,revision,created_at,updated_at';
const revision=z.number().int().positive().max(2147483647);
const request=z.object({requestId:z.uuid()}).strict();
function unavailable():never{throw new FoundationError(404,'Analysis not found or unavailable.');}
function bad(message='Check the analysis fields and try again.'):never{throw new FoundationError(400,message);}
function kindValue(value:unknown):AnalysisKind{return parse(z.enum(['funnel','goal']),value);}
function dto(row:DefinitionRow):AnalysisItem{return {id:row.id,projectId:row.project_id,revision:row.revision,definition:row.definition,createdAt:row.created_at.toISOString(),updatedAt:row.updated_at.toISOString()};}
async function find(client:PoolClient,projectId:string,kind:AnalysisKind,id:string){
  return (await client.query<DefinitionRow>(`SELECT ${columns} FROM analytics_definition WHERE project_id=$1 AND kind=$2 AND id=$3`,[projectId,kind,id])).rows[0];
}
function oneCursor(params:URLSearchParams){
  if([...params.keys()].some(key=>key!=='cursor')||params.getAll('cursor').length>1)bad('Use one analysis list cursor.');
  return params.get('cursor');
}

export async function listAnalyses(projectId:unknown,userId:unknown,kind:AnalysisKind,params:URLSearchParams){
  kind=kindValue(kind);const value=oneCursor(params);
  return withContentProject(projectId,userId,false,async(client,project)=>{
    const scope={projectId:project.id,list:'analyses',kind},after=readContentCursor(value,scope);
    const {rows}=await client.query<DefinitionRow>(`SELECT ${columns} FROM analytics_definition WHERE project_id=$1 AND kind=$2
      AND ($3::timestamptz IS NULL OR (created_at,id)<($3::timestamptz,$4::uuid)) ORDER BY created_at DESC,id DESC LIMIT 51`,[project.id,kind,after?.at??null,after?.id??null]);
    return {role:project.role,items:rows.slice(0,50).map(dto),nextCursor:rows.length>50?contentCursor({id:rows[49].id,createdAt:rows[49].created_at},scope):null};
  });
}
export async function getAnalysis(projectId:unknown,userId:unknown,kind:AnalysisKind,analysisId:unknown){
  kind=kindValue(kind);const id=parse(z.uuid(),analysisId);
  return withContentProject(projectId,userId,false,async(client,project)=>{
    const row=await find(client,project.id,kind,id);if(!row)unavailable();return {role:project.role,item:dto(row)};
  });
}
export async function saveAnalysis(projectId:unknown,userId:unknown,kind:AnalysisKind,raw:unknown,analysisId?:unknown){
  kind=kindValue(kind);const id=analysisId===undefined?null:parse(z.uuid(),analysisId),uid=parse(z.uuid(),userId);
  const input=parse(id?request.extend({revision,definition:z.unknown()}):request.extend({definition:z.unknown()}),raw);
  const definition=parseAnalysisDefinition(input.definition);if(definition.kind!==kind)bad('The definition type does not match this analysis.');
  return withContentProject(projectId,uid,true,async(client,project)=>{
    const receipt=await contentReceipt(client,project.id,input.requestId,`analysis.${id?'update:'+id:'create:'+kind}`,{userId:uid,...input,definition});
    if(receipt.replayed){
      const row=await find(client,project.id,kind,receipt.result.id);
      return {role:project.role,item:row?dto(row):null,deleted:!row,replayed:true};
    }
    let row:DefinitionRow;
    if(id){
      const old=await find(client,project.id,kind,id);if(!old)unavailable();
      if(old.revision!==('revision' in input?input.revision:null))throw new FoundationError(409,'This analysis changed. Reload its saved definition before saving again.');
      if(old.revision===2147483647)throw new FoundationError(409,'This definition reached its revision limit. Save a new definition instead.');
      row=(await client.query<DefinitionRow>(`UPDATE analytics_definition SET definition=$4,revision=revision+1,updated_at=clock_timestamp() WHERE project_id=$1 AND kind=$2 AND id=$3 RETURNING ${columns}`,[project.id,kind,id,JSON.stringify(definition)])).rows[0];
    }else{
      row=(await client.query<DefinitionRow>(`INSERT INTO analytics_definition(id,project_id,kind,definition) VALUES($1,$2,$3,$4) RETURNING ${columns}`,[randomUUID(),project.id,kind,JSON.stringify(definition)])).rows[0];
    }
    await receipt.save({id:row.id});return {role:project.role,item:dto(row),deleted:false,replayed:false};
  });
}
export async function deleteAnalysis(projectId:unknown,userId:unknown,kind:AnalysisKind,analysisId:unknown,raw:unknown){
  kind=kindValue(kind);const id=parse(z.uuid(),analysisId),uid=parse(z.uuid(),userId),input=parse(request.extend({revision}),raw);
  return withContentProject(projectId,uid,true,async(client,project)=>{
    const receipt=await contentReceipt(client,project.id,input.requestId,`analysis.delete:${id}`,{userId:uid,kind,...input});
    if(receipt.replayed)return {role:project.role,id,deleted:true as const,replayed:true};
    const old=await find(client,project.id,kind,id);if(!old)unavailable();
    if(old.revision!==input.revision)throw new FoundationError(409,'This analysis changed. Reload its saved definition before deleting it.');
    await client.query('DELETE FROM analytics_definition WHERE project_id=$1 AND kind=$2 AND id=$3',[project.id,kind,id]);
    await receipt.save({id});return {role:project.role,id,deleted:true as const,replayed:false};
  });
}

export const analysisMethod={version:'ten98-ordered-visitors-v1',unit:'estimated_visitors',filterScope:'all_steps',ordering:'strict_server_receipt_time',window:'adjacent_steps_inclusive_upper',equalTimestamps:'cannot_advance',funnelPath:'activity_at_path',goalPath:'pageviews_only',eventSteps:'custom_events_only',propertyComparison:'typed_case_sensitive_literal'} as const;
function queryInput(params:URLSearchParams,witness:boolean){
  if(params.toString().length>22000)bad('The analysis query is too large.');
  const allowed=new Set(['revision','from','to','timeZone','propertyKey','propertyType','propertyValue',...explorerFilters,...(witness?['step','cursor']:[])]);
  for(const key of params.keys())if(!allowed.has(key)||params.getAll(key).length!==1)bad('Use each supported analysis filter only once.');
  if(!/^[1-9][0-9]{0,9}(?![\s\S])/.test(params.get('revision')??''))bad('Choose the current saved analysis revision.');
  const expected=parse(revision,Number(params.get('revision'))),scope=new URLSearchParams(params);
  for(const key of ['revision','step','cursor'])scope.delete(key);
  const step=params.get('step');if(step!==null&&!/^[1-8](?![\s\S])/.test(step))bad('Choose a funnel step from 1 to 8.');
  return {revision:expected,query:explorerQuery(scope),step:step===null?null:Number(step),cursor:params.get('cursor')};
}

// Parameter values never become SQL. Only fixed operators/column names enter templates.
function predicate(match:Match,bind:(value:unknown)=>string,goal=false){
  const column=match.type==='path'?'s.path':'s.event_name',value=bind(match.value);
  const matches=match.match==='exact'?`${column}=${value}`:match.match==='prefix'?`starts_with(${column},${value})`:match.match==='suffix'?`right(${column},char_length(${value}))=${value}`:`strpos(${column},${value})>0`;
  return `(${matches})${match.type==='event'?" AND s.event_name<>'page_view'":goal?" AND s.event_name='page_view'":''}`;
}
function propertyPredicate(filter:PropertyPredicate,bind:(value:unknown)=>string){
  const key=bind(filter.key);
  if(filter.operator==='missing')return `NOT (s.properties ? ${key})`;
  const type=bind(filter.type),present=`s.properties ? ${key} AND s.properties->${key}->>'type'=${type}`;
  if(filter.operator==='contains'||filter.operator==='not_contains')return `(${present} AND strpos(s.properties->${key}->>'value',${bind(filter.value)})${filter.operator==='contains'?'>0':'=0'})`;
  return `(${present} AND s.properties->${key}->'value'${filter.operator==='eq'?'=':'<>'}${bind(JSON.stringify(filter.value))}::jsonb)`;
}
export type AnalysisEvidence={id:string;eventName:string;path:string;origin:string;receivedAt:string};
type Evidence=AnalysisEvidence;
type QueryRow={retained_from:Date|null;start:Date;finish:Date;generated_at:Date;events:string;identified:string;visitors:string;counts:number[];witnesses:{id:string;at:string;events:Evidence[]}[];anchor_found:boolean};
type ScopeQuery=ReturnType<typeof explorerQuery>;
async function calculate(client:PoolClient,projectId:string,userId:string,definition:AnalysisDefinition,query:ScopeQuery,step:number,cursorId:string|null,witness:boolean){
  const values=analyticsScopeValues(projectId,userId,query),bind=(value:unknown)=>{values.push(value);return `$${values.length}`;};
  const steps=definition.kind==='funnel'?definition.steps:[definition.condition],levels:string[]=[];
  const window=definition.kind==='funnel'?bind(definition.windowMinutes):null;
  for(let i=0;i<steps.length;i++){
    const current=steps[i];let condition=predicate(current,bind,definition.kind==='goal');
    if(definition.kind==='funnel'){
      const configured=definition.steps[i];
      if(configured.pageViewsOnly)condition+=" AND s.event_name='page_view'";
      for(const property of configured.properties)condition+=` AND ${propertyPredicate(property,bind)}`;
    }
    // Keep every reachable ending, not a greedy first attempt. A monotone ordinal
    // identifies the latest earlier reachable predecessor without pair expansion.
    // Candidates sort before prior endpoints at equal times, so ties never advance.
    levels.push(i===0?`r1 AS MATERIALIZED (SELECT s.id,s.visitor_id,s.received_at,ARRAY[s.id] AS chain,
        row_number() OVER(PARTITION BY s.visitor_id ORDER BY s.received_at,s.id) AS ordinal
      FROM scope s WHERE s.visitor_id IS NOT NULL AND ${condition})`:
      `ordered${i+1} AS (
        SELECT id,visitor_id,received_at,kind,chain,max(ordinal) OVER(PARTITION BY visitor_id ORDER BY received_at,kind,id ROWS UNBOUNDED PRECEDING) AS predecessor
        FROM (SELECT s.id,s.visitor_id,s.received_at,0 AS kind,NULL::bigint AS ordinal,NULL::uuid[] AS chain FROM scope s WHERE s.visitor_id IS NOT NULL AND ${condition}
          UNION ALL SELECT p.id,p.visitor_id,p.received_at,1 AS kind,p.ordinal,p.chain FROM r${i} p) stream
      ),carried${i+1} AS (
        SELECT id,visitor_id,received_at,kind,predecessor,first_value(chain) OVER prior AS chain,first_value(received_at) OVER prior AS prior_time
        FROM ordered${i+1} WINDOW prior AS(PARTITION BY visitor_id,predecessor ORDER BY received_at,kind,id ROWS UNBOUNDED PRECEDING)
      ),r${i+1} AS MATERIALIZED (SELECT s.id,s.visitor_id,s.received_at,s.chain||s.id AS chain,
        row_number() OVER(PARTITION BY s.visitor_id ORDER BY s.received_at,s.id) AS ordinal
        FROM carried${i+1} s WHERE s.kind=0 AND s.predecessor IS NOT NULL AND s.prior_time<s.received_at AND s.prior_time>=s.received_at-${window}::integer*interval '1 minute')`);
  }
  const countSql=steps.map((_,i)=>`(SELECT count(DISTINCT visitor_id) FROM r${i+1})`).join(','),anchor=witness?bind(cursorId):null;
  // Chain IDs came from scope in this repeatable-read snapshot. Fetch at most
  // 51×8 event rows by primary key instead of repeatedly scanning that population.
  const witnessSql=witness?`,
    chosen AS MATERIALIZED (SELECT DISTINCT ON(visitor_id) id,visitor_id,received_at,chain FROM r${step} ORDER BY visitor_id,received_at,id),
    anchor AS (SELECT received_at,id FROM chosen WHERE id=${anchor}::uuid),
    witness_page AS MATERIALIZED (SELECT * FROM chosen WHERE ${anchor}::uuid IS NULL OR (received_at,id)>(SELECT received_at,id FROM anchor) ORDER BY received_at,id LIMIT 51),
    witness_chains AS (
      SELECT w.id,w.received_at,json_agg(json_build_object('id',s.id,'eventName',s.event_name,'path',s.path,'origin',COALESCE(s.dimensions->>'origin',(SELECT origin FROM target)),'receivedAt',s.received_at) ORDER BY c.position) AS events
      FROM witness_page w CROSS JOIN LATERAL unnest(w.chain) WITH ORDINALITY c(id,position) JOIN event s ON s.id=c.id AND s.project_id=$1 GROUP BY w.id,w.received_at
    )`:'';
  const {rows}=await client.query<QueryRow>(`${analyticsScopeSql},${levels.join(',')}${witnessSql}
    SELECT (SELECT analytics_retained_from FROM target) AS retained_from,(SELECT start FROM bounds) AS start,(SELECT finish FROM bounds) AS finish,
      statement_timestamp() AS generated_at,(SELECT count(*) FROM scope) AS events,(SELECT count(visitor_id) FROM scope) AS identified,
      (SELECT count(DISTINCT visitor_id) FROM scope) AS visitors,json_build_array(${countSql}) AS counts,
      ${witness?`${anchor}::uuid IS NULL OR EXISTS(SELECT 1 FROM anchor)`:'true'} AS anchor_found,
      ${witness?"COALESCE((SELECT json_agg(json_build_object('id',w.id,'at',w.received_at,'events',w.events) ORDER BY w.received_at,w.id) FROM witness_chains w),'[]'::json)":"'[]'::json"} AS witnesses`,values);
  return rows[0];
}

export function runAnalysis(projectId:unknown,userId:unknown,kind:AnalysisKind,analysisId:unknown,params:URLSearchParams,witness?:false):Promise<AnalysisResult>;
export function runAnalysis(projectId:unknown,userId:unknown,kind:AnalysisKind,analysisId:unknown,params:URLSearchParams,witness:true):Promise<AnalysisWitnessResult>;
export function runAnalysis(projectId:unknown,userId:unknown,kind:AnalysisKind,analysisId:unknown,params:URLSearchParams,witness:boolean):Promise<AnalysisResult|AnalysisWitnessResult>;
export async function runAnalysis(projectId:unknown,userId:unknown,kind:AnalysisKind,analysisId:unknown,params:URLSearchParams,witness=false):Promise<AnalysisResult|AnalysisWitnessResult>{
  kind=kindValue(kind);const id=parse(z.uuid(),analysisId),uid=parse(z.uuid(),userId),input=queryInput(params,witness);
  try{return await withContentProject(projectId,uid,false,async(client,project)=>{
    await client.query("SET LOCAL statement_timeout='5s'");
    const saved=await find(client,project.id,kind,id);if(!saved)unavailable();
    if(saved.revision!==input.revision)throw new FoundationError(409,'This analysis changed. Reload its saved definition before running it.');
    if(!(await client.query('SELECT 1 FROM pg_timezone_names WHERE name=$1',[input.query.timeZone])).rowCount)bad('The database does not support this timezone.');
    const definition=saved.definition,max=definition.kind==='funnel'?definition.steps.length:1,step=input.step??max;
    if(witness&&definition.kind==='funnel'&&input.step===null)bad('Choose the funnel step whose evidence you want to inspect.');
    if(step>max)bad('This analysis has no such step.');
    // Bind the full PostgreSQL timestamp precision; Date would truncate microseconds.
    const retained=(await client.query<{retained_marker:string|null}>('SELECT extract(epoch FROM analytics_retained_from)::text AS retained_marker FROM project WHERE id=$1',[project.id])).rows[0].retained_marker;
    const cursorScope={projectId:project.id,kind,id,revision:saved.revision,query:input.query,step,retainedFrom:retained};
    const after=readContentCursor(input.cursor,cursorScope);
    const row=await calculate(client,project.id,uid,definition,input.query,step,after?.id??null,witness);
    if(!row.anchor_found)throw new FoundationError(409,'The matching evidence changed. Reload this result before continuing.');
    const start=row.start.toISOString(),end=row.finish.toISOString(),coverage=retentionCoverage(start,end,row.retained_from);
    const events=Number(row.events),identified=Number(row.identified),population=Number(row.visitors);
    const known=coverage.status!=='unavailable'&&identified>0,rates=known&&coverage.status==='complete';
    const counts=row.counts.map(Number),first=counts[0];
    const result:AnalysisResult={role:project.role,item:dto(saved),range:{from:input.query.from,to:input.query.to,timeZone:input.query.timeZone,start,end},query:input.query,
      generatedAt:row.generated_at.toISOString(),method:analysisMethod,coverage:{...coverage,countsAreLowerBounds:coverage.status==='partial'},
      identity:{status:!known?'unavailable':identified<events?'partial':'complete',identifiedEvents:coverage.status==='unavailable'?null:identified,unidentifiedEvents:coverage.status==='unavailable'?null:events-identified,visitors:known?population:null},
      steps:definition.kind==='funnel'?counts.map((count,i)=>({step:i+1,visitors:known?count:null,dropped:rates&&i>0?counts[i-1]-count:null,
        conversionRate:rates&&i>0&&counts[i-1]>0?count/counts[i-1]:null,remainingRate:rates&&first>0?count/first:null})):[],
      goal:definition.kind==='goal'?{visitors:known?first:null,totalVisitors:known?population:null,rate:rates&&population>0?first/population:null}:null};
    if(!witness)return result;
    const visible=known?row.witnesses.slice(0,50):[],last=visible.at(-1);
    return {...result,step,witnesses:visible.map(item=>({events:item.events})),nextCursor:known&&row.witnesses.length>50&&last?contentCursor({id:last.id,createdAt:last.at},cursorScope):null};
  });}catch(error){
    if((error as {code?:string}).code==='57014')throw new FoundationError(503,'This analysis took too long. Choose a shorter date range or more filters.');
    throw error;
  }
}
