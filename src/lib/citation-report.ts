import type {CitationReport,CitationFilters,CitationNavigation,CitationCount,CitationAxes,CitationPeriod,CitationEvidence} from '../server/prompt-citations';
import type {CarriedCitations} from '../server/citation-carried';
import {openRouterModelId} from './openrouter-models.ts';
import {workspaceRoles} from '@ten98/runtime';

// Browser-side enum values only: never import the server's domain lists/classifier.
export const citationPublishers=['editorial','reviews','ecommerce','social','developer','pr','reference','institutional','other'] as const;
export const citationPageTypes=['homepage','article','listicle','howto','comparison','review','product','doc','forum','video','info','search','shopping','other'] as const;
export const citationSources=['publisher','google_shopping','google_search','google_wrapper','unclassified'] as const;
export const citationOwners=['untracked','brand','competitor','ambiguous'] as const;
export const citationChanges=['newly_observed','fewer_citations','not_observed_now','annotation_title_changed'] as const;
const kinds=['eligible','queued','running','no_answer','empty','truncated','content_filtered','expired','invalid'] as const;
const coverageKeys=['attempted',...kinds] as const;
const filterKeys=['from','to','timeZone','model','promptId','tag','urlGrouping','query','publisherCategory','pageType','sourceType','ownership','entityId'];
const navigationKeys=['view','period','urlId','domainId','changeKind'];
const object=(v:unknown):v is Record<string,any>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const integer=(v:unknown,max=100000):v is number=>Number.isSafeInteger(v)&&Number(v)>=0&&Number(v)<=max;
const text=(v:unknown,max=2048,min=0):v is string=>typeof v==='string'&&v.length>=min&&v.length<=max&&!/[\x00-\x1f\x7f\uD800-\uDFFF]/u.test(v);
const prose=(v:unknown,max=2*1024*1024):v is string=>typeof v==='string'&&v.length<=max&&!/[\x00\uD800-\uDFFF]/u.test(v);
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const hex=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const stamp=(v:unknown):v is string=>typeof v==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z$/.test(v)&&Number.isFinite(Date.parse(v));
const day=(v:unknown):v is string=>typeof v==='string'&&/^\d{4}-\d\d-\d\d$/.test(v)&&!v.startsWith('0000')&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString().slice(0,10)===v;
const member=(v:unknown,values:readonly string[])=>typeof v==='string'&&values.includes(v);
const equal=(v:unknown,expected:object,keys:string[])=>object(v)&&Object.keys(v).length===keys.length&&keys.every(k=>v[k]===(expected as any)[k]);

export function validCitationFilters(v:unknown):v is CitationFilters {
  if(!object(v)||Object.keys(v).length!==filterKeys.length||!filterKeys.every(k=>k in v)||!day(v.from)||!day(v.to)||v.from>v.to||Date.parse(v.to)-Date.parse(v.from)>30*86400000||!text(v.timeZone,120,1)||v.model!==null&&!openRouterModelId(v.model)||v.promptId!==null&&!uuid(v.promptId)||v.tag!==null&&(!prose(v.tag,80)||!v.tag||v.tag.trim()!==v.tag)||!member(v.urlGrouping,['retained-fragment-v1','elmo-url-v1']))return false;
  try{new Intl.DateTimeFormat('en',{timeZone:v.timeZone});}catch{return false;}
  if(v.query!==null&&(!text(v.query,200,1)||v.query.trim()!==v.query)||v.entityId!==null&&v.entityId!=='brand'&&!uuid(v.entityId))return false;
  return (v.publisherCategory===null||member(v.publisherCategory,citationPublishers))&&(v.pageType===null||member(v.pageType,citationPageTypes))&&(v.sourceType===null||member(v.sourceType,citationSources))&&(v.ownership===null||member(v.ownership,citationOwners));
}

export function citationSafeHref(value:string):string|null {
  try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&prose(value,20480)?u.href:null;}catch{return null;}
}

export function citationPublicHost(value:unknown):value is string {
  if(!text(value,253,3)||value!==value.toLowerCase()||value.endsWith('.')||/^\d+(?:\.\d+){3}$/.test(value))return false;
  if(['localhost','local','internal','invalid','test','example','onion','home.arpa'].some(s=>value===s||value.endsWith('.'+s)))return false;
  const labels=value.split('.');
  return labels.length>=2&&!/^\d+$/.test(labels.at(-1)!)&&labels.every(s=>/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(s));
}
function retained(value:unknown):value is string{return prose(value,2048)&&citationSafeHref(value)!==null;}
export function citationRetainedHost(value:string):string|null {if(!retained(value))return null;const h=new URL(value).hostname.replace(/\.$/,'');return citationPublicHost(h)?h:null;}
function coverage(v:unknown):boolean{return object(v)&&coverageKeys.every(k=>integer(v[k],1000))&&kinds.reduce((n,k)=>n+v[k],0)===v.attempted;}
function count(v:unknown,executions:number,annotations:number):v is CitationCount {
  return object(v)&&integer(v.executions,executions)&&integer(v.annotations,annotations)&&integer(v.prompts,v.executions)&&v.executions<=v.annotations&&v.annotations<=v.executions*100&&(v.executions===0)===(v.prompts===0);
}
function axes(v:unknown,executions:number,annotations:number):v is CitationAxes {
  if(!object(v))return false;
  for(const [key,values]of [['ownership',citationOwners],['publisher',citationPublishers],['pageType',citationPageTypes],['sourceType',citationSources]] as const){
    const rows=v[key];
    if(!Array.isArray(rows)||rows.length!==values.length||!rows.every((r:unknown,i:number)=>object(r)&&r.key===values[i]&&count(r.count,executions,annotations))||rows.reduce((n,r)=>n+r.count.annotations,0)!==annotations||rows.reduce((n,r)=>n+r.count.executions,0)<executions)return false;
  }
  return true;
}
function period(v:unknown,from:string,to:string):v is CitationPeriod {
  return object(v)&&v.from===from&&v.to===to&&coverage(v.coverage)&&v.eligibleAnswers===(v.coverage.eligible||null)&&integer(v.citedExecutions,v.coverage.eligible)&&integer(v.annotations,v.citedExecutions*100)&&v.citedExecutions<=v.annotations&&integer(v.uniqueUrls,v.annotations)&&integer(v.unclassifiedHostAnnotations,v.annotations)&&integer(v.uniqueDomains,v.annotations-v.unclassifiedHostAnnotations)&&(v.annotations===0)===(v.uniqueUrls===0)&&(v.annotations===v.unclassifiedHostAnnotations)===(v.uniqueDomains===0);
}
function part(v:unknown,p:CitationPeriod):boolean{return object(v)&&count(v.count,p.citedExecutions,p.annotations)&&axes(v.axes,v.count.executions,v.count.annotations);}

export function validCitationReport(value:unknown,f:CitationFilters,n:CitationNavigation,pageIndex:number):value is CitationReport {
  try{return report(value,f,n,pageIndex);}catch{return false;}
}
const localDayIn=(timeZone:string)=>{const formatter=new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'});return (timestamp:string)=>{const parts=formatter.formatToParts(new Date(timestamp)),p=(type:string)=>parts.find(p=>p.type===type)!.value;return `${p('year')}-${p('month')}-${p('day')}`;};};
function report(v:unknown,f:CitationFilters,n:CitationNavigation,pageIndex:number):v is CitationReport {
  if(!validCitationFilters(f)||!integer(pageIndex,8000)||!object(v)||!member(v.role,workspaceRoles)||!equal(v.filters,f,filterKeys)||!equal(v.navigation,n,navigationKeys)||!stamp(v.asOf)||!integer(v.contextRevision,2147483647)||v.contextRevision<1||!hex(v.profileHash)||!hex(v.selectionRevision)||v.eligibilityVersion!=='retained-nonempty-stop-v1'||v.classifierVersion!=='elmo-3c673d0-native-axes-v1'||v.ownershipVersion!=='citation-host-suffix-v1'||!text(v.googleDomainsVersion,160)||!/^google-supported-2026-10-13-sha256-[a-f0-9]{64}$/.test(v.googleDomainsVersion)||v.label!=='Retained citation observations classified using current project context'||!Array.isArray(v.warnings)||v.warnings.length>10||!v.warnings.every((w:unknown)=>text(w)))return false;
  const length=1+(Date.parse(f.to)-Date.parse(f.from))/86400000,previousFrom=new Date(Date.parse(f.from)-length*86400000).toISOString().slice(0,10),previousTo=new Date(Date.parse(f.from)-86400000).toISOString().slice(0,10);
  if(!day(previousFrom)||!period(v.current,f.from,f.to)||!period(v.previous,previousFrom,previousTo)||v.current.coverage.attempted+v.previous.coverage.attempted>1000||!object(v.axes)||!axes(v.axes.current,v.current.citedExecutions,v.current.annotations)||!axes(v.axes.previous,v.previous.citedExecutions,v.previous.annotations))return false;
  if(!Array.isArray(v.entities)||v.entities.length<1||v.entities.length>101||new Set(v.entities.map((e:any)=>e?.id)).size!==v.entities.length||!v.entities.every((e:unknown,i:number)=>object(e)&&(i===0?e.id==='brand':uuid(e.id))&&prose(e.label,512)&&e.label.length>0)||f.entityId!==null&&!v.entities.some((e:any)=>e.id===f.entityId))return false;
  const ids=v.entities.map((e:any)=>e.id),localDay=localDayIn(f.timeZone);
  if(v.periodOpen!==(f.to>=localDay(v.asOf)))return false;
  const status=!v.current.coverage.attempted?'no_data':!v.previous.coverage.attempted?'no_previous':!v.current.eligibleAnswers||!v.previous.eligibleAnswers?'unavailable':v.periodOpen?'in_progress':v.current.coverage.eligible*10<v.current.coverage.attempted*9||v.previous.coverage.eligible*10<v.previous.coverage.attempted*9?'incomplete':'ready';
  if(!object(v.changes)||v.changes.status!==status||v.changes.countBasis!=='annotation_occurrences'||!object(v.changes.counts)||!citationChanges.every(k=>integer(v.changes.counts[k],400000)&&(status==='ready'||v.changes.counts[k]===0)))return false;
  if(!Array.isArray(v.evidenceStates)||v.evidenceStates.length!==v.current.coverage.attempted+v.previous.coverage.attempted||new Set(v.evidenceStates.map((e:any)=>e?.id)).size!==v.evidenceStates.length||!v.evidenceStates.every((e:unknown)=>object(e)&&uuid(e.id)&&member(e.period,['current','previous'])&&member(e.eligibility,kinds)))return false;
  for(const side of ['current','previous'] as const){const entries=v.evidenceStates.filter((e:any)=>e.period===side);if(!coverageKeys.every(k=>k==='attempted'?entries.length===v[side].coverage.attempted:entries.filter((e:any)=>e.eligibility===k).length===v[side].coverage[k]))return false;}
  if(!Array.isArray(v.daily)||v.daily.length!==length*2||!v.daily.every((d:unknown,i:number)=>{const date=new Date(Date.parse(previousFrom)+i*86400000).toISOString().slice(0,10);return object(d)&&d.date===date&&d.period===(i<length?'previous':'current')&&period(d.summary,date,date)&&axes(d.axes,d.summary.citedExecutions,d.summary.annotations);} ))return false;
  for(const side of ['current','previous'] as const){const days=v.daily.filter((d:any)=>d.period===side),p=v[side];
    if(!coverageKeys.every(k=>days.reduce((sum:number,d:any)=>sum+d.summary.coverage[k],0)===p.coverage[k])||!['citedExecutions','annotations','unclassifiedHostAnnotations'].every(k=>days.reduce((sum:number,d:any)=>sum+d.summary[k],0)===p[k]))return false;
    for(const key of ['uniqueUrls','uniqueDomains'])if(p[key]<Math.max(...days.map((d:any)=>d.summary[key]))||p[key]>days.reduce((sum:number,d:any)=>sum+d.summary[key],0))return false;
    for(const key of ['ownership','publisher','pageType','sourceType'])for(let i=0;i<v.axes[side][key].length;i++)for(const metric of ['executions','annotations'])if(days.reduce((sum:number,d:any)=>sum+d.axes[key][i].count[metric],0)!==v.axes[side][key][i].count[metric])return false;
  }
  const eligible=(id:string,side:string)=>v.evidenceStates.some((e:any)=>e.id===id&&e.period===side&&e.eligibility==='eligible');
  const representative=(r:unknown,side:'current'|'previous',present:boolean)=>{
    if(!present)return r===null;
    return object(r)&&uuid(r.executionId)&&eligible(r.executionId,side)&&uuid(r.comparisonId)&&integer(r.retainedCitationIndex,99)&&retained(r.retainedUrl)&&(r.retainedTitle===null||prose(r.retainedTitle))&&stamp(r.requestedAt)&&localDay(r.requestedAt)>=v[side].from&&localDay(r.requestedAt)<=v[side].to;
  };
  if(!object(v.page)||v.page.kind!==n.view||!Array.isArray(v.page.rows)||!integer(v.totalRows,400000)||v.page.rows.length!==Math.min(50,Math.max(0,v.totalRows-pageIndex*50))||!(v.nextCursor===null||text(v.nextCursor,512,1))||(v.nextCursor!==null)!==(v.totalRows>(pageIndex+1)*50)||new Set(v.page.rows.map((r:any)=>r?.id)).size!==v.page.rows.length)return false;
  const rows=v.page.rows;
  if(n.view==='categories')return v.totalRows===9&&rows.every((r:any,i:number)=>object(r)&&r.id===citationPublishers[pageIndex*50+i]&&part(r.current,v.current)&&part(r.previous,v.previous)&&['current','previous'].every(side=>Object.keys(r[side].count).every(k=>r[side].count[k]===v.axes[side].publisher[pageIndex*50+i].count[k])));
  if(n.view==='urls')return v.totalRows<=v.current.uniqueUrls+v.previous.uniqueUrls&&v.totalRows>=Math.max(v.current.uniqueUrls,v.previous.uniqueUrls)&&rows.every((r:any)=>object(r)&&hex(r.id)&&prose(r.url,20480)&&citationSafeHref(r.url)!==null&&part(r.current,v.current)&&part(r.previous,v.previous)&&r.current.count.annotations+r.previous.count.annotations>0&&representative(r.currentRepresentative,'current',r.current.count.annotations>0)&&representative(r.previousRepresentative,'previous',r.previous.count.annotations>0));
  if(n.view==='domains')return v.totalRows<=v.current.uniqueDomains+v.previous.uniqueDomains+Number(v.current.unclassifiedHostAnnotations+v.previous.unclassifiedHostAnnotations>0)&&v.totalRows>=Math.max(v.current.uniqueDomains,v.previous.uniqueDomains)&&rows.every((r:any)=>object(r)&&hex(r.id)&&(r.hostname===null||citationPublicHost(r.hostname))&&r.trackable===(r.hostname!==null)&&part(r.current,v.current)&&part(r.previous,v.previous)&&r.current.count.annotations+r.previous.count.annotations>0&&integer(r.currentUniqueUrls,r.current.count.annotations)&&integer(r.previousUniqueUrls,r.previous.count.annotations)&&(r.currentUniqueUrls===0)===(r.current.count.annotations===0)&&(r.previousUniqueUrls===0)===(r.previous.count.annotations===0));
  if(n.view==='changes'){
    if(v.totalRows!==(n.changeKind?v.changes.counts[n.changeKind]:citationChanges.reduce((sum,k)=>sum+v.changes.counts[k],0)))return false;
    return rows.every((r:any)=>{
      if(!object(r)||!hex(r.id)||!hex(r.targetId)||!member(r.kind,citationChanges)||n.changeKind!==null&&r.kind!==n.changeKind||!member(r.target,['url','domain'])||!prose(r.label,20480)||!count(r.current,v.current.citedExecutions,v.current.annotations)||!count(r.previous,v.previous.citedExecutions,v.previous.annotations))return false;
      if(r.target==='domain'?(r.before!==null||r.after!==null):!representative(r.before,'previous',r.previous.annotations>0)||!representative(r.after,'current',r.current.annotations>0))return false;
      return r.kind==='newly_observed'?r.previous.annotations===0&&r.current.annotations>=2:r.kind==='fewer_citations'?r.previous.annotations>=2&&r.current.annotations>0&&r.current.annotations*2<=r.previous.annotations:r.kind==='not_observed_now'?r.previous.annotations>=2&&r.current.annotations===0:r.target==='url'&&!!r.before?.retainedTitle?.trim()&&!!r.after?.retainedTitle?.trim()&&r.before.retainedTitle!==r.after.retainedTitle;
    });
  }
  if(n.view!=='evidence'||!n.period||v.totalRows>v[n.period].annotations||!n.urlId&&!n.domainId&&v.totalRows!==v[n.period].annotations)return false;
  return rows.every((r:unknown)=>validCitationEvidence(r,f,{period:n.period!,from:v[n.period!].from,to:v[n.period!].to,eligible:id=>eligible(id,n.period!),competitorIds:ids,urlId:n.urlId}));
}

export type CitationEvidenceScope={period:'current'|'previous';from:string;to:string;eligible:(executionId:string)=>boolean;competitorIds:readonly string[];urlId?:string|null;applySourceFilters?:boolean};
// Shared record boundary; each report keeps its own page, navigation and population checks.
export function validCitationEvidence(r:unknown,f:CitationFilters,scope:CitationEvidenceScope):r is CitationEvidence {
  try{
    if(!validCitationFilters(f))return false;
    const localDay=localDayIn(f.timeZone);
    if(!object(r)||!hex(r.id)||!hex(r.urlId)||![r.executionId,r.comparisonId,r.promptId,r.versionId].every(uuid)||r.period!==scope.period||!scope.eligible(r.executionId)||!stamp(r.requestedAt)||!day(r.date)||localDay(r.requestedAt)!==r.date||r.date<scope.from||r.date>scope.to||!openRouterModelId(r.model)||f.model!==null&&r.model!==f.model||f.promptId!==null&&r.promptId!==f.promptId||!integer(r.retainedCitationIndex,99)||!retained(r.retainedUrl)||(r.retainedTitle!==null&&!prose(r.retainedTitle))||!prose(r.groupedUrl,20480)||citationSafeHref(r.groupedUrl)===null||r.hostname!==citationRetainedHost(r.retainedUrl)||r.trackable!==(r.hostname!==null)||scope.urlId!=null&&r.urlId!==scope.urlId)return false;
    const c=r.classification,o=c?.ownership;
    if(!object(c)||!object(o)||typeof o.brand!=='boolean'||!Array.isArray(o.competitorIds)||o.competitorIds.length>100||!o.competitorIds.every((id:unknown,i:number)=>uuid(id)&&scope.competitorIds.includes(id)&&(i===0||o.competitorIds[i-1]<id))||o.ambiguous!==(o.competitorIds.length>1||o.brand&&o.competitorIds.length>0)||!member(c.publisherCategory,citationPublishers)||!member(c.automaticPublisherCategory,citationPublishers)||!member(c.publisherBasis,['override','elmo-automatic','unclassified'])||!member(c.pageType,citationPageTypes)||c.pageTypeBasis!=='elmo-url-title-heuristic-v1'||!member(c.sourceType,citationSources))return false;
    if(r.hostname===null?(c.publisherBasis!=='unclassified'||c.sourceType!=='unclassified'||c.publisherCategory!=='other'||c.automaticPublisherCategory!=='other'||o.brand||o.competitorIds.length>0):(c.publisherBasis==='unclassified'||c.sourceType==='unclassified'))return false;
    if(c.publisherBasis==='elmo-automatic'&&c.publisherCategory!==c.automaticPublisherCategory)return false;
    const owner=o.ambiguous?'ambiguous':o.brand?'brand':o.competitorIds.length?'competitor':'untracked';
    return scope.applySourceFilters===false||(!f.query||[r.retainedUrl,r.retainedTitle??'',r.hostname??''].some(s=>s.toLowerCase().includes(f.query!.toLowerCase())))&&(!f.publisherCategory||f.publisherCategory===c.publisherCategory)&&(!f.pageType||f.pageType===c.pageType)&&(!f.sourceType||f.sourceType===c.sourceType)&&(!f.ownership||f.ownership===owner)&&(!f.entityId||(f.entityId==='brand'?o.brand:o.competitorIds.includes(f.entityId)));

  }catch{return false;}
}

const carriedAxisKeys={ownership:citationOwners,publisher:citationPublishers,pageType:citationPageTypes,sourceType:citationSources} as const;
/** Additive block: a malformed or absent `carried` only disables the carried view; observed validation is unchanged. */
export function validCarriedCitations(value:unknown,dates:string[]):CarriedCitations|null{
  const v=(object(value)?value:{}).carried;
  if(!object(v)||v.method!=='elmo-lvcf-v1'||!Array.isArray(v.dates)||v.dates.length!==dates.length||!v.dates.every((d:unknown,i:number)=>d===dates[i])||!Array.isArray(v.observed)||v.observed.length!==dates.length||!v.observed.every((o:unknown)=>typeof o==='boolean')||!object(v.axes))return null;
  for(const [axis,keys] of Object.entries(carriedAxisKeys)){const rows=v.axes[axis];
    if(!Array.isArray(rows)||rows.length!==keys.length||!rows.every((r:unknown,i:number)=>object(r)&&r.key===keys[i]&&Array.isArray(r.values)&&r.values.length===dates.length&&r.values.every((n:unknown)=>typeof n==='number'&&Number.isFinite(n)&&n>=0&&n<=1e6)))return null;}
  return v as CarriedCitations;
}
