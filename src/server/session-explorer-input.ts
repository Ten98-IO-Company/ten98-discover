import {z} from 'zod';
import {canonicalHash,cleanText} from './context-input.ts';
import {explorerFilters,explorerQuery} from './explorer-input.ts';
import {InputError} from './validation.ts';
import type {NormalizedDimensions,NormalizedProperties,NormalizedProperty} from './analytics-input.ts';
import type {environmentCatalog,environmentVersion} from '../lib/analytics-environment.ts';
import type {AdvancedPredicates} from './advanced-predicate-input.ts';
import type {advancedPredicateMethod} from './advanced-predicates.ts';
import type {CohortReport,SessionPropertyScope} from './explorer.ts';
import type {retentionCoverage} from './retention.ts';

export type SessionPopulationQuery={from:string;to:string;timeZone:string;kind:'all'|'pageviews'|'custom';
  filters:Partial<Record<typeof explorerFilters[number],string>>;
  property:({key:string}&(NormalizedProperty|{type:'missing';value:null}))|null;
  cohort?:{id:string;revision:number};predicates?:AdvancedPredicates};
export type CanonicalSessionListQuery=SessionPopulationQuery&{visitorKey:string|null};
export type SessionListInput={query:CanonicalSessionListQuery;pageSize:number;cursor:Extract<SessionCursor,{route:'list'}>|null};
export type SessionActivityInput={visitorKey:string;from:string;to:string;timeZone:string;pageSize:number;cursor:Extract<SessionCursor,{route:'activity'}>|null};
export type LinkedActivityInput=Omit<SessionActivityInput,'cursor'>&{cursor:Extract<SessionCursor,{route:'linked-activity'}>|null};
export type StoredSessionDimensions=Omit<NormalizedDimensions,'distinctId'>&{origin?:string;environmentVersion?:typeof environmentVersion;browser?:typeof environmentCatalog.browser[number];os?:typeof environmentCatalog.os[number];device?:typeof environmentCatalog.device[number]};
export type SessionSelection={status:'available';reason:null;countsAreLowerBounds:boolean}|{status:'unavailable';
  reason:'event_history_unavailable'|'identity_unavailable'|'cohort_membership_unavailable'|'session_property_selection_unavailable';countsAreLowerBounds:false};
export type SessionRetention={policy:{revision:number;rawAnalyticsDays:number};eventRetainedFrom:string|null;
  profileEvidenceLostAt:string|null;profileEvidenceLost:boolean;fingerprint:string};
export type SessionReadMeta={method:'observed-visitor-session-explorer-v1';asOf:string;
  range:{from:string;to:string;timeZone:string;start:string;end:string};coverage:ReturnType<typeof retentionCoverage>;
  identity:{unit:'rotating-visitor-key';identifiedEvents:number|null;unidentifiedEvents:number|null;limitation:string};
  selection:SessionSelection;retention:SessionRetention;predicateMethod?:ReturnType<typeof advancedPredicateMethod>;
  cohort?:CohortReport;sessionProperties?:SessionPropertyScope;
  paging:{mode:'current-page-with-fixed-event-bound';eventBefore:string;consistency:'current-per-page';nextCursor:string|null;limit:number;retentionEvidenceChanged:boolean}};
export type SessionRow={visitorKey:string;firstAt:string;lastAt:string;events:number;pageViews:number;customEvents:number;visits:number};
export type SessionList=SessionReadMeta&{query:CanonicalSessionListQuery;rows:SessionRow[]|null;totalKeys:number|null};
export type CurrentPropertyEvidence={method:'current-retained-session-properties-v1';asOf:string;retainedFrom:string;
  evidence:{lost:boolean;lostAt:string|null;expiredValuesPresent:boolean};values:{key:string;property:NormalizedProperty;updatedAt:string}[];
  absence:'unobserved-without-known-loss'|'unknown-after-evidence-loss';limitation:string};
export type SessionDetail=SessionReadMeta&{visitorKey:string;activityScope:'all-key-activity-in-selected-dates';
  summary:{events:number|null;pageViews:number|null;customEvents:number|null;visits:number|null;firstAt:string|null;lastAt:string|null;
    observedVisitSpanSeconds:string|null;meanObservedVisitSpanSeconds:string|null};
  activity:{id:string;receivedAt:string;visitKey:string;kind:'pageview'|'custom';eventName:string;path:string;origin:string;
    properties:NormalizedProperties;dimensions:StoredSessionDimensions;source:'legacy'|'browser'|'api';metricVersion:string}[]|null;
  currentProperties:CurrentPropertyEvidence;linkedIdentities:{status:'lookup-available';action:'open-linked-activity';limitation:string}|
    {status:'unavailable';reason:'link_evidence_unavailable';limitation:string}};
export type LinkedActivity={projectId:string;baseVisitorKey:string;method:'explicit-identified-activity-v1';asOf:string;range:SessionReadMeta['range'];
  selection:{status:'available';reason:null;reference:{version:1;keyGeneration:string;token:string};scope:'direct-marked-events-in-selected-dates'}|
    {status:'unavailable';reason:'link_evidence_unavailable'|'explicit_event_evidence_unavailable'|'event_history_unavailable'};
  summary:{events:number;pageViews:number;customEvents:number;observedKeys:number;visits:number;firstAt:string|null;lastAt:string|null;
    observedVisitSpanSeconds:string|null;meanObservedVisitSpanSeconds:string|null}|null;
  activity:(NonNullable<SessionDetail['activity']>[number]&{source:'browser';visitorKey:string;identityEvidenceVersion:1})[]|null;
  coverage:{status:'partial'|'unavailable';eventRetainedFrom:string;linkRetainedFrom:string;eventEvidenceStartedAt:string|null;
    linksStartedAt:string|null;linkEvidenceLostAt:string|null;linkingEnabled:boolean;unprovenEventsExcluded:number;
    legacyEvidence:'not_backfilled';historyComplete:false;historyScope:'retained_direct_explicit_observations_only';
    warnings:('legacy_evidence_excluded'|'retained_range_clipped'|'project_link_evidence_lost'|'new_linking_disabled'|'evidence_changed')[]};
  paging:SessionReadMeta['paging']};

function bad(message='Check the session dates, filters and page cursor.'):never{throw new InputError(400,message);}
const hex=z.string().regex(/^[a-f0-9]{64}$/).refine(value=>value.length===64);
const uuid=z.uuid().refine(value=>value===value.toLowerCase());
// Keep six fractional digits as text: Date would discard the cursor's microseconds.
const instant=z.iso.datetime({precision:6}).refine(value=>!value.startsWith('0000-')&&value.endsWith('Z'));
const cursorFields={version:z.literal(1),projectId:uuid,scope:hex,pageSize:z.number().int().min(1).max(100),eventBefore:instant,
  retention:z.object({policyHash:hex,initialEvidenceHash:hex}).strict()};
const cursorInput=z.discriminatedUnion('route',[
  z.object({...cursorFields,route:z.literal('list'),last:z.object({at:instant,visitorKey:hex}).strict()}).strict(),
  z.object({...cursorFields,route:z.literal('activity'),visitorKey:hex,last:z.object({at:instant,id:uuid}).strict()}).strict(),
  z.object({...cursorFields,route:z.literal('linked-activity'),visitorKey:hex,anchor:hex,last:z.object({at:instant,id:uuid}).strict()}).strict(),
]);
export type SessionCursor=z.infer<typeof cursorInput>;

function cursorObject(raw:unknown):SessionCursor{
  const parsed=cursorInput.safeParse(raw);
  if(!parsed.success||parsed.data.last.at>=parsed.data.eventBefore)bad();
  return parsed.data;
}
export function encodeSessionCursor(cursor:SessionCursor):string{
  const encoded=Buffer.from(JSON.stringify(cursorObject(cursor))).toString('base64url');
  if(encoded.length>2048)bad();return encoded;
}
export function parseSessionCursor(value:string):SessionCursor{
  if(value.length>2048||!value||!/^[A-Za-z0-9_-]+$/.test(value))bad();
  try{
    const bytes=Buffer.from(value,'base64url');if(bytes.toString('base64url')!==value)bad();
    const json=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);
    const cursor=cursorObject(JSON.parse(json));
    if(JSON.stringify(cursor)!==json)bad();
    return cursor;
  }catch{return bad();}
}

const calendarKeys=['from','to','timeZone'] as const;
const listKeys=new Set([...calendarKeys,'kind',...explorerFilters,'propertyKey','propertyType','propertyValue','predicates','cohortId','cohortRevision','visitorKey','pageSize','cursor']);
const activityKeys=new Set([...calendarKeys,'pageSize','cursor']);
function parameters(params:URLSearchParams,allowed:Set<string>,defaultSize:number){
  for(const key of params.keys())if(!allowed.has(key)||params.getAll(key).length!==1)bad('Use each supported session parameter only once.');
  if(!calendarKeys.every(key=>params.has(key)))bad('Choose explicit session dates and a timezone.');
  const raw=params.get('pageSize'),pageSize=raw===null?defaultSize:Number(raw);
  if(!Number.isInteger(pageSize)||pageSize<1||pageSize>100||raw!==null&&String(pageSize)!==raw)bad();
  const cursor=params.has('cursor')?parseSessionCursor(params.get('cursor')!):null;
  const population=new URLSearchParams(params);population.delete('pageSize');population.delete('cursor');population.delete('visitorKey');
  return {pageSize,cursor,population};
}
function populationParams(query:SessionPopulationQuery):URLSearchParams{
  const params=new URLSearchParams({from:query.from,to:query.to,timeZone:query.timeZone,kind:query.kind});
  for(const key of explorerFilters)if(Object.hasOwn(query.filters,key))params.set(key,query.filters[key]!);
  if(query.property){params.set('propertyKey',query.property.key);params.set('propertyType',query.property.type);
    if(query.property.type!=='missing')params.set('propertyValue',JSON.stringify(query.property.value));}
  if(query.predicates)params.set('predicates',JSON.stringify(query.predicates));
  if(query.cohort){params.set('cohortId',query.cohort.id);params.set('cohortRevision',String(query.cohort.revision));}
  return params;
}
export function canonicalSessionListQuery(query:CanonicalSessionListQuery):string{
  const params=populationParams(query);if(query.visitorKey!==null)params.set('visitorKey',query.visitorKey);
  return params.toString();
}
export function sessionListQuery(params:URLSearchParams,now=new Date()):SessionListInput{
  const {pageSize,cursor,population}=parameters(params,listKeys,25);
  if(cursor&&cursor.route!=='list')bad();
  const rawKey=params.get('visitorKey');if(rawKey!==null&&!hex.safeParse(rawKey).success)bad();
  const {groupBy:_,groupProperty:__,...parsed}=explorerQuery(population,now);
  const query:CanonicalSessionListQuery={...parsed,kind:parsed.kind as SessionPopulationQuery['kind'],
    property:parsed.property as SessionPopulationQuery['property'],visitorKey:rawKey,
    ...(parsed.cohort?{cohort:{...parsed.cohort,id:parsed.cohort.id.toLowerCase()}}:{})};
  const canonical=canonicalSessionListQuery(query);
  if(canonical.length>20000||!cleanText(canonical))bad('The session query is too large.');
  return {query,pageSize,cursor};
}
export function sessionActivityQuery(visitorKey:string,params:URLSearchParams,now=new Date()):SessionActivityInput{
  if(!hex.safeParse(visitorKey).success)bad();
  const {pageSize,cursor,population}=parameters(params,activityKeys,50);
  if(cursor&&cursor.route!=='activity')bad();
  const {from,to,timeZone}=explorerQuery(population,now);
  return {visitorKey,from,to,timeZone,pageSize,cursor};
}
export function linkedActivityQuery(visitorKey:string,params:URLSearchParams,now=new Date()):LinkedActivityInput{
  if(!hex.safeParse(visitorKey).success)bad();
  const {pageSize,cursor,population}=parameters(params,activityKeys,50);
  if(cursor&&cursor.route!=='linked-activity')bad();
  const {from,to,timeZone}=explorerQuery(population,now);
  return {visitorKey,from,to,timeZone,pageSize,cursor};
}
export function linkedActivityScope(projectId:string,input:LinkedActivityInput,anchor:string):string{
  if(!uuid.safeParse(projectId).success||!hex.safeParse(anchor).success)bad();
  return canonicalHash(['linked-activity-scope-v1',projectId,input.visitorKey,input.from,input.to,input.timeZone,input.pageSize,anchor]);
}
// Scope checks, current authorization, policy hashes and eventBefore<=asOf belong to the gated service.
export function sessionCursorScope(projectId:string,input:SessionListInput|SessionActivityInput):string{
  if(!uuid.safeParse(projectId).success)bad();
  const list='query'in input,query=list?populationParams(input.query).toString():new URLSearchParams({from:input.from,to:input.to,timeZone:input.timeZone}).toString();
  return canonicalHash(['session-explorer-scope-v1',list?'list':'activity',projectId,query,list?input.query.visitorKey:input.visitorKey,input.pageSize]);
}
