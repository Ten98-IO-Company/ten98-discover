import {z} from 'zod';
import type {SessionList,SessionDetail} from '../server/session-explorer-input';
import {buildParams,buildAdvanced,validAdvancedResult,validSessionSelection,validCohort,qualificationDraft,preciseDate,clean,FILTERS,type Draft,type CohortRef} from '../components/ExplorerFilters';

const text=(max:number)=>z.string().max(max).refine(value=>clean(value,max));
const count=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),key=z.string().length(64).regex(/^[a-f0-9]{64}$/),uuid=z.string().uuid();
const stamp=z.string().refine(value=>/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value);
const instant=z.string().refine(value=>/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3,6}Z$/.test(value)&&preciseDate(value)===value);
const scalar=z.union([text(1000),z.number().finite().min(-1e15).max(1e15),z.boolean(),z.null()]);
const property=z.discriminatedUnion('type',[
  z.object({type:z.literal('string'),value:text(1000)}).strict(),z.object({type:z.literal('number'),value:z.number().finite().min(-1e15).max(1e15)}).strict(),
  z.object({type:z.literal('boolean'),value:z.boolean()}).strict(),z.object({type:z.literal('null'),value:z.null()}).strict(),
  z.object({type:z.literal('date'),value:text(1000).refine(value=>preciseDate(value)===value)}).strict(),
  z.object({type:z.literal('array'),value:z.array(scalar).max(50).refine(value=>new TextEncoder().encode(JSON.stringify(value)).length<=4096)}).strict(),
]);
const properties=z.record(text(320).min(1),property).refine(value=>Object.keys(value).length<=50);
const range=z.object({from:text(10),to:text(10),timeZone:text(80),start:stamp,end:stamp}).strict();
const coverage=z.object({status:z.enum(['complete','partial','unavailable']),retainedFrom:stamp.nullable()}).strict();
const evidence=z.object({lost:z.boolean(),lostAt:stamp.nullable(),expiredValuesPresent:z.boolean()}).strict().refine(value=>value.lost===(value.lostAt!==null||value.expiredValuesPresent));
const ref=z.object({id:uuid,revision:count.positive().max(2147483647)}).strict();
const queryProperty=z.object({key:text(320).min(1),type:text(20),value:z.unknown()}).strict().refine(value=>value.type==='missing'?value.value===null:property.safeParse({type:value.type,value:value.value}).success);
const query=z.object({from:text(10),to:text(10),timeZone:text(80),kind:z.enum(['all','pageviews','custom']),filters:z.partialRecord(z.enum(FILTERS.map(([name])=>name)),text(2048)),property:queryProperty.nullable(),visitorKey:key.nullable(),cohort:ref.optional(),predicates:z.unknown().optional()}).strict();
const sessionScope=z.object({method:z.literal('current-retained-session-properties-v1'),asOf:stamp,retainedFrom:stamp,evidence,candidates:z.object({identifiedEvents:count.nullable(),unidentifiedEvents:count.nullable()}).strict(),selection:z.object({status:z.enum(['available','unavailable']),countsAreLowerBounds:z.boolean(),reason:z.enum(['missing_evidence_lost','identity_unavailable','candidate_scope_unavailable']).nullable()}).strict(),limitation:text(2000)}).strict();
const method=z.object({version:z.literal('native-flat-predicates-v1'),requiredFilters:z.literal('all'),fieldMatch:z.enum(['all','any']),propertyMatch:z.literal('all'),textSearch:z.literal('postgresql-lower-literal'),regex:z.literal('postgresql-case-insensitive'),dateComparison:z.literal('calendar-day-in-scope-timezone'),sessionPropertyMatch:z.literal('all').optional(),sessionPropertyValues:z.literal('current-retained-at-report-snapshot').optional()}).strict();
const cohort=z.object({item:z.object({id:uuid,projectId:uuid,revision:count.positive(),definition:z.object({schemaVersion:z.literal(1),name:text(200),query:text(20000)}).strict(),createdAt:stamp,updatedAt:stamp}).strict(),range,coverage,identity:z.object({status:z.enum(['complete','partial','unavailable']),identifiedEvents:count.nullable(),unidentifiedEvents:count.nullable(),observedMemberKeys:count.nullable()}).strict(),membership:z.object({status:z.enum(['available','unavailable']),countsAreLowerBounds:z.boolean()}).strict(),limitation:text(2000),predicateMethod:method.optional(),sessionProperties:sessionScope.optional()}).strict();
const selection=z.discriminatedUnion('status',[z.object({status:z.literal('available'),reason:z.null(),countsAreLowerBounds:z.boolean()}).strict(),z.object({status:z.literal('unavailable'),reason:z.enum(['event_history_unavailable','identity_unavailable','cohort_membership_unavailable','session_property_selection_unavailable']),countsAreLowerBounds:z.literal(false)}).strict()]);
const base={method:z.literal('observed-visitor-session-explorer-v1'),asOf:stamp,range,coverage,identity:z.object({unit:z.literal('rotating-visitor-key'),identifiedEvents:count.nullable(),unidentifiedEvents:count.nullable(),limitation:text(2000)}).strict(),selection,retention:z.object({policy:z.object({revision:count.positive(),rawAnalyticsDays:count.positive()}).strict(),eventRetainedFrom:stamp.nullable(),profileEvidenceLostAt:stamp.nullable(),profileEvidenceLost:z.boolean(),fingerprint:key}).strict(),predicateMethod:method.optional(),cohort:cohort.optional(),sessionProperties:sessionScope.optional(),paging:z.object({mode:z.literal('current-page-with-fixed-event-bound'),eventBefore:instant,consistency:z.literal('current-per-page'),nextCursor:text(2048).min(1).nullable(),limit:count.positive().max(100),retentionEvidenceChanged:z.boolean()}).strict()};
const list=z.object({...base,query,rows:z.array(z.object({visitorKey:key,firstAt:stamp,lastAt:stamp,events:count,pageViews:count,customEvents:count,visits:count}).strict()).max(100).nullable(),totalKeys:count.nullable()}).strict();
const currentProperties=z.object({method:z.literal('current-retained-session-properties-v1'),asOf:stamp,retainedFrom:stamp,evidence,values:z.array(z.object({key:text(320).min(1),property,updatedAt:stamp}).strict()).max(50),absence:z.enum(['unobserved-without-known-loss','unknown-after-evidence-loss']),limitation:text(2000)}).strict();
const dimensions=z.object({origin:text(2048).optional(),referrerHost:text(320).optional(),language:text(320).optional(),screenWidth:count.optional(),screenHeight:count.optional(),campaign:z.object({source:text(320).optional(),medium:text(320).optional(),campaign:text(320).optional(),term:text(320).optional(),content:text(320).optional()}).strict().optional()}).strict();
const duration=z.string().regex(/^\d+(?:\.\d+)?$/).nullable();
const detail=z.object({...base,visitorKey:key,activityScope:z.literal('all-key-activity-in-selected-dates'),summary:z.object({events:count.nullable(),pageViews:count.nullable(),customEvents:count.nullable(),visits:count.nullable(),firstAt:stamp.nullable(),lastAt:stamp.nullable(),observedVisitSpanSeconds:duration,meanObservedVisitSpanSeconds:duration}).strict(),activity:z.array(z.object({id:uuid,receivedAt:stamp,visitKey:key,kind:z.enum(['pageview','custom']),eventName:text(320),path:text(2048),origin:text(2048),properties,dimensions,source:z.enum(['legacy','browser','api']),metricVersion:text(2000)}).strict()).max(100).nullable(),currentProperties,linkedIdentities:z.object({status:z.literal('unavailable'),reason:z.literal('link-evidence-not-stored'),limitation:text(2000)}).strict()}).strict();

export function sessionParams(draft:Draft,cohort:CohortRef|null,visitorKey=''){
  const built=buildParams({...draft,groupBy:'event',groupProperty:''});if('error'in built)return built;
  const params=new URLSearchParams(built.qs);params.delete('groupBy');params.delete('groupProperty');
  try{params.set('timeZone',new Intl.DateTimeFormat('en-US',{timeZone:draft.timeZone.trim()}).resolvedOptions().timeZone);}catch{return {error:'Choose a supported IANA time zone.'};}
  if(cohort){params.set('cohortId',cohort.id);params.set('cohortRevision',String(cohort.revision));}
  if(visitorKey){if(!key.safeParse(visitorKey).success)return {error:'Enter a complete observed visitor key.'};params.set('visitorKey',visitorKey);}
  return {params};
}
function equal(a:unknown,b:unknown):boolean{
  if(a===b)return true;if(!a||!b||typeof a!=='object'||typeof b!=='object')return false;
  if(Array.isArray(a)||Array.isArray(b))return Array.isArray(a)&&Array.isArray(b)&&a.length===b.length&&a.every((value,index)=>equal(value,b[index]));
  const x=a as Record<string,unknown>,y=b as Record<string,unknown>;return Object.keys(x).length===Object.keys(y).length&&Object.keys(x).every(key=>Object.hasOwn(y,key)&&equal(x[key],y[key]));
}
export function readSessionResponse(value:unknown,params:URLSearchParams,projectId:string,visitorKey?:string):SessionList|SessionDetail{
  const parsed=(visitorKey?detail:list).safeParse(value);const fail=():never=>{throw new Error('The session response could not be confirmed. Retry this request.');};if(!parsed.success)return fail();
  const v=parsed.data;let zone:string;try{zone=new Intl.DateTimeFormat('en-US',{timeZone:params.get('timeZone')!}).resolvedOptions().timeZone;}catch{return fail();}
  if(v.range.from!==params.get('from')||v.range.to!==params.get('to')||v.range.timeZone!==zone||v.range.start>v.range.end||v.paging.limit!==Number(params.get('pageSize')??(visitorKey?50:25)))return fail();
  if(v.selection.status==='unavailable'&&v.paging.nextCursor!==null)return fail();
  if(v.coverage.status==='unavailable'&&(v.selection.status!=='unavailable'||v.selection.reason!=='event_history_unavailable'))return fail();
  if(v.sessionProperties?.selection.status==='unavailable'&&v.selection.status!=='unavailable')return fail();
  if(v.retention.profileEvidenceLostAt!==null&&!v.retention.profileEvidenceLost)return fail();
  if(visitorKey){
    if(!('activity'in v)||v.visitorKey!==visitorKey||v.predicateMethod||v.cohort||v.sessionProperties||v.currentProperties.asOf!==v.asOf)return fail();
    const p=v.currentProperties;if((p.absence==='unknown-after-evidence-loss')!==p.evidence.lost||new Set(p.values.map(row=>row.key)).size!==p.values.length||p.values.some(row=>row.updatedAt<p.retainedFrom||row.updatedAt>v.asOf))return fail();
    if(v.selection.status==='unavailable'){if(v.selection.reason!=='event_history_unavailable'||v.activity!==null||Object.values(v.summary).some(item=>item!==null))return fail();}
    else if(!v.activity||v.activity.length>v.paging.limit||[v.summary.events,v.summary.pageViews,v.summary.customEvents,v.summary.visits].some(item=>item===null)||v.summary.events!==(v.summary.pageViews!+v.summary.customEvents!))return fail();
    if(v.activity&&new Set(v.activity.map(row=>row.id)).size!==v.activity.length)return fail();
  }else{
    if(!('rows'in v))return fail();const q=v.query;
    const expectedPredicates=params.has('predicates')?JSON.parse(params.get('predicates')!):undefined;
    if(!validAdvancedResult(q.predicates,v.predicateMethod,expectedPredicates)||!validSessionSelection(v.sessionProperties,expectedPredicates)||v.sessionProperties&&v.sessionProperties.asOf!==v.asOf)return fail();
    const expectedFilters=Object.fromEntries(FILTERS.filter(([name])=>params.has(name)).map(([name])=>[name,params.get(name)!]));
    let expectedProperty:unknown=null;if(params.has('propertyKey')){const type=params.get('propertyType');let value=type==='missing'?null:JSON.parse(params.get('propertyValue')!);if(type==='date')value=preciseDate(value);expectedProperty={key:params.get('propertyKey'),type,value};}
    if(q.from!==v.range.from||q.to!==v.range.to||q.timeZone!==zone||q.kind!==(params.get('kind')??'all')||q.visitorKey!==(params.get('visitorKey')??null)||!equal(q.filters,expectedFilters)||!equal(q.property,expectedProperty))return fail();
    if(params.has('cohortId')){
      const c=v.cohort;if(!c||!validCohort(c.item,projectId)||c.item.id!==params.get('cohortId')||c.item.revision!==Number(params.get('cohortRevision'))||!equal(q.cohort,{id:c.item.id,revision:c.item.revision}))return fail();
      const draft=qualificationDraft(c.item.definition.query)!,built=buildAdvanced(draft.advanced);if('error'in built||!validAdvancedResult(built.predicates,c.predicateMethod,built.predicates)||!validSessionSelection(c.sessionProperties,built.predicates)||c.range.from!==draft.from||c.range.to!==draft.to||c.range.timeZone!==draft.timeZone||c.sessionProperties&&c.sessionProperties.asOf!==v.asOf)return fail();
      if(c.membership.status==='unavailable'&&v.selection.status!=='unavailable')return fail();
    }else if(v.cohort||q.cohort)return fail();
    if(v.selection.status==='unavailable'){if(v.rows!==null||v.totalKeys!==null)return fail();}
    else if(!v.rows||v.totalKeys===null||v.rows.length>v.paging.limit||v.rows.length>v.totalKeys||new Set(v.rows.map(row=>row.visitorKey)).size!==v.rows.length||v.rows.some(row=>row.events<1||row.events!==row.pageViews+row.customEvents||row.visits<1||row.firstAt>row.lastAt))return fail();
    if(v.sessionProperties?.selection.status==='unavailable'&&v.selection.status!=='unavailable')return fail();
  }
  return v as SessionList|SessionDetail;
}
