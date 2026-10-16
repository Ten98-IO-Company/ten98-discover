import {analyticsFieldLimit} from '../lib/analytics-dimensions';
import {isGeo,fieldValueLabel,patchLocationFilters,GeographyValueControl,KINDS,FILTERS,PROP_TYPES,TIMEZONES,utcDate,labelOf,num,decimal,emptyAdvanced,initialDraft,buildParams,record,uuid,clean,draftFilterQuery,savedPredicates,validSaved,sameDefinition,preciseDate,buildAdvanced,readAdvanced,focusAdvanced,validAdvancedResult,qualificationDraft,validCohort,sameCohortDefinition,reportParams,validSessionSelection,sessionReason,AdvancedSummary,SessionStatus,AdvancedControls,ExactFilterControls,type SessionSelection,type FilterRow,type AdvancedRow,type AdvancedDraft,type AdvancedIssue,type Draft,type Definition,type SavedFilter,type CohortRef} from './ExplorerFilters';
import {useEffect,useId,useRef,useState,type FormEvent} from 'react';
import {useBlocker} from '@tanstack/react-router';
import {api,ApiError,errMsg} from '../lib/api';
import {useAnnotations} from './AnnotationsPanel';
import type {AdvancedPredicates} from '../server/advanced-predicate-input';
import type {advancedPredicateMethod} from '../server/advanced-predicates';
import {geographyFields,parseGeographyKey,type GeoField} from '../lib/analytics-geography';
import {geographyLabel} from './GeographyCard';
import {GeographyAttribution} from './GeographyAttribution';
import {environmentCatalog,environmentFields,type EnvironmentField} from '../lib/analytics-environment';
import type {PropertyReport} from '../server/explorer';
import {propertyWeekdays,propertyDecimal,comparePropertyDecimals,propertyDecimalScale,validPropertyDateSummary,validPropertyNumberStats} from '../lib/property-visuals';

type Coverage='complete'|'partial'|'unavailable';


export interface ExploreResult{
  propertyReport?:PropertyReport;
  range:{from:string;to:string;timeZone:string;start:string;end:string};
  query:{from:string;to:string;timeZone:string;kind:string;groupBy?:string;groupProperty?:string|null;fields?:string[];filters:Record<string,string>;property:{key:string;type:string;value:unknown}|null;cohort?:CohortRef;predicates?:AdvancedPredicates};
  predicateMethod?:ReturnType<typeof advancedPredicateMethod>;
  sessionProperties?:SessionSelection;
  coverage:{status:Coverage;retainedFrom:string|null};
  totals:{events:number|null;pageViews:number|null;customEvents:number|null;identifiedEvents:number|null;unidentifiedEvents:number|null;visitors:number|null;visits:number|null};
  daily:Array<{date:string;start:string;end:string;skipped:boolean;coverage:Coverage;events:number|null;pageViews:number|null;customEvents:number|null}>;
  breakdown:{groups:Array<{type:string;value:unknown;events:number;identifiedEvents:number;visitors:number|null;pageViews?:number;identifiedPageViews?:number;estimatedVisitors?:number|null;visits?:number|null;bounceRate?:number|null;averageVisitSeconds?:number|null}>;totalGroups:number|null;returnedGroupEvents:number|null;truncated:boolean};
  properties:{keys:string[];truncated:boolean};
  numeric:{samples:number;sum:string|null;average:string|null;min:string|null;max:string|null}|null;
  csv:string;
  geographyProvenance?:{source:'db-ip-city-lite';scope:'matching-report-events';databaseCount:number|null;oldestDatabaseBuild:number|null;newestDatabaseBuild:number|null};
  cohort?:{item:SavedFilter;range:{from:string;to:string;timeZone:string;start:string;end:string};coverage:{status:Coverage;retainedFrom:string|null};identity:{status:Coverage;identifiedEvents:number|null;unidentifiedEvents:number|null;observedMemberKeys:number|null};membership:{status:'available'|'unavailable';countsAreLowerBounds:boolean};limitation:string;predicateMethod?:ReturnType<typeof advancedPredicateMethod>;sessionProperties?:SessionSelection};
}

const GROUPS=[['event','Event name'],['path','Path'],['origin','Origin'],['referrer','Referrer'],['language','Language'],['browser','Browser'],['os','OS'],['device','Device'],['country','Country'],['region','Region'],['city','City'],['campaignSource','Campaign source'],['campaignMedium','Campaign medium'],['campaignName','Campaign name'],['campaignTerm','Campaign term'],['campaignContent','Campaign content'],['screenWidth','Screen width'],['screenHeight','Screen height'],['property','Property']] as const;
type Role='owner'|'admin'|'editor'|'viewer';
type SaveAttempt={kind:'create'|'update'|'delete';id?:string;body:{requestId:string;revision?:number;definition?:Definition}};
type CohortEditor={item:SavedFilter|null;name:string;draft:Draft};
const roleValue=(value:unknown):value is Role=>['owner','admin','editor','viewer'].includes(value as string);
const canSave=(role:Role|null)=>role==='owner'||role==='admin'||role==='editor';
function tupleFields(raw:string|null):string[]|null{
  try{const fields:unknown=JSON.parse(raw??'null');return Array.isArray(fields)&&fields.length>=2&&fields.length<=3&&new Set(fields).size===fields.length&&fields.every(field=>GROUPS.some(([key])=>key!=='property'&&key===field))?fields:null;}catch{return null;}
}
function combinationParams(draft:Draft,cohort:CohortRef|null,fields:string[]|null,propertyDetails=false){
  if(propertyDetails&&!fields&&draft.groupBy==='property'){
    const value=reportParams(draft,cohort);if('error'in value)return value;const p=new URLSearchParams(value.qs);p.set('propertyView','details');return p.toString().length>20000?{error:'These filters are too large.'}:{qs:p.toString()};
  }
  const result=reportParams(fields?{...draft,groupBy:'event',groupProperty:''}:draft,cohort);if('error'in result||!fields)return result;
  if(!tupleFields(JSON.stringify(fields)))return {error:'Choose two or three different fields.'};
  const p=new URLSearchParams(result.qs);p.delete('groupBy');p.delete('groupProperty');p.set('fields',JSON.stringify(fields));
  return p.toString().length>20000?{error:'These filters are too large. Shorten values or remove conditions.'}:{qs:p.toString()};
}
export function validReportBase(result:ExploreResult,params:URLSearchParams):boolean{
  if(!record(result)||!record(result.query)||!record(result.totals)||!record(result.breakdown)||!record(result.coverage)||!['complete','partial','unavailable'].includes(result.coverage.status)||!Array.isArray(result.breakdown.groups)||!clean(result.csv,2097152))return false;
  for(const key of ['from','to','kind']as const)if(result.query[key]!==params.get(key))return false;
  try{if(new Intl.DateTimeFormat('en-US',{timeZone:result.query.timeZone}).resolvedOptions().timeZone!==new Intl.DateTimeFormat('en-US',{timeZone:params.get('timeZone')!}).resolvedOptions().timeZone)return false;}catch{return false;}
  if(!record(result.range)||(['from','to','timeZone']as const).some(key=>result.range[key]!==result.query[key]))return false;
  const expectedFilters=Object.fromEntries(FILTERS.filter(([key])=>params.has(key)).map(([key])=>[key,params.get(key)]));if(JSON.stringify(result.query.filters)!==JSON.stringify(expectedFilters)){
    if(!record(result.query.filters)||Object.keys(result.query.filters).length!==Object.keys(expectedFilters).length||Object.entries(expectedFilters).some(([key,value])=>result.query.filters[key]!==value))return false;
  }
  const propertyValue=params.has('propertyValue')?JSON.parse(params.get('propertyValue')!):null;
  const expectedProperty=params.has('propertyKey')?{key:params.get('propertyKey'),type:params.get('propertyType'),value:params.get('propertyType')==='date'?preciseDate(propertyValue):propertyValue}:null;
  if(JSON.stringify(result.query.property)!==JSON.stringify(expectedProperty))return false;
  const count=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0;
  const stamp=(value:unknown):value is string=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
  const from=Date.parse(result.range.from+'T00:00:00.000Z'),to=Date.parse(result.range.to+'T00:00:00.000Z'),days=(to-from)/864e5+1;
  if(!Number.isInteger(days)||days<1||days>366||utcDate(new Date(from))!==result.range.from||utcDate(new Date(to))!==result.range.to||!stamp(result.range.start)||!stamp(result.range.end)||result.range.start>result.range.end||result.coverage.retainedFrom!==null&&!stamp(result.coverage.retainedFrom)||!record(result.properties)||!Array.isArray(result.properties.keys)||result.properties.keys.length>100||!result.properties.keys.every(key=>clean(key,320)&&key.length>0)||new Set(result.properties.keys).size!==result.properties.keys.length||typeof result.properties.truncated!=='boolean'||result.properties.truncated&&result.properties.keys.length!==100||!Array.isArray(result.daily)||result.daily.length!==days)return false;
  const coverage=(start:string,end:string)=>result.coverage.retainedFrom===null||start>=result.coverage.retainedFrom?'complete':end<=result.coverage.retainedFrom?'unavailable':'partial';
  if(result.coverage.status!==coverage(result.range.start,result.range.end))return false;
  const selectionUnavailable=result.sessionProperties?.selection?.status==='unavailable'||result.cohort?.membership?.status==='unavailable';
  let dailyEvents=0,dailyViews=0,dailyCustom=0;
  for(const [index,day]of result.daily.entries()){
    if(!record(day)||day.date!==utcDate(new Date(from+index*864e5))||!stamp(day.start)||!stamp(day.end)||day.start>day.end||day.start<result.range.start||day.end>result.range.end||index===0&&day.start!==result.range.start||index===days-1&&day.end!==result.range.end||day.skipped!==(day.start===day.end)||day.coverage!==coverage(day.start,day.end))return false;
    if(selectionUnavailable||day.coverage==='unavailable'){if([day.events,day.pageViews,day.customEvents].some(value=>value!==null))return false;}
    else{if(!count(day.events)||!count(day.pageViews)||!count(day.customEvents)||day.pageViews+day.customEvents!==day.events||day.skipped&&day.events!==0||result.query.kind==='pageviews'&&day.customEvents!==0||result.query.kind==='custom'&&day.pageViews!==0)return false;dailyEvents+=day.events;dailyViews+=day.pageViews;dailyCustom+=day.customEvents;}
  }
  if(Object.keys(result.totals).sort().join(',')!=='customEvents,events,identifiedEvents,pageViews,unidentifiedEvents,visitors,visits'||!Object.values(result.totals).every(value=>value===null||count(value)))return false;
  if(result.totals.events===null){const empty=(params.has('fields')||params.has('propertyView')||selectionUnavailable)?null:0;return (result.coverage.status==='unavailable'||selectionUnavailable)&&Object.values(result.totals).every(value=>value===null)&&result.breakdown.groups.length===0&&result.breakdown.totalGroups===empty&&result.breakdown.returnedGroupEvents===empty&&result.breakdown.truncated===false&&result.properties.keys.length===0&&result.properties.truncated===false;}
  if(selectionUnavailable||dailyEvents!==result.totals.events||dailyViews!==result.totals.pageViews||dailyCustom!==result.totals.customEvents)return false;
  if(result.coverage.status==='unavailable'||!count(result.totals.identifiedEvents)||result.totals.identifiedEvents>result.totals.events||!count(result.totals.unidentifiedEvents)||result.totals.identifiedEvents+result.totals.unidentifiedEvents!==result.totals.events||!count(result.totals.pageViews)||!count(result.totals.customEvents)||result.totals.pageViews+result.totals.customEvents!==result.totals.events||(result.totals.identifiedEvents===0?result.totals.visitors!==null:!count(result.totals.visitors)||result.totals.visitors<1||result.totals.visitors>result.totals.identifiedEvents)||result.totals.visits!==null&&(!count(result.totals.visits)||result.totals.visits<1||result.totals.visits>result.totals.events)||!count(result.breakdown.totalGroups)||result.breakdown.totalGroups>result.totals.events||result.breakdown.groups.length!==Math.min(params.has('fields')?500:100,result.breakdown.totalGroups)||result.breakdown.truncated!==(result.breakdown.totalGroups>(params.has('fields')?500:100)))return false;
  return true;
}
export function validTupleResult(result:ExploreResult,params:URLSearchParams):boolean{
  const fields=tupleFields(params.get('fields'));if(!fields||!record(result)||!record(result.query)||JSON.stringify(result.query.fields)!==JSON.stringify(fields)||Object.hasOwn(result.query,'groupBy')||Object.hasOwn(result.query,'groupProperty')||!record(result.totals)||!record(result.breakdown)||!record(result.coverage)||!['complete','partial','unavailable'].includes(result.coverage.status)||!Array.isArray(result.breakdown.groups)||result.breakdown.groups.length>500||result.numeric!==null||!clean(result.csv,2097152))return false;
  if(!validReportBase(result,params))return false;
  if(result.totals.events===null)return true;
  const count=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0;
  if(!count(result.totals.events)||!count(result.totals.identifiedEvents)||!count(result.totals.pageViews))return false;
  const incomplete=result.coverage.status!=='complete'||result.sessionProperties?.selection?.countsAreLowerBounds||result.cohort?.membership?.countsAreLowerBounds;
  const seen=new Set<string>();let events=0,identified=0,views=0,identifiedViews=0;
  for(const row of result.breakdown.groups){
    if(!record(row)||row.type!=='tuple'||!Array.isArray(row.value)||row.value.length!==fields.length||!count(row.events)||row.events<1||row.events>result.totals.events||!count(row.identifiedEvents)||row.identifiedEvents>row.events||row.identifiedEvents>result.totals.identifiedEvents||row.identifiedEvents===0&&row.visitors!==null||row.identifiedEvents>0&&(!count(row.visitors)||row.visitors<1||row.visitors>row.identifiedEvents||result.totals.visitors===null||row.visitors>result.totals.visitors))return false;
    if(!count(row.pageViews)||row.pageViews>row.events||!count(row.identifiedPageViews)||row.identifiedPageViews>row.pageViews||row.identifiedPageViews>row.identifiedEvents||row.pageViews-row.identifiedPageViews>row.events-row.identifiedEvents)return false;
    if(row.identifiedPageViews===0){if([row.estimatedVisitors,row.visits,row.bounceRate,row.averageVisitSeconds].some(value=>value!==null))return false;}
    else{
      if(!count(row.estimatedVisitors)||row.estimatedVisitors<1||!count(row.visits)||row.visits<row.estimatedVisitors||row.visits>row.identifiedPageViews||row.visitors===null||row.estimatedVisitors>row.visitors||result.totals.visits===null||row.visits>result.totals.visits)return false;
      if(incomplete){if(row.bounceRate!==null||row.averageVisitSeconds!==null)return false;}
      else if(typeof row.bounceRate!=='number'||!Number.isFinite(row.bounceRate)||row.bounceRate<0||row.bounceRate>100||typeof row.averageVisitSeconds!=='number'||!Number.isFinite(row.averageVisitSeconds)||row.averageVisitSeconds<0||row.averageVisitSeconds>(Date.parse(result.range.end)-Date.parse(result.range.start))/1000||row.identifiedPageViews===row.visits&&row.averageVisitSeconds!==0)return false;
    }
    for(const [index,atom]of row.value.entries()){
      if(!record(atom)||Object.keys(atom).sort().join(',')!=='type,value')return false;
      const field=fields[index];if(isGeo(field)){if(atom.type!=='string'||typeof atom.value!=='string'||!parseGeographyKey(field,atom.value))return false;}
      else if(atom.type==='missing'||atom.type==='null'){if(atom.value!==null)return false;}
      else if(field==='screenWidth'||field==='screenHeight'){if(atom.type!=='number'||!count(atom.value))return false;}
      else if(atom.type!=='string'||!clean(atom.value,field==='path'||field==='referrer'||field==='origin'?2048:320))return false;
    }
    const key=JSON.stringify(row.value);if(seen.has(key))return false;seen.add(key);events+=row.events;identified+=row.identifiedEvents;views+=row.pageViews;identifiedViews+=row.identifiedPageViews;
  }
  return result.breakdown.returnedGroupEvents===events&&events<=result.totals.events&&identified<=result.totals.identifiedEvents&&views<=result.totals.pageViews&&identifiedViews<=result.totals.identifiedEvents&&(result.breakdown.truncated||events===result.totals.events&&identified===result.totals.identifiedEvents&&views===result.totals.pageViews);
}
export async function readCombination(path:string,signal:AbortSignal):Promise<ExploreResult>{
  const response=await fetch(path,{credentials:'same-origin',redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(20000)])});
  const failure=(message:string)=>{const error=new ApiError(message);error.status=response.status;return error;};
  if([401,403,404].includes(response.status)){void response.body?.cancel();throw failure(response.status===401?'Your session has expired. Sign in again.':'This project is unavailable.');}
  if(response.ok&&response.status!==200){void response.body?.cancel();throw failure('The combination response status could not be verified.');}
  if(!response.body||!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type')??''))throw failure('The combination response could not be verified. Refresh the applied report.');
  const reader=response.body.getReader(),limit=response.ok?2097152:8192,parts:Uint8Array[]=[];let size=0;
  try{for(;;){const next=await reader.read();if(next.done)break;size+=next.value.byteLength;if(size>limit)throw failure('The complete combination response is too large. Narrow the filters.');parts.push(next.value);}}finally{await reader.cancel().catch(()=>{});}
  const bytes=new Uint8Array(size);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.length;}
  let value:unknown;try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw failure('The combination response was incomplete or malformed.');}
  if(!response.ok)throw failure(record(value)&&typeof value.error==='string'?value.error:'The combination report could not be loaded.');
  return value as ExploreResult;
}
function redactedReport(result:ExploreResult){return Object.values(result.totals).every(n=>n===null)&&result.daily.every(day=>day.events===null&&day.pageViews===null&&day.customEvents===null)&&result.numeric===null&&result.breakdown.groups.length===0&&result.breakdown.totalGroups===null&&result.breakdown.returnedGroupEvents===null&&result.breakdown.truncated===false&&result.properties.keys.length===0&&result.properties.truncated===false;}
export function validCohortResult(result:ExploreResult,params:URLSearchParams,projectId:string){
  if(params.has('propertyView')&&!validPropertyReport(result,params))return false;
  const fields=params.has('fields')?tupleFields(params.get('fields')):null;
  if(params.has('fields')&&!validTupleResult(result,params))return false;
  const expected=params.has('predicates')?JSON.parse(params.get('predicates')!) as AdvancedPredicates:undefined;
  if(!validAdvancedResult(result.query.predicates,result.predicateMethod,expected)||!validSessionSelection(result.sessionProperties,expected)||result.sessionProperties?.selection.status==='unavailable'&&!redactedReport(result))return false;
  const geoScope=!!fields?.some(isGeo)||isGeo(result.query.groupBy??'')||geographyFields.some(field=>Object.hasOwn(result.query.filters,field))||isGeo(params.get('groupBy')??'')||geographyFields.some(field=>params.has(field))||expected?.fields.some(row=>isGeo(row.field));
  if(geoScope){
    if(!result||!record(result.query)||!fields&&result.query.groupBy!==params.get('groupBy')||!record(result.query.filters)||geographyFields.some(field=>result.query.filters[field]!== (params.get(field)??undefined))||!record(result.breakdown)||!Array.isArray(result.breakdown.groups)||result.breakdown.groups.length>(fields?500:100))return false;
    const group=result.query.groupBy??'';if(isGeo(group)){const seen=new Set<string>();let events=0;for(const row of result.breakdown.groups){if(!record(row)||row.type!=='string'||typeof row.value!=='string'||!parseGeographyKey(group,row.value)||seen.has(row.value)||!Number.isSafeInteger(row.events)||row.events<1||!Number.isSafeInteger(row.identifiedEvents)||row.identifiedEvents<0||row.identifiedEvents>row.events||(row.identifiedEvents===0?row.visitors!==null:!Number.isSafeInteger(row.visitors)||row.visitors!<1||row.visitors!>row.identifiedEvents))return false;seen.add(row.value);events+=row.events;}if(result.breakdown.returnedGroupEvents!==null&&result.breakdown.returnedGroupEvents!==events)return false;}
  }
  const provenance=result.geographyProvenance;
  if(geoScope&&!provenance)return false;
  if(provenance){
    if(!record(provenance)||Object.keys(provenance).length!==5||provenance.source!=='db-ip-city-lite'||provenance.scope!=='matching-report-events')return false;
    if(result.totals.events===null?[provenance.databaseCount,provenance.oldestDatabaseBuild,provenance.newestDatabaseBuild].some(value=>value!==null):!Number.isSafeInteger(provenance.databaseCount)||provenance.databaseCount===null||provenance.databaseCount<0||provenance.databaseCount>result.totals.events||(provenance.databaseCount===0?provenance.oldestDatabaseBuild!==null||provenance.newestDatabaseBuild!==null:![provenance.oldestDatabaseBuild,provenance.newestDatabaseBuild].every(value=>Number.isSafeInteger(value)&&value!==null&&value>0&&value<=253402300799)||provenance.oldestDatabaseBuild!>provenance.newestDatabaseBuild!))return false;
  }
  const c=result.cohort;if(!params.has('cohortId'))return !c&&!result.query.cohort;
  if(!c||!validCohort(c.item,projectId)||c.item.id!==params.get('cohortId')||c.item.revision!==Number(params.get('cohortRevision'))||result.query.cohort?.id!==c.item.id||result.query.cohort.revision!==c.item.revision)return false;
  const d=qualificationDraft(c.item.definition.query)!;
  const qualified=buildAdvanced(d.advanced);if('error'in qualified||!validAdvancedResult(qualified.predicates,c.predicateMethod,qualified.predicates)||!validSessionSelection(c.sessionProperties,qualified.predicates))return false;
  if(!c.range||c.range.from!==d.from||c.range.to!==d.to||c.range.timeZone!==d.timeZone||![c.range.start,c.range.end].every(v=>typeof v==='string'&&Number.isFinite(Date.parse(v)))||!c.coverage||!['complete','partial','unavailable'].includes(c.coverage.status)||!c.identity||!['complete','partial','unavailable'].includes(c.identity.status)||!c.membership||!['available','unavailable'].includes(c.membership.status)||typeof c.membership.countsAreLowerBounds!=='boolean'||!clean(c.limitation,2000))return false;
  if(![c.identity.identifiedEvents,c.identity.unidentifiedEvents,c.identity.observedMemberKeys].every(n=>n===null||Number.isSafeInteger(n)&&n>=0))return false;
  if(c.coverage.retainedFrom!==null&&(typeof c.coverage.retainedFrom!=='string'||!Number.isFinite(Date.parse(c.coverage.retainedFrom))))return false;
  if(c.sessionProperties?.selection.status==='unavailable'&&(c.membership.status!=='unavailable'||Object.values(c.identity).some((value)=>typeof value==='number')))return false;
  if(c.sessionProperties?.selection.status==='available'&&(c.sessionProperties.candidates.unidentifiedEvents??0)>0&&(c.identity.unidentifiedEvents!==null||c.identity.status!=='partial'))return false;
  if(c.membership.status==='unavailable'&&result.sessionProperties&&result.sessionProperties.selection.reason!=='candidate_scope_unavailable')return false;
  if(c.sessionProperties&&result.sessionProperties&&(c.sessionProperties.asOf!==result.sessionProperties.asOf||c.sessionProperties.retainedFrom!==result.sessionProperties.retainedFrom))return false;
  return c.membership.status!=='unavailable'||redactedReport(result);
}

function validPropertyReport(result:ExploreResult,params:URLSearchParams){
  if(!validReportBase(result,params))return false;
  const p=result.propertyReport,count=(n:unknown)=>Number.isSafeInteger(n)&&Number(n)>=0,atom=(type:string,value:unknown)=>type==='missing'||type==='null'?value===null:type==='number'?typeof value==='number'&&Number.isFinite(value):type==='boolean'?typeof value==='boolean':type==='array'?Array.isArray(value)&&value.length<=50:typeof value==='string'&&['string','date'].includes(type)&&value.length<=1000;
  if(!p||p.version!==1||p.key!==params.get('groupProperty')||result.query.groupBy!=='property'||result.query.groupProperty!==p.key||typeof p.snapshot!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(p.snapshot)||p.countsAreLowerBounds!==(result.coverage.status!=='complete'||!!result.cohort?.membership?.countsAreLowerBounds||!!result.sessionProperties?.selection?.countsAreLowerBounds)||p.nextCursor!==null&&!/^[A-Za-z0-9_-]{1,4096}$/.test(p.nextCursor))return false;
  for(const key of ['from','to','kind']as const)if(result.query[key]!==params.get(key))return false;
  const stamp=(value:unknown):value is string=>typeof value==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(value)&&preciseDate(value)===value;
  const readCursor=(raw:string|null)=>{try{if(!raw||!/^[A-Za-z0-9_-]{1,4096}$/.test(raw))return null;const value:unknown=JSON.parse(atob(raw.replaceAll('-','+').replaceAll('_','/')));return record(value)&&Object.keys(value).sort().join(',')==='before,last,policy,scope,version'&&value.version===1&&typeof value.scope==='string'&&/^[a-f0-9]{64}$/.test(value.scope)&&typeof value.policy==='string'&&/^[a-f0-9]{64}$/.test(value.policy)&&stamp(value.before)&&record(value.last)&&Object.keys(value.last).sort().join(',')==='at,id'&&stamp(value.last.at)&&uuid(value.last.id)?{before:value.before,scope:value.scope,policy:value.policy,last:{at:value.last.at,id:value.last.id}}:null;}catch{return null;}};
  const cursor=readCursor(params.get('propertyCursor')),next=readCursor(p.nextCursor);
  if(!stamp(p.snapshot)||params.has('propertyCursor')&&(!cursor||cursor.before!==p.snapshot)||p.nextCursor!==null&&(!next||next.before!==p.snapshot||cursor&&(next.scope!==cursor.scope||next.policy!==cursor.policy)))return false;
  const series=(rows:PropertyReport['values'])=>Array.isArray(rows)&&rows.length<=100&&rows.every(row=>record(row)&&atom(row.type,row.value)&&count(row.total)&&Array.isArray(row.counts)&&row.counts.length===result.daily.length&&row.counts.every(n=>n===null||count(n))&&row.counts.reduce((sum:number,n:number|null)=>sum+(n??0),0)===row.total);
  if(!series(p.values)||!record(p.arrays)||!record(p.dates)||!series(p.arrays.series)||![p.arrays.samples,p.arrays.occurrences,p.arrays.totalGroups,p.dates.totalGroups].every(n=>n===null||count(n))||typeof p.arrays.truncated!=='boolean'||typeof p.dates.truncated!=='boolean'||!Array.isArray(p.numbers)||p.numbers.length!==result.daily.length||!p.numbers.every((n,i)=>record(n)&&(result.totals.events===null||result.daily[i].coverage==='unavailable'?n.samples===null&&n.sum===null&&n.average===null:count(n.samples)&&Number(n.samples)<=Number(result.daily[i].events)&&(n.samples===0?n.sum===null&&n.average===null:propertyDecimal(n.sum)&&propertyDecimal(n.average)))))return false;
  if(!Array.isArray(p.dates.values)||p.dates.values.length>100||!p.dates.values.every(d=>typeof d.value==='string'&&d.value.length<=1000&&count(d.count))||!Array.isArray(p.events)||p.events.length>50||new Set(p.events.map(e=>e.id)).size!==p.events.length)return false;
  if(!validPropertyNumberStats(p.numberStats,result.totals.events)||!validPropertyDateSummary(p.dateSummary,result.totals.events))return false;
  if(result.totals.events===null){if(p.dates.totalGroups!==null||p.dates.truncated||p.dates.values.length!==0||p.values.length!==0||p.arrays.series.length!==0||p.arrays.truncated||[p.arrays.samples,p.arrays.occurrences,p.arrays.totalGroups].some(n=>n!==null))return false;}
  else{
    if(p.numberStats.samples!==p.numbers.reduce((total,n)=>total+(n.samples??0),0)||Number(p.numberStats.samples)+Number(p.dateSummary.samples)>result.totals.events||!result.numeric||p.numberStats.samples!==result.numeric.samples)return false;
    for(const key of ['sum','average','min','max']as const){const actual=p.numberStats[key],expected=result.numeric[key];if(actual===null?expected!==null:!propertyDecimal(expected)||comparePropertyDecimals(actual,expected)!==0)return false;}
    if(!count(p.dates.totalGroups)||Number(p.dates.totalGroups)>Number(p.dateSummary.samples)||p.dates.truncated!==(Number(p.dates.totalGroups)>100)||p.dates.values.length!==Math.min(100,Number(p.dates.totalGroups))||new Set(p.dates.values.map(d=>d.value)).size!==p.dates.values.length||!p.dates.values.every(d=>preciseDate(d.value)===d.value&&d.count>0))return false;
    const dateCount=p.dates.values.reduce((total,d)=>total+d.count,0);if(p.dates.truncated?dateCount>=Number(p.dateSummary.samples):dateCount!==p.dateSummary.samples)return false;
    if(p.values.length!==result.breakdown.groups.length||!p.values.every((row,i)=>row.total>0&&row.type===result.breakdown.groups[i].type&&JSON.stringify(row.value)===JSON.stringify(result.breakdown.groups[i].value)&&row.total===result.breakdown.groups[i].events))return false;
    const valueTotal=p.values.reduce((total,row)=>total+row.total,0);if(valueTotal>result.totals.events||!result.breakdown.truncated&&valueTotal!==result.totals.events)return false;
    if(!count(p.arrays.samples)||Number(p.arrays.samples)>result.totals.events||!count(p.arrays.occurrences)||Number(p.arrays.occurrences)>Number(p.arrays.samples)*50||!count(p.arrays.totalGroups)||Number(p.arrays.totalGroups)>Number(p.arrays.occurrences)||p.arrays.truncated!==(Number(p.arrays.totalGroups)>100)||p.arrays.series.length!==Math.min(100,Number(p.arrays.totalGroups))||new Set(p.arrays.series.map(row=>JSON.stringify([row.type,row.value]))).size!==p.arrays.series.length)return false;
    const occurrences=p.arrays.series.reduce((total,row)=>total+row.total,0);if(p.arrays.series.some(row=>row.total<1)|| (p.arrays.truncated?occurrences>=Number(p.arrays.occurrences):occurrences!==p.arrays.occurrences))return false;
  }
  const last=p.events.at(-1);if(next&&(!last||next.last.at!==last.receivedAt||next.last.id!==last.id)||cursor&&p.events.some(e=>e.receivedAt>cursor.last.at||e.receivedAt===cursor.last.at&&e.id>=cursor.last.id))return false;
  return p.events.every((e,index)=>stamp(e.receivedAt)&&e.receivedAt<p.snapshot&&Date.parse(e.receivedAt)>=Date.parse(result.range.start)&&Date.parse(e.receivedAt)<Date.parse(result.range.end)&&(index===0||p.events[index-1].receivedAt>e.receivedAt||p.events[index-1].receivedAt===e.receivedAt&&p.events[index-1].id>e.id)&&uuid(e.id)&&clean(e.eventName,320)&&clean(e.path,2048)&&typeof e.receivedAt==='string'&&Number.isFinite(Date.parse(e.receivedAt))&&record(e.properties)&&Object.entries(e.properties).every(([key,value])=>key.length<=320&&record(value)&&atom(value.type,value.value)));
}
export function PropertyShares({items,total,label,noun}:{items:{key:string;label:string;count:number}[];total:number|null;label:string;noun?:string}){
  const pattern=useId().replaceAll(':',''),returned=items.reduce((sum,item)=>sum+item.count,0),first=items.slice(0,8),rest=returned-first.reduce((sum,item)=>sum+item.count,0);
  const slices=[...first,...(rest>0?[{key:'returned',label:'Other returned values',count:rest}]:[]),...(total!==null&&total>returned?[{key:'omitted',label:'Values omitted from the exact table',count:total-returned}]:[])];
  const color=(key:string)=>{if(key==='returned'||key==='omitted')return `url(#${pattern}-${key})`;let hash=0;for(const char of key)hash=(Math.imul(hash,31)+char.codePointAt(0)!)>>>0;return `var(--color-chart-${hash%4+1})`;};
  let offset=0;
  return <div className="stack">{total!==null&&total>0?<svg viewBox="0 0 180 180" style={{width:'100%',maxWidth:240,height:180,alignSelf:'center'}} role="img" aria-label={`${label}: share of ${total} observed ${noun??(label==='Array occurrence shares'?'occurrences':'samples')}`}>
    <defs><pattern id={`${pattern}-returned`} width="6" height="6" patternUnits="userSpaceOnUse"><rect width="6" height="6" fill="var(--color-chart-5)"/><path d="M0 0L6 6" stroke="var(--color-surface)" strokeWidth="2"/></pattern><pattern id={`${pattern}-omitted`} width="6" height="6" patternUnits="userSpaceOnUse"><rect width="6" height="6" fill="var(--color-text-muted)"/><circle cx="3" cy="3" r="1.5" fill="var(--color-surface)"/></pattern></defs>
    <title>{label}; counts and exact denominator in the adjacent table</title>{slices.map(slice=>{const share=slice.count/total*100,start=offset;offset+=share;return <circle key={slice.key} cx="90" cy="90" r="65" pathLength="100" fill="none" stroke={color(slice.key)} strokeWidth="28" strokeDasharray={`${share} ${100-share}`} strokeDashoffset={-start} transform="rotate(-90 90 90)"><title>{slice.label}: {slice.count} of {total} ({share.toFixed(1)}%)</title></circle>;})}</svg>:<p className="hint">{total===null?'Share distribution unavailable.':`No observed ${noun??'samples'} for this distribution.`}</p>}
    <div className="table-wrap" tabIndex={0} role="region" aria-label={label}><table><thead><tr><th>Value</th><th>Count</th><th>Share of observed total</th></tr></thead><tbody>{slices.map(slice=><tr key={slice.key}><td><svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" style={{marginInlineEnd:6}}><rect x="1" y="1" width="10" height="10" fill={color(slice.key)} stroke="var(--color-text)"/></svg><bdi>{slice.label}</bdi></td><td>{slice.count}</td><td>{total===null?'Unavailable':total===0?'No samples':`${(slice.count/total*100).toFixed(1)}%`}</td></tr>)}</tbody><tfoot><tr><th>Observed total</th><td>{num(total)}</td><td>{total===null?'Unavailable':total===0?'No samples':'100%'}</td></tr></tfoot></table></div>
  </div>;
}
function PropertyDetails({report,days,timeZone,totalEvents,onNext,onFirst,tab,setTab}:{report:PropertyReport;days:ExploreResult['daily'];timeZone:string;totalEvents:number|null;onNext:()=>void;onFirst:()=>void;tab:string;setTab:(value:string)=>void}){
  const series=tab==='arrays'?report.arrays.series:report.values;
  const allKeys=[...new Set(report.events.flatMap(e=>Object.keys(e.properties)))].sort(),pivotKeys=allKeys.slice(0,100);
  const shown=series.slice(0,8),max=Math.max(1,...days.map((_,i)=>shown.reduce((n,row)=>n+(row.counts[i]??0),0)));
  const coordinates=propertyDecimalScale(report.numbers.flatMap(n=>[n.sum,n.average])),dates=report.dateSummary,dateMax=Math.max(1,...dates.histogram.map(bucket=>bucket.count));
  const weekdayMax=dates.weekdays?Math.max(...dates.weekdays):0,topWeekday=weekdayMax>0?dates.weekdays!.indexOf(weekdayMax):null;
  return <section className="card stack" aria-label="Property analysis"><h3>Property analysis: <bdi>{report.key}</bdi></h3>
    <p className="hint">{report.countsAreLowerBounds?'Observed counts are lower bounds because some selection or history is unavailable.':'Counts use the applied event population.'} Missing, null and different types stay separate. Array charts count occurrences, including repeated elements.</p><p className="hint">The first page excludes later arrivals. Each page rechecks current retention, cohort and session-property selection, so eligible events and counts can change between pages.</p>
    <div className="row" role="group" aria-label="Property analysis views">{[['values','Values over time'],['numbers','Numeric series'],['dates','Date values'],['arrays','Array occurrences'],['events','Event properties']].map(([key,label])=><button className="btn" type="button" key={key} aria-pressed={tab===key} onClick={()=>setTab(key)}>{label}</button>)}</div>
    {(tab==='values'||tab==='arrays')&&<><p className="hint">Chart shows the first {shown.length} returned series. The table includes every returned series. {tab==='arrays'?`${num(report.arrays.samples)} array samples · ${num(report.arrays.occurrences)} element occurrences. `:''}{tab==='arrays'&&report.arrays.truncated?'Array values truncated at100; narrow filters for the rest.':''}</p>
      <svg className="analytics-chart" style={{display:'block',width:'100%',height:180,minWidth:0}} preserveAspectRatio="none" viewBox={`0 0 ${Math.max(1,days.length)*12} 180`} role="img" aria-label="Typed property occurrences by local event day; exact counts and coverage in the table below">{days.map((day,i)=>{let offset=0;return <g key={day.date}>{shown.map((s,j)=>{const value=s.counts[i];if(value===null)return null;const height=value/max*160,y=170-offset-height;offset+=height;return <rect key={j} x={i*12+1} y={y} width={10} height={height} fill="currentColor" opacity={(j+1)/9}><title>{day.date}: {s.type} {JSON.stringify(s.value)} — {value} ({day.coverage})</title></rect>;})}</g>;})}</svg>
      <PropertyShares items={series.map(s=>({key:JSON.stringify([s.type,s.value]),label:`${s.type}: ${s.type==='missing'?'Missing / uncollected':JSON.stringify(s.value)}`,count:s.total}))} total={tab==='arrays'?report.arrays.occurrences:totalEvents} label={tab==='arrays'?'Array occurrence shares':'Typed property value shares'}/>
      <div className="table-wrap" tabIndex={0} role="region" aria-label="Property series data"><table><thead><tr><th>Type</th><th>Value</th><th>Total</th><th>Share of observed total</th>{days.map(d=><th key={d.date}>{d.date}<div className="hint">{d.skipped?'Skipped date':d.coverage}</div></th>)}</tr></thead><tbody>{series.map((s,i)=><tr key={i}><td>{s.type}</td><td><bdi>{s.type==='missing'?'Missing / uncollected':JSON.stringify(s.value)}</bdi></td><td>{s.total}</td><td>{`${(s.total/Number(tab==='arrays'?report.arrays.occurrences:totalEvents)*100).toFixed(1)}%`}</td>{s.counts.map((n,j)=><td key={j}>{num(n)}</td>)}</tr>)}</tbody></table></div></>}
    {tab==='numbers'&&<><div className="metric-grid" aria-label="Numeric property summary">{([['Total',report.numberStats.sum],['Average',report.numberStats.average],['Median',report.numberStats.median],['Minimum',report.numberStats.min],['Maximum',report.numberStats.max]]as const).map(([label,value])=><div className="metric" key={label}><div className="metric-label">{label}</div><div className="metric-value"><bdi>{decimal(value)}</bdi></div></div>)}</div>
      <p className="hint">{num(report.numberStats.samples)} observed numeric samples. {report.countsAreLowerBounds?'These sums, averages and extrema describe only the observed population; they are not lower bounds. ':''}Sum and average share one signed scale. Very small bars can be below a pixel; the table and CSV retain exact decimals. Empty or unavailable samples have no bar.</p>
      {report.numberStats.samples!==null&&report.numberStats.samples>0?<svg className="analytics-chart" style={{display:'block',width:'100%',height:180,minWidth:0}} preserveAspectRatio="none" viewBox={`0 0 ${Math.max(1,days.length)*20} 180`} role="img" aria-label="Numeric property sum and average by local event day; exact decimals in the table below"><line x1={0} x2={Math.max(1,days.length)*20} y1={90} y2={90} stroke="currentColor"/>{report.numbers.map((n,i)=><g key={days[i].date}>{(['sum','average']as const).map((key,j)=>{const value=coordinates[i*2+j];return value===null?null:<rect key={key} x={i*20+j*8+2} y={value<0?90:90-value*80} width={7} height={Math.abs(value)*80} fill="currentColor" opacity={j===0?1:0.45}><title>{days[i].date}: {key} {n[key]} ({days[i].coverage})</title></rect>;})}</g>)}</svg>:<p className="hint">{report.numberStats.samples===null?'Numeric chart unavailable.':'No numeric samples in this population.'}</p>}<p className="hint">Solid bars: sum. Lighter bars: average. Baseline: zero.</p>
      <div className="table-wrap" tabIndex={0} role="region" aria-label="Numeric property series"><table><thead><tr><th>Local event date</th><th>Samples</th><th>Exact sum</th><th>Exact average</th><th>Coverage</th></tr></thead><tbody>{report.numbers.map((n,i)=><tr key={days[i].date}><td>{days[i].date}</td><td>{num(n.samples)}</td><td>{decimal(n.sum)}</td><td>{decimal(n.average)}</td><td>{days[i].skipped?'Skipped date':days[i].coverage}</td></tr>)}</tbody></table></div></>}
    {tab==='dates'&&<><p className="hint">These are property date values, not the date the event was received. Calendar summaries use <bdi>{timeZone}</bdi>; weeks start Monday. {num(dates.samples)} observed date samples. Histogram and weekday summaries include every matching date value. {report.dates.truncated?'The exact UTC table shows the first100 values; narrow filters for the rest.':'Exact UTC values are preserved below.'}</p>
      <div className="metric-grid" aria-label="Property date summary">{[['Top weekday',topWeekday===null?null:propertyWeekdays[topWeekday],topWeekday===null?null:weekdayMax],['Top date',dates.topDate?.date??null,dates.topDate?.count??null],['Earliest date',dates.earliest,null],['Latest date',dates.latest,null]].map(([label,value,count])=><div className="metric" key={String(label)}><div className="metric-label">{label}</div><div className="metric-value"><bdi>{value??(dates.samples===null?'Unavailable':'No samples')}</bdi></div>{count!==null&&<div className="hint">{count} occurrences · {(Number(count)/Number(dates.samples)*100).toFixed(1)}%</div>}</div>)}</div>
      <p className="hint">Automatic calendar bucket: {dates.unit??(dates.samples===null?'Unavailable':'No samples')}. Missing buckets between the earliest and latest observed dates are zero; unavailable history is never zero-filled.</p>
      {dates.samples!==null&&dates.samples>0?<svg className="analytics-chart" style={{display:'block',width:'100%',height:180,minWidth:0}} preserveAspectRatio="none" viewBox={`0 0 ${Math.max(1,dates.histogram.length)*12} 180`} role="img" aria-label="Property date value histogram; complete observed population by local calendar bucket">{dates.histogram.map((bucket,i)=><rect key={bucket.date} x={i*12+1} y={170-bucket.count/dateMax*160} width={10} height={bucket.count/dateMax*160} fill="currentColor"><title>{bucket.date}: {bucket.count} occurrences ({dates.unit}, {timeZone})</title></rect>)}</svg>:<p className="hint">{dates.samples===null?'Property date chart unavailable.':'No property date samples in this population.'}</p>}
      <div className="table-wrap" tabIndex={0} role="region" aria-label="Property date histogram data"><table><thead><tr><th>Local bucket start</th><th>Occurrences</th></tr></thead><tbody>{dates.histogram.map(bucket=><tr key={bucket.date}><td>{bucket.date}</td><td>{bucket.count}</td></tr>)}</tbody></table></div>
      <div className="table-wrap" tabIndex={0} role="region" aria-label="Property weekday distribution"><table><thead><tr><th>Weekday</th><th>Occurrences</th><th>Share</th></tr></thead><tbody>{propertyWeekdays.map((day,i)=><tr key={day}><td>{day}</td><td>{num(dates.weekdays?.[i]??null)}</td><td>{dates.samples===null?'Unavailable':dates.samples===0?'No samples':`${(dates.weekdays![i]/dates.samples*100).toFixed(1)}%`}</td></tr>)}</tbody></table></div>
      <PropertyShares items={dates.weekdays===null?[]:propertyWeekdays.map((label,i)=>({key:label,label,count:dates.weekdays![i]}))} total={dates.samples} label="Property weekday shares"/>
      <div className="table-wrap" tabIndex={0} role="region" aria-label="Date property distribution"><table><thead><tr><th>Property date (UTC)</th><th>Occurrences</th></tr></thead><tbody>{report.dates.values.map(d=><tr key={d.value}><td><time dateTime={d.value}>{d.value}</time></td><td>{d.count}</td></tr>)}</tbody></table></div></>}
    {tab==='events'&&<><p className="hint">Up to50 matching events, including events without visitor identifiers. Missing properties differ from explicit null. {allKeys.length>100?'First100 property columns shown; CSV preserves every returned event property.':''}</p><div className="table-wrap" tabIndex={0} role="region" aria-label="Event property pivot"><table><thead><tr><th>Received at (UTC)</th><th>Event</th><th>Path</th>{pivotKeys.map(key=><th key={key}><bdi>{key}</bdi></th>)}</tr></thead><tbody>{report.events.map(e=><tr key={e.id}><td>{e.receivedAt}</td><td><bdi>{e.eventName}</bdi></td><td><bdi>{e.path}</bdi></td>{pivotKeys.map(key=>{const value=e.properties[key];return <td key={key}><bdi>{value?`${value.type} ${JSON.stringify(value.value)}`:'Missing / uncollected'}</bdi></td>;})}</tr>)}</tbody></table></div><div className="row"><button className="btn" type="button" onClick={onFirst}>First events</button><button className="btn" type="button" disabled={!report.nextCursor} onClick={onNext}>Next50 events</button></div></>}
  </section>;
}

function groupValue(type:string,value:unknown,field?:string):string{
  if(field&&isGeo(field)){const key=parseGeographyKey(field,value);return key?geographyLabel(key):'Invalid location';}
  if(environmentFields.includes(field as EnvironmentField)&&(type==='missing'||value==='unknown'))return type==='missing'?'Not recorded':'Unknown';
  if(type==='missing')return 'Missing / uncollected';
  if(value===null)return 'null';
  if(typeof value==='string'&&value==='')return '(empty string)';
  if(Array.isArray(value))return JSON.stringify(value);
  return String(value);
}
const groupType=(type:string)=>type?type.charAt(0).toUpperCase()+type.slice(1):'Unknown';

type Props={projectId:string;userId:string;onUnauthorized:()=>void};
export function ExplorerPanel(props:Props){
  return <ExplorerInner key={`${props.userId}:${props.projectId}`} {...props}/>;
}
function ExplorerInner({projectId,userId,onUnauthorized}:Props){
  const uid=useId();
  const unauthRef=useRef(onUnauthorized);
  unauthRef.current=onUnauthorized;

  const [draft,setDraft]=useState<Draft>(initialDraft);
  const [combined,setCombined]=useState(false),[fields,setFields]=useState<string[]>(['campaignSource','campaignMedium']);
  const [propertyDetails,setPropertyDetails]=useState(false);
  const [propertyTab,setPropertyTab]=useState('values');
  const [applied,setApplied]=useState<string>(()=>{const r=buildParams(initialDraft());return 'qs'in r?r.qs:'';});
  const [attempt,setAttempt]=useState(0);
  const [result,setResult]=useState<ExploreResult|null>(null);
  const [phase,setPhase]=useState<'loading'|'ok'|'error'|'unavailable'|'denied'>('loading');
  const [message,setMessage]=useState('');
  const [formError,setFormError]=useState('');
  const base=`/api/projects/${encodeURIComponent(projectId)}/segments`;
  const [savedItems,setSavedItems]=useState<SavedFilter[]>([]),[savedCursor,setSavedCursor]=useState<string|null>(null),[savedLoaded,setSavedLoaded]=useState(false);
  const [savedRole,setSavedRole]=useState<Role|null>(null),[selected,setSelected]=useState<SavedFilter|null>(null),[selectedId,setSelectedId]=useState(''),[savedName,setSavedName]=useState('');
  const [savedBusy,setSavedBusy]=useState(false),[savedError,setSavedError]=useState(''),[savedNotice,setSavedNotice]=useState(''),[pending,setPending]=useState<SaveAttempt|null>(null);
  const alive=useRef(false),accessEpoch=useRef(0),accessDenied=useRef(false),analyticsRead=useRef<AbortController|null>(null),propertyCursorStale=useRef(false);
  const savedOp=useRef<AbortController|null>(null),savedRoleRef=useRef<Role|null>(null),pendingRef=useRef<SaveAttempt|null>(null),deletedIds=useRef(new Set<string>());
  const cohortBase=`/api/projects/${encodeURIComponent(projectId)}/cohorts`;
  const [cohortItems,setCohortItems]=useState<SavedFilter[]>([]),[cohortCursor,setCohortCursor]=useState<string|null>(null),[cohortSelected,setCohortSelected]=useState<SavedFilter|null>(null),[cohortSelectedId,setCohortSelectedId]=useState('');
  const [cohortDraft,setCohortDraft]=useState<(CohortRef&{definition?:Definition})|null>(null),[cohortEditor,setCohortEditor]=useState<CohortEditor|null>(null),[cohortRole,setCohortRole]=useState<Role|null>(null);
  const [cohortBusy,setCohortBusy]=useState(false),[cohortError,setCohortError]=useState(''),[cohortNotice,setCohortNotice]=useState(''),[cohortPending,setCohortPending]=useState<SaveAttempt|null>(null);
  const cohortOp=useRef<AbortController|null>(null),cohortRoleRef=useRef<Role|null>(null),cohortPendingRef=useRef<SaveAttempt|null>(null),cohortDeleted=useRef(new Set<string>()),cohortInvalid=useRef(new Set<string>()),cohortManager=useRef<HTMLDetailsElement>(null);
  function clearCohortData(){cohortOp.current?.abort();cohortOp.current=null;setCohortBusy(false);setCohortItems([]);setCohortCursor(null);setCohortSelected(null);setCohortSelectedId('');setCohortEditor(null);setCohortRole(null);cohortRoleRef.current=null;setCohortNotice('');setCohortDraft(old=>old?{id:old.id,revision:old.revision}:null);}
  function purgeAccess(status:number,notice?:string,keepAttempt:SaveAttempt|null=pendingRef.current){
    accessEpoch.current++;accessDenied.current=true;analyticsRead.current?.abort();savedOp.current?.abort();savedOp.current=null;
    clearCohortData();
    setResult(null);setDraft(initialDraft());setCombined(false);setFields(['campaignSource','campaignMedium']);setFormError('');setSavedItems([]);setSavedCursor(null);setSavedLoaded(false);setSelected(null);setSelectedId('');setSavedName('');setSavedRole(null);savedRoleRef.current=null;setSavedBusy(false);setSavedError('');setSavedNotice('');pendingRef.current=keepAttempt;setPending(keepAttempt);
    const initial=buildParams(initialDraft());if('qs'in initial)setApplied(old=>{const previous=new URLSearchParams(old),next=new URLSearchParams(initial.qs);for(const key of ['cohortId','cohortRevision'])if(previous.has(key))next.set(key,previous.get(key)!);return next.toString();});
    setPhase(status===401?'denied':'unavailable');setMessage(notice??(status===401?'Your session has ended. Sign in again to continue.':'This project is unavailable. It may have been removed or you may not have access.'));
    if(status===401)unauthRef.current();
  }
  function acceptCohortRole(value:unknown){if(!roleValue(value)){purgeAccess(403,'Cohort access could not be verified. Reload cohort access before continuing.',pendingRef.current);throw new Error('Cohort access could not be verified.');}cohortRoleRef.current=value;setCohortRole(value);return value;}
  async function readCohorts(id?:string,mode:'inspect'|'load'|'edit'='inspect',cursor?:string,recover=false){
    if(accessDenied.current&&!recover||cohortPendingRef.current&&(cohortOp.current||mode!=='inspect'))return;
    cohortOp.current?.abort();const op=new AbortController(),generation=accessEpoch.current;cohortOp.current=op;setCohortBusy(true);setCohortError('');cohortRoleRef.current=null;
    try{
      const data=await api<unknown>(id?`${cohortBase}/${encodeURIComponent(id)}`:cohortBase+(cursor?'?'+new URLSearchParams({cursor}):''),{signal:AbortSignal.any([op.signal,AbortSignal.timeout(20000)])});
      if(!alive.current||op.signal.aborted||generation!==accessEpoch.current)return;
      if(!record(data))throw new Error('Cohorts could not be verified. Refresh cohorts.');const role=acceptCohortRole(data.role);
      if(id){
        if(!validCohort(data.item,projectId)||data.item.id!==id||cohortDeleted.current.has(id))throw new Error('This cohort could not be verified. Refresh cohorts.');
        const item=data.item;setCohortSelected(item);setCohortSelectedId(id);setCohortItems(old=>[...new Map([...old,item].map(v=>[v.id,v])).values()]);
        if(mode==='load'){setCohortDraft({id:item.id,revision:item.revision,definition:item.definition});cohortInvalid.current.delete(`${item.id}:${item.revision}`);setCohortNotice('Cohort loaded into your draft. Apply filters to update results and CSV.');}
        if(mode==='edit'&&canSave(role)){setCohortEditor({item,name:item.definition.name,draft:qualificationDraft(item.definition.query)!});if(cohortManager.current)cohortManager.current.open=true;}
      }else{
        if(!Array.isArray(data.items)||data.items.length>50||!data.items.every(v=>validCohort(v,projectId))||new Set(data.items.map(v=>v.id)).size!==data.items.length||data.nextCursor!==null&&(!clean(data.nextCursor,4096)||!data.nextCursor))throw new Error('Cohorts could not be verified. Refresh cohorts.');
        const items=(data.items as SavedFilter[]).filter(v=>!cohortDeleted.current.has(v.id));setCohortItems(old=>[...new Map([...(cursor?old:[]),...items].map(v=>[v.id,v])).values()]);setCohortCursor(data.nextCursor as string|null);
      }
      if(!canSave(role))setCohortEditor(null);
      if(recover){accessDenied.current=false;setPhase('error');setMessage('Access rechecked. Clear or load a cohort, then Apply filters to load results.');void readSaved();}
      return true;
    }catch(e){
      if(!alive.current||op.signal.aborted||generation!==accessEpoch.current)return;
      if(e instanceof ApiError&&[401,403,404].includes(e.status))purgeAccess(e.status,'This cohort or project is unavailable. Reload cohort access, then clear or load a cohort.',pendingRef.current);
      else{clearCohortData();setCohortError(errMsg(e));}
    }finally{if(cohortOp.current===op){cohortOp.current=null;if(alive.current)setCohortBusy(false);}}
  }
  async function saveCohort(value:SaveAttempt){
    if(cohortOp.current||!canSave(cohortRoleRef.current)||accessDenied.current)return;const confirming=cohortPendingRef.current===value;
    cohortPendingRef.current=value;setCohortPending(value);const op=new AbortController(),generation=accessEpoch.current;cohortOp.current=op;setCohortBusy(true);setCohortError('');setCohortNotice('');let conflict=false,reload=false;
    try{
      const data=await api<unknown>(value.kind==='create'?cohortBase:`${cohortBase}/${encodeURIComponent(value.id!)}/${value.kind}`,{method:'POST',body:value.body,signal:AbortSignal.any([op.signal,AbortSignal.timeout(20000)])});
      if(!alive.current||op.signal.aborted||generation!==accessEpoch.current)return;
      if(!record(data))throw new Error('The cohort acknowledgement could not be verified.');acceptCohortRole(data.role);
      if(!canSave(data.role as Role)||typeof data.replayed!=='boolean'||typeof data.deleted!=='boolean')throw new Error('The cohort acknowledgement could not be verified.');
      if(value.kind==='delete'||data.deleted){
        if(value.kind==='delete'?data.id!==value.id||data.deleted!==true:data.item!==null||data.replayed!==true)throw new Error('The cohort acknowledgement could not be matched.');
        if(value.id)cohortDeleted.current.add(value.id);setCohortSelected(null);setCohortSelectedId('');setCohortItems(old=>value.id?old.filter(item=>item.id!==value.id):[]);setCohortCursor(null);reload=true;
        setCohortNotice(value.kind==='delete'?'Cohort deleted. Clear its report draft reference or load another cohort before applying. Existing results remain a snapshot.':'Original save confirmed, but this cohort was since deleted. It was not recreated.');
      }else{
        if(!validCohort(data.item,projectId)||value.id&&data.item.id!==value.id||cohortDeleted.current.has(data.item.id)||value.body.revision!==undefined&&data.item.revision<=value.body.revision||!data.replayed&&(data.item.revision!==(value.body.revision??0)+1||!sameCohortDefinition(value.body.definition!,data.item.definition)))throw new Error('The cohort acknowledgement could not be matched.');
        const item=data.item;setCohortItems(old=>[item,...old.filter(v=>v.id!==item.id)]);setCohortSelected(item);setCohortSelectedId(item.id);setCohortNotice(data.replayed?'Original save confirmed. The current cohort definition is shown; report results are unchanged.':'Cohort saved. Load this version into your draft, then Apply filters to update the report.');
      }
      cohortPendingRef.current=null;setCohortPending(null);setCohortEditor(null);
    }catch(e){
      if(!alive.current||op.signal.aborted||generation!==accessEpoch.current)return;const status=e instanceof ApiError?e.status:0;
      if(status===0||status===408||status===429||status>=500)setCohortError('The outcome is unknown. Retry the same request to confirm it; the original name, qualification and revision are kept.');
      else{
        if(!confirming||![401,403,404].includes(status)){cohortPendingRef.current=null;setCohortPending(null);}
        if([401,403,404].includes(status))purgeAccess(status,'This cohort or project is unavailable. Reload cohort access before continuing.',pendingRef.current);
        else if(status===409){setCohortEditor(null);setCohortError('This cohort changed. Reloading its current definition for review.');conflict=true;}
        else{setCohortError(errMsg(e));if(status===400&&errMsg(e).includes('regular expression'))focusAdvanced(`${uid}-qualification-advanced`);}
      }
    }finally{if(cohortOp.current===op){cohortOp.current=null;if(alive.current)setCohortBusy(false);}}
    if(conflict&&alive.current&&generation===accessEpoch.current&&await readCohorts(value.id,'edit'))setCohortError('This cohort changed. Review its reloaded definition before saving again. Report results are unchanged.');
    if(reload&&alive.current&&generation===accessEpoch.current)void readCohorts();
  }
  function submitCohort(){
    if(!cohortEditor||cohortPendingRef.current||cohortOp.current||!canSave(cohortRoleRef.current)||accessDenied.current)return;
    const name=cohortEditor.name.trim(),d=cohortEditor.draft;if(!clean(name,200)||!name){setCohortError('Enter a cohort name of 1 to 200 characters.');return;}
    const built=buildParams(d);if('error'in built){setCohortError(built.error);if(built.advanced)focusAdvanced(`${uid}-qualification-advanced`,built.advanced);return;}const p=new URLSearchParams(built.qs);p.delete('groupBy');p.delete('groupProperty');
    if(!qualificationDraft(p.toString())){setCohortError('Choose valid qualification dates, a timezone, exactly one action and supported filters.');return;}
    const todayParts=new Intl.DateTimeFormat('en-US',{timeZone:d.timeZone.trim(),year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date()),today=['year','month','day'].map(key=>todayParts.find(part=>part.type===key)!.value).join('-');
    if(d.to>today){setCohortError('Qualification cannot end after today in its selected time zone.');return;}
    const item=cohortEditor.item;void saveCohort({kind:item?'update':'create',...(item?{id:item.id}:{}),body:{requestId:crypto.randomUUID(),...(item?{revision:item.revision}:{}),definition:{schemaVersion:1,name,query:p.toString()}}});
  }
  useBlocker({shouldBlockFn:()=>cohortPendingRef.current!==null&&!window.confirm('A cohort request may still complete. Leave without confirming its outcome?'),enableBeforeUnload:()=>cohortPendingRef.current!==null});
  useEffect(()=>{void readCohorts();return()=>cohortOp.current?.abort();},[]);
  function acceptRole(value:unknown){if(!roleValue(value)){purgeAccess(403,'Project access could not be verified. Reload access before confirming any pending save.',pendingRef.current);throw new Error('Project access could not be verified.');}savedRoleRef.current=value;setSavedRole(value);return value;}
  async function readSaved(id?:string,loadDraft=false,cursor?:string,recover=false){
    if(accessDenied.current&&!recover||pendingRef.current&&loadDraft)return;
    savedOp.current?.abort();const op=new AbortController(),generation=accessEpoch.current;savedOp.current=op;setSavedBusy(true);setSavedError('');savedRoleRef.current=null;
    try{
      const data=await api<unknown>(id?`${base}/${encodeURIComponent(id)}`:base+(cursor?'?'+new URLSearchParams({cursor}):''),{signal:AbortSignal.any([op.signal,AbortSignal.timeout(20000)])});
      if(!alive.current||op.signal.aborted||generation!==accessEpoch.current||savedOp.current!==op)return;
      if(!record(data))throw new Error('Saved filters could not be verified. Refresh the saved list.');acceptRole(data.role);
      if(id){
        if(!validSaved(data.item,projectId)||data.item.id!==id||deletedIds.current.has(id))throw new Error('This saved filter is no longer available. Refresh the saved list.');
        const item=data.item;setSelected(item);setSelectedId(id);setSavedName(item.definition.name);setSavedItems(old=>old.map(value=>value.id===id?item:value));
        if(loadDraft){const predicates=savedPredicates(item.definition.query)!;setDraft(old=>({...old,...predicates}));setFormError('');setSavedNotice('Saved filters loaded into your draft. Apply filters to update results and CSV.');}
      }else{
        if(!Array.isArray(data.items)||data.items.length>50||!data.items.every(value=>validSaved(value,projectId))||new Set(data.items.map(value=>value.id)).size!==data.items.length||data.nextCursor!==null&&!clean(data.nextCursor,4096))throw new Error('Saved filters could not be verified. Refresh the saved list.');
        const items=(data.items as SavedFilter[]).filter(value=>!deletedIds.current.has(value.id));
        setSavedItems(old=>[...new Map([...(cursor?old:[]),...items].map(value=>[value.id,value])).values()]);setSavedCursor(data.nextCursor as string|null);setSavedLoaded(true);
      }
      if(recover){accessDenied.current=false;setPhase('error');setMessage('Access rechecked. Apply filters to load report results.');}
      return true;
    }catch(e){
      if(!alive.current||op.signal.aborted||generation!==accessEpoch.current)return;
      if(e instanceof ApiError&&[401,403,404].includes(e.status)){
        if(id&&e.status===404){deletedIds.current.add(id);purgeAccess(404,'This saved filter or project is unavailable. Retry to reload access.');}
        else purgeAccess(e.status);
      }else{setSavedRole(null);savedRoleRef.current=null;setSelected(null);setSavedError(errMsg(e));}
    }finally{if(savedOp.current===op){savedOp.current=null;if(alive.current)setSavedBusy(false);}}
  }
  async function saveAttempt(value:SaveAttempt){
    if(savedOp.current||!canSave(savedRoleRef.current)||accessDenied.current)return;
    const confirming=pendingRef.current===value;
    pendingRef.current=value;setPending(value);const op=new AbortController(),generation=accessEpoch.current;savedOp.current=op;setSavedBusy(true);setSavedError('');setSavedNotice('');
    let conflict=false,reloadList=false;
    try{
      const data=await api<unknown>(value.kind==='create'?base:`${base}/${encodeURIComponent(value.id!)}/${value.kind}`,{method:'POST',body:value.body,signal:AbortSignal.any([op.signal,AbortSignal.timeout(20000)])});
      if(!alive.current||op.signal.aborted||generation!==accessEpoch.current)return;
      if(!record(data))throw new Error('The save acknowledgement could not be verified.');acceptRole(data.role);
      if(!canSave(data.role as Role)||typeof data.replayed!=='boolean'||typeof data.deleted!=='boolean')throw new Error('The save acknowledgement could not be verified.');
      if(value.kind==='delete'){
        if(data.deleted!==true||data.id!==value.id)throw new Error('The deletion acknowledgement could not be matched.');
        deletedIds.current.add(value.id!);setSavedItems(old=>old.filter(item=>item.id!==value.id));setSelected(null);setSelectedId('');setSavedName('');setSavedNotice('Saved filter deleted. Your draft and applied results are unchanged.');
      }else if(data.deleted){
        if(data.item!==null||data.replayed!==true)throw new Error('The saved filter receipt could not be verified.');
        if(value.id){deletedIds.current.add(value.id);setSavedItems(old=>old.filter(item=>item.id!==value.id));}else{setSavedItems([]);setSavedCursor(null);setSavedLoaded(false);reloadList=true;}
        setSelected(null);setSelectedId('');setSavedName('');setSavedNotice('The original save was confirmed, but that saved filter was since deleted. It was not recreated.');
      }else{
        if(!validSaved(data.item,projectId)||value.id&&data.item.id!==value.id||value.body.revision!==undefined&&data.item.revision<=value.body.revision||deletedIds.current.has(data.item.id)||!data.replayed&&(data.item.revision!==(value.body.revision??0)+1||!sameDefinition(value.body.definition!,data.item.definition)))throw new Error('The save acknowledgement could not be matched.');
        const item=data.item;setSavedItems(old=>[item,...old.filter(row=>row.id!==item.id)]);setSelected(item);setSelectedId(item.id);setSavedName(item.definition.name);setSavedNotice(data.replayed?'Original save confirmed. The current saved definition is shown; your draft is unchanged.':'Saved. Results and CSV still use the applied filters.');
      }
      pendingRef.current=null;setPending(null);
    }catch(e){
      if(!alive.current||op.signal.aborted||generation!==accessEpoch.current)return;
      const status=e instanceof ApiError?e.status:0;
      if(status===0||status===408||status===429||status>=500)setSavedError('The outcome is unknown. Retry the same request to confirm it; the original settings are kept.');
      else{
        if(!confirming||![401,403,404].includes(status)){pendingRef.current=null;setPending(null);}
        if([401,403,404].includes(status))purgeAccess(status,status===404?'This saved filter or project is unavailable. Retry to reload access.':undefined);
        else if(status===409){setSelected(null);setSavedError('This saved filter changed. Reloading its current definition; review it before saving again. Your report draft is unchanged.');conflict=true;}
        else{setSavedError(errMsg(e));if(status===400&&errMsg(e).includes('regular expression'))focusAdvanced(`${uid}-report-advanced`);}
      }
    }finally{if(savedOp.current===op){savedOp.current=null;if(alive.current)setSavedBusy(false);}}
    if(conflict&&alive.current&&generation===accessEpoch.current&&await readSaved(value.id))setSavedError('This saved filter changed. Its current definition was reloaded. Review it before saving again; your report draft is unchanged.');
    if(reloadList&&alive.current&&generation===accessEpoch.current)void readSaved();
  }
  function saveFilters(kind:'create'|'update'|'rename'|'delete'){
    if(savedOp.current||pendingRef.current||!canSave(savedRoleRef.current)||accessDenied.current)return;
    if(kind!=='create'&&!selected)return;
    if(kind==='delete'){
      if(window.confirm('Delete this saved filter? Your report draft and results will stay unchanged.'))void saveAttempt({kind,id:selected!.id,body:{requestId:crypto.randomUUID(),revision:selected!.revision}});return;
    }
    const name=savedName.trim();if(!clean(name,200)||!name){setSavedError('Enter a name of 1 to 200 characters.');return;}
    const query=kind==='rename'?{qs:selected!.definition.query}:draftFilterQuery(draft);if('error'in query){setSavedError(query.error);if(query.advanced)focusAdvanced(`${uid}-report-advanced`,query.advanced);return;}
    void saveAttempt({kind:kind==='create'?'create':'update',...(kind!=='create'?{id:selected!.id}:{}),body:{requestId:crypto.randomUUID(),...(kind!=='create'?{revision:selected!.revision}:{}),definition:{schemaVersion:1,name,query:query.qs}}});
  }
  useBlocker({shouldBlockFn:()=>pendingRef.current!==null&&!window.confirm('A saved-filter request may still complete. Leave without confirming its outcome?'),enableBeforeUnload:()=>pendingRef.current!==null});
  useEffect(()=>{alive.current=true;void readSaved();return()=>{alive.current=false;accessEpoch.current++;savedOp.current?.abort();pendingRef.current=null;};},[]);

  useEffect(()=>{
    if(accessDenied.current)return;
    const ctrl=new AbortController();
    const generation=accessEpoch.current;analyticsRead.current=ctrl;
    setResult(null);setPhase('loading');setMessage('');
    const path=`/api/projects/${encodeURIComponent(projectId)}/explore?${applied}`;
    (new URLSearchParams(applied).has('fields')||new URLSearchParams(applied).has('propertyView')?readCombination(path,ctrl.signal):api<ExploreResult>(path,{signal:ctrl.signal}))
      .then(r=>{if(!ctrl.signal.aborted&&generation===accessEpoch.current){if(!validCohortResult(r,new URLSearchParams(applied),projectId))throw new Error('The applied report filters could not be verified. Reload before applying again.');setResult(r);setPhase('ok');}})
      .catch(e=>{
        if(ctrl.signal.aborted||generation!==accessEpoch.current)return;
        setResult(null);
        const params=new URLSearchParams(applied),cohortId=params.get('cohortId');
        if(params.has('propertyCursor')&&e instanceof ApiError&&e.status===409&&e.message==='Retention settings changed. Reload property events.'){
          propertyCursorStale.current=true;setPhase('error');setMessage('Retention settings changed. Retry to reload the first page of property events. Your draft and cohort are unchanged.');return;
        }
        if(cohortId&&e instanceof ApiError&&[404,409].includes(e.status))cohortInvalid.current.add(`${cohortId}:${params.get('cohortRevision')}`);
        if(cohortId&&e instanceof ApiError&&e.status===409){
          setPhase('error');setMessage('This cohort changed. Review its current definition, load it, then Apply filters.');void readCohorts(cohortId);
        }else if(e instanceof ApiError&&e.status===401){
          purgeAccess(401);
        }else if(e instanceof ApiError&&(e.status===403||e.status===404)){
          purgeAccess(e.status);
        }else if(e instanceof ApiError&&e.status===400&&e.message.includes('regular expression')){
          setPhase('error');setMessage('One or more patterns are invalid. Check the pattern conditions and try again.');focusAdvanced(`${uid}-report-advanced`);
        }else if(e instanceof ApiError&&e.status===503&&e.message==='The complete combination report is too large. Choose a shorter range or more filters.'){
          setPhase('error');setMessage(e.message);
        }else if(e instanceof ApiError&&e.status===503&&(params.has('predicates')||cohortId)&&e.message==='This query took too long. Choose a shorter date range or more filters.'){
          setPhase('error');setMessage('The report took too long. Simplify the patterns or shorten the date range, then Apply filters.');
        }else{
          setPhase('error');setMessage(`Couldn't load explore data. ${errMsg(e)}`);
        }
      });
    return()=>ctrl.abort();
  },[applied,attempt,projectId]);

  const refresh=()=>{if(propertyCursorStale.current){propertyCursorStale.current=false;setApplied(old=>{const p=new URLSearchParams(old);p.delete('propertyCursor');return p.toString();});}if(accessDenied.current){accessDenied.current=false;void readSaved();void readCohorts();}setResult(null);setPhase('loading');setMessage('');setAttempt(a=>a+1);};

  const apply=(e:FormEvent)=>{
    e.preventDefault();
    if(accessDenied.current)return;
    if(cohortDraft&&(cohortDeleted.current.has(cohortDraft.id)||cohortInvalid.current.has(`${cohortDraft.id}:${cohortDraft.revision}`))){setFormError('Clear the unavailable cohort or load its current definition before applying.');return;}
    const r=combinationParams(draft,cohortDraft,combined?fields:null,propertyDetails);
    if('error'in r){setFormError(r.error);if(r.advanced)focusAdvanced(`${uid}-report-advanced`,r.advanced);return;}
    setFormError('');setApplied(r.qs);refresh();
  };

  const download=()=>{
    if(phase!=='ok'||!result)return;
    const url=URL.createObjectURL(new Blob([result.csv],{type:'text/csv;charset=utf-8'}));
    const a=document.createElement('a');
    a.href=url;a.download='ten98-explore.csv';
    document.body.appendChild(a);a.click();a.remove();
    URL.revokeObjectURL(url);
  };

  const patch=(p:Partial<Draft>)=>setDraft(d=>({...d,...p}));
  const patchFilter=(k:string,p:Partial<FilterRow>)=>setDraft(d=>({...d,filters:patchLocationFilters(d.filters,k,p)}));
  const patchProp=(p:Partial<Draft['prop']>)=>setDraft(d=>({...d,prop:{...d.prop,...p}}));

  const keyList=phase==='ok'&&result?result.properties.keys:[];
  const keysTruncated=phase==='ok'&&result?result.properties.truncated:false;
  const t=result?.totals;
  const currentParams=combinationParams(draft,cohortDraft,combined?fields:null,propertyDetails);
  const appliedScope=new URLSearchParams(applied);appliedScope.delete('propertyCursor');
  const unapplied='error'in currentParams||currentParams.qs!==appliedScope.toString();
  const appliedDates=new URLSearchParams(applied);
  const cohortLocked=cohortBusy||!!cohortPending,qualification=cohortEditor?.draft,cohortMembershipUnavailable=result?.cohort?.membership.status==='unavailable',sessionUnavailable=result?.sessionProperties?.selection.status==='unavailable'||result?.cohort?.sessionProperties?.selection.status==='unavailable';
  function patchQualification(patch:Partial<Draft>){setCohortEditor(old=>old?{...old,draft:{...old.draft,...patch}}:old);}
  const annotations=useAnnotations({projectId,userId,range:accessDenied.current?null:{from:appliedDates.get('from')!,to:appliedDates.get('to')!,timeZone:result?.range.timeZone??appliedDates.get('timeZone')!},onUnauthorized,onAccessLost:status=>purgeAccess(status)});

  return(
    <section className="explorer stack" aria-labelledby={`${uid}-h`} style={{'--control-md':'var(--control-touch)'} as import('react').CSSProperties}>
      <h2 id={`${uid}-h`}>Explore</h2>

      <form className="card stack" onSubmit={apply}>
        <fieldset className="stack" disabled={phase==='denied'||phase==='unavailable'} style={{border:0,padding:0,margin:0,minWidth:0}}>
        <section className="stack" aria-label="Saved filters" style={{minWidth:0,overflowWrap:'anywhere'}}>
          <div className="row" style={{alignItems:'end'}}>
            <div style={{flex:'1 1 240px',minWidth:0}}><label htmlFor={`${uid}-saved`}>Saved filters</label><select id={`${uid}-saved`} style={{width:'100%',minWidth:0}} disabled={savedBusy||!!pending||!savedRole} value={selectedId} onChange={e=>{const id=e.target.value;setSelectedId(id);setSelected(null);setSavedName('');setSavedNotice('');if(id)void readSaved(id);}}><option value="">Choose a saved filter</option>{savedItems.map(item=><option key={item.id} value={item.id}>{item.definition.name}</option>)}</select></div>
            <button className="btn" type="button" disabled={savedBusy||!!pending||!selected||!savedRole} onClick={()=>void readSaved(selectedId,true)}>Load</button>
            <button className="btn" type="button" disabled={savedBusy} onClick={()=>void readSaved()}>Refresh saved filters</button>
            {savedCursor&&<button className="btn" type="button" disabled={savedBusy} onClick={()=>void readSaved(undefined,false,savedCursor)}>Load more saved filters</button>}
          </div>
          <p className="hint">Load replaces draft filters only. Dates, time zone and grouping stay as you set them. Apply filters to update results and CSV.</p>
          {savedBusy&&<p role="status">{pending?'Saving filters…':'Loading saved filters…'}</p>}
          {savedLoaded&&!savedItems.length&&!savedBusy&&<p className="hint">No saved filters yet.</p>}
          {savedNotice&&<p className="notice" role="status">{savedNotice}</p>}
          {savedError&&<p className="alert" role="alert">{savedError}</p>}
          {pending&&<div className="row"><p className="hint">This request keeps its original name, filters and revision.</p><button className="btn" type="button" disabled={savedBusy||!canSave(savedRole)} onClick={()=>void saveAttempt(pending)}>Retry same request</button></div>}
          {canSave(savedRole)&&<details><summary>Save or manage filters</summary><div className="stack">
            <p className="hint">Save the current draft's event kind, exact filters and typed property filter. Dates, time zone and grouping are excluded.</p>
            <details><summary>Draft filters to save</summary><p><strong>Required filters — all</strong></p><p>{labelOf(KINDS,draft.kind)}</p>{FILTERS.filter(([key])=>draft.filters[key].on).map(([key,label])=><p key={key}>{label} equals {fieldValueLabel(key,draft.filters[key].value)}</p>)}{draft.prop.on&&<p>Property {JSON.stringify(draft.prop.key)}: {draft.prop.type}{draft.prop.type!=='missing'?` equals ${draft.prop.value}`:''}</p>}{!FILTERS.some(([key])=>draft.filters[key].on)&&!draft.prop.on&&<p>No additional required filters.</p>}<AdvancedSummary draft={draft.advanced} zone={draft.timeZone}/></details>
            <div><label htmlFor={`${uid}-saved-name`}>Saved filter name</label><input id={`${uid}-saved-name`} style={{width:'100%',minWidth:0}} maxLength={200} value={savedName} disabled={savedBusy||!!pending} onChange={e=>setSavedName(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'){e.preventDefault();saveFilters(selected?'rename':'create');}}}/></div>
            {selected&&<p className="hint">Selected: {selected.definition.name} · Revision {selected.revision}. Rename keeps its saved predicates; Update saved filter replaces them with your current draft.</p>}
            <div className="row"><button className="btn" type="button" disabled={savedBusy||!!pending} onClick={()=>saveFilters('create')}>{selected?'Save as new':'Save filters'}</button>{selected&&<><button className="btn" type="button" disabled={savedBusy||!!pending} onClick={()=>saveFilters('update')}>Update saved filter</button><button className="btn" type="button" disabled={savedBusy||!!pending} onClick={()=>saveFilters('rename')}>Rename</button><button className="btn" type="button" disabled={savedBusy||!!pending} onClick={()=>saveFilters('delete')}>Delete saved filter</button></>}</div>
          </div></details>}
          {savedRole==='viewer'&&<p className="hint">You can load saved filters. An owner, admin or editor can save changes.</p>}
        </section>
        <section className="stack cohort-controls" aria-label="Report cohort">
          <div className="row" style={{alignItems:'end'}}>
            <div style={{flex:'1 1 240px',minWidth:0}}><label htmlFor={`${uid}-cohort`}>Saved cohort</label><select id={`${uid}-cohort`} disabled={cohortLocked||!cohortRole} value={cohortSelectedId} onChange={e=>{const id=e.target.value;setCohortSelectedId(id);setCohortSelected(null);if(id)void readCohorts(id);}}><option value="">Choose a cohort</option>{cohortItems.map(item=><option key={item.id} value={item.id}>{item.definition.name}</option>)}</select></div>
            <button className="btn" type="button" disabled={cohortLocked||!cohortSelected||!cohortRole} onClick={()=>void readCohorts(cohortSelected!.id,'load')}>Load cohort</button>
            <button className="btn" type="button" disabled={cohortBusy} onClick={()=>void readCohorts()}>Refresh cohorts</button>
            {cohortCursor&&<button className="btn" type="button" disabled={cohortBusy} onClick={()=>void readCohorts(undefined,'inspect',cohortCursor)}>Load more cohorts</button>}
          </div>
          <p className="hint">Load stages a saved qualification for this report. Apply filters to update results and CSV; report dates and filters stay as you set them.</p>
          <p className="hint">Report cohort: {cohortDraft?`${cohortDraft.definition?.name??'Saved cohort reference'} · Revision ${cohortDraft.revision}`:'None'}</p>
          {cohortDraft?.definition&&<p className="hint">Qualification dates: {new URLSearchParams(cohortDraft.definition.query).get('from')} to {new URLSearchParams(cohortDraft.definition.query).get('to')} ({new URLSearchParams(cohortDraft.definition.query).get('timeZone')})</p>}
          {cohortSelected&&<details><summary>Selected qualification</summary><p>{cohortSelected.definition.name} · Revision {cohortSelected.revision}</p><p><strong>Required filters — all</strong></p>{[...new URLSearchParams(cohortSelected.definition.query)].filter(([key])=>key!=='predicates').map(([key,value])=><p className="hint" key={key}>{labelOf([...FILTERS,['from','Qualification from'],['to','Qualification to'],['timeZone','Qualification time zone'],['kind','Qualifying event kind'],['propertyKey','Property key'],['propertyType','Property type'],['propertyValue','Property value']],key)}: {key==='kind'?labelOf(KINDS,value):fieldValueLabel(key,value)}</p>)}<AdvancedSummary draft={qualificationDraft(cohortSelected.definition.query)!.advanced} zone={qualificationDraft(cohortSelected.definition.query)!.timeZone}/></details>}
        </section>
        <div className="explorer-toolbar">
          <div>
          <label htmlFor={`${uid}-from`}>From</label>
          <input id={`${uid}-from`} type="date" required max={draft.to} value={draft.from} onChange={e=>patch({from:e.target.value})}/>
          </div><div>
          <label htmlFor={`${uid}-to`}>To</label>
          <input id={`${uid}-to`} type="date" required min={draft.from} value={draft.to} onChange={e=>patch({to:e.target.value})}/>
          </div><div>
          <label htmlFor={`${uid}-tz`}>Time zone</label>
          <input id={`${uid}-tz`} type="text" required list={`${uid}-tzl`} value={draft.timeZone} onChange={e=>patch({timeZone:e.target.value})}/>
          </div>
          <datalist id={`${uid}-tzl`}>{TIMEZONES.map(z=><option key={z} value={z}/>)}</datalist>
        </div>
        <p className="hint dim">Dates include the whole calendar day in your selected time zone.</p>
        <div className="explorer-toolbar">
          <div>
          <label htmlFor={`${uid}-kind`}>Show</label>
          <select id={`${uid}-kind`} value={draft.kind} onChange={e=>patch({kind:e.target.value})}>
            {KINDS.map(([k,l])=><option key={k} value={k}>{l}</option>)}
          </select>
          </div><div><label htmlFor={`${uid}-group-mode`}>Grouping</label><select id={`${uid}-group-mode`} value={combined?'combined':'single'} onChange={e=>setCombined(e.target.value==='combined')}><option value="single">Single field</option><option value="combined">Combined fields</option></select></div>{!combined&&<div>
          <label htmlFor={`${uid}-gb`}>Group by</label>
          <select id={`${uid}-gb`} value={draft.groupBy} onChange={e=>patch({groupBy:e.target.value})}>
            {GROUPS.map(([k,l])=><option key={k} value={k}>{l}</option>)}
          </select>
          </div>}
          {!combined&&draft.groupBy==='property'&&(<div>
            <label htmlFor={`${uid}-gp`}>Property key</label>
            <input id={`${uid}-gp`} type="text" required maxLength={320} list={`${uid}-keys`} placeholder="nested.count or a\.b" value={draft.groupProperty} onChange={e=>patch({groupProperty:e.target.value})}/>
          </div>)}
          <datalist id={`${uid}-keys`}>{keyList.map(k=><option key={k} value={k}/>)}</datalist>
        </div>
        {combined&&<fieldset className="stack" style={{minWidth:0}}><legend>Combined fields</legend><p className="hint">Each row is one observed combination. Visitor keys can appear in several rows; do not add row visitors together. Changes remain draft-only until Apply filters.</p><div className="row">{fields.map((field,index)=><div key={index} style={{minWidth:0,flex:'1 1 180px'}}><label htmlFor={`${uid}-field-${index}`}>Field {index+1}</label><select id={`${uid}-field-${index}`} value={field} onChange={e=>setFields(old=>old.map((value,i)=>i===index?e.target.value:value))}>{GROUPS.filter(([key])=>key!=='property').map(([key,label])=><option key={key} value={key} disabled={fields.includes(key)&&field!==key}>{label}</option>)}</select>{index>0&&<button type="button" className="btn" aria-label={`Move field ${index+1} earlier`} onClick={()=>setFields(old=>{const next=[...old];[next[index-1],next[index]]=[next[index],next[index-1]];return next;})}>Move earlier</button>}</div>)}</div><div className="row">{fields.length===2?<button type="button" className="btn" onClick={()=>setFields(old=>[...old,GROUPS.find(([key])=>key!=='property'&&!old.includes(key))![0]])}>Add third field</button>:<button type="button" className="btn" onClick={()=>setFields(old=>old.slice(0,2))}>Remove third field</button>}<button type="button" className="btn" onClick={()=>{setFields(['campaignSource','campaignMedium','campaignName']);patch({kind:'pageviews'});}}>Stage source × medium × campaign</button></div><p className="hint">The campaign preset stages Page views and three campaign fields. Review dates and filters, then Apply filters. Grouping is not stored in saved filters or the page URL.</p></fieldset>}
        {!combined&&draft.groupBy==='property'&&keysTruncated&&(
          <p className="hint dim">Key suggestions show the top 100 keys only; exact keys not listed still work.</p>
        )}

        <ExactFilterControls uid={uid} draft={draft} patchFilter={patchFilter} patchProp={patchProp} keysTruncated={keysTruncated}/>

        <AdvancedControls id={`${uid}-report-advanced`} label="Advanced filters" draft={draft.advanced} zone={draft.timeZone} error={formError||savedError} onChange={advanced=>patch({advanced})}/>
        <div className="row">
          <button className="btn primary" type="submit">Apply filters</button>
          <button className="btn" type="button" disabled={phase==='loading'} onClick={refresh}>Refresh</button>
          {phase==='ok'&&result&&<button className="btn" type="button" onClick={download}>Download CSV</button>}
        </div>
        {!combined&&draft.groupBy==='property'&&<label><input type="checkbox" checked={propertyDetails} onChange={e=>setPropertyDetails(e.target.checked)}/> Property analysis and event properties</label>}
        {unapplied&&<p className="hint" role="status">You have unapplied changes. Apply filters to update the results and CSV.</p>}
        {formError&&<p className="alert" role="alert">{formError}</p>}
        {phase==='ok'&&result&&<p className="hint dim">CSV downloads the current bounded table, daily data and scope — it is not a complete data export.</p>}
        </fieldset>
      </form>

      <section className="card stack cohort-controls" aria-label="Cohorts">
        <div className="row between"><h3>Cohorts</h3>{cohortDraft&&<button className="btn" type="button" onClick={()=>{setCohortDraft(null);setFormError('');setCohortNotice('Cohort cleared from your draft. Apply filters to update results and CSV.');}}>Clear cohort</button>}{accessDenied.current&&<button className="btn" type="button" disabled={cohortBusy} onClick={()=>void readCohorts(undefined,'inspect',undefined,true)}>Reload cohort access</button>}</div>
        <p className="hint">Choose visitors observed performing an action in a fixed qualification period. Report dates decide which activity you view.</p>
        {cohortBusy&&<p role="status">{cohortPending?'Saving cohort…':'Loading cohorts…'}</p>}{cohortNotice&&<p className="notice" role="status">{cohortNotice}</p>}{cohortError&&<p className="alert" role="alert">{cohortError}</p>}
        {cohortPending&&<div className="row"><p className="hint">Only the original request can be retried until its outcome is confirmed.</p><button className="btn" type="button" disabled={cohortBusy||!canSave(cohortRole)||accessDenied.current} onClick={()=>void saveCohort(cohortPending)}>Retry same cohort request</button></div>}
        {cohortDraft&&(cohortDeleted.current.has(cohortDraft.id)||cohortInvalid.current.has(`${cohortDraft.id}:${cohortDraft.revision}`))&&<p className="alert" role="alert">The report draft references an unavailable cohort version. Clear cohort or load its current definition before applying.</p>}
        {cohortRole&&cohortItems.length===0&&!cohortBusy&&<p className="hint">No saved cohorts yet.</p>}
        {cohortRole==='viewer'&&<p className="hint">You can load cohorts. An owner, admin or editor can save changes.</p>}
        <details ref={cohortManager}><summary>Manage cohorts</summary><div className="stack">
          {canSave(cohortRole)&&<div className="row"><button className="btn" type="button" disabled={cohortLocked} onClick={()=>{setCohortEditor({item:null,name:'',draft:{...initialDraft(),from:appliedDates.get('from')!,to:appliedDates.get('to')!,timeZone:appliedDates.get('timeZone')!}});setCohortError('');}}>New cohort</button>{cohortSelected&&<><button className="btn" type="button" disabled={cohortLocked} onClick={()=>void readCohorts(cohortSelected.id,'edit')}>Edit cohort</button><button className="btn" type="button" disabled={cohortLocked} onClick={()=>{if(!cohortPendingRef.current&&window.confirm(`Delete ${cohortSelected.definition.name}? Existing report results remain a snapshot. Future reports cannot use this cohort.`))void saveCohort({kind:'delete',id:cohortSelected.id,body:{requestId:crypto.randomUUID(),revision:cohortSelected.revision}});}}>Delete cohort</button></>}</div>}
          {cohortEditor&&qualification&&canSave(cohortRole)&&<form className="card stack" aria-label="Cohort qualification" onSubmit={e=>{e.preventDefault();submitCohort();}}><fieldset className="stack" disabled={cohortLocked} style={{border:0,padding:0,margin:0,minWidth:0}}>
            <div><label htmlFor={`${uid}-cohort-name`}>Cohort name</label><input id={`${uid}-cohort-name`} autoFocus maxLength={200} value={cohortEditor.name} onChange={e=>setCohortEditor({...cohortEditor,name:e.target.value})}/><p className="hint">{cohortEditor.name.length}/200 characters</p></div>
            <div className="explorer-toolbar"><div><label htmlFor={`${uid}-qfrom`}>Qualification from</label><input id={`${uid}-qfrom`} type="date" required max={qualification.to} value={qualification.from} onChange={e=>patchQualification({from:e.target.value})}/></div><div><label htmlFor={`${uid}-qto`}>Qualification to</label><input id={`${uid}-qto`} type="date" required min={qualification.from} value={qualification.to} onChange={e=>patchQualification({to:e.target.value})}/></div><div><label htmlFor={`${uid}-qtz`}>Qualification time zone</label><input id={`${uid}-qtz`} required list={`${uid}-tzl`} value={qualification.timeZone} onChange={e=>patchQualification({timeZone:e.target.value})}/></div></div>
            <p className="hint">These fixed dates decide who qualifies, independently of report dates. Choose 1 to 366 days ending today or earlier in this time zone.</p>
            <div className="row"><div className="cohort-field"><label htmlFor={`${uid}-qaction`}>Qualifying action</label><select id={`${uid}-qaction`} required value={qualification.filters.path.on?'path':qualification.filters.eventName.on?'eventName':''} onChange={e=>patchQualification({filters:{...qualification.filters,path:{...qualification.filters.path,on:e.target.value==='path'},eventName:{...qualification.filters.eventName,on:e.target.value==='eventName'}}})}><option value="">Choose an action</option><option value="path">Path</option><option value="eventName">Event name</option></select></div>{(['path','eventName'] as const).filter(key=>qualification.filters[key].on).map(key=><div key={key} className="cohort-field"><label htmlFor={`${uid}-qaction-value`}>{key==='path'?'Qualification path equals':'Qualification event name equals'}</label><input id={`${uid}-qaction-value`} maxLength={key==='path'?2048:320} value={qualification.filters[key].value} onChange={e=>patchQualification({filters:{...qualification.filters,[key]:{on:true,value:e.target.value}}})}/><p className="hint">Blank matches an empty stored value.</p></div>)}</div>
            <div><label htmlFor={`${uid}-qkind`}>Qualifying event kind</label><select id={`${uid}-qkind`} value={qualification.kind} onChange={e=>patchQualification({kind:e.target.value})}>{KINDS.map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></div>
            <details><summary>More qualification filters</summary><div className="stack">
              <p><strong>Required filters — all</strong></p><p className="hint">The qualifying action and event conditions must match the same event. Session conditions use that event's visitor key and current retained values.</p>
              {FILTERS.filter(([key])=>!['path','eventName'].includes(key)).map(([key,label])=><div className="row" key={key}><label className="row cohort-check"><input type="checkbox" checked={qualification.filters[key].on} onChange={e=>patchQualification({filters:{...qualification.filters,[key]:{...qualification.filters[key],on:e.target.checked}}})}/>Enable qualification {label}</label><div className="cohort-field"><label htmlFor={`${uid}-q-${key}`}>Qualification {label} equals</label>{isGeo(key)?<GeographyValueControl id={`${uid}-q-${key}`} field={key} disabled={!qualification.filters[key].on} value={qualification.filters[key].value} onChange={value=>patchQualification({filters:patchLocationFilters(qualification.filters,key,{on:true,value})})}/>:environmentFields.includes(key as EnvironmentField)?<select id={`${uid}-q-${key}`} disabled={!qualification.filters[key].on} value={qualification.filters[key].value} onChange={e=>patchQualification({filters:{...qualification.filters,[key]:{on:true,value:e.target.value}}})}><option value="">Choose a category</option>{environmentCatalog[key as EnvironmentField].map(value=><option key={value} value={value}>{value==='unknown'?'Unknown':value}</option>)}<option value="not-recorded">Not recorded</option></select>:<input id={`${uid}-q-${key}`} maxLength={analyticsFieldLimit(key)} disabled={!qualification.filters[key].on} value={qualification.filters[key].value} onChange={e=>patchQualification({filters:{...qualification.filters,[key]:{on:true,value:e.target.value}}})}/>}</div></div>)}
              <label className="row cohort-check"><input type="checkbox" checked={qualification.prop.on} onChange={e=>patchQualification({prop:{...qualification.prop,on:e.target.checked}})}/>Enable qualification property filter</label>
              {qualification.prop.on&&<><div className="row"><div className="cohort-field"><label htmlFor={`${uid}-qkey`}>Qualification property key</label><input id={`${uid}-qkey`} required maxLength={320} value={qualification.prop.key} onChange={e=>patchQualification({prop:{...qualification.prop,key:e.target.value}})}/></div><div className="cohort-field"><label htmlFor={`${uid}-qtype`}>Qualification property type</label><select id={`${uid}-qtype`} value={qualification.prop.type} onChange={e=>patchQualification({prop:{...qualification.prop,type:e.target.value}})}>{PROP_TYPES.map(type=><option key={type} value={type}>{type}</option>)}</select></div></div>{qualification.prop.type!=='missing'&&<div><label htmlFor={`${uid}-qvalue`}>Qualification value (JSON literal)</label><input id={`${uid}-qvalue`} required maxLength={8192} value={qualification.prop.value} onChange={e=>patchQualification({prop:{...qualification.prop,value:e.target.value}})}/></div>}<p className="hint">Valid date strings are normalized; arrays compare the whole array. Missing is distinct from null.</p></>}
            </div></details>
            <AdvancedControls id={`${uid}-qualification-advanced`} label="Advanced qualification filters" draft={qualification.advanced} zone={qualification.timeZone} error={cohortError} onChange={advanced=>patchQualification({advanced})}/>
            <div className="row"><button className="btn" type="submit">{cohortEditor.item?'Save cohort changes':'Save cohort'}</button><button className="btn" type="button" onClick={()=>setCohortEditor(null)}>Cancel cohort edit</button></div>
          </fieldset></form>}
        </div></details>
      </section>

      <p role="status" aria-live="polite" className={phase==='loading'||phase==='ok'?'hint dim':'alert'}>
        {phase==='loading'?'Loading explore data…':message}
      </p>
      {(phase==='error'||phase==='unavailable')&&(accessDenied.current&&pending?<button className="btn" type="button" disabled={savedBusy} onClick={()=>void readSaved(undefined,false,undefined,true)}>Reload saved-filter access</button>:<button className="btn" type="button" onClick={refresh}>Retry</button>)}

      {phase==='ok'&&result&&t&&(<><GeographyAttribution/>{result.geographyProvenance&&<p className="hint">Location source builds across matching report events: {num(result.geographyProvenance.databaseCount)}{result.geographyProvenance.oldestDatabaseBuild?` · oldest ${new Date(result.geographyProvenance.oldestDatabaseBuild*1000).toISOString().slice(0,10)}`:''}{result.geographyProvenance.newestDatabaseBuild?` · newest ${new Date(result.geographyProvenance.newestDatabaseBuild*1000).toISOString().slice(0,10)}`:''}. This uses retained report events, not the cohort qualification period or current database file.</p>}
        <p className="hint dim">
          {result.range.from} to {result.range.to} ({result.range.timeZone}) · {labelOf(KINDS,result.query.kind)} · grouped by {result.query.fields?result.query.fields.map(field=>labelOf(GROUPS,field)).join(' × '):labelOf(GROUPS,result.query.groupBy??'')}{result.query.groupProperty?`: ${result.query.groupProperty}`:''}
        </p>
        <details className="explorer-scope"><summary>Applied filters and boundaries</summary>
          <p className="hint">UTC bounds: {result.range.start} (inclusive) to {result.range.end} (exclusive). Only instants within the selected local dates are included.</p>
          <p><strong>Required filters — all</strong></p>
          {Object.entries(result.query.filters).map(([key,value])=><p key={key}>{labelOf(FILTERS,key)} equals {fieldValueLabel(key,value)}</p>)}
          {result.query.property&&<p>Property {JSON.stringify(result.query.property.key)}: {result.query.property.type}{result.query.property.type!=='missing'?` equals ${JSON.stringify(result.query.property.value)}`:''}</p>}
          {!Object.keys(result.query.filters).length&&!result.query.property&&<p className="hint">No additional filters.</p>}
          {result.query.predicates&&<AdvancedSummary draft={readAdvanced(result.query.predicates)!} zone={result.range.timeZone}/>}
        </details>
        {result.cohort&&<section className="card stack cohort-controls" aria-label="Applied cohort">
          <h3>Applied cohort: {result.cohort.item.definition.name} · Revision {result.cohort.item.revision}</h3>
          {[...new URLSearchParams(result.cohort.item.definition.query)].filter(([key])=>key==='path'||key==='eventName').map(([key,value])=><p className="hint" key={key}>Qualifying action: {labelOf(FILTERS,key)} equals {fieldValueLabel(key,value)}.</p>)}
          {cohortDeleted.current.has(result.cohort.item.id)&&<p className="alert">This cohort was deleted. These results remain a snapshot; clear the draft reference or load another cohort before applying.</p>}
          <div className="row"><p className="cohort-field">Report dates: {result.range.from} to {result.range.to} ({result.range.timeZone})<br/><span className="hint">Report coverage: {result.coverage.status}</span></p><p className="cohort-field">Qualification dates: {result.cohort.range.from} to {result.cohort.range.to} ({result.cohort.range.timeZone})<br/><span className="hint">Qualification coverage: {result.cohort.coverage.status}</span></p></div>
          <p className={cohortMembershipUnavailable?'alert':result.cohort.membership.countsAreLowerBounds?'banner':'hint'} role="status">{cohortMembershipUnavailable?<><strong>Membership unavailable.</strong> {result.cohort.sessionProperties?.selection.status==='unavailable'?sessionReason(result.cohort.sessionProperties):result.cohort.coverage.status==='unavailable'?'The qualification period is no longer retained.':'Qualifying events have no visitor identifiers.'} Cohort report counts are unavailable.</>:result.cohort.membership.countsAreLowerBounds?<><strong>Observed lower bounds.</strong> Some qualifying history, session-property evidence or visitor identifiers are unavailable. Counts include only the membership we can observe.</>:result.cohort.coverage.status==='complete'&&result.cohort.identity.identifiedEvents===0&&result.cohort.identity.unidentifiedEvents===0?<><strong>No qualifying events.</strong> No events matched this qualification in the fully retained period.</>:<strong>Observed membership available.</strong>}</p>
          <p className="hint">Membership uses observed visitor identifiers. They reset each UTC month and can change when identity settings or the signing secret change. Activity cannot be linked across those changes.</p>
          <details><summary>Qualification details</summary><div className="stack"><p className="hint">Qualification retained from: {result.cohort.coverage.retainedFrom??'No retention boundary'}. Identifier coverage: {result.cohort.identity.status}.</p><p className="hint">Qualifying events with identifiers: {num(result.cohort.identity.identifiedEvents)} · without identifiers: {num(result.cohort.identity.unidentifiedEvents)} · observed member keys: {num(result.cohort.identity.observedMemberKeys)}.</p><p className="hint">Qualification UTC bounds: {result.cohort.range.start} (inclusive) to {result.cohort.range.end} (exclusive).</p>{[...new URLSearchParams(result.cohort.item.definition.query)].filter(([key])=>!['from','to','timeZone','predicates'].includes(key)).map(([key,value])=><p className="hint" key={key}>{key==='kind'?'Qualifying event kind':key==='propertyKey'?'Property key':key==='propertyType'?'Property type':key==='propertyValue'?'Property value':labelOf(FILTERS,key)}: {fieldValueLabel(key,value)}</p>)}<AdvancedSummary draft={qualificationDraft(result.cohort.item.definition.query)!.advanced} zone={result.cohort.range.timeZone}/><p className="hint">{result.cohort.limitation}</p></div></details>
        </section>}
        {result.sessionProperties&&<SessionStatus scope={result.sessionProperties} label="Report session properties"/>}
        {result.cohort?.sessionProperties&&<SessionStatus scope={result.cohort.sessionProperties} label="Qualification session properties"/>}
        {result.coverage.status!=='complete'&&(
          <p className="hint">Coverage is {result.coverage.status}: results include retained observations only{result.coverage.retainedFrom?` from ${result.coverage.retainedFrom}`:''}.</p>
        )}

        <div className="metric-grid">
          <div className="card">
            <div className={`metric-value${t.events===null?' is-unavailable':''}`}>{num(t.events)}</div>
            <div className="metric-label">Events</div>
            <div className="hint dim">{num(t.identifiedEvents)} identified · {num(t.unidentifiedEvents)} unidentified</div>
          </div>
          <div className="card">
            <div className={`metric-value${t.pageViews===null?' is-unavailable':''}`}>{num(t.pageViews)}</div>
            <div className="metric-label">Page views</div>
          </div>
          <div className="card">
            <div className={`metric-value${t.customEvents===null?' is-unavailable':''}`}>{num(t.customEvents)}</div>
            <div className="metric-label">Custom events</div>
          </div>
          <div className="card">
            <div className={`metric-value${t.visitors===null?' is-unavailable':''}`}>{num(t.visitors)}</div>
            <div className="metric-label">Visitors</div>
            <div className="hint dim">{t.visitors==null?'Visitor estimate unavailable':`${num(t.visits)} visits`}</div>
          </div>
        </div>

        <div className="card stack">
          <h3>Breakdown</h3>{(isGeo(result.query.groupBy??'')||result.query.fields?.some(isGeo))&&<p className="hint">Select a location to add a required draft filter. Apply filters to update results and CSV. Names include their country and region; location is approximate.</p>}
          <p className="hint dim">
            {sessionUnavailable?'Breakdown unavailable because session-property selection is unavailable.':cohortMembershipUnavailable?'Breakdown unavailable because cohort membership is unavailable.':result.coverage.status==='unavailable'?'Breakdown unavailable after retention.':<>
            Returned {num(result.breakdown.returnedGroupEvents)} of {num(t.events)} events across {num(result.breakdown.totalGroups)} groups.
            {result.breakdown.truncated?' Breakdown truncated — apply filters to narrow the results.':''}
            </>}
          </p>
          {result.query.fields&&<p className="hint">Page-view metrics use observed rotating visitor and visit keys, not people or complete sessions. Visitors (all events) also includes custom events; estimated visitors and visits use page views only. Anonymous page views remain counted, with unavailable key metrics. Duration is the mean of each matching visit's last minus first matching page view, including zero-length visits. Any retained custom event in the project/date range suppresses that visit's bounce, including outside these filters. Rates and duration are unavailable when history or selection evidence is incomplete. Rows rank by estimated visitors, then page views; do not add visitors or visits across rows.</p>}
          {result.breakdown.groups.length===0?(
            <p className="hint dim">{sessionUnavailable?'Review the session-property evidence above. Unavailable selection does not mean no matching events.':cohortMembershipUnavailable?'Qualification data cannot establish membership. Review the qualification period and identifier coverage.':result.coverage.status==='unavailable'?'This history is no longer available. Choose a more recent range.':'No retained events match these filters. Change the dates or remove filters.'}</p>
          ):(
            <div className="table-wrap" tabIndex={0} role="region" aria-label="Breakdown data, scroll horizontally for all columns">
              <table>
                <thead><tr>{result.query.fields?result.query.fields.map(field=><th key={field} scope="col">{labelOf(GROUPS,field)}</th>):<><th>Value</th><th>Type</th></>}<th>Events</th><th>{result.query.fields?'Visitors (all events)':'Visitors'}</th>{result.query.fields&&<><th scope="col">Page views</th><th scope="col">Estimated visitors (page views)</th><th scope="col">Visits (page views)</th><th scope="col">Bounce rate</th><th scope="col">Average observed visit duration</th></>}</tr></thead>
                <tbody>
                  {result.breakdown.groups.slice(0,result.query.fields?500:100).map((g,i)=>(
                    <tr key={i}>
                      {result.query.fields?(g.value as Array<{type:string;value:unknown}>).map((atom,index)=>{const field=result.query.fields![index],label=groupValue(atom.type,atom.value,field);return <td key={field}>{isGeo(field)?<button type="button" className="analytics-environment-label" onClick={()=>{patchFilter(field,{on:true,value:atom.value as string});setFormError('');}} aria-label={`Use ${labelOf(GROUPS,field)}: ${label}`}><bdi>{label}</bdi></button>:<><bdi>{label}</bdi> <span className="hint">({groupType(atom.type)})</span></>}</td>;}):<><td>{isGeo(result.query.groupBy??'')?<button type="button" className="analytics-environment-label" onClick={()=>{patchFilter(result.query.groupBy!,{on:true,value:g.value as string});setFormError('');}} aria-label={`Use ${labelOf(GROUPS,result.query.groupBy??'')}: ${groupValue(g.type,g.value,result.query.groupBy)}`}><bdi>{groupValue(g.type,g.value,result.query.groupBy)}</bdi></button>:groupValue(g.type,g.value,result.query.groupBy)}</td>
                      <td>{isGeo(result.query.groupBy??'')?parseGeographyKey(result.query.groupBy as GeoField,g.value)?.state==='known'?'Known location':parseGeographyKey(result.query.groupBy as GeoField,g.value)?.state==='unknown'?'Unknown':'Not recorded':groupType(g.type)}</td></>}
                      <td>{g.events}</td>
                      <td>{g.visitors==null?'Unavailable':g.visitors}</td>
                      {result.query.fields&&<><td>{g.pageViews}</td><td>{num(g.estimatedVisitors??null)}</td><td>{num(g.visits??null)}</td><td>{g.bounceRate==null?'Unavailable':<bdi>{new Intl.NumberFormat('en-US',{maximumFractionDigits:2}).format(g.bounceRate)}%</bdi>}</td><td>{g.averageVisitSeconds==null?'Unavailable':<bdi>{new Intl.NumberFormat('en-US',{maximumFractionDigits:2}).format(g.averageVisitSeconds)} s</bdi>}</td></>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <details className="card">
          <summary>Daily data ({result.daily.length} {result.daily.length===1?'day':'days'})</summary>
          <div className="table-wrap" tabIndex={0} role="region" aria-label="Daily data, scroll horizontally for all columns">
            <table>
              <thead><tr><th>Date</th><th>Events</th><th>Page views</th><th>Custom events</th><th>Coverage</th><th>Notes</th></tr></thead>
              <tbody>
                {result.daily.map(d=>(
                  <tr key={d.date}>
                    <td>
                      {d.date}
                      {d.skipped?(
                        <div className="hint dim">This calendar date did not occur in {result.range.timeZone}.</div>
                      ):(
                        <details>
                          <summary className="hint dim">UTC boundaries</summary>
                          <div className="hint dim">{d.start} – {d.end}</div>
                        </details>
                      )}
                    </td>
                    <td>{d.skipped?'—':num(d.events)}</td>
                    <td>{d.skipped?'—':num(d.pageViews)}</td>
                    <td>{d.skipped?'—':num(d.customEvents)}</td>
                    <td>{d.coverage}</td>
                    <td>{annotations.dayButton(d.date)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      </>)}
      <div className="card">{annotations.panel}</div>
      {phase==='ok'&&result&&(<>

        {result.propertyReport&&<PropertyDetails report={result.propertyReport} days={result.daily} timeZone={result.range.timeZone} totalEvents={result.totals.events} tab={propertyTab} setTab={setPropertyTab} onFirst={()=>{const p=new URLSearchParams(applied);p.delete('propertyCursor');setApplied(p.toString());refresh();}} onNext={()=>{if(result.propertyReport?.nextCursor){const p=new URLSearchParams(applied);p.set('propertyCursor',result.propertyReport.nextCursor);setApplied(p.toString());}}}/>}
        {result.numeric&&(
          <div className="card stack">
            <h3>Property values</h3>
            <p className="hint dim">{result.numeric.samples} numeric {result.numeric.samples===1?'sample':'samples'} · exact decimal values</p>
            <div className="table-wrap" tabIndex={0} role="region" aria-label="Numeric property data, scroll horizontally for all columns">
              <table>
                <thead><tr><th>Sum</th><th>Average</th><th>Min</th><th>Max</th></tr></thead>
                <tbody><tr>
                  <td>{decimal(result.numeric.sum)}</td>
                  <td>{decimal(result.numeric.average)}</td>
                  <td>{decimal(result.numeric.min)}</td>
                  <td>{decimal(result.numeric.max)}</td>
                </tr></tbody>
              </table>
            </div>
          </div>
        )}
      </>)}
    </section>
  );
}
