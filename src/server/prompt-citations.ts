import {toUSVString} from 'node:util';
import {z} from 'zod';
import type {PoolClient} from 'pg';
import {FoundationError} from './auth.ts';
import {canonicalHash} from './context-input.ts';
import {csvCell} from './explorer-input.ts';
import {withContentProject,type ContentProject} from './project-context.ts';
import {insightFilters,selectPromptInsights,type InsightCoverage,type InsightEligibility,type InsightExecution} from './prompt-insights.ts';
import {carriedCitations,type CarriedCitations} from './citation-carried.ts';
import {createCitationClassifier,groupCitationUrl,publisherCategories,pageTypes,sourceTypes,ownershipKinds,
 classifierVersion,ownershipVersion,googleDomainsVersion,
 type PublisherCategory,type PageType,type SourceType,type OwnershipKind,type UrlGrouping,type CitationClassification} from './citation-classification.ts';

export type CitationFilters={from:string;to:string;timeZone:string;model:string|null;promptId:string|null;tag:string|null;urlGrouping:UrlGrouping;
 query:string|null;publisherCategory:PublisherCategory|null;pageType:PageType|null;sourceType:SourceType|null;ownership:OwnershipKind|null;entityId:string|null};
type Period='current'|'previous';
export type CitationCount={executions:number;annotations:number;prompts:number};
type Facet<K extends string>={key:K;count:CitationCount};
export type CitationAxes={ownership:Facet<OwnershipKind>[];publisher:Facet<PublisherCategory>[];pageType:Facet<PageType>[];sourceType:Facet<SourceType>[]};
export type CitationPeriod={from:string;to:string;coverage:InsightCoverage;eligibleAnswers:number|null;citedExecutions:number;annotations:number;uniqueUrls:number;uniqueDomains:number;unclassifiedHostAnnotations:number};
export type CitationEvidence={id:string;executionId:string;comparisonId:string;promptId:string;versionId:string;requestedAt:string;date:string;period:Period;model:string;
 retainedCitationIndex:number;retainedUrl:string;retainedTitle:string|null;urlId:string;groupedUrl:string;hostname:string|null;trackable:boolean;classification:CitationClassification};
export type CitationRepresentative=Pick<CitationEvidence,'executionId'|'comparisonId'|'retainedCitationIndex'|'retainedUrl'|'retainedTitle'|'requestedAt'>;
type Part={count:CitationCount;axes:CitationAxes};
export type CitationUrlRow={id:string;url:string;current:Part;previous:Part;currentRepresentative:CitationRepresentative|null;previousRepresentative:CitationRepresentative|null};
export type CitationDomainRow={id:string;hostname:string|null;trackable:boolean;current:Part;previous:Part;currentUniqueUrls:number;previousUniqueUrls:number};
export type CitationCategoryRow={id:PublisherCategory;current:Part;previous:Part};
export type CitationChangeKind='newly_observed'|'fewer_citations'|'not_observed_now'|'annotation_title_changed';
export type CitationChangeRow={id:string;kind:CitationChangeKind;target:'url'|'domain';targetId:string;label:string;current:CitationCount;previous:CitationCount;before:CitationRepresentative|null;after:CitationRepresentative|null};
export type CitationChangesStatus='no_data'|'no_previous'|'unavailable'|'in_progress'|'incomplete'|'ready';
export type CitationNavigation={view:'urls'|'domains'|'categories'|'changes'|'evidence';period:Period|null;urlId:string|null;domainId:string|null;changeKind:CitationChangeKind|null};
export type CitationReport={role:ContentProject['role'];filters:CitationFilters;navigation:CitationNavigation;asOf:string;contextRevision:number;profileHash:string;selectionRevision:string;
 eligibilityVersion:'retained-nonempty-stop-v1';classifierVersion:typeof classifierVersion;ownershipVersion:typeof ownershipVersion;googleDomainsVersion:string;
 label:'Retained citation observations classified using current project context';warnings:string[];entities:{id:string;label:string}[];
 current:CitationPeriod;previous:CitationPeriod;periodOpen:boolean;axes:{current:CitationAxes;previous:CitationAxes};
 daily:{date:string;period:Period;summary:CitationPeriod;axes:CitationAxes}[];evidenceStates:{id:string;period:Period;eligibility:InsightEligibility}[];
 changes:{status:CitationChangesStatus;countBasis:'annotation_occurrences';counts:Record<CitationChangeKind,number>};
 page:{kind:'urls';rows:CitationUrlRow[]}|{kind:'domains';rows:CitationDomainRow[]}|{kind:'categories';rows:CitationCategoryRow[]}|
  {kind:'changes';rows:CitationChangeRow[]}|{kind:'evidence';rows:CitationEvidence[]};totalRows:number;nextCursor:string|null};

/** Additive Elmo-method carried source trends; `daily`, `axes` and exports stay observed-only. */
export type CitationResponse=CitationReport&{carried:CarriedCitations};
const label='Retained citation observations classified using current project context',eligibilityVersion='retained-nonempty-stop-v1';
const changesKinds=['newly_observed','fewer_citations','not_observed_now','annotation_title_changed'] as const;
const filterKeys=['from','to','timeZone','model','promptId','tag','urlGrouping','query','publisherCategory','pageType','sourceType','ownership','entityId'];
const navigationKeys=['view','period','urlId','domainId','changeKind','cursor'];
const hex=z.string().regex(/^[a-f0-9]{64}$/);
const bad=()=>new FoundationError(400,'Check the citation filters and try again.');
const changed=()=>new FoundationError(409,'The citation evidence or current context changed. Reload the report.');
const cap=()=>new FoundationError(413,'Narrow the date range. This citation report exceeds its analysis capacity.');
const cmp=(a:string,b:string)=>a<b?-1:a>b?1:0;
function optionalEnum<T extends string>(params:URLSearchParams,key:string,allowed:readonly T[]):T|null{const value=params.get(key);if(value!==null&&!allowed.includes(value as T))throw bad();return value as T|null;}
function parse(params:URLSearchParams){
 if(params.toString().length>4096)throw bad();for(const key of params.keys())if(![...filterKeys,...navigationKeys].includes(key)||params.getAll(key).length!==1)throw bad();
 const base=new URLSearchParams();for(const key of ['from','to','timeZone','model','promptId','tag'])if(params.has(key))base.set(key,params.get(key)!);
 const {matcher:_,...dates}=insightFilters(base),urlGrouping=optionalEnum(params,'urlGrouping',['retained-fragment-v1','elmo-url-v1'])??'retained-fragment-v1';
 const rawQuery=params.get('query'),query=rawQuery?.trim()??null,entity=params.get('entityId');
 if(rawQuery!==null&&(!query||rawQuery.length>200||toUSVString(rawQuery)!==rawQuery||/[\u0000-\u001f\u007f]/.test(rawQuery)))throw bad();
 let entityId:string|null=null;if(entity!==null){if(entity==='brand')entityId=entity;else{const id=z.uuid().safeParse(entity);if(!id.success)throw bad();entityId=id.data.toLowerCase();}}
 const filters:CitationFilters={...dates,urlGrouping,query,entityId,publisherCategory:optionalEnum(params,'publisherCategory',publisherCategories),pageType:optionalEnum(params,'pageType',pageTypes),sourceType:optionalEnum(params,'sourceType',sourceTypes),ownership:optionalEnum(params,'ownership',ownershipKinds)};
 const view=optionalEnum(params,'view',['urls','domains','categories','changes','evidence'])??'urls',period=optionalEnum(params,'period',['current','previous']);
 const urlId=params.get('urlId'),domainId=params.get('domainId'),changeKind=optionalEnum(params,'changeKind',changesKinds);
 if(urlId!==null&&!hex.safeParse(urlId).success||domainId!==null&&!hex.safeParse(domainId).success||urlId!==null&&domainId!==null||
  view!=='evidence'&&['period','urlId','domainId'].some(k=>params.has(k))||view!=='changes'&&params.has('changeKind'))throw bad();
 return {filters,navigation:{view,period:view==='evidence'?period??'current':null,urlId,domainId,changeKind} as CitationNavigation,cursor:params.get('cursor')};
}
export const citationFilters=(params:URLSearchParams):CitationFilters=>parse(params).filters;
function previousRange(f:CitationFilters){const days=1+(Date.parse(f.to)-Date.parse(f.from))/86400000;
 const from=new Date(Date.parse(f.from)-days*86400000).toISOString().slice(0,10),to=new Date(Date.parse(f.from)-86400000).toISOString().slice(0,10);
 if(!/^\d{4}-\d\d-\d\d$/.test(from)||from.startsWith('0000'))throw bad();return {from,to};}
function deadline(signal?:AbortSignal){const start=Date.now();return()=>{if(signal?.aborted)throw new FoundationError(499,'Citation request cancelled.');if(Date.now()-start>30000)throw new FoundationError(503,'This citation report took too long. Narrow the date range.');};}
function error(e:unknown):never{if((e as {code?:string})?.code==='57014')throw new FoundationError(503,'This citation report took too long. Narrow the date range.');throw e;}
const emptyCoverage=():InsightCoverage=>({attempted:0,eligible:0,queued:0,running:0,no_answer:0,empty:0,truncated:0,content_filtered:0,expired:0,invalid:0});
function count(rows:CitationEvidence[]):CitationCount{return {executions:new Set(rows.map(r=>r.executionId)).size,annotations:rows.length,prompts:new Set(rows.map(r=>r.promptId)).size};}
function ownership(row:CitationEvidence):OwnershipKind{const o=row.classification.ownership;return o.ambiguous?'ambiguous':o.brand?'brand':o.competitorIds.length?'competitor':'untracked';}
function axes(rows:CitationEvidence[]):CitationAxes{
 const facets=<K extends string>(keys:readonly K[],key:(r:CitationEvidence)=>K)=>keys.map(k=>({key:k,count:count(rows.filter(r=>key(r)===k))}));
 return {ownership:facets(ownershipKinds,ownership),publisher:facets(publisherCategories,r=>r.classification.publisherCategory),pageType:facets(pageTypes,r=>r.classification.pageType),sourceType:facets(sourceTypes,r=>r.classification.sourceType)};
}
function summary(from:string,to:string,observations:InsightExecution[],rows:CitationEvidence[]):CitationPeriod{
 const coverage=emptyCoverage();for(const row of observations){coverage.attempted++;coverage[row.eligibility]++;}
 return {from,to,coverage,eligibleAnswers:coverage.eligible||null,citedExecutions:count(rows).executions,annotations:rows.length,
  uniqueUrls:new Set(rows.map(r=>r.urlId)).size,uniqueDomains:new Set(rows.flatMap(r=>r.hostname===null?[]:[r.hostname])).size,unclassifiedHostAnnotations:rows.filter(r=>r.hostname===null).length};
}
function evidenceOrder(a:CitationEvidence,b:CitationEvidence){return cmp(b.requestedAt,a.requestedAt)||cmp(a.executionId,b.executionId)||a.retainedCitationIndex-b.retainedCitationIndex;}
function representative(rows:CitationEvidence[]):CitationRepresentative|null{
 if(!rows.length)return null;let selected:CitationEvidence|undefined;
 for(const row of rows){const nonempty=!!row.retainedTitle?.trim(),oldNonempty=!!selected?.retainedTitle?.trim();
  if(!selected||nonempty&&!oldNonempty||nonempty===oldNonempty&&evidenceOrder(row,selected)<0)selected=row;}
 const r=selected!;return {executionId:r.executionId,comparisonId:r.comparisonId,retainedCitationIndex:r.retainedCitationIndex,retainedUrl:r.retainedUrl,retainedTitle:r.retainedTitle,requestedAt:r.requestedAt};
}
export function matchesCitationEvidence(row:CitationEvidence,f:CitationFilters){const c=row.classification;
 if(f.publisherCategory&&c.publisherCategory!==f.publisherCategory||f.pageType&&c.pageType!==f.pageType||f.sourceType&&c.sourceType!==f.sourceType||f.ownership&&ownership(row)!==f.ownership)return false;
 if(f.entityId&&(f.entityId==='brand'?!c.ownership.brand:!c.ownership.competitorIds.includes(f.entityId)))return false;
 if(f.query){const query=f.query.toLowerCase();if(![row.retainedUrl,row.retainedTitle??'',row.hostname??''].some(v=>v.toLowerCase().includes(query)))return false;}return true;
}
const domainId=(hostname:string|null)=>canonicalHash({kind:'domain',hostname});
type Group={id:string;label:string;hostname:string|null;current:CitationEvidence[];previous:CitationEvidence[];currentCount:CitationCount;previousCount:CitationCount};
function groups(rows:CitationEvidence[],kind:'url'|'domain'){
 const map=new Map<string,Group>();for(const row of rows){const id=kind==='url'?row.urlId:domainId(row.hostname);let group=map.get(id);
  if(!group){group={id,label:kind==='url'?row.groupedUrl:row.hostname??'Unclassified hostname',hostname:row.hostname,current:[],previous:[],currentCount:count([]),previousCount:count([])};map.set(id,group);}group[row.period].push(row);}
 for(const group of map.values()){group.currentCount=count(group.current);group.previousCount=count(group.previous);}return map;
}
const groupOrder=(a:Group,b:Group)=>b.currentCount.executions-a.currentCount.executions||b.currentCount.annotations-a.currentCount.annotations||b.previousCount.executions-a.previousCount.executions||cmp(a.id,b.id);
function changesFor(urls:Map<string,Group>,domains:Map<string,Group>,status:CitationChangesStatus):CitationChangeRow[]{
 if(status!=='ready')return [];const changes:CitationChangeRow[]=[];
 for(const [target,map]of [['url',urls],['domain',domains]] as const)for(const group of map.values()){
  const now=group.currentCount.annotations,prev=group.previousCount.annotations,before=target==='url'?representative(group.previous):null,after=target==='url'?representative(group.current):null;
  const kinds:CitationChangeKind[]=[];if(prev===0&&now>=2)kinds.push('newly_observed');if(prev>=2&&now>0&&now*2<=prev)kinds.push('fewer_citations');if(prev>=2&&now===0)kinds.push('not_observed_now');
  if(before?.retainedTitle?.trim()&&after?.retainedTitle?.trim()&&before.retainedTitle!==after.retainedTitle)kinds.push('annotation_title_changed');
  for(const kind of kinds)changes.push({id:canonicalHash({kind,target,id:group.id}),kind,target,targetId:group.id,label:group.label,current:group.currentCount,previous:group.previousCount,before,after});
 }
 return changes.sort((a,b)=>changesKinds.indexOf(a.kind)-changesKinds.indexOf(b.kind)||(a.kind==='newly_observed'?b.current.annotations-a.current.annotations:b.previous.annotations-a.previous.annotations)||cmp(a.targetId,b.targetId));
}
export async function selectCitationEvidence(client:PoolClient,p:ContentProject,filters:CitationFilters,check:()=>void){
 const previous=previousRange(filters),base={from:previous.from,to:filters.to,timeZone:filters.timeZone,model:filters.model,promptId:filters.promptId,tag:filters.tag,matcher:'unicode-boundary-v1' as const};
 const selected=await selectPromptInsights(client,p,base,check,false,true),r=selected.report;
 if(filters.entityId&&!r.subjects.some(s=>s.id===filters.entityId))throw bad();
 const classify=createCitationClassifier({brandDomains:r.subjects[0].domains,competitors:r.subjects.slice(1).map(s=>({id:s.id,domains:s.domains})),overrides:selected.citationCategoryOverrides});
 const observations=selected.observations,evidence:CitationEvidence[]=[];let occurrences=0;
 for(const observation of observations){check();const citations=selected.citationEvidence.get(observation.id)??[];occurrences+=citations.length;if(occurrences>100000)throw cap();
  for(const [retainedCitationIndex,citation]of citations.entries()){check();const groupedUrl=groupCitationUrl(citation.url,filters.urlGrouping),classified=classify(citation.url,citation.title);
   const row:CitationEvidence={id:canonicalHash({projectId:p.id,executionId:observation.id,retainedCitationIndex}),executionId:observation.id,comparisonId:observation.comparisonId,promptId:observation.promptId,versionId:observation.versionId,
    requestedAt:observation.requestedAt,date:observation.date,period:observation.date<filters.from?'previous':'current',model:observation.model,retainedCitationIndex,retainedUrl:citation.url,retainedTitle:citation.title,
    urlId:canonicalHash({kind:'url',url:groupedUrl}),groupedUrl,...classified};evidence.push(row);
  }
 }
 return {previous,selected,evidence};
}
async function select(client:PoolClient,p:ContentProject,filters:CitationFilters,check:()=>void){
 const {previous,selected,evidence:allEvidence}=await selectCitationEvidence(client,p,filters,check),r=selected.report,observations=selected.observations;
 const evidence=allEvidence.filter(row=>matchesCitationEvidence(row,filters));
 const currentRows=evidence.filter(e=>e.period==='current'),previousRows=evidence.filter(e=>e.period==='previous');
 const current=summary(filters.from,filters.to,observations.filter(o=>o.date>=filters.from),currentRows),before=summary(previous.from,previous.to,observations.filter(o=>o.date<filters.from),previousRows);
 const localDate=(await client.query('SELECT (transaction_timestamp() AT TIME ZONE $1)::date::text AS date',[filters.timeZone])).rows[0].date,periodOpen=filters.to>=localDate;
 const status:CitationChangesStatus=!current.coverage.attempted?'no_data':!before.coverage.attempted?'no_previous':!current.coverage.eligible||!before.coverage.eligible?'unavailable':periodOpen?'in_progress':current.coverage.eligible*10<current.coverage.attempted*9||before.coverage.eligible*10<before.coverage.attempted*9?'incomplete':'ready';
 const urls=groups(evidence,'url'),domains=groups(evidence,'domain'),changes=changesFor(urls,domains,status),daily:CitationReport['daily']=[];
 for(let day=Date.parse(previous.from);day<=Date.parse(filters.to);day+=86400000){check();const date=new Date(day).toISOString().slice(0,10),rows=evidence.filter(e=>e.date===date);
  daily.push({date,period:date<filters.from?'previous':'current',summary:summary(date,date,observations.filter(o=>o.date===date),rows),axes:axes(rows)});}
 const profileHash=canonicalHash({subjects:r.subjects,overrides:selected.citationCategoryOverrides,classifierVersion,ownershipVersion,googleDomainsVersion});
 const scope=canonicalHash({projectId:p.id,filters}),selectionRevision=canonicalHash({scope,selection:r.selectionRevision,profileHash,eligibilityVersion});check();
 const report:Omit<CitationReport,'navigation'|'page'|'totalRows'|'nextCursor'>={role:p.role,filters,asOf:r.asOf,contextRevision:r.contextRevision,profileHash,selectionRevision,eligibilityVersion,classifierVersion,ownershipVersion,googleDomainsVersion,label,
  warnings:r.warnings,entities:r.subjects.map(s=>({id:s.id,label:s.name})),current,previous:before,periodOpen,axes:{current:axes(currentRows),previous:axes(previousRows)},daily,
  evidenceStates:observations.map(o=>({id:o.id,period:(o.date<filters.from?'previous':'current') as Period,eligibility:o.eligibility})),
  changes:{status,countBasis:'annotation_occurrences',counts:Object.fromEntries(changesKinds.map(k=>[k,changes.filter(c=>c.kind===k).length])) as Record<CitationChangeKind,number>}};
 return {scope,evidence,observations,urls,domains,changes,report};
}
const cursorSchema=z.object({scope:hex,revision:hex,offset:z.number().int().min(1).max(400000)}).strict();
function offset(raw:string|null,scope:string,revision:string){if(raw===null)return 0;let value:unknown;
 try{if(!raw||raw.length>512||!/^[A-Za-z0-9_-]+$/.test(raw))throw bad();value=JSON.parse(Buffer.from(raw,'base64url').toString('utf8'));}catch{throw bad();}
 const parsed=cursorSchema.safeParse(value);if(!parsed.success||parsed.data.scope!==scope)throw bad();if(parsed.data.revision!==revision)throw changed();return parsed.data.offset;}
const part=(rows:CitationEvidence[]):Part=>({count:count(rows),axes:axes(rows)});
export async function getPromptCitations(projectId:string,userId:string,params=new URLSearchParams(),signal?:AbortSignal):Promise<CitationResponse>{
 const input=parse(params),check=deadline(signal);check();return withContentProject(projectId,userId,false,async(client,p)=>{
  const selected=await select(client,p,input.filters,check),{navigation}=input,scope=canonicalHash({scope:selected.scope,navigation}),at=offset(input.cursor,scope,selected.report.selectionRevision),next=at+50;
  let page:CitationReport['page'],totalRows:number;
  if(navigation.view==='evidence'){const rows=selected.evidence.filter(e=>e.period===navigation.period&&(!navigation.urlId||e.urlId===navigation.urlId)&&(!navigation.domainId||domainId(e.hostname)===navigation.domainId)).sort(evidenceOrder);
   totalRows=rows.length;page={kind:'evidence',rows:rows.slice(at,next)};
  }else if(navigation.view==='changes'){const rows=selected.changes.filter(c=>!navigation.changeKind||c.kind===navigation.changeKind);totalRows=rows.length;page={kind:'changes',rows:rows.slice(at,next)};
  }else if(navigation.view==='categories'){totalRows=publisherCategories.length;page={kind:'categories',rows:publisherCategories.slice(at,next).map(id=>({id,current:part(selected.evidence.filter(e=>e.period==='current'&&e.classification.publisherCategory===id)),previous:part(selected.evidence.filter(e=>e.period==='previous'&&e.classification.publisherCategory===id))}))};
  }else{const map=navigation.view==='urls'?selected.urls:selected.domains,rows=[...map.values()].sort(groupOrder);totalRows=rows.length;
   if(navigation.view==='urls')page={kind:'urls',rows:rows.slice(at,next).map(g=>({id:g.id,url:g.label,current:part(g.current),previous:part(g.previous),currentRepresentative:representative(g.current),previousRepresentative:representative(g.previous)}))};
   else page={kind:'domains',rows:rows.slice(at,next).map(g=>({id:g.id,hostname:g.hostname,trackable:g.hostname!==null,current:part(g.current),previous:part(g.previous),currentUniqueUrls:new Set(g.current.map(e=>e.urlId)).size,previousUniqueUrls:new Set(g.previous.map(e=>e.urlId)).size}))};
  }
  const carried=carriedCitations(selected.evidence.map(e=>({promptId:e.promptId,date:e.date,keys:{ownership:ownership(e),publisher:e.classification.publisherCategory,pageType:e.classification.pageType,sourceType:e.classification.sourceType}})),
   selected.observations.filter(o=>o.eligibility==='eligible'),selected.report.daily.map(d=>d.date),{ownership:ownershipKinds,publisher:publisherCategories,pageType:pageTypes,sourceType:sourceTypes});
  const report:CitationResponse={...selected.report,carried,navigation,page,totalRows,nextCursor:next<totalRows?Buffer.from(JSON.stringify({scope,revision:selected.report.selectionRevision,offset:next})).toString('base64url'):null};
  check();if(Buffer.byteLength(JSON.stringify(report))>2*1024*1024)throw cap();return report;
 }).catch(error);
}
export async function exportPromptCitations(projectId:string,userId:string,raw:unknown,signal?:AbortSignal){
 const shape=z.object({from:z.string(),to:z.string(),timeZone:z.string(),model:z.string().nullable().optional(),promptId:z.string().nullable().optional(),tag:z.string().nullable().optional(),urlGrouping:z.string(),
  query:z.string().nullable().optional(),publisherCategory:z.string().nullable().optional(),pageType:z.string().nullable().optional(),sourceType:z.string().nullable().optional(),ownership:z.string().nullable().optional(),entityId:z.string().nullable().optional(),expectedSelectionRevision:hex}).strict();
 const parsed=shape.safeParse(raw);if(!parsed.success)throw bad();const {expectedSelectionRevision,...values}=parsed.data,params=new URLSearchParams();for(const [key,value]of Object.entries(values))if(value!==null&&value!==undefined)params.set(key,value);
 const {filters}=parse(params),check=deadline(signal);check();return withContentProject(projectId,userId,false,async(client,p)=>{
  const selected=await select(client,p,filters,check),r=selected.report;if(r.selectionRevision!==expectedSelectionRevision)throw changed();
  const header=['Record','As of','Context revision','Profile hash','Selection revision','Eligibility method','Classifier','Ownership method','Google domains version','Applied filters','Entities','Period','Date','Summary','Axes','Execution ID','Comparison ID','Prompt ID','Version ID','Requested at','Requested model','Retained citation index','Retained URL','Retained title','Grouped URL ID','Grouped URL','Hostname','Trackable','Classification'];
  const lines:string[]=[];let bytes=0,rowCount=0;const line=(cells:unknown[])=>{check();const text=[...cells,...Array(Math.max(0,header.length-cells.length)).fill('')].map(csvCell).join(',')+'\r\n';bytes+=Buffer.byteLength(text);if(bytes>16*1024*1024)throw new FoundationError(413,'The citation export exceeds 16 MiB. Narrow the date range or source filters.');lines.push(text);};
  const prefix=[r.asOf,r.contextRevision,r.profileHash,r.selectionRevision,eligibilityVersion,classifierVersion,ownershipVersion,googleDomainsVersion,filters,r.entities];line(header);
  line(['metadata',...prefix,'','',{label:r.label,changes:r.changes,periodOpen:r.periodOpen,warnings:r.warnings}]);rowCount++;
  for(const period of ['current','previous'] as const){line(['period',...prefix,period,'',r[period],r.axes[period]]);rowCount++;}
  for(const day of r.daily){line(['daily',...prefix,day.period,day.date,day.summary,day.axes]);rowCount++;}
  for(const e of selected.evidence.sort(evidenceOrder)){line(['evidence',...prefix,e.period,e.date,'','',e.executionId,e.comparisonId,e.promptId,e.versionId,e.requestedAt,e.model,e.retainedCitationIndex,e.retainedUrl,e.retainedTitle,e.urlId,e.groupedUrl,e.hostname,e.trackable,e.classification]);rowCount++;}
  check();return {role:p.role,filename:'prompt-citations.csv',contentType:'text/csv; charset=utf-8',rowCount,body:lines.join('')};
 }).catch(error);
}
