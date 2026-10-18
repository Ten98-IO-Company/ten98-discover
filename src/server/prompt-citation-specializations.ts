import {z} from 'zod';
import type {PoolClient} from 'pg';
import {FoundationError} from './auth.ts';
import {canonicalHash} from './context-input.ts';
import {csvCell} from './explorer-input.ts';
import {withContentProject,type ContentProject} from './project-context.ts';
import type {InsightCoverage,InsightEligibility,InsightExecution} from './prompt-insights.ts';
import {citationFilters,matchesCitationEvidence,selectCitationEvidence,type CitationFilters,type CitationEvidence,type CitationCount,type CitationRepresentative} from './prompt-citations.ts';
import {classifierVersion,ownershipVersion,googleDomainsVersion} from './citation-classification.ts';
import {attributeProduct,parseGoogleProductName} from './citation-taxonomy.ts';
import {parseCitationRedditCommunity,parseCitationSearchQuery} from './citation-specialized-labels.ts';

type Period='current'|'previous';
export type SpecializedFilters=CitationFilters&{productAttribution:'brand'|'competitor'|'other'|null};
export type SpecializedNavigation={view:'reddit'|'reddit_pages'|'shopping'|'search'|'gaps'|'prompts'|'evidence';period:Period|null;groupId:string|null;gapPromptId:string|null;evidenceMode:'matching'|'gap_all'|null};
const specializedMethods={reddit:'reddit-path-community-v1',googleLabels:'google-retained-link-labels-elmo-v1',productAttribution:'google-product-name-elmo-v1',gaps:'prompt-period-domain-gap-v1'} as const;
export type SpecializedGapSummary={status:'ready';evaluatedPrompts:number;promptsWithCompetitor:number;observedCandidates:number;confirmedCandidates:number;matchingCandidates:number}|
 {status:'brand_identity_unavailable';evaluatedPrompts:null;promptsWithCompetitor:null;observedCandidates:null;confirmedCandidates:null;matchingCandidates:null};
export type SpecializedPeriod={from:string;to:string;open:boolean;coverage:InsightCoverage;eligibleAnswers:number|null;
 reddit:{all:CitationCount;community:CitationCount;ungrouped:CitationCount};
 google:{shopping:CitationCount;labelledShopping:CitationCount;unlabelledShopping:CitationCount;matchingProducts:CitationCount;search:CitationCount;labelledSearch:CitationCount;unlabelledSearch:CitationCount;wrappers:CitationCount};
 gaps:SpecializedGapSummary};
type GroupPart=CitationCount&{groupedPages:number};
type GroupIdentity={id:string;label:string;current:GroupPart;previous:GroupPart};
export type SpecializedRedditRow=GroupIdentity&{kind:'reddit';communityKey:string;currentNewPages:number|null;previousNotObservedPages:number|null;changeStatus:'no_previous'|'unavailable'|'in_progress'|'incomplete'|'ready'};
export type SpecializedProductRow=GroupIdentity&{kind:'product';labelBasis:'retained_title'|'url_product_id'|'mixed';attribution:{kind:'brand'|'competitor'|'other';competitorId:string|null};currentRepresentative:CitationRepresentative|null;previousRepresentative:CitationRepresentative|null};
export type SpecializedQueryRow=GroupIdentity&{kind:'query';labelBasis:'retained_url_q'};
export type SpecializedRedditPage={id:string;urlId:string;groupedUrl:string;count:CitationCount;representative:CitationRepresentative;newlyObserved:boolean|null};
export type SpecializedPromptRow={promptId:string;representativeVersionId:string;promptPreview:string;versionCount:number;count:CitationCount};
export type SpecializedGapRow={promptId:string;representativeVersionId:string;promptPreview:string;versionCount:number;period:Period;coverage:InsightCoverage;status:'confirmed_observed_gap'|'incomplete_evidence'|'in_progress';brandAnnotations:0;competitorCount:CitationCount;competitorIds:string[];matchingCompetitorCount:CitationCount};
export type SpecializedPage={kind:'reddit';rows:SpecializedRedditRow[]}|{kind:'reddit_pages';rows:SpecializedRedditPage[]}|{kind:'shopping';rows:SpecializedProductRow[]}|{kind:'search';rows:SpecializedQueryRow[]}|{kind:'gaps';rows:SpecializedGapRow[]}|{kind:'prompts';rows:SpecializedPromptRow[]}|{kind:'evidence';basis:'matching'|'gap_all';rows:CitationEvidence[]};
export type SpecializedReport={role:ContentProject['role'];filters:SpecializedFilters;navigation:SpecializedNavigation;asOf:string;contextRevision:number;profileHash:string;selectionRevision:string;
 eligibilityVersion:'retained-nonempty-stop-v1';classifierVersion:typeof classifierVersion;ownershipVersion:typeof ownershipVersion;googleDomainsVersion:string;methods:typeof specializedMethods;
 label:'Specialized retained citation observations using current project context';warnings:string[];entities:{id:string;label:string}[];
 googleConsumerModule:{status:'not_recorded';reason:'consumer_surface_not_captured'};
 unresolvedEvidence:{redditCommunityId:string;shoppingLabelId:string;searchQueryId:string;googleWrapperId:string};
 current:SpecializedPeriod;previous:SpecializedPeriod;evidenceStates:{id:string;period:Period;eligibility:InsightEligibility}[];
 page:SpecializedPage;totalRows:number;nextCursor:string|null};

const periods=['current','previous'] as const,filterKeys=['from','to','timeZone','model','promptId','tag','urlGrouping','query','publisherCategory','pageType','sourceType','ownership','entityId','productAttribution'];
const navigationKeys=['view','period','groupId','gapPromptId','evidenceMode','cursor'];
const hex=z.string().regex(/^[a-f0-9]{64}$/),uuid=z.uuid();
const bad=()=>new FoundationError(400,'Check the specialized citation filters and try again.');
const missing=()=>new FoundationError(404,'This citation target is unavailable in the selected report.');
const changed=()=>new FoundationError(409,'The citation evidence or current context changed. Reload the report.');
const cap=()=>new FoundationError(413,'Narrow the date range or source filters. This specialized citation report exceeds its analysis capacity.');
const cmp=(a:string,b:string)=>a<b?-1:a>b?1:0;
function enumValue<T extends string>(params:URLSearchParams,key:string,allowed:readonly T[]):T|null{const value=params.get(key);if(value!==null&&!allowed.includes(value as T))throw bad();return value as T|null;}
function parse(params:URLSearchParams){
 if(params.toString().length>4096)throw bad();for(const key of params.keys())if(![...filterKeys,...navigationKeys].includes(key)||params.getAll(key).length!==1)throw bad();
 const base=new URLSearchParams();for(const key of filterKeys)if(key!=='productAttribution'&&params.has(key))base.set(key,params.get(key)!);
 const filters:SpecializedFilters={...citationFilters(base),productAttribution:enumValue(params,'productAttribution',['brand','competitor','other'])};
 const view=enumValue(params,'view',['reddit','reddit_pages','shopping','search','gaps','prompts','evidence'])??'reddit';
 let period=enumValue(params,'period',periods);const groupId=params.get('groupId'),rawPrompt=params.get('gapPromptId'),evidenceMode=enumValue(params,'evidenceMode',['matching','gap_all']);
 if(groupId!==null&&!hex.safeParse(groupId).success||rawPrompt!==null&&!uuid.safeParse(rawPrompt).success)throw bad();
 const gapPromptId=rawPrompt?.toLowerCase()??null;
 if(['reddit','shopping','search'].includes(view)){if(period||groupId||gapPromptId||evidenceMode)throw bad();}
 else if(view==='gaps'){period??='current';if(groupId||gapPromptId||evidenceMode)throw bad();}
 else if(view==='reddit_pages'||view==='prompts'){if(!period||!groupId||gapPromptId||evidenceMode)throw bad();}
 else if(!period||!evidenceMode||evidenceMode==='gap_all'&&(!gapPromptId||groupId)||evidenceMode==='matching'&&!groupId)throw bad();
 return {filters,navigation:{view,period,groupId,gapPromptId,evidenceMode} as SpecializedNavigation,cursor:params.get('cursor')};
}
function deadline(signal?:AbortSignal){const start=Date.now();return()=>{if(signal?.aborted)throw new FoundationError(499,'Citation request cancelled.');if(Date.now()-start>30000)throw new FoundationError(503,'This citation report took too long. Narrow the date range.');};}
function failure(e:unknown):never{if((e as {code?:string})?.code==='57014')throw new FoundationError(503,'This citation report took too long. Narrow the date range.');throw e;}
function coverage(rows:InsightExecution[]):InsightCoverage{const c:InsightCoverage={attempted:0,eligible:0,queued:0,running:0,no_answer:0,empty:0,truncated:0,content_filtered:0,expired:0,invalid:0};for(const row of rows){c.attempted++;c[row.eligibility]++;}return c;}
const count=(rows:CitationEvidence[]):CitationCount=>({annotations:rows.length,executions:new Set(rows.map(e=>e.executionId)).size,prompts:new Set(rows.map(e=>e.promptId)).size});
const part=(rows:CitationEvidence[]):GroupPart=>({...count(rows),groupedPages:new Set(rows.map(e=>e.urlId)).size});
const evidenceOrder=(a:CitationEvidence,b:CitationEvidence)=>cmp(b.requestedAt,a.requestedAt)||cmp(a.executionId,b.executionId)||a.retainedCitationIndex-b.retainedCitationIndex;
function representative(rows:CitationEvidence[]):CitationRepresentative|null{if(!rows.length)return null;const e=rows.reduce((a,b)=>evidenceOrder(a,b)<=0?a:b);return {executionId:e.executionId,comparisonId:e.comparisonId,retainedCitationIndex:e.retainedCitationIndex,retainedUrl:e.retainedUrl,retainedTitle:e.retainedTitle,requestedAt:e.requestedAt};}
function bucket<T>(rows:T[],key:(row:T)=>string){const map=new Map<string,T[]>();for(const row of rows){const id=key(row),list=map.get(id);if(list)list.push(row);else map.set(id,[row]);}return map;}
type Group={kind:'reddit'|'product'|'query';key:string;id:string;label:string;current:CitationEvidence[];previous:CitationEvidence[];titleBasis:Set<'retained_title'|'url_product_id'>;attribution:SpecializedProductRow['attribution']|null};
const groupId=(kind:string,key:string)=>canonicalHash({kind,key,methods:specializedMethods});
const unresolved={redditCommunityId:groupId('unresolved','reddit'),shoppingLabelId:groupId('unresolved','shopping'),searchQueryId:groupId('unresolved','search'),googleWrapperId:groupId('unresolved','wrapper')};
type Derived={row:CitationEvidence;reddit:boolean;community:string|null;product:string|null;query:string|null;productBasis:'retained_title'|'url_product_id'|null;matches:boolean;attribution:SpecializedProductRow['attribution']|null};
type Gap={row:SpecializedGapRow;evidence:CitationEvidence[];matching:boolean};

async function select(client:PoolClient,p:ContentProject,filters:SpecializedFilters,check:()=>void){
 const base=await selectCitationEvidence(client,p,filters,check),source=base.selected.report,observations=base.selected.observations;
 check();const names=(await client.query<{id:string;name:string|null}>('SELECT id,name FROM context_competitor WHERE project_id=$1 ORDER BY id LIMIT 101',[p.id])).rows;if(names.length>100)throw cap();
 const competitors=names.filter((n):n is {id:string;name:string}=>!!n.name?.trim()),brandName=source.subjects[0].name;
 const versionIds=[...new Set(observations.map(o=>o.versionId))];
 check();const versions=(await client.query<{id:string;prompt_id:string;preview:string}>('SELECT id,prompt_id,left(text,160) AS preview FROM prompt_text_version WHERE project_id=$1 AND id=ANY($2::uuid[])',[p.id,versionIds])).rows;
 const previews=new Map(versions.map(v=>[v.id,v]));
 if(versions.length!==versionIds.length)throw missing();
 check();const localDate=(await client.query('SELECT (transaction_timestamp() AT TIME ZONE $1)::date::text AS date',[filters.timeZone])).rows[0].date;
 const derived:Derived[]=[],uniqueProducts=new Map<string,string>();let work=0;
 for(const row of base.evidence){check();const sourceType=row.classification.sourceType,community=parseCitationRedditCommunity(row.retainedUrl);
  const reddit=!!row.hostname&&(row.hostname==='reddit.com'||row.hostname.endsWith('.reddit.com'));
  const product=sourceType==='google_shopping'?parseGoogleProductName(row.retainedUrl,row.retainedTitle):null,query=sourceType==='google_search'?parseCitationSearchQuery(row.retainedUrl):null;
  const matches=matchesCitationEvidence(row,filters);
  if(product&&matches){const key=product.toLowerCase();if(!uniqueProducts.has(key)){work+=key.length*(competitors.length+Number(!!brandName.trim()));if(work>100000000)throw cap();uniqueProducts.set(key,product);}}
  derived.push({row,reddit,community:reddit?community:null,product,query,productBasis:product?(row.retainedTitle?.trim()?'retained_title':'url_product_id'):null,matches,attribution:null});
 }
 const attributions=new Map<string,SpecializedProductRow['attribution']>();
 for(const [key,value]of uniqueProducts){check();const attribution=attributeProduct(value,brandName,competitors);attributions.set(key,{kind:attribution.kind,competitorId:attribution.kind==='competitor'?attribution.competitorId:null});}
 const groups=new Map<string,Group>();
 const add=(kind:Group['kind'],label:string,d:Derived)=>{const key=label.toLowerCase(),id=groupId(kind,key);let group=groups.get(id);
  if(!group){group={kind,key,id,label,current:[],previous:[],titleBasis:new Set(),attribution:d.attribution};groups.set(id,group);}group[d.row.period].push(d.row);if(d.productBasis&&kind==='product')group.titleBasis.add(d.productBasis);};
 derived.sort((a,b)=>evidenceOrder(a.row,b.row));
 for(const d of derived){check();if(!d.matches)continue;if(d.community)add('reddit','r/'+d.community,d);
  if(d.product){d.attribution=attributions.get(d.product.toLowerCase())!;if(!filters.productAttribution||filters.productAttribution===d.attribution.kind)add('product',d.product,d);}
  if(d.query)add('query',d.query,d);
 }
 const promptInfo=(rows:{promptId:string;versionId:string;requestedAt:string;id:string}[])=>{const selected=rows.reduce((a,b)=>(cmp(b.requestedAt,a.requestedAt)||cmp(a.id,b.id))<=0?a:b);
  const version=previews.get(selected.versionId);if(!version||version.prompt_id!==selected.promptId)throw missing();return {promptId:selected.promptId,representativeVersionId:selected.versionId,promptPreview:version.preview,versionCount:new Set(rows.map(r=>r.versionId)).size};};
 const gaps=new Map<string,Gap>(),periodData={} as Record<Period,SpecializedPeriod>,brandIdentityAvailable=source.subjects[0].domains.length>0;
 for(const period of periods){check();const from=period==='current'?filters.from:base.previous.from,to=period==='current'?filters.to:base.previous.to,open=to>=localDate;
  const periodObservations=observations.filter(o=>(o.date<filters.from?'previous':'current')===period),c=coverage(periodObservations),all=derived.filter(d=>d.row.period===period),matching=all.filter(d=>d.matches);
  const counts=(predicate:(d:Derived)=>boolean)=>count(matching.filter(predicate).map(d=>d.row));
  const summary={evaluatedPrompts:0,promptsWithCompetitor:0,observedCandidates:0,confirmedCandidates:0,matchingCandidates:0},byPrompt=bucket(all,d=>d.row.promptId);
  for(const [promptId,attempts]of bucket(periodObservations,o=>o.promptId)){check();if(!brandIdentityAvailable)continue;const pc=coverage(attempts);if(!pc.eligible)continue;summary.evaluatedPrompts++;
   const rows=byPrompt.get(promptId)??[],competitorRows=rows.filter(d=>d.row.classification.ownership.competitorIds.length>0);if(!competitorRows.length)continue;summary.promptsWithCompetitor++;
   if(rows.some(d=>d.row.classification.ownership.brand))continue;summary.observedCandidates++;
   const status=pc.eligible<pc.attempted?'incomplete_evidence':open?'in_progress':'confirmed_observed_gap';if(status==='confirmed_observed_gap')summary.confirmedCandidates++;
   const matched=competitorRows.filter(d=>d.matches);if(matched.length)summary.matchingCandidates++;
   const row:SpecializedGapRow={...promptInfo(attempts),period,coverage:pc,status,brandAnnotations:0,competitorCount:count(competitorRows.map(d=>d.row)),competitorIds:[...new Set(competitorRows.flatMap(d=>d.row.classification.ownership.competitorIds))].sort(),matchingCompetitorCount:count(matched.map(d=>d.row))};
   gaps.set(period+':'+promptId,{row,evidence:rows.map(d=>d.row),matching:matched.length>0});
  }
  periodData[period]={from,to,open,coverage:c,eligibleAnswers:c.eligible||null,reddit:{all:counts(d=>d.reddit),community:counts(d=>!!d.community),ungrouped:counts(d=>d.reddit&&!d.community)},
   google:{shopping:counts(d=>d.row.classification.sourceType==='google_shopping'),labelledShopping:counts(d=>!!d.product),unlabelledShopping:counts(d=>d.row.classification.sourceType==='google_shopping'&&!d.product),
    matchingProducts:counts(d=>!!d.product&&(!filters.productAttribution||d.attribution?.kind===filters.productAttribution)),search:counts(d=>d.row.classification.sourceType==='google_search'),labelledSearch:counts(d=>!!d.query),unlabelledSearch:counts(d=>d.row.classification.sourceType==='google_search'&&!d.query),wrappers:counts(d=>d.row.classification.sourceType==='google_wrapper')},gaps:brandIdentityAvailable?{status:'ready',...summary}:{status:'brand_identity_unavailable',evaluatedPrompts:null,promptsWithCompetitor:null,observedCandidates:null,confirmedCandidates:null,matchingCandidates:null}};
 }
 const previous=periodData.previous,current=periodData.current;
 const changeStatus:SpecializedRedditRow['changeStatus']=!previous.coverage.attempted?'no_previous':!previous.coverage.eligible||!current.coverage.eligible?'unavailable':previous.open||current.open?'in_progress':previous.coverage.eligible*10<previous.coverage.attempted*9||current.coverage.eligible*10<current.coverage.attempted*9?'incomplete':'ready';
 const ordered=[...groups.values()].sort((a,b)=>b.current.length-a.current.length||b.previous.length-a.previous.length||cmp(a.key,b.key)||cmp(a.id,b.id));
 const groupRows=ordered.map(g=>{check();const identity={id:g.id,label:g.label,current:part(g.current),previous:part(g.previous)};
  if(g.kind==='reddit'){const now=new Set(g.current.map(e=>e.urlId)),before=new Set(g.previous.map(e=>e.urlId));return {...identity,kind:'reddit',communityKey:g.key,changeStatus,currentNewPages:changeStatus==='ready'?[...now].filter(id=>!before.has(id)).length:null,previousNotObservedPages:changeStatus==='ready'?[...before].filter(id=>!now.has(id)).length:null} as SpecializedRedditRow;}
  if(g.kind==='product')return {...identity,kind:'product',labelBasis:g.titleBasis.size>1?'mixed':[...g.titleBasis][0],attribution:g.attribution!,currentRepresentative:representative(g.current),previousRepresentative:representative(g.previous)} as SpecializedProductRow;
  return {...identity,kind:'query',labelBasis:'retained_url_q'} as SpecializedQueryRow;
 });
 const profileHash=canonicalHash({subjects:source.subjects,productNames:names,overrides:base.selected.citationCategoryOverrides,classifierVersion,ownershipVersion,googleDomainsVersion,methods:specializedMethods});
 const scope=canonicalHash({projectId:p.id,filters}),selectionRevision=canonicalHash({scope,selection:source.selectionRevision,profileHash,eligibilityVersion:'retained-nonempty-stop-v1',open:[current.open,previous.open]});
 const report:Omit<SpecializedReport,'navigation'|'page'|'totalRows'|'nextCursor'>={role:p.role,filters,asOf:source.asOf,contextRevision:source.contextRevision,profileHash,selectionRevision,eligibilityVersion:'retained-nonempty-stop-v1',classifierVersion,ownershipVersion,googleDomainsVersion,methods:specializedMethods,
  label:'Specialized retained citation observations using current project context',warnings:source.warnings,entities:source.subjects.map(s=>({id:s.id,label:s.name})),googleConsumerModule:{status:'not_recorded',reason:'consumer_surface_not_captured'},unresolvedEvidence:unresolved,current,previous,
  evidenceStates:observations.map(o=>({id:o.id,period:o.date<filters.from?'previous':'current',eligibility:o.eligibility}))};
 check();return {scope,report,derived,groups,groupRows,gaps,changeStatus,promptInfo};
}

type Selected=Awaited<ReturnType<typeof select>>;
function targetRows(selected:Selected,navigation:SpecializedNavigation):CitationEvidence[]{
 const {period,groupId,gapPromptId,evidenceMode}=navigation;
 if(evidenceMode==='gap_all'){const gap=selected.gaps.get(period+':'+gapPromptId);if(!gap?.matching)throw missing();return gap.evidence;}
 const group=selected.groups.get(groupId!);let rows:CitationEvidence[];
 if(group)rows=group[period!];
 else {
  const entries=selected.derived.filter(d=>d.matches&&d.row.period===period);
  if(navigation.view!=='evidence')throw missing();
  if(groupId===unresolved.redditCommunityId)rows=entries.filter(d=>d.reddit&&!d.community).map(d=>d.row);
  else if(groupId===unresolved.shoppingLabelId)rows=entries.filter(d=>d.row.classification.sourceType==='google_shopping'&&!d.product).map(d=>d.row);
  else if(groupId===unresolved.searchQueryId)rows=entries.filter(d=>d.row.classification.sourceType==='google_search'&&!d.query).map(d=>d.row);
  else if(groupId===unresolved.googleWrapperId)rows=entries.filter(d=>d.row.classification.sourceType==='google_wrapper').map(d=>d.row);
  else throw missing();
 }
 if(gapPromptId){if(!rows.some(r=>r.promptId===gapPromptId))throw missing();rows=rows.filter(r=>r.promptId===gapPromptId);}
 return rows;
}
const cursorShape=z.object({scope:hex,revision:hex,offset:z.number().int().min(1).max(400000)}).strict();
function offset(raw:string|null,scope:string,revision:string){if(raw===null)return 0;let value:unknown;
 try{if(!raw||raw.length>512||!/^[A-Za-z0-9_-]+$/.test(raw))throw bad();value=JSON.parse(Buffer.from(raw,'base64url').toString('utf8'));}catch{throw bad();}
 const parsed=cursorShape.safeParse(value);if(!parsed.success||parsed.data.scope!==scope)throw bad();if(parsed.data.revision!==revision)throw changed();return parsed.data.offset;}
export async function getPromptCitationSpecializations(projectId:string,userId:string,params=new URLSearchParams(),signal?:AbortSignal):Promise<SpecializedReport>{
 const input=parse(params),check=deadline(signal);check();return withContentProject(projectId,userId,false,async(client,p)=>{
  const selected=await select(client,p,input.filters,check),{navigation}=input,scope=canonicalHash({scope:selected.scope,navigation}),at=offset(input.cursor,scope,selected.report.selectionRevision),next=at+50;
  let page:SpecializedPage,totalRows:number;
  if(navigation.view==='reddit'||navigation.view==='shopping'||navigation.view==='search'){
   const kind=navigation.view==='shopping'?'product':navigation.view==='search'?'query':'reddit',rows=selected.groupRows.filter(g=>g.kind===kind);totalRows=rows.length;
   page={kind:navigation.view,rows:rows.slice(at,next)} as SpecializedPage;
  }else if(navigation.view==='gaps'){
   const rows=[...selected.gaps.values()].filter(g=>g.matching&&g.row.period===navigation.period).map(g=>g.row).sort((a,b)=>b.competitorCount.annotations-a.competitorCount.annotations||cmp(a.promptId,b.promptId));
   totalRows=rows.length;page={kind:'gaps',rows:rows.slice(at,next)};
  }else {
   const rows=targetRows(selected,navigation);check();
   if(navigation.view==='evidence'){rows.sort(evidenceOrder);totalRows=rows.length;page={kind:'evidence',basis:navigation.evidenceMode!,rows:rows.slice(at,next)};}
   else if(navigation.view==='prompts'){
    const prompts=[...bucket(rows,e=>e.promptId).values()].map(evidence=>({...selected.promptInfo(evidence),count:count(evidence)})).sort((a,b)=>b.count.annotations-a.count.annotations||cmp(a.promptId,b.promptId));
    totalRows=prompts.length;page={kind:'prompts',rows:prompts.slice(at,next)};
   }else {
    const group=selected.groups.get(navigation.groupId!);if(!group||group.kind!=='reddit')throw missing();
    const other=new Set(group[navigation.period==='current'?'previous':'current'].map(e=>e.urlId));
    const pages=[...bucket(rows,e=>e.urlId)].map(([urlId,evidence])=>({id:urlId,urlId,groupedUrl:evidence[0].groupedUrl,count:count(evidence),representative:representative(evidence)!,newlyObserved:selected.changeStatus==='ready'?!other.has(urlId):null})).sort((a,b)=>b.count.annotations-a.count.annotations||cmp(a.id,b.id));
    totalRows=pages.length;page={kind:'reddit_pages',rows:pages.slice(at,next)};
   }
  }
  const report:SpecializedReport={...selected.report,navigation,page,totalRows,nextCursor:next<totalRows?Buffer.from(JSON.stringify({scope,revision:selected.report.selectionRevision,offset:next})).toString('base64url'):null};
  check();if(Buffer.byteLength(JSON.stringify(report))>2*1024*1024)throw cap();return report;
 }).catch(failure);
}
export async function exportPromptCitationSpecializations(projectId:string,userId:string,raw:unknown,signal?:AbortSignal){
 const shape=z.object({from:z.string(),to:z.string(),timeZone:z.string(),model:z.string().nullable().optional(),promptId:z.string().nullable().optional(),tag:z.string().nullable().optional(),urlGrouping:z.string(),
  query:z.string().nullable().optional(),publisherCategory:z.string().nullable().optional(),pageType:z.string().nullable().optional(),sourceType:z.string().nullable().optional(),ownership:z.string().nullable().optional(),entityId:z.string().nullable().optional(),productAttribution:z.string().nullable().optional(),expectedSelectionRevision:hex}).strict();
 const parsed=shape.safeParse(raw);if(!parsed.success)throw bad();const {expectedSelectionRevision,...values}=parsed.data,params=new URLSearchParams();for(const [key,value]of Object.entries(values))if(value!==null&&value!==undefined)params.set(key,value);
 const {filters}=parse(params),check=deadline(signal);check();return withContentProject(projectId,userId,false,async(client,p)=>{
  const selected=await select(client,p,filters,check),r=selected.report;if(r.selectionRevision!==expectedSelectionRevision)throw changed();
  const header=['Record','Basis','Matches source filters','Period','As of','Context revision','Profile hash','Selection revision','Applied filters','Methods','Summary','Group ID','Execution ID','Comparison ID','Prompt ID','Version ID','Requested at','Retained citation index','Retained URL','Retained title','Grouped URL ID','Grouped URL','Classification','Group references','Gap proof'];
  const lines:string[]=[];let bytes=0,rowCount=0;
  const line=(cells:unknown[])=>{check();const text=[...cells,...Array(Math.max(0,header.length-cells.length)).fill('')].map(csvCell).join(',')+'\r\n';bytes+=Buffer.byteLength(text);if(bytes>16*1024*1024)throw new FoundationError(413,'The specialized citation export exceeds 16 MiB. Narrow the date range or source filters.');lines.push(text);};
  const prefix=[r.asOf,r.contextRevision,r.profileHash,r.selectionRevision,filters,{...r.methods,eligibilityVersion:r.eligibilityVersion,classifierVersion,ownershipVersion,googleDomainsVersion}];line(header);
  line(['metadata','','','',...prefix,{label:r.label,warnings:r.warnings,entities:r.entities,googleConsumerModule:r.googleConsumerModule}]);rowCount++;
  for(const period of periods){line(['period','','',period,...prefix,r[period]]);rowCount++;}
  for(const g of selected.groupRows){line([g.kind,'matching','','',...prefix,g,g.id]);rowCount++;}
  const proof=new Set<string>();
  for(const g of [...selected.gaps.values()].sort((a,b)=>cmp(a.row.period,b.row.period)||cmp(a.row.promptId,b.row.promptId))){line(['gap','base_predicate','',g.row.period,...prefix,g.row,'','','',g.row.promptId,g.row.representativeVersionId]);rowCount++;for(const e of g.evidence)proof.add(e.id);}
  const reference=(kind:string,key:string|null)=>{if(key===null)return null;const id=groupId(kind,key);return selected.groups.has(id)?id:null;};
  for(const d of selected.derived){check();const e=d.row,gapProof=proof.has(e.id),matching=d.matches&&(!d.product||!filters.productAttribution||d.attribution?.kind===filters.productAttribution);if(!matching&&!gapProof)continue;
   const references={reddit:reference('reddit',d.community?'r/'+d.community:null),product:reference('product',d.product?.toLowerCase()??null),query:reference('query',d.query?.toLowerCase()??null)};
   line(['evidence',matching?'matching':'gap_proof',d.matches,e.period,...prefix,'','',e.executionId,e.comparisonId,e.promptId,e.versionId,e.requestedAt,e.retainedCitationIndex,e.retainedUrl,e.retainedTitle,e.urlId,e.groupedUrl,e.classification,references,gapProof]);rowCount++;
  }
  check();return {role:p.role,filename:'prompt-citation-specializations.csv',contentType:'text/csv; charset=utf-8',rowCount,body:lines.join('')};
 }).catch(failure);
}
