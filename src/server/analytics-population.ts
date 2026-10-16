import {analyticsCalendarSql,analyticsScopeSql,analyticsScopeValues,analyticsRevenuePeriodScopeSql,boardShareAnalyticsScopeSql,type BoardShareReadContext} from './analytics-scope.ts';
import {advancedPredicateSql,advancedPredicateMethod,sessionPredicateSql} from './advanced-predicates.ts';
import {retentionCoverage} from './retention.ts';
import type {explorerQuery} from './explorer-input.ts';
import type {CohortItem} from './cohorts.ts';

type Query=ReturnType<typeof explorerQuery>;
export type SessionContext={asOf:string;cutoff:string;lostAt:string|null;expiredValuesPresent:boolean};
export type SessionPropertyScope={method:'current-retained-session-properties-v1';asOf:string;retainedFrom:string;
  evidence:{lost:boolean;lostAt:string|null;expiredValuesPresent:boolean};candidates:{identifiedEvents:number|null;unidentifiedEvents:number|null};
  selection:{status:'available'|'unavailable';countsAreLowerBounds:boolean;reason:'missing_evidence_lost'|'identity_unavailable'|'candidate_scope_unavailable'|null};limitation:string};
export type CohortReport={item:CohortItem;range:{from:string;to:string;timeZone:string;start:string;end:string};coverage:ReturnType<typeof retentionCoverage>;
  identity:{status:'complete'|'partial'|'unavailable';identifiedEvents:number|null;unidentifiedEvents:number|null;observedMemberKeys:number|null};
  membership:{status:'available'|'unavailable';countsAreLowerBounds:boolean};limitation:string;predicateMethod?:ReturnType<typeof advancedPredicateMethod>;sessionProperties?:SessionPropertyScope};
type Candidates={identified:number;unidentified:number};
export type PopulationEvidence={retained_from:string|Date|null;session_context:SessionContext;
  qualification:{start:string;end:string;events:number;identified:number;members:number};qualification_candidates:Candidates};
const sessionLimitation='Conditions use current retained properties of the observed project-scoped rotating visitor key at this report snapshot, not historical values at event time. Keys rotate monthly and when identity inputs or the signing secret change; persistent-person continuity is unavailable. Missing means unobserved only when no property evidence loss is known.';
export function sessionScope(context:SessionContext,candidates:Candidates,missing:boolean,unavailable:boolean,partial:boolean):SessionPropertyScope{
  const lost=context.lostAt!==null||context.expiredValuesPresent;
  const reason=unavailable?'candidate_scope_unavailable':missing&&lost?'missing_evidence_lost':candidates.unidentified>0&&candidates.identified===0?'identity_unavailable':null;
  return {method:'current-retained-session-properties-v1',asOf:new Date(context.asOf).toISOString(),retainedFrom:new Date(context.cutoff).toISOString(),
    evidence:{lost,lostAt:context.lostAt===null?null:new Date(context.lostAt).toISOString(),expiredValuesPresent:context.expiredValuesPresent},
    candidates:{identifiedEvents:unavailable?null:candidates.identified,unidentifiedEvents:unavailable?null:candidates.unidentified},
    selection:{status:reason?'unavailable':'available',countsAreLowerBounds:!reason&&(lost||candidates.unidentified>0||partial),reason},limitation:sessionLimitation};
}
const cohortLimitation='Membership uses observed project-scoped visitor keys, not persistent people. Keys rotate each UTC month and when identity inputs or the signing secret change; continuity across those changes is unavailable. Identity coverage describes retained qualifying events only.';
export function cohortCoverage(item:CohortItem|null,qualification:Query|null,row:PopulationEvidence):CohortReport|undefined{
  if(!item||!qualification)return;
  const q=row.qualification,from=new Date(q.start).toISOString(),to=new Date(q.end).toISOString(),qualifiedCoverage=retentionCoverage(from,to,row.retained_from);
  const expired=qualifiedCoverage.status==='unavailable',unidentified=q.events-q.identified,unavailable=expired||(q.events>0&&q.identified===0);
  const cohort:CohortReport={item,range:{from:qualification.from,to:qualification.to,timeZone:qualification.timeZone,start:from,end:to},coverage:qualifiedCoverage,
    identity:{status:expired||(q.events>0&&q.identified===0)?'unavailable':unidentified>0?'partial':'complete',identifiedEvents:expired?null:q.identified,unidentifiedEvents:expired?null:unidentified,observedMemberKeys:expired?null:q.members},
    membership:{status:unavailable?'unavailable':'available',countsAreLowerBounds:!unavailable&&(qualifiedCoverage.status==='partial'||unidentified>0)},limitation:cohortLimitation,
    ...(qualification.predicates?{predicateMethod:advancedPredicateMethod(qualification.predicates)}:{})};
  if(qualification.predicates?.sessionProperties?.length){
    const sessionProperties=sessionScope(row.session_context,row.qualification_candidates,qualification.predicates.sessionProperties.some(filter=>filter.operator==='missing'),expired,qualifiedCoverage.status==='partial');
    const unavailable=sessionProperties.selection.status==='unavailable',unknown=row.qualification_candidates.unidentified>0;
    cohort.sessionProperties=sessionProperties;
    cohort.identity={status:unavailable?'unavailable':unknown?'partial':'complete',identifiedEvents:unavailable?null:q.identified,
      unidentifiedEvents:unavailable||unknown?null:0,observedMemberKeys:unavailable?null:q.members};
    cohort.membership={status:sessionProperties.selection.status,countsAreLowerBounds:sessionProperties.selection.countsAreLowerBounds};
  }
  return cohort;
}

// Trusted constants only: existing report slots1–12, qualification slots13–22.
const qualificationSql=analyticsScopeSql.replace(/\$(\d+)\b/g,(_,slot)=>`$${Number(slot)+12}`);
const qualificationCalendarSql=analyticsCalendarSql.replace(/\$(\d+)\b/g,(_,slot)=>`$${Number(slot)+12}`);
export type AnalyticsPopulation={ctes:string;values:unknown[];population:'scope'|'report_scope'|'filtered_report';sessionAware:boolean;
  reportCandidates:'report_candidates'|null;qualificationCandidates:'qualification_candidates'|null};
export function analyticsPopulation(projectId:string,userId:string,report:Query,qualification:Query|null,includeCurrentProperties:boolean,eventBefore?:string|null,mode?:'revenue-comparison',share?:BoardShareReadContext):AnalyticsPopulation{
  if(share&&(qualification||includeCurrentProperties||mode||report.cohort||report.predicates))throw new Error('Board sharing accepts only its exact approved native card scope.');
  const reportSession=!!report.predicates?.sessionProperties?.length,qualificationSession=!!qualification?.predicates?.sessionProperties?.length;
  const paged=eventBefore!==undefined,sessionAware=includeCurrentProperties||reportSession||qualificationSession||paged;
  const values=[...analyticsScopeValues(projectId,share?JSON.stringify(share):userId,report),report.groupBy,report.groupProperty,...(qualification?analyticsScopeValues(projectId,userId,qualification):[])];
  const bind=(value:unknown)=>{values.push(value);return `$${values.length}`;};
  let reportPredicate=advancedPredicateSql(report.predicates,bind,report.timeZone),qualificationPredicate=advancedPredicateSql(qualification?.predicates,bind,qualification?.timeZone??report.timeZone);
  const reportSessionPredicate=sessionPredicateSql(report.predicates?.sessionProperties,bind,report.timeZone),qualificationSessionPredicate=sessionPredicateSql(qualification?.predicates?.sessionProperties,bind,qualification?.timeZone??report.timeZone);
  const pageSql=paged?`, session_page AS MATERIALIZED (SELECT COALESCE(${bind(eventBefore)}::timestamptz,as_of) AS event_before FROM session_clock)`:'';
  if(paged){reportPredicate+=` AND s.received_at<(SELECT event_before FROM session_page)`;qualificationPredicate+=` AND s.received_at<(SELECT event_before FROM session_page)`;}
  const sessionSql=sessionAware?`, session_clock AS MATERIALIZED (SELECT ${mode==='revenue-comparison'?'revenue_snapshot.as_of':includeCurrentProperties||paged?'clock_timestamp()':"date_trunc('milliseconds',clock_timestamp())"} AS as_of${mode==='revenue-comparison'?' FROM revenue_snapshot':''}),
    session_cutoff AS MATERIALIZED (SELECT p.id,c.as_of,GREATEST(p.session_properties_retained_from,c.as_of-w.raw_analytics_days*interval '24 hours') AS cutoff,
      p.session_properties_evidence_lost_at AS lost_at,p.analytics_retained_from AS event_watermark,w.retention_revision AS policy_revision,w.raw_analytics_days AS raw_days
      FROM project p JOIN target t ON t.id=p.id JOIN workspace w ON w.id=p.workspace_id CROSS JOIN session_clock c),
    session_context AS MATERIALIZED (SELECT c.*,EXISTS(SELECT 1 FROM analytics_session_property sp WHERE sp.project_id=c.id AND sp.updated_at<c.cutoff) AS expired_values_present FROM session_cutoff c)`:'';
  const cohortSql=qualification?`${qualificationSession?`, qualification_candidates AS MATERIALIZED (${qualificationSql} SELECT s.* FROM scope s WHERE ${qualificationPredicate}),
    qualification AS MATERIALIZED (SELECT visitor_id FROM qualification_candidates s WHERE ${qualificationSessionPredicate})`:
    `, qualification AS MATERIALIZED (${qualificationSql} SELECT visitor_id FROM scope s WHERE ${qualificationPredicate})`},
    qualification_bounds AS (WITH RECURSIVE ${qualificationCalendarSql} SELECT start,finish FROM bounds),
    cohort_keys AS MATERIALIZED (SELECT DISTINCT visitor_id FROM qualification WHERE visitor_id IS NOT NULL),
    report_scope AS MATERIALIZED (SELECT s.* FROM scope s WHERE EXISTS(SELECT 1 FROM cohort_keys c WHERE c.visitor_id=s.visitor_id))`:'';
  const basePopulation=qualification?'report_scope':'scope',population=report.predicates||paged?'filtered_report':basePopulation;
  const advancedSql=reportSession?`, report_candidates AS MATERIALIZED (SELECT s.* FROM ${basePopulation} s WHERE ${reportPredicate}),
    filtered_report AS MATERIALIZED (SELECT s.* FROM report_candidates s WHERE ${reportSessionPredicate})`:
    report.predicates||paged?`, filtered_report AS MATERIALIZED (SELECT s.* FROM ${basePopulation} s WHERE ${reportPredicate})`:'';
  return {ctes:`${share?boardShareAnalyticsScopeSql:mode==='revenue-comparison'?analyticsRevenuePeriodScopeSql:analyticsScopeSql}, report_arguments AS MATERIALIZED (SELECT $11::text AS group_by,$12::text AS group_property)${sessionSql}${pageSql}${cohortSql}${advancedSql}`,
    values,population,sessionAware,reportCandidates:reportSession?'report_candidates':null,qualificationCandidates:qualificationSession?'qualification_candidates':null};
}
