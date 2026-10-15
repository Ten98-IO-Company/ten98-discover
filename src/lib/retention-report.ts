import {z} from 'zod';
import type {SessionPopulationQuery} from '../server/session-explorer-input.ts';
import type {CohortReport,SessionPropertyScope} from '../server/analytics-population.ts';

export const retentionOffsets=[1,2,3,4,5,6,7,14,21,28] as const;
export const retentionReportVersion='observed-key-cohort-returns-v1';
export const retentionLimits={query:20000,json:512*1024,csv:256*1024} as const;
export const retentionLimitation='Cohorts count observed project-scoped rotating visitor keys, not new users or persistent people. Keys rotate each UTC month and when identity inputs or the signing secret change; cookieless and consented keys stay separate. A local month can cross a UTC rotation. Explicit identity links do not merge these cohorts. Entry filters select the first retained matching activity in this month; returns count any activity on the exact later local date within the same month.';
export type RetentionQuery=Omit<SessionPopulationQuery,'from'|'to'>&{month:string};
type Coverage='complete'|'partial'|'unavailable';
type Calendar='complete'|'in-progress'|'not-started'|'skipped';
type Reason=null|'history-unavailable'|'identity-unavailable'|'cohort-unavailable'|'session-property-unavailable';
export type RetentionSelection={status:'available'|'unavailable';reason:Reason;assignment:'complete'|'retained-only'|'unavailable'};
export type RetentionCell={offset:number;date:string;calendar:Calendar|'outside-month';coverage:Coverage|null;status:'available'|'provisional'|'empty-cohort'|'not-started'|'skipped'|'outside-month'|'history-unavailable'|'assignment-incomplete'|'identity-unavailable'|'selection-unavailable';returnedKeys:number|null;denominator:number|null;percentage:number|null};
export type RetentionRow={date:string;start:string;end:string;skipped:boolean;calendar:Calendar;coverage:Coverage;matchingEvents:number|null;keyedEvents:number|null;unkeyedEvents:number|null;cohortKeys:number|null;cells:RetentionCell[]};
export type RetentionReport={version:typeof retentionReportVersion;projectId:string;role:'owner'|'admin'|'editor'|'viewer';asOf:string;query:RetentionQuery;
  range:{from:string;to:string;start:string;end:string;observedEnd:string};offsets:typeof retentionOffsets;
  coverage:{status:Coverage;retainedFrom:string|null};selection:RetentionSelection;
  identity:{unit:'rotating-visitor-key';entryEvents:number|null;keyedEntryEvents:number|null;unkeyedEntryEvents:number|null;observedKeys:number|null;returnScopeEvents:number|null;unkeyedReturnScopeEvents:number|null};
  rows:RetentionRow[];cohort?:CohortReport;sessionProperties?:SessionPropertyScope;
  geographyProvenance?:{source:'db-ip-city-lite';scope:'matching-entry-events';databaseCount:number|null;oldestDatabaseBuild:number|null;newestDatabaseBuild:number|null};csv:string};

export function retentionCalendar(start:string,end:string,asOf:string):Calendar{return start===end?'skipped':Date.parse(start)>=Date.parse(asOf)?'not-started':Date.parse(end)>Date.parse(asOf)?'in-progress':'complete';}
export function retentionCell(row:Pick<RetentionRow,'date'|'cohortKeys'|'calendar'|'coverage'>,offset:number,target:{start:string;end:string;coverage:Coverage}|undefined,asOf:string,selection:RetentionSelection,returned:number):RetentionCell{
  const date=new Date(Date.parse(row.date+'T00:00:00Z')+offset*86400000).toISOString().slice(0,10),calendar=target?retentionCalendar(target.start,target.end,asOf):'outside-month';
  const base:Pick<RetentionCell,'offset'|'date'|'calendar'|'coverage'>={offset,date,calendar,coverage:target?.coverage??null};
  const none=(status:RetentionCell['status']):RetentionCell=>({...base,status,returnedKeys:null,denominator:null,percentage:null});
  if(calendar==='outside-month'||calendar==='skipped'||calendar==='not-started')return none(calendar);
  if(row.calendar==='skipped')return none('skipped');
  if(row.coverage==='unavailable'||selection.reason==='history-unavailable'||target!.coverage==='unavailable')return none('history-unavailable');
  if(selection.reason&&selection.reason!=='identity-unavailable')return none('selection-unavailable');
  if(row.cohortKeys===null)return none('identity-unavailable');
  if(selection.assignment==='retained-only'||target!.coverage==='partial')return {...base,status:'assignment-incomplete',returnedKeys:returned,denominator:row.cohortKeys,percentage:null};
  if(row.cohortKeys===0)return {...base,status:'empty-cohort',returnedKeys:0,denominator:0,percentage:null};
  return {...base,status:calendar==='in-progress'?'provisional':'available',returnedKeys:returned,denominator:row.cohortKeys,percentage:100*returned/row.cohortKeys};
}

const text=(max:number)=>z.string().max(max).refine(value=>!value.includes('\0')&&!/[\uD800-\uDFFF]/u.test(value));
const count=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),stamp=z.iso.datetime({offset:false}),day=z.iso.date(),coverage=z.enum(['complete','partial','unavailable']);
const fields=['eventName','path','origin','referrer','language','browser','os','device','country','region','city','campaignSource','campaignMedium','campaignName','campaignTerm','campaignContent'] as const;
const property=z.object({key:text(320).min(1),type:z.enum(['string','number','boolean','null','date','array','missing']),value:z.unknown()}).strict();
const query=z.object({month:z.string().regex(/^\d{4}-(?:0[1-9]|1[0-2])$/),timeZone:text(80),kind:z.enum(['all','pageviews','custom']),filters:z.partialRecord(z.enum(fields),text(2048)),property:property.nullable(),predicates:z.unknown().optional(),cohort:z.object({id:z.uuid(),revision:count.positive().max(2147483647)}).strict().optional()}).strict();
const evidence=z.object({lost:z.boolean(),lostAt:stamp.nullable(),expiredValuesPresent:z.boolean()}).strict();
const session=z.object({method:z.literal('current-retained-session-properties-v1'),asOf:stamp,retainedFrom:stamp,evidence,candidates:z.object({identifiedEvents:count.nullable(),unidentifiedEvents:count.nullable()}).strict(),selection:z.object({status:z.enum(['available','unavailable']),countsAreLowerBounds:z.boolean(),reason:z.enum(['missing_evidence_lost','identity_unavailable','candidate_scope_unavailable']).nullable()}).strict(),limitation:text(2000)}).strict();
const retained=z.object({status:coverage,retainedFrom:stamp.nullable()}).strict(),range=z.object({from:day,to:day,timeZone:text(80),start:stamp,end:stamp}).strict();
const method=z.object({version:z.literal('native-flat-predicates-v1'),requiredFilters:z.literal('all'),fieldMatch:z.enum(['all','any']),propertyMatch:z.literal('all'),textSearch:z.literal('postgresql-lower-literal'),regex:z.literal('postgresql-case-insensitive'),dateComparison:z.literal('calendar-day-in-scope-timezone'),sessionPropertyMatch:z.literal('all').optional(),sessionPropertyValues:z.literal('current-retained-at-report-snapshot').optional()}).strict();
const cohort=z.object({item:z.object({id:z.uuid(),projectId:z.uuid(),revision:count.positive(),definition:z.object({schemaVersion:z.literal(1),name:text(200),query:text(20000)}).strict(),createdAt:stamp,updatedAt:stamp}).strict(),range,coverage:retained,identity:z.object({status:coverage,identifiedEvents:count.nullable(),unidentifiedEvents:count.nullable(),observedMemberKeys:count.nullable()}).strict(),membership:z.object({status:z.enum(['available','unavailable']),countsAreLowerBounds:z.boolean()}).strict(),limitation:text(2000),predicateMethod:method.optional(),sessionProperties:session.optional()}).strict();
const cell=z.object({offset:count,date:day,calendar:z.enum(['complete','in-progress','not-started','skipped','outside-month']),coverage:coverage.nullable(),status:z.enum(['available','provisional','empty-cohort','not-started','skipped','outside-month','history-unavailable','assignment-incomplete','identity-unavailable','selection-unavailable']),returnedKeys:count.nullable(),denominator:count.nullable(),percentage:z.number().finite().min(0).max(100).nullable()}).strict();
const row=z.object({date:day,start:stamp,end:stamp,skipped:z.boolean(),calendar:z.enum(['complete','in-progress','not-started','skipped']),coverage,matchingEvents:count.nullable(),keyedEvents:count.nullable(),unkeyedEvents:count.nullable(),cohortKeys:count.nullable(),cells:z.array(cell).length(10)}).strict();
const schema=z.object({version:z.literal(retentionReportVersion),projectId:z.uuid(),role:z.enum(['owner','admin','editor','viewer']),asOf:stamp,query,range:z.object({from:day,to:day,start:stamp,end:stamp,observedEnd:stamp}).strict(),offsets:z.array(count).length(10),coverage:retained,selection:z.object({status:z.enum(['available','unavailable']),reason:z.enum(['history-unavailable','identity-unavailable','cohort-unavailable','session-property-unavailable']).nullable(),assignment:z.enum(['complete','retained-only','unavailable'])}).strict(),identity:z.object({unit:z.literal('rotating-visitor-key'),entryEvents:count.nullable(),keyedEntryEvents:count.nullable(),unkeyedEntryEvents:count.nullable(),observedKeys:count.nullable(),returnScopeEvents:count.nullable(),unkeyedReturnScopeEvents:count.nullable()}).strict(),rows:z.array(row).min(28).max(31),cohort:cohort.optional(),sessionProperties:session.optional(),geographyProvenance:z.object({source:z.literal('db-ip-city-lite'),scope:z.literal('matching-entry-events'),databaseCount:count.nullable(),oldestDatabaseBuild:count.nullable(),newestDatabaseBuild:count.nullable()}).strict().optional(),csv:text(retentionLimits.csv)}).strict();

export function readRetentionReport(value:unknown,expected:RetentionQuery,projectId:string):RetentionReport{
  const fail=():never=>{throw new Error('The retention report could not be verified. Reload this report.');};
  const parsed=schema.safeParse(value);if(!parsed.success)return fail();const v=parsed.data as unknown as RetentionReport;
  if(new TextEncoder().encode(JSON.stringify(value)).length>retentionLimits.json||new TextEncoder().encode(v.csv).length>retentionLimits.csv||!v.csv.startsWith(`"Report","${retentionReportVersion}"\r\n`)||!v.csv.endsWith('\r\n')||(v.csv.match(/^"\d{4}-\d{2}-\d{2}",/gm)||[]).length!==v.rows.length*10||v.projectId!==projectId||JSON.stringify(v.query)!==JSON.stringify(expected)||v.range.from!==expected.month+'-01'||v.range.to!==new Date(Date.UTC(Number(expected.month.slice(0,4)),Number(expected.month.slice(5)),0)).toISOString().slice(0,10)||v.rows.length!==Number(v.range.to.slice(-2))||JSON.stringify(v.offsets)!==JSON.stringify(retentionOffsets)||Date.parse(v.range.start)>Date.parse(v.range.observedEnd)||Date.parse(v.range.observedEnd)!==Math.min(Date.parse(v.range.end),Date.parse(v.asOf)))return fail();
  const coverageAt=(start:string,end:string)=>v.coverage.retainedFrom===null||Date.parse(start)>=Date.parse(v.coverage.retainedFrom)?'complete':Date.parse(end)<=Date.parse(v.coverage.retainedFrom)?'unavailable':'partial';
  if(v.coverage.status!==coverageAt(v.range.start,v.range.end)||v.cohort&&(!expected.cohort||v.cohort.item.projectId!==projectId||v.cohort.item.id!==expected.cohort.id||v.cohort.item.revision!==expected.cohort.revision)||!!expected.cohort!==!!v.cohort||!!expected.predicates?.sessionProperties?.length!==!!v.sessionProperties)return fail();
  const reason:Reason=v.coverage.status==='unavailable'?'history-unavailable':v.cohort?.membership.status==='unavailable'?'cohort-unavailable':v.sessionProperties?.selection.status==='unavailable'?'session-property-unavailable':v.identity.entryEvents!==null&&v.identity.entryEvents>0&&v.identity.keyedEntryEvents===0?'identity-unavailable':null;
  const assignment=reason?'unavailable':v.coverage.status==='partial'||v.cohort?.coverage.status==='partial'||v.sessionProperties?.selection.countsAreLowerBounds||v.cohort?.membership.countsAreLowerBounds?'retained-only':'complete',suppressed=reason!==null&&reason!=='identity-unavailable';
  if(v.selection.reason!==reason||v.selection.status!==(reason?'unavailable':'available')||v.selection.assignment!==assignment)return fail();
  const identity=v.identity;if(identity.entryEvents!==null&&(identity.keyedEntryEvents===null||identity.unkeyedEntryEvents===null||identity.entryEvents!==identity.keyedEntryEvents+identity.unkeyedEntryEvents||identity.observedKeys!==null&&identity.observedKeys>identity.keyedEntryEvents)||identity.returnScopeEvents!==null&&(identity.unkeyedReturnScopeEvents===null||identity.unkeyedReturnScopeEvents>identity.returnScopeEvents))return fail();
  const measured=[identity.entryEvents,identity.keyedEntryEvents,identity.unkeyedEntryEvents,identity.returnScopeEvents,identity.unkeyedReturnScopeEvents];
  if(suppressed?(measured.some(n=>n!==null)||identity.observedKeys!==null):(measured.some(n=>n===null)||(reason==='identity-unavailable')!==(identity.observedKeys===null)||identity.entryEvents===0&&identity.observedKeys!==0))return fail();
  for(let i=0;i<v.rows.length;i++){
    const r=v.rows[i],date=expected.month+'-'+String(i+1).padStart(2,'0');
    if(r.date!==date||r.start>r.end||r.skipped!==(r.start===r.end)||r.calendar!==retentionCalendar(r.start,r.end,v.asOf)||r.coverage!==coverageAt(r.start,r.end)||i===0&&r.start!==v.range.start||i===v.rows.length-1&&r.end!==v.range.end||r.matchingEvents!==null&&(r.keyedEvents===null||r.unkeyedEvents===null||r.matchingEvents!==r.keyedEvents+r.unkeyedEvents||r.cohortKeys!==null&&r.cohortKeys>r.keyedEvents))return fail();
    const unknown=suppressed||r.coverage==='unavailable'||r.calendar==='skipped'||r.calendar==='not-started';
    if(unknown?[r.matchingEvents,r.keyedEvents,r.unkeyedEvents,r.cohortKeys].some(n=>n!==null):[r.matchingEvents,r.keyedEvents,r.unkeyedEvents].some(n=>n===null)||((r.matchingEvents!>0&&r.keyedEvents===0)!==(r.cohortKeys===null)))return fail();
    for(let n=0;n<retentionOffsets.length;n++){const c=r.cells[n],target=v.rows[i+retentionOffsets[n]],correct=retentionCell(r,retentionOffsets[n],target,v.asOf,v.selection,c.returnedKeys??0);if(JSON.stringify(c)!==JSON.stringify(correct)||c.denominator!==null&&c.returnedKeys!>c.denominator)return fail();}
  }
  if(identity.entryEvents!==null&&v.rows.reduce((n,r)=>n+(r.matchingEvents??0),0)!==identity.entryEvents||identity.observedKeys!==null&&v.rows.reduce((n,r)=>n+(r.cohortKeys??0),0)!==identity.observedKeys)return fail();
  return v;
}
