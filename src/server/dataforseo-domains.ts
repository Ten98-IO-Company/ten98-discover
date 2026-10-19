import {FoundationError} from './auth.ts';
import {dataforseoJson,dataforseoRefusal,dataforseoRefusalEvidence,dataforseoRefusalMessage} from './dataforseo-transport.ts';
import {keywordReconcileEndpoint,microUsd,providerMicros,validText} from './keyword-research-input.ts';
import {domainEndpoint,domainEndpointName,domainPayload,domainTarget,domainUrlMatches,matchesDomainPayload,type DomainRequest,type DomainReportResult,type DomainRow,type DomainOrganicMetrics,type DomainPageRow,type DomainCompetitorRow} from './domain-research-input.ts';
import {normalizePublicHostname} from './domains.ts';
type Obj=Record<string,unknown>;
const object=(v:unknown):v is Obj=>!!v&&typeof v==='object'&&!Array.isArray(v);
function invalid():never{throw new Error('The domain research response could not be verified.');}
function metric(v:unknown,max=Number.MAX_SAFE_INTEGER,integer=false):number|null{if(v==null)return null;if(typeof v!=='number'||!Number.isFinite(v)||v<0||v>max||integer&&!Number.isSafeInteger(v))invalid();return v;}
function stamp(v:unknown):string|null{if(v==null)return null;if(typeof v!=='string'||v.length>40||!/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,3})? ?(?:Z|\+00:00)$/.test(v))invalid();const d=new Date(v.replace(' ','T').replace(' +00:00','+00:00'));if(!Number.isFinite(d.getTime()))invalid();return d.toISOString();}
function row(value:unknown,request:DomainRequest):DomainRow{
 if(!object(value)||!object(value.keyword_data)||!object(value.ranked_serp_element)||!object(value.ranked_serp_element.serp_item))invalid();
 const k=value.keyword_data,s=value.ranked_serp_element.serp_item,info=k.keyword_info??{},props=k.keyword_properties??{};
 if(!object(info)||!object(props)||!validText(k.keyword,500)||!validText(s.url,16384)||s.type!=='organic'||!domainUrlMatches(s.url,domainTarget(request.target,request.scope)))invalid();
 const url=new URL(s.url);if(s.domain!==url.hostname||s.relative_url!=null&&s.relative_url!==url.pathname+url.search)invalid();
 const position=metric(s.rank_absolute,Number.MAX_SAFE_INTEGER,true);if(position===0)invalid();
 return {keyword:k.keyword,position,searchVolume:metric(info.search_volume,Number.MAX_SAFE_INTEGER,true),estimatedTraffic:metric(s.etv),cpcUsd:info.cpc==null?null:microUsd(providerMicros(info.cpc)),keywordDifficulty:metric(props.keyword_difficulty,100),url:s.url,metricsUpdatedAt:stamp(info.last_updated_time)};
}
function organic(value:unknown):DomainOrganicMetrics{
 if(value!=null&&!object(value))invalid();const v=(value??{}) as Obj;
 const fields=['pos_1','pos_2_3','pos_4_10','pos_11_20','pos_21_30','pos_31_40','pos_41_50','pos_51_60','pos_61_70','pos_71_80','pos_81_90','pos_91_100'];
 return {rankedKeywords:metric(v.count,Number.MAX_SAFE_INTEGER,true),estimatedTraffic:metric(v.etv),estimatedAdsValueUsd:metric(v.estimated_paid_traffic_cost),rankDistribution:fields.map(key=>metric(v[key],Number.MAX_SAFE_INTEGER,true))};
}
function metrics(value:unknown){if(value!=null&&!object(value))invalid();return organic(object(value)?value.organic:undefined);}
function pageRow(value:unknown,request:DomainRequest):DomainPageRow{
 if(!object(value)||value.se_type!=='google'||!validText(value.page_address,16384)||!domainUrlMatches(value.page_address,domainTarget(request.target,request.scope)))invalid();
 return {url:value.page_address,organic:metrics(value.metrics)};
}
function competitorRow(value:unknown,request:DomainRequest):DomainCompetitorRow{
 if(!object(value)||value.se_type!=='google'||!validText(value.domain,253))invalid();
 const domain=normalizePublicHostname(value.domain);if(domain!==value.domain||domain.replace(/^www\./,'')===domainTarget(request.target,request.scope).hostname)invalid();
 const averagePosition=metric(value.avg_position);if(averagePosition!==null&&averagePosition<1)invalid();
 // Provider metrics describe the TARGET on shared keywords; full_domain_metrics
 // describe the competitor. They must not be merged or relabeled as one population.
 return {domain,sharedKeywords:metric(value.intersections,Number.MAX_SAFE_INTEGER,true),averagePosition,fullDomain:metrics(value.full_domain_metrics),targetOverlap:metrics(value.metrics)};
}
export type DomainOutcome={cost:string|null;reference:string|null;result:DomainReportResult|null;diagnostic:string|null;evidence:{httpStatus:number|null;statusCode:number|null;taskStatus:number|null;reportedCost:unknown;taskCost:unknown}};
const final=new Set([20000,40102,40103,40106,40501,40502,40503,40504,40505,40506]);
export function parseDomainOutcome(response:{httpStatus:number;body:unknown},request:DomainRequest,id:string,now=new Date()):DomainOutcome{
 const outcome:DomainOutcome={cost:null,reference:null,result:null,diagnostic:'The provider charge is unknown. Reconcile it before spending again.',evidence:{httpStatus:response.httpStatus,statusCode:null,taskStatus:null,reportedCost:null,taskCost:null}};
 const refused=dataforseoRefusal(response);if(refused)return {...outcome,cost:'0.000000',diagnostic:dataforseoRefusalMessage[refused],evidence:dataforseoRefusalEvidence(response)};
 try{
  const b=response.body;if(!object(b))invalid();outcome.evidence.reportedCost=b.cost;outcome.evidence.statusCode=typeof b.status_code==='number'?b.status_code:null;
  if(response.httpStatus!==200||b.status_code!==20000||b.tasks_count!==1||!Array.isArray(b.tasks)||b.tasks.length!==1||!object(b.tasks[0]))invalid();
  const task=b.tasks[0];outcome.evidence.taskCost=task.cost;outcome.evidence.taskStatus=typeof task.status_code==='number'?task.status_code:null;
  if(!validText(task.id,128)||JSON.stringify(task.path)!==JSON.stringify(['v3','dataforseo_labs','google',domainEndpointName(request),'live'])||!matchesDomainPayload(task.data,request,id)||typeof task.status_code!=='number'||!final.has(task.status_code)||providerMicros(b.cost)!==providerMicros(task.cost))invalid();
  outcome.reference=task.id;outcome.cost=microUsd(providerMicros(task.cost));outcome.diagnostic='The charge was recorded, but no readable result is available. A new run needs a new paid quote.';
  if(task.status_code!==20000||task.result_count!==1||!Array.isArray(task.result)||task.result.length!==1||!object(task.result[0]))invalid();
  const r=task.result[0],t=domainTarget(request.target,request.scope);
  // A live empty result can omit its total; zero returned rows do not prove a zero provider total.
  const unknownTotal=r.total_count===null&&r.items===null&&r.items_count===0;
  const items=r.items===null&&(r.total_count===0||unknownTotal)&&r.items_count===0?[]:r.items;
  const noMarketData=(request.report===undefined||request.report==='pages_v1')&&(r.total_count===0||unknownTotal)&&r.items_count===0&&r.location_code===null&&r.language_code===null;
  if(r.se_type!=='google'||r.target!==t.hostname||!noMarketData&&(r.location_code!==request.locationCode||r.language_code!==request.languageCode)||!unknownTotal&&(!Number.isSafeInteger(r.total_count)||Number(r.total_count)<0)||!Array.isArray(items)||items.length>request.limit||r.items_count!==items.length||!unknownTotal&&Number(r.total_count)<items.length)invalid();
  const totalCount=unknownTotal?null:Number(r.total_count);
  const base={source:'DataForSEO Labs / Google' as const,retrievedAt:now.toISOString(),target:request.target,scope:request.scope,locationCode:request.locationCode,languageCode:request.languageCode,returnedCount:items.length,totalCount,limited:totalCount===null?null:totalCount>items.length};
  if(request.report==='overview_v1'){
   if(base.totalCount!==null&&base.totalCount>1)invalid();const rows=items.map(v=>{if(!object(v)||v.se_type!=='google'||v.location_code!==request.locationCode||v.language_code!==request.languageCode)invalid();return metrics(v.metrics);});
   outcome.result={...base,report:request.report,rows};
  }else if(request.report==='pages_v1'){
   const rows=items.map(v=>pageRow(v,request));if(new Set(rows.map(v=>v.url)).size!==rows.length)invalid();outcome.result={...base,report:request.report,rows};
  }else if(request.report==='competitors_v1'){
   const rows=items.map(v=>competitorRow(v,request));if(new Set(rows.map(v=>v.domain.replace(/^www\./,''))).size!==rows.length)invalid();outcome.result={...base,report:request.report,rows};
  }else{
   const rows=items.map(v=>row(v,request)),seen=new Set<string>();for(const v of rows){const key=JSON.stringify([v.keyword,v.url]);if(seen.has(key))invalid();seen.add(key);}outcome.result={...base,rows};
  }
  outcome.diagnostic=null;
 }catch{/* Financial evidence above is retained independently of malformed content. */}
 return outcome;
}
export async function requestDomainResearch(credentials:unknown,request:DomainRequest,id:string,send:typeof fetch=fetch):Promise<DomainOutcome>{
 try{return parseDomainOutcome(await dataforseoJson(domainEndpoint(request),credentials,'POST',[domainPayload(request,id)],send),request,id);}catch{return {cost:null,reference:null,result:null,diagnostic:'The request may have reached the provider. Its charge is unknown; reconcile it before spending again.',evidence:{httpStatus:null,statusCode:null,taskStatus:null,reportedCost:null,taskCost:null}};}
}
export function parseDomainReconciliation(response:{httpStatus:number;body:unknown},request:DomainRequest,id:string){
 const b=response.body;if(response.httpStatus!==200||!object(b)||b.status_code!==20000||providerMicros(b.cost)!==0n||b.tasks_count!==1||!Array.isArray(b.tasks)||b.tasks.length!==1||!object(b.tasks[0]))invalid();
 const task=b.tasks[0];if(task.status_code!==20000||providerMicros(task.cost)!==0n||!Array.isArray(task.result)||task.result.length>=1000)invalid();
 const matches=task.result.filter(v=>object(v)&&v.url==='v3/dataforseo_labs/google/'+domainEndpointName(request)+'/live'&&matchesDomainPayload(v.metadata,request,id));
 if(matches.length!==1||!object(matches[0])||!validText(matches[0].id,128)||typeof matches[0].status!=='string'||!/^\d{5}$/.test(matches[0].status)||!final.has(Number(matches[0].status)))invalid();
 return {reference:matches[0].id,cost:microUsd(providerMicros(matches[0].cost)),statusCode:Number(matches[0].status)};
}
export async function reconcileDomainCharge(credentials:unknown,request:DomainRequest,id:string,dispatchedAt:Date,send:typeof fetch=fetch){
 if(!Number.isFinite(dispatchedAt.getTime())||Date.now()-dispatchedAt.getTime()>28*86400000)throw new FoundationError(409,'The provider charge lookup window expired. Review the recorded receipt.');
 const stamp=(date:Date)=>date.toISOString().replace('T',' ').slice(0,19)+' +00:00';
 try{return parseDomainReconciliation(await dataforseoJson(keywordReconcileEndpoint,credentials,'POST',[{datetime_from:stamp(new Date(dispatchedAt.getTime()-60000)),datetime_to:stamp(new Date(Math.min(Date.now(),dispatchedAt.getTime()+120000))),limit:1000,offset:0,sort:'asc',include_metadata:true}],send),request,id);}catch{throw new FoundationError(409,'The charge could not be matched uniquely. The charge remains unresolved; do not repeat the paid request.');}
}
