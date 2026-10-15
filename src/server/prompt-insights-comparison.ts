import type {InsightCoverage,InsightExecution,InsightFilters} from './prompt-insights.ts';
import type {MentionSubject,MentionMethod} from './answer-mentions.ts';
import {z} from 'zod';
import type {PoolClient} from 'pg';
import {FoundationError} from './auth.ts';
import {canonicalHash} from './context-input.ts';
import {csvCell} from './explorer-input.ts';
import {withContentProject,type ContentProject} from './project-context.ts';
import {insightFilters,selectPromptInsights} from './prompt-insights.ts';

export type ComparisonFilters=InsightFilters&{cohort:'current-neutral'|'all'};
/** Fractions of one, not percentages. Only delta may have a negative numerator. */
export type ComparisonFraction={numerator:string;denominator:string};
export type ComparisonStatus='no_data'|'no_previous'|'unavailable'|'scope_changed'|'in_progress'|'incomplete'|'comparable';
export type ComparisonPeriod={from:string;to:string;coverage:InsightCoverage;usable:number;
 /** Eligible answers excluded from cell rates because captured input cannot be used. */
 identityUnavailable:number;identityInvalid:number;excludedByCohort:number;cells:number;matchedCells:number;matchedExecutions:number};
export type ComparisonCellPart={attempted:number;usable:number;metrics:{id:string;mentions:number;citations:number}[]};
export type ComparisonCell={id:string;promptId:string;versionId:string;promptPreview:string;model:string;provider:string;maxCompletionTokens:number;
 status:'matched'|'current_only'|'previous_only'|'unavailable';current:ComparisonCellPart;previous:ComparisonCellPart};
export type ComparisonExecution=InsightExecution&{period:'current'|'previous';cellId:string|null;identity:'available'|'unavailable'|'invalid';usable:boolean};
export type ComparisonEvidenceState=Pick<ComparisonExecution,'id'|'period'|'eligibility'|'identity'>;
export type ComparisonNavigation={view:'cells'|'executions';period:'current'|'previous'|null;cellId:string|null;
 outcome:'all'|'usable'|'unavailable'|'mentioned'|'not_mentioned'|'cited';entityId:string|null};
export type PromptInsightsComparison={role:'owner'|'admin'|'editor'|'viewer';filters:ComparisonFilters;asOf:string;
 contextRevision:number;profileHash:string;matcherVersion:MentionMethod;selectionRevision:string;
 formulaVersion:'current-context-equal-cell-v1';eligibilityVersion:'retained-nonempty-stop-v1';classifierVersion:'elmo-substring-current-overrides-v1';
 label:string;warnings:string[];subjects:MentionSubject[];periodOpen:boolean;status:ComparisonStatus;
 current:ComparisonPeriod;previous:ComparisonPeriod;cellCount:number;evidenceStates:ComparisonEvidenceState[];headlineBasis:'matched_cells'|'current_cells'|'none';
 metrics:{id:string;current:ComparisonFraction|null;previous:ComparisonFraction|null;delta:ComparisonFraction|null;
 citationsCurrent:ComparisonFraction|null;citationsPrevious:ComparisonFraction|null;citationsDelta:ComparisonFraction|null}[];
 navigation:ComparisonNavigation;page:{kind:'cells';rows:ComparisonCell[]}|{kind:'executions';rows:ComparisonExecution[]};totalRows:number;nextCursor:string|null};

const formulaVersion='current-context-equal-cell-v1',eligibilityVersion='retained-nonempty-stop-v1',classifierVersion='elmo-substring-current-overrides-v1';
const label='Adjacent local-day comparison recomputed using current project context';
const baseKeys=['from','to','timeZone','model','promptId','tag','matcher'];
const navigationKeys=['view','period','cellId','outcome','entityId','cursor'];
const outcomes=['all','usable','unavailable','mentioned','not_mentioned','cited'];
const exactHex=z.string().regex(/^[a-f0-9]{64}$(?![\s\S])/);
const bad=()=>new FoundationError(400,'Check the comparison filters and try again.');
const changed=()=>new FoundationError(409,'The comparison evidence or current context changed. Reload the comparison.');
function parse(params:URLSearchParams){
 if(params.toString().length>4096)throw bad();for(const key of params.keys())if(![...baseKeys,'cohort',...navigationKeys].includes(key)||params.getAll(key).length!==1)throw bad();
 const base=new URLSearchParams();for(const k of baseKeys)if(params.has(k))base.set(k,params.get(k)!);
 const cohort=params.get('cohort')??'current-neutral';if(cohort!=='current-neutral'&&cohort!=='all')throw bad();
 const filters:ComparisonFilters={...insightFilters(base),cohort};
 const view=params.get('view')??'cells',period=params.get('period'),cellId=params.get('cellId'),outcome=params.get('outcome')??'all',entityId=params.get('entityId');
 if(!['cells','executions'].includes(view)||!outcomes.includes(outcome)||cellId!==null&&!exactHex.safeParse(cellId).success||
  (entityId!==null&&(entityId.length>100||!entityId))||(['mentioned','not_mentioned','cited'].includes(outcome)!==(entityId!==null))||
  (view==='cells'&&['period','cellId','outcome','entityId'].some(k=>params.has(k)))||view==='executions'&&!['current','previous'].includes(period??''))throw bad();
 return {filters,navigation:{view,period,cellId,outcome,entityId} as ComparisonNavigation,cursor:params.get('cursor')};
}
const emptyCoverage=():InsightCoverage=>({attempted:0,eligible:0,queued:0,running:0,no_answer:0,empty:0,truncated:0,content_filtered:0,expired:0,invalid:0});
const gcd=(a:bigint,b:bigint):bigint=>{a=a<0n?-a:a;while(b){const next=a%b;a=b;b=next;}return a;};
function fraction(n:bigint,d:bigint):ComparisonFraction{const g=gcd(n,d);return {numerator:(n/g).toString(),denominator:(d/g).toString()};}
export function equalCellMean(parts:{numerator:number;denominator:number}[]):ComparisonFraction|null{
 if(!Array.isArray(parts)||parts.length>1000||parts.some(p=>!p||!Number.isSafeInteger(p.numerator)||!Number.isSafeInteger(p.denominator)||p.numerator<0||p.denominator<1||p.denominator>1000||p.numerator>p.denominator))throw new RangeError('Invalid comparison fractions.');
 if(!parts.length)return null;let n=0n,d=1n;for(const p of parts){const denominator=BigInt(p.denominator);n=n*denominator+BigInt(p.numerator)*d;d*=denominator;const g=gcd(n,d);n/=g;d/=g;}return fraction(n,d*BigInt(parts.length));
}
export function comparisonDelta(now:ComparisonFraction|null,before:ComparisonFraction|null):ComparisonFraction|null{
 if(!now||!before)return null;
 for(const value of [now,before])if(!/^(?:0|[1-9]\d{0,4095})$(?![\s\S])/.test(value.numerator)||!/^[1-9]\d{0,4095}$(?![\s\S])/.test(value.denominator)||BigInt(value.numerator)>BigInt(value.denominator))throw new RangeError('Invalid comparison fractions.');
 const a=BigInt(now.numerator),b=BigInt(now.denominator),c=BigInt(before.numerator),d=BigInt(before.denominator);return fraction(a*d-c*b,b*d);
}
function previousRange(f:ComparisonFilters){const days=1+(Date.parse(f.to)-Date.parse(f.from))/86400000;
 const from=new Date(Date.parse(f.from)-days*86400000).toISOString().slice(0,10),to=new Date(Date.parse(f.from)-86400000).toISOString().slice(0,10);
 if(!/^[0-9]{4}-\d\d-\d\d$/.test(from)||from.startsWith('0000'))throw bad();return {from,to};}
function deadline(signal?:AbortSignal){const start=Date.now();return()=>{if(signal?.aborted)throw new FoundationError(499,'Comparison request cancelled.');if(Date.now()-start>30000)throw new FoundationError(503,'The comparison took too long. Narrow the date range.');};}
function error(e:unknown):never{if((e as {code?:string})?.code==='57014')throw new FoundationError(503,'The comparison took too long. Narrow the date range.');throw e;}
async function select(client:PoolClient,p:ContentProject,filters:ComparisonFilters,check:()=>void){
 const previous=previousRange(filters),selected=await selectPromptInsights(client,p,{...filters,from:previous.from},check,true),r=selected.report;
 const period=(from:string,to:string):ComparisonPeriod=>({from,to,coverage:emptyCoverage(),usable:0,identityUnavailable:0,identityInvalid:0,excludedByCohort:0,cells:0,matchedCells:0,matchedExecutions:0});
 const periods={current:period(filters.from,filters.to),previous:period(previous.from,previous.to)},cells=new Map<string,ComparisonCell>(),executions:ComparisonExecution[]=[];
 const part=():ComparisonCellPart=>({attempted:0,usable:0,metrics:r.subjects.map(s=>({id:s.id,mentions:0,citations:0}))});
 for(const row of selected.observations){check();const captured=selected.identities.get(row.id);if(!captured)throw changed();const side=row.date<filters.from?'previous':'current',at=periods[side];
  if(filters.cohort==='current-neutral'&&captured.isBranded){at.excludedByCohort++;continue;}
  at.coverage.attempted++;at.coverage[row.eligibility]++;
  const usable=row.eligibility==='eligible'&&captured.state==='available',cellId=captured.requestHash?canonicalHash({projectId:p.id,request:captured.requestHash,profile:r.profileHash,matcher:filters.matcher,eligibilityVersion}):null;
  if(usable)at.usable++;else if(row.eligibility==='eligible'){if(captured.state==='unavailable')at.identityUnavailable++;else at.identityInvalid++;}
  executions.push({...row,period:side,cellId,identity:captured.state,usable});
  if(!cellId)continue;let cell=cells.get(cellId);if(!cell){cell={id:cellId,promptId:row.promptId,versionId:row.versionId,promptPreview:captured.promptPreview,model:row.model,provider:captured.providerName!,maxCompletionTokens:captured.maxCompletionTokens!,status:'unavailable',current:part(),previous:part()};cells.set(cellId,cell);}
  cell[side].attempted++;if(usable){cell[side].usable++;for(const [i,match]of row.matches!.entries()){cell[side].metrics[i].mentions+=Number(match.mentioned);cell[side].metrics[i].citations+=Number(match.cited);}}
 }
 const allCells=[...cells.values()].sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0),matched=allCells.filter(c=>c.current.usable>0&&c.previous.usable>0);
 for(const c of allCells)c.status=c.current.usable?c.previous.usable?'matched':'current_only':c.previous.usable?'previous_only':'unavailable';
 for(const side of ['current','previous'] as const){periods[side].cells=allCells.filter(c=>c[side].usable>0).length;periods[side].matchedCells=matched.length;periods[side].matchedExecutions=matched.reduce((n,c)=>n+c[side].usable,0);}
 const localToday=(await client.query("SELECT (transaction_timestamp() AT TIME ZONE $1)::date::text AS today",[filters.timeZone])).rows[0].today;
 const periodOpen=filters.to>=localToday,now=periods.current,before=periods.previous;
 const status:ComparisonStatus=!now.coverage.attempted?'no_data':!before.coverage.attempted?'no_previous':!now.usable||!before.usable?'unavailable':!matched.length?'scope_changed':periodOpen?'in_progress':now.usable*10<now.coverage.attempted*9||before.usable*10<before.coverage.attempted*9?'incomplete':'comparable';
 const currentCells=matched.length?matched:allCells.filter(c=>c.current.usable>0);
 const mean=(rows:ComparisonCell[],side:'current'|'previous',index:number,kind:'mentions'|'citations')=>equalCellMean(rows.map(c=>({numerator:c[side].metrics[index][kind],denominator:c[side].usable})));
 const metrics=r.subjects.map((s,i)=>{const current=mean(currentCells,'current',i,'mentions'),previous=mean(matched,'previous',i,'mentions'),citationsCurrent=mean(currentCells,'current',i,'citations'),citationsPrevious=mean(matched,'previous',i,'citations');
  return {id:s.id,current,previous,delta:status==='comparable'?comparisonDelta(current,previous):null,citationsCurrent,citationsPrevious,citationsDelta:status==='comparable'?comparisonDelta(citationsCurrent,citationsPrevious):null};});
 // Include all candidate identities, including cohort exclusions: changing an
 // override or copied-input availability must invalidate pages and downloads.
 const selectionRevision=canonicalHash({source:r.selectionRevision,filters,formulaVersion,eligibilityVersion,classifierVersion,identities:[...selected.identities].sort(([a],[b])=>a<b?-1:a>b?1:0),periodOpen});
 const report:Omit<PromptInsightsComparison,'navigation'|'page'|'totalRows'|'nextCursor'>={role:r.role,filters,asOf:r.asOf,contextRevision:r.contextRevision,profileHash:r.profileHash,matcherVersion:r.matcherVersion,selectionRevision,formulaVersion,eligibilityVersion,classifierVersion,label,warnings:[...r.warnings,'Market and language were not recorded. Exact underlying model versions were not captured.','Cell rates are equally weighted; pooled answer share of voice is a different metric.'],subjects:r.subjects,periodOpen,status,current:now,previous:before,cellCount:allCells.length,evidenceStates:executions.map(({id,period,eligibility,identity})=>({id,period,eligibility,identity})),headlineBasis:matched.length?'matched_cells':'current_cells',metrics};
 if(!currentCells.length)report.headlineBasis='none';
 return {report,cells:allCells,executions};
}
function pageOffset(raw:string|null,scope:string,revision:string){if(raw===null)return 0;let value:unknown;try{if(!raw||raw.length>512||!/^[A-Za-z0-9_-]+$(?![\s\S])/.test(raw))throw bad();value=JSON.parse(Buffer.from(raw,'base64url').toString('utf8'));}catch{throw bad();}
 const parsed=z.object({scope:exactHex,revision:exactHex,offset:z.number().int().positive().max(999)}).strict().safeParse(value);if(!parsed.success||parsed.data.scope!==scope||parsed.data.offset%50!==0)throw bad();if(parsed.data.revision!==revision)throw changed();return parsed.data.offset;}
export async function getPromptInsightsComparison(projectId:string,userId:string,params=new URLSearchParams()):Promise<PromptInsightsComparison>{
 const input=parse(params),check=deadline();return withContentProject(projectId,userId,false,async(client,p)=>{
  const selected=await select(client,p,input.filters,check),{navigation}=input;if(navigation.entityId!==null&&!selected.report.subjects.some(s=>s.id===navigation.entityId))throw bad();
  if(navigation.cellId!==null&&!selected.cells.some(c=>c.id===navigation.cellId))throw changed();
  const rows=navigation.view==='cells'?selected.cells:selected.executions.filter(e=>{if(e.period!==navigation.period||navigation.cellId!==null&&e.cellId!==navigation.cellId)return false;
   if(navigation.outcome==='all')return true;if(navigation.outcome==='usable')return e.usable;if(navigation.outcome==='unavailable')return !e.usable;
   if(!e.usable)return false;const m=e.matches!.find(m=>m.id===navigation.entityId)!;return navigation.outcome==='mentioned'?m.mentioned:navigation.outcome==='not_mentioned'?!m.mentioned:m.cited;});
  const scope=canonicalHash({projectId,filters:input.filters,navigation}),offset=pageOffset(input.cursor,scope,selected.report.selectionRevision),next=offset+50;
  return {...selected.report,navigation,page:{kind:navigation.view,rows:rows.slice(offset,next)} as PromptInsightsComparison['page'],totalRows:rows.length,nextCursor:next<rows.length?Buffer.from(JSON.stringify({scope,revision:selected.report.selectionRevision,offset:next})).toString('base64url'):null};
 }).catch(error);
}
export async function exportPromptInsightsComparison(projectId:string,userId:string,raw:unknown,signal?:AbortSignal){
 const parsed=z.object({from:z.string(),to:z.string(),timeZone:z.string(),model:z.string().nullable().optional(),promptId:z.string().nullable().optional(),tag:z.string().nullable().optional(),matcher:z.string(),cohort:z.enum(['current-neutral','all']).optional(),expectedSelectionRevision:exactHex}).strict().safeParse(raw);if(!parsed.success)throw bad();
 const {expectedSelectionRevision,...values}=parsed.data,params=new URLSearchParams();for(const [k,v]of Object.entries(values))if(v!==null&&v!==undefined)params.set(k,v);
 const {filters}=parse(params),check=deadline(signal);check();return withContentProject(projectId,userId,false,async(client,p)=>{
  const {report,cells,executions}=await select(client,p,filters,check);if(report.selectionRevision!==expectedSelectionRevision)throw changed();
  const header=['Record','As of','Context revision','Profile hash','Matcher','Formula','Classifier','Selection revision','Filters','Current identities','Comparison status','Open period','Period','Cell ID','Prompt ID','Version ID','Prompt preview','Requested model','Provider','Maximum output tokens','Attempts','Usable answers','Coverage','Identity unavailable','Identity invalid','Excluded by cohort','Matched cells','Matched executions','Entity ID','Mentions','Citations','Current fraction','Previous fraction','Delta fraction','Current citation fraction','Previous citation fraction','Citation delta fraction','Execution ID','Comparison ID','Requested at','Requested day','Receipt status','Eligibility','Identity state','Matches'];
  let bytes=0,rowCount=0;const lines:string[]=[];const line=(record:Record<string,unknown>)=>{check();const value=header.map(k=>csvCell(record[k]??'')).join(',')+'\r\n';bytes+=Buffer.byteLength(value);if(bytes>16*1024*1024)throw new FoundationError(413,'The comparison export exceeds 16 MiB. Narrow the date range.');lines.push(value);rowCount++;};
  line(Object.fromEntries(header.map(k=>[k,k])));rowCount=0;
  const prefix={'As of':report.asOf,'Context revision':report.contextRevision,'Profile hash':report.profileHash,Matcher:report.matcherVersion,Formula:formulaVersion,Classifier:classifierVersion,'Selection revision':report.selectionRevision,Filters:filters,'Current identities':report.subjects,'Comparison status':report.status,'Open period':report.periodOpen};
  for(const side of ['current','previous'] as const){const r=report[side];line({...prefix,Record:'coverage',Period:side,Attempts:r.coverage.attempted,'Usable answers':r.usable,Coverage:r.coverage,'Identity unavailable':r.identityUnavailable,'Identity invalid':r.identityInvalid,'Excluded by cohort':r.excludedByCohort,'Matched cells':r.matchedCells,'Matched executions':r.matchedExecutions});}
  for(const m of report.metrics)line({...prefix,Record:'metric','Entity ID':m.id,'Current fraction':m.current,'Previous fraction':m.previous,'Delta fraction':m.delta,'Current citation fraction':m.citationsCurrent,'Previous citation fraction':m.citationsPrevious,'Citation delta fraction':m.citationsDelta});
  for(const c of cells)for(const side of ['current','previous'] as const)for(const m of c[side].metrics)line({...prefix,Record:'cell',Period:side,'Cell ID':c.id,'Prompt ID':c.promptId,'Version ID':c.versionId,'Prompt preview':c.promptPreview,'Requested model':c.model,Provider:c.provider,'Maximum output tokens':c.maxCompletionTokens,Attempts:c[side].attempted,'Usable answers':c[side].usable,'Entity ID':m.id,Mentions:m.mentions,Citations:m.citations});
  for(const e of executions)line({...prefix,Record:'execution',Period:e.period,'Cell ID':e.cellId,'Prompt ID':e.promptId,'Version ID':e.versionId,'Requested model':e.model,'Execution ID':e.id,'Comparison ID':e.comparisonId,'Requested at':e.requestedAt,'Requested day':e.date,'Receipt status':e.status,Eligibility:e.eligibility,'Identity state':e.identity,Matches:e.matches});
  check();return {role:p.role,filename:'prompt-insights-comparison.csv',contentType:'text/csv; charset=utf-8',rowCount,body:lines.join('')};
 }).catch(error);
}
