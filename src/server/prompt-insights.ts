import {toUSVString} from 'node:util';
import type {PoolClient} from 'pg';
import {z} from 'zod';
import {FoundationError} from './auth.ts';
import {canonicalHash,classifyPrompt,contextHost} from './context-input.ts';
import {csvCell,explorerQuery} from './explorer-input.ts';
import {executionInput,promptModels} from './openrouter-input.ts';
import {contentProfile,withContentProject,type ContentProject} from './project-context.ts';
import {matchAnswer,AnswerMentionError,type MentionSubject,type MentionMethod,type AnswerMention} from './answer-mentions.ts';

export type InsightFilters={from:string;to:string;timeZone:string;model:string|null;promptId:string|null;tag:string|null;matcher:MentionMethod};
export type InsightEligibility='eligible'|'queued'|'running'|'no_answer'|'empty'|'truncated'|'content_filtered'|'expired'|'invalid';
export type InsightCoverage=Record<InsightEligibility,number>&{attempted:number};
export type InsightMetric={id:string;mentions:number;eligibleAnswers:number|null;shareOfVoiceDenominator:number|null;citations:number;citationDenominator:number|null};
export type InsightExecution={id:string;comparisonId:string;promptId:string;versionId:string;requestedAt:string;date:string;model:string;resolvedModel:string|null;status:string;eligibility:InsightEligibility;matches:AnswerMention[]|null};
type Drilldown={entityId:string|null;outcome:'all'|'mentioned'|'not_mentioned'|'cited'|'eligible'|'unavailable'};
export type PromptInsightsReport={role:ContentProject['role'];filters:InsightFilters;drilldown:Drilldown;asOf:string;contextRevision:number;profileHash:string;matcherVersion:MentionMethod;selectionRevision:string;label:string;warnings:string[];subjects:MentionSubject[];coverage:InsightCoverage;evidenceStates:Pick<InsightExecution,'id'|'eligibility'>[];metrics:InsightMetric[];daily:{date:string;coverage:InsightCoverage;metrics:InsightMetric[]}[];executions:InsightExecution[];totalRows:number;nextCursor:string|null};
const label='Recomputed from retained answers using current project context';
const hex=z.string().regex(/^[a-f0-9]{64}$(?![\s\S])/),uuid=z.uuid().transform(v=>v.toLowerCase());
const keys=['from','to','timeZone','model','promptId','tag','matcher','entityId','outcome','cursor'];
const cap=()=>new FoundationError(413,'Narrow the date range. This report exceeds its analysis capacity.');
const bad=()=>new FoundationError(400,'Check the AI insight filters and try again.');
function parseQuery(params:URLSearchParams){
 if(params.toString().length>4096)throw bad();
 for(const key of params.keys())if(!keys.includes(key)||params.getAll(key).length!==1)throw bad();
 const dateParams=new URLSearchParams();for(const key of ['from','to','timeZone'])if(params.has(key))dateParams.set(key,params.get(key)!);
 const {from,to,timeZone}=explorerQuery(dateParams);if(Date.parse(to)-Date.parse(from)>30*86400000)throw bad();
 const model=params.get('model'),rawPrompt=params.get('promptId'),tag=params.get('tag'),matcher=params.get('matcher')??'unicode-boundary-v1';
 if(model!==null&&!promptModels.includes(model as typeof promptModels[number]))throw bad();
 if(tag!==null&&(!tag||tag.length>80||tag.trim()!==tag||toUSVString(tag)!==tag||tag.includes('\0')))throw bad();
 if(!['elmo-substring-v1','unicode-boundary-v1'].includes(matcher))throw bad();
 const parsedId=rawPrompt===null?null:uuid.safeParse(rawPrompt);if(parsedId!==null&&!parsedId.success)throw bad();
 const entityId=params.get('entityId'),outcome=params.get('outcome')??'all';
 if(!['all','mentioned','not_mentioned','cited','eligible','unavailable'].includes(outcome)||
  (entityId!==null&&(entityId.length>100||!entityId))||(['mentioned','not_mentioned','cited'].includes(outcome)!==(entityId!==null)))throw bad();
 return {filters:{from,to,timeZone,model,promptId:parsedId?.data??null,tag,matcher:matcher as MentionMethod},
  drilldown:{entityId,outcome:outcome as Drilldown['outcome']},cursor:params.get('cursor')};
}
export const insightFilters=(params:URLSearchParams)=>parseQuery(params).filters;
const stamp=(column:string)=>`to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const expired=`(e.result_purged_at IS NOT NULL OR (e.result IS NOT NULL AND e.completed_at IS NOT NULL AND e.completed_at<transaction_timestamp()-w.raw_provider_evidence_days*interval '24 hours'))`;
const inputExpired=`(q.input_purged_at IS NOT NULL OR (EXISTS(SELECT 1 FROM prompt_execution child WHERE child.comparison_id=c.id)
 AND NOT EXISTS(SELECT 1 FROM prompt_execution child WHERE child.comparison_id=c.id AND
 (child.status IN('queued','running') OR child.completed_at IS NULL OR child.completed_at>=transaction_timestamp()-w.raw_provider_evidence_days*interval '24 hours'))))`;
const fromSql=`FROM prompt_comparison c JOIN prompt_execution e ON e.comparison_id=c.id AND e.project_id=c.project_id
 JOIN prompt_execution_quote q ON q.id=c.quote_id AND q.project_id=c.project_id
 JOIN project_prompt p ON p.id=q.prompt_id AND p.project_id=c.project_id
 JOIN workspace w ON w.id=c.workspace_id
 WHERE c.project_id=$1 AND c.created_at >= ($2::date::timestamp AT TIME ZONE 'UTC')-interval '2 days'
 AND c.created_at < (($3::date+1)::timestamp AT TIME ZONE 'UTC')+interval '2 days'
 AND (c.created_at AT TIME ZONE $4)::date BETWEEN $2::date AND $3::date
 AND ($5::text IS NULL OR e.route->>'model'=$5) AND ($6::uuid IS NULL OR q.prompt_id=$6)
 AND ($7::text IS NULL OR p.user_tags ? $7)`;
type Stored={id:string;comparisonId:string;promptId:string;versionId:string;requestedAt:string;date:string;model:string;status:string;expired:boolean;resultHash:string|null;tags:string[];hasResult:boolean};
export type InsightIdentity={state:'available'|'unavailable'|'invalid';requestHash:string|null;maxCompletionTokens:number|null;isBranded:boolean;promptPreview:string};
const safeText=z.string().refine(v=>toUSVString(v)===v&&!v.includes('\0'));
const answer=z.object({text:safeText.max(250000),resolvedModel:z.enum(promptModels),provider:z.literal('OpenAI'),finishReason:z.enum(['stop','length','content_filter']),
 citations:z.array(z.object({url:safeText.max(2048).refine(v=>{try{const u=new URL(v);return u.protocol==='https:'&&!u.username&&!u.password;}catch{return false;}}),title:safeText.nullable()})).max(100)});
function coverage():InsightCoverage{return {attempted:0,eligible:0,queued:0,running:0,no_answer:0,empty:0,truncated:0,content_filtered:0,expired:0,invalid:0};}
function metrics(subjects:MentionSubject[],rows:InsightExecution[]):InsightMetric[]{
 const eligible=rows.filter(r=>r.eligibility==='eligible'),counts=subjects.map(s=>({id:s.id,mentions:0,citations:0}));
 for(const row of eligible)for(let i=0;i<counts.length;i++){counts[i].mentions+=Number(row.matches![i].mentioned);counts[i].citations+=Number(row.matches![i].cited);}
 const denominator=counts.reduce((n,c)=>n+c.mentions,0);
 return counts.map(c=>({...c,eligibleAnswers:eligible.length||null,shareOfVoiceDenominator:denominator||null,citationDenominator:eligible.length||null}));
}
function count(rows:InsightExecution[]):InsightCoverage{const c=coverage();for(const row of rows){c.attempted++;c[row.eligibility]++;}return c;}
function error(error:unknown):never{if((error as {code?:string})?.code==='57014')throw new FoundationError(503,'This insight report took too long. Narrow the date range.');throw error;}

/** Current membership is admitted into one repeatable-read snapshot. Report dates
 * describe comparison requests; missing days are not carried or seeded. No ledger
 * join can accidentally remove a valid answer whose charge is still uncertain. */
export async function selectPromptInsights(client:PoolClient,p:ContentProject,filters:InsightFilters,check:()=>void,comparison=false){
 await client.query("SET LOCAL statement_timeout='5s'");check();
 if(!(await client.query('SELECT 1 FROM pg_timezone_names WHERE name=$1',[filters.timeZone])).rowCount)throw bad();
 if(filters.promptId&&!(await client.query('SELECT 1 FROM project_prompt WHERE project_id=$1 AND id=$2',[p.id,filters.promptId])).rowCount)throw new FoundationError(404,'Prompt not found or unavailable.');
 const profile=await contentProfile(client,p),competitors=(await client.query<{id:string;name:string|null;primary_domain:string;aliases:string[];domains:string[]}>('SELECT id,name,primary_domain,aliases,domains FROM context_competitor WHERE project_id=$1 ORDER BY id LIMIT 101',[p.id])).rows;
 if(competitors.length>100)throw cap();const warnings:string[]=[];let domain:string[]=[];
 try{domain=[contextHost(new URL(p.origin).hostname)];}catch{warnings.push('The project origin is not a public citation identity. Brand name and aliases still apply.');}
 const subjects:MentionSubject[]=[{id:'brand',name:profile.name,aliases:profile.aliases,domains:domain},...competitors.map(c=>({id:c.id,name:c.name||c.primary_domain,aliases:c.aliases,domains:c.domains}))];
 // Validate authored identities even for an empty report, without scanning text.
 try{matchAnswer({text:'',subjects,citationUrls:[],method:filters.matcher});}catch(e){if(e instanceof AnswerMentionError)throw new FoundationError(409,'Current project identities cannot be analyzed. Review the brand and competitor names, aliases and domains.');throw e;}
 const profileHash=canonicalHash(subjects),values=[p.id,filters.from,filters.to,filters.timeZone,filters.model,filters.promptId,filters.tag];
 // The LIMIT is a capacity check, never a sampled report. Payloads are not loaded
 // until BOTH limits pass, and expired text is neither loaded nor hashed.
 const bounds=(await client.query<{n:number;bytes:string}>(`SELECT count(*)::int AS n,COALESCE(sum(bytes),0)::text AS bytes FROM
 (SELECT CASE WHEN ${expired} THEN 0 ELSE COALESCE(octet_length(e.result::text),0) END AS bytes ${fromSql} LIMIT 1001) bounded`,values)).rows[0];
 if(bounds.n>1000||BigInt(bounds.bytes)>10n*1024n*1024n)throw cap();check();
 // Only the comparison caller needs copied request identity. Count unique quotes
 // before loading any raw input; expired payload is never loaded or hashed.
 if(comparison){const inputs=(await client.query<{bytes:string}>(`SELECT COALESCE(sum(bytes),0)::text AS bytes FROM
   (SELECT DISTINCT q.id,CASE WHEN ${inputExpired} THEN 0 ELSE COALESCE(octet_length(q.input::text),0)+COALESCE(octet_length(q.messages::text),0) END AS bytes ${fromSql}) bounded`,values)).rows[0];
  if(BigInt(bounds.bytes)+BigInt(inputs.bytes)>10n*1024n*1024n)throw cap();}
 const stored=(await client.query<Stored>(`SELECT e.id,c.id AS "comparisonId",q.prompt_id AS "promptId",q.version_id AS "versionId",
 ${stamp('c.created_at')} AS "requestedAt",(c.created_at AT TIME ZONE $4)::date::text AS date,e.route->>'model' AS model,e.status,
 ${expired} AS expired,e.result IS NOT NULL AS "hasResult",p.user_tags AS tags,
 CASE WHEN ${expired} THEN NULL ELSE encode(sha256(convert_to(e.result::text,'UTF8')),'hex') END AS "resultHash"
 ${fromSql} ORDER BY c.created_at DESC,c.id DESC,e.position,e.id`,values)).rows;
 const identities=new Map<string,InsightIdentity>();
 if(comparison){
  const captured=(await client.query(`SELECT e.id,q.prompt_id,q.version_id,e.route,v.text,${inputExpired} AS input_expired,
    CASE WHEN ${inputExpired} THEN NULL ELSE q.input END AS input,CASE WHEN ${inputExpired} THEN NULL ELSE q.messages END AS messages,p.user_tags
    ${fromSql.replace(' WHERE c.project_id', ' JOIN prompt_text_version v ON v.id=q.version_id AND v.prompt_id=q.prompt_id AND v.project_id=q.project_id WHERE c.project_id')}`,values)).rows;
  for(const row of captured){check();const identity:InsightIdentity={state:'unavailable',requestHash:null,maxCompletionTokens:null,isBranded:classifyPrompt(row.text,profile.name,p.origin,profile.aliases,row.user_tags).isBranded,promptPreview:(row.text as string).slice(0,160).replace(/[\uD800-\uDBFF]$/,'')};
   if(!row.input_expired){const parsed=executionInput.safeParse(row.input);identity.state='invalid';
    if(parsed.success){const input=parsed.data,messages=[...(input.systemText?[{role:'system',content:input.systemText}]:[]),{role:'user',content:row.text}];
     const saved=z.array(z.object({role:z.enum(['system','user']),content:safeText.max(4000)}).strict()).min(1).max(2).safeParse(row.messages);
     if(saved.success&&input.promptId.toLowerCase()===row.prompt_id&&input.versionId.toLowerCase()===row.version_id&&input.models.includes(row.route?.model)&&row.route?.tag==='openai'&&row.route?.providerName==='OpenAI'&&canonicalHash(messages)===canonicalHash(saved.data)){
      identity.state='available';identity.maxCompletionTokens=input.maxCompletionTokens;
      identity.requestHash=canonicalHash({profile:'openrouter-api-text-no-search-v1',promptId:row.prompt_id,versionId:row.version_id,messages,maxCompletionTokens:input.maxCompletionTokens,model:row.route.model,provider:'openai',serviceTier:'default',fallback:false});
     }
    }
   }identities.set(row.id,identity);
  }
 }
 const payloadIds=stored.filter(r=>r.hasResult&&!r.expired).map(r=>r.id);
 const payloads=new Map<string,unknown>(payloadIds.length?(await client.query<{id:string;result:unknown}>('SELECT id,result FROM prompt_execution WHERE project_id=$1 AND id=ANY($2::uuid[])',[p.id,payloadIds])).rows.map(r=>[r.id,r.result]):[]);
 const observations:InsightExecution[]=[];let work=0;
 // Conservative upper bound, before matching: includes duplicates and domains
 // even when a method would deduplicate/omit them. This is not silent sampling.
 const terms=Math.max(1,subjects.reduce((n,s)=>n+1+s.aliases.length+(filters.matcher==='elmo-substring-v1'?s.domains.length:0),0));
 for(const row of stored){check();let eligibility:InsightEligibility,parsed:z.infer<typeof answer>|null=null,matches:AnswerMention[]|null=null;
  if(row.expired)eligibility='expired';
  else if(!row.hasResult)eligibility=row.status==='queued'?'queued':row.status==='running'?'running':'no_answer';
  else{const result=answer.safeParse(payloads.get(row.id));
   if(!result.success||result.data.resolvedModel!==row.model)eligibility='invalid';
   else{parsed=result.data;eligibility=parsed.finishReason==='length'?'truncated':parsed.finishReason==='content_filter'?'content_filtered':!parsed.text.trim()?'empty':'eligible';}
  }
  if(eligibility==='eligible'){
   work+=parsed!.text.length*terms;if(work>100_000_000)throw cap();
   try{matches=matchAnswer({text:parsed!.text,subjects,citationUrls:parsed!.citations.map(c=>c.url),method:filters.matcher});}catch(e){if(e instanceof AnswerMentionError)throw cap();throw e;}
  }
  observations.push({id:row.id,comparisonId:row.comparisonId,promptId:row.promptId,versionId:row.versionId,requestedAt:row.requestedAt,date:row.date,model:row.model,status:row.status,resolvedModel:parsed?.resolvedModel??null,eligibility,matches});
 }
 check();const asOf=(await client.query<{at:string}>(`SELECT ${stamp('transaction_timestamp()')} AS at`)).rows[0].at;
 const scope=canonicalHash({projectId:p.id,filters}),selectionRevision=canonicalHash({scope,contextRevision:profile.revision,profileHash,stored});
 const daily:PromptInsightsReport['daily']=[];
 for(let day=Date.parse(filters.from);day<=Date.parse(filters.to);day+=86400000){const date=new Date(day).toISOString().slice(0,10),rows=observations.filter(r=>r.date===date);daily.push({date,coverage:count(rows),metrics:metrics(subjects,rows)});}
 return {scope,observations,identities,report:{role:p.role,filters,asOf,contextRevision:profile.revision,profileHash,matcherVersion:filters.matcher,selectionRevision,label,warnings,subjects,coverage:count(observations),evidenceStates:observations.map(({id,eligibility})=>({id,eligibility})),metrics:metrics(subjects,observations),daily}};
}
const cursorSchema=z.object({scope:hex,revision:hex,offset:z.number().int().min(1).max(999)}).strict();
function pageOffset(raw:string|null,scope:string,revision:string){
 if(raw===null)return 0;let input:unknown;
 try{if(!raw||raw.length>512||!/^[A-Za-z0-9_-]+$(?![\s\S])/.test(raw))throw bad();input=JSON.parse(Buffer.from(raw,'base64url').toString('utf8'));}catch{throw bad();}
 const parsed=cursorSchema.safeParse(input);if(!parsed.success||parsed.data.scope!==scope)throw bad();
 if(parsed.data.revision!==revision)throw new FoundationError(409,'The insight selection changed. Reload the report.');return parsed.data.offset;
}
function deadline(signal?:AbortSignal){const started=Date.now();return()=>{if(signal?.aborted)throw new FoundationError(499,'Insight request cancelled.');if(Date.now()-started>30000)throw new FoundationError(503,'This insight report took too long. Narrow the date range.');};}
export async function getPromptInsights(projectId:string,userId:string,params=new URLSearchParams()):Promise<PromptInsightsReport>{
 const input=parseQuery(params),check=deadline();
 return withContentProject(projectId,userId,false,async(client,p)=>{const selected=await selectPromptInsights(client,p,input.filters,check),{drilldown}=input;
  if(drilldown.entityId!==null&&!selected.report.subjects.some(s=>s.id===drilldown.entityId))throw bad();
  const rows=selected.observations.filter(r=>{if(drilldown.outcome==='all')return true;if(drilldown.outcome==='eligible')return r.eligibility==='eligible';if(drilldown.outcome==='unavailable')return r.eligibility!=='eligible';
   if(!r.matches)return false;const m=r.matches.find(v=>v.id===drilldown.entityId)!;return drilldown.outcome==='mentioned'?m.mentioned:drilldown.outcome==='not_mentioned'?!m.mentioned:m.cited;});
  const scope=canonicalHash({scope:selected.scope,drilldown}),offset=pageOffset(input.cursor,scope,selected.report.selectionRevision),next=offset+50;
  return {...selected.report,drilldown,executions:rows.slice(offset,next),totalRows:rows.length,nextCursor:next<rows.length?Buffer.from(JSON.stringify({scope,revision:selected.report.selectionRevision,offset:next})).toString('base64url'):null};
 }).catch(error);
}
export async function exportPromptInsights(projectId:string,userId:string,raw:unknown,signal?:AbortSignal){
 const shape=z.object({from:z.string(),to:z.string(),timeZone:z.string(),model:z.string().nullable().optional(),promptId:z.string().nullable().optional(),tag:z.string().nullable().optional(),matcher:z.string(),expectedSelectionRevision:hex}).strict();
 const parsed=shape.safeParse(raw);if(!parsed.success)throw bad();const {expectedSelectionRevision,...values}=parsed.data,params=new URLSearchParams();
 for(const [key,value]of Object.entries(values))if(value!==null&&value!==undefined)params.set(key,value);
 const {filters}=parseQuery(params),check=deadline(signal);check();
 return withContentProject(projectId,userId,false,async(client,p)=>{const {report,observations}=await selectPromptInsights(client,p,filters,check);
  if(report.selectionRevision!==expectedSelectionRevision)throw new FoundationError(409,'The insight selection changed. Reload the report before exporting.');
  const lines:string[]=[];let bytes=0,rowCount=0;
  const line=(cells:unknown[])=>{check();const value=[...cells,...Array(Math.max(0,26-cells.length)).fill('')].map(csvCell).join(',')+'\r\n';bytes+=Buffer.byteLength(value);if(bytes>16*1024*1024)throw new FoundationError(413,'The insight export exceeds 16 MiB. Narrow the date range.');lines.push(value);};
  line(['Record','As of','Context revision','Profile hash','Matcher','Selection revision','Filters','Current identities','Date','Coverage','Entity ID','Mentions','Eligible answers','Share-of-voice denominator','Citation hits','Citation denominator','Execution ID','Comparison ID','Prompt ID','Version ID','Requested at','Requested model','Resolved model','Receipt status','Eligibility','Matches']);
  const prefix=[report.asOf,report.contextRevision,report.profileHash,report.matcherVersion,report.selectionRevision,filters,report.subjects];
  line(['coverage',...prefix,'',report.coverage]);rowCount++;
  for(const metric of report.metrics){line(['entity',...prefix,'','',metric.id,metric.mentions,metric.eligibleAnswers,metric.shareOfVoiceDenominator,metric.citations,metric.citationDenominator]);rowCount++;}
  for(const day of report.daily)for(const metric of day.metrics){line(['daily',...prefix,day.date,day.coverage,metric.id,metric.mentions,metric.eligibleAnswers,metric.shareOfVoiceDenominator,metric.citations,metric.citationDenominator]);rowCount++;}
  for(const row of observations){line(['execution',...prefix,row.date,'','','','','','','',row.id,row.comparisonId,row.promptId,row.versionId,row.requestedAt,row.model,row.resolvedModel,row.status,row.eligibility,row.matches]);rowCount++;}
  check();return {role:p.role,filename:'prompt-insights.csv',contentType:'text/csv; charset=utf-8',rowCount,body:lines.join('')};
 }).catch(error);
}
