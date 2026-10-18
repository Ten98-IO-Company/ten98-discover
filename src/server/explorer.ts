import {boardShareSqlBudget} from './analytics-scope.ts';
import { getDatabase } from './db.ts';
import { FoundationError } from './auth.ts';
import { explorerQuery, explorerGroupingQuery, csvCell,type CompoundExplorerQuery,type ExplorerTupleAtom } from './explorer-input.ts';
import { retentionCoverage } from './retention.ts';
import {analyticsPopulation,cohortCoverage,sessionScope,type CohortReport,type SessionPropertyScope} from './analytics-population.ts';
export type {CohortReport,SessionPropertyScope} from './analytics-population.ts';
import {resolveCohort} from './cohorts.ts';
import {advancedPredicateMethod,validateAdvancedRegex} from './advanced-predicates.ts';
import {analyticsDimensionValueSql,analyticsCustomVisitsSql} from './analytics-dimensions.ts';
import {geographyFields,parseGeographyKey,serializeGeographyKey,type GeoField,type GeographyProvenance} from '../lib/analytics-geography.ts';
import {canonicalHash} from './context-input.ts';
import {propertyWeekdays,type PropertyDateSummary,type PropertyNumberStats} from '../lib/property-visuals.ts';

type Totals = {events:number|null;pageViews:number|null;customEvents:number|null;identifiedEvents:number|null;unidentifiedEvents:number|null;visitors:number|null;visits:number|null};
type Day = {date:string;start:string;end:string;events:number|null;pageViews:number|null;customEvents:number|null;skipped:boolean;coverage:'complete'|'partial'|'unavailable'};
type Group = {type:string;value:unknown;events:number;identifiedEvents:number;visitors:number|null;pageViews?:number;identifiedPageViews?:number;estimatedVisitors?:number|null;visits?:number|null;bounceRate?:number|null;averageVisitSeconds?:number|null};
type Numeric = {samples:number;sum:string|null;average:string|null;min:string|null;max:string|null};
type ExplorerGeographyProvenance=GeographyProvenance&{scope:'matching-report-events'};
const usesGeography=(query:ReturnType<typeof explorerQuery>)=>geographyFields.includes(query.groupBy as GeoField)||geographyFields.some(field=>Object.hasOwn(query.filters,field))||!!query.predicates?.fields.some(filter=>geographyFields.includes(filter.field as GeoField));
export async function exploreAnalytics(projectId:string,userId:string,params:URLSearchParams){return readExplorer(projectId,userId,params);}
export async function readBoardShareExplorer(client:import('pg').PoolClient,context:import('./analytics-scope.ts').BoardShareReadContext,params:URLSearchParams){
 const grouped=explorerGroupingQuery(params);if(context.entityKind!=='website'||grouped.scope.cohort||grouped.scope.predicates||'propertyReport'in grouped)throw new FoundationError(400,'This board share does not grant another Explorer mode.');
 await boardShareSqlBudget(client,context);return readExplorer(context.entityId,JSON.stringify(context),params,{client,context});
}
async function readExplorer(projectId:string,userId:string,params:URLSearchParams,borrowed?:{client:import('pg').PoolClient;context:import('./analytics-scope.ts').BoardShareReadContext}) {
  const grouping=explorerGroupingQuery(params),{scope:query,fields}=grouping;
  const propertyDetails='propertyReport'in grouping?grouping.propertyReport:null,cursor=propertyDetails?.cursor??null;
  const propertyScope=propertyDetails?canonicalHash(['event-property-scope-v1',projectId,query]):null;
  if(cursor&&cursor.scope!==propertyScope)throw new FoundationError(400,'The property event cursor does not match these filters.');
  const client = borrowed?.client??await getDatabase().pool.connect();
  try {
    const reportSession=!!query.predicates?.sessionProperties?.length;
    const gatedBegin=async()=>{
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      await client.query("SET LOCAL statement_timeout='5s'");
      await client.query("SET LOCAL lock_timeout='250ms'");
      // ponytail: session reads hold workspace SHARE through bounded SQL; measure contention before replacing this gate.
      await client.query('SELECT w.id FROM workspace w JOIN project p ON p.workspace_id=w.id WHERE p.id=$1 FOR SHARE OF w',[projectId]);
      if(!(await client.query('SELECT 1 FROM project p JOIN membership m ON m.workspace_id=p.workspace_id AND m.user_id=$2 WHERE p.id=$1',[projectId,userId])).rowCount)throw new FoundationError(404,'Project not found or unavailable.');
    };
    if(!borrowed&&(reportSession||propertyDetails))await gatedBegin();
    else if(!borrowed){await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await client.query("SET LOCAL statement_timeout='5s'");}
    let item=query.cohort?await resolveCohort(client,projectId,userId,query.cohort.id,query.cohort.revision):null;
    let qualification=item?explorerQuery(new URLSearchParams(item.definition.query)):null;
    if(!reportSession&&!propertyDetails&&qualification?.predicates?.sessionProperties?.length){
      await client.query('ROLLBACK');await gatedBegin();
      item=await resolveCohort(client,projectId,userId,query.cohort!.id,query.cohort!.revision);
      qualification=explorerQuery(new URLSearchParams(item.definition.query));
    }
    const qualificationSession=!!qualification?.predicates?.sessionProperties?.length,sessionAware=reportSession||qualificationSession||!!propertyDetails;
    // Keep the resolved cohort/aggregate on its original snapshot. Only publication
    // reacquires a fresh gate; holding it over this snapshot would block cohort edits.
    const publicationSql=`SELECT p.workspace_id,p.analytics_retained_from::text AS watermark,p.analytics_epoch AS epoch FROM project p
      JOIN membership m ON m.workspace_id=p.workspace_id AND m.user_id=$2 WHERE p.id=$1 AND m.role IN('owner','admin','editor','viewer')`;
    const publication=borrowed?null:(await client.query(publicationSql,[projectId,userId])).rows[0];
    if(!borrowed&&!publication)throw new FoundationError(404,'Project not found or unavailable.');
    if(query.predicates||qualification?.predicates){
      if(!(await client.query('SELECT 1 FROM project p JOIN membership m ON m.workspace_id=p.workspace_id AND m.user_id=$2 WHERE p.id=$1',[projectId,userId])).rowCount)throw new FoundationError(404,'Project not found or unavailable.');
      await validateAdvancedRegex(client,query.predicates,qualification?.predicates);
    }
    for(const zone of new Set([query.timeZone,...(qualification?[qualification.timeZone]:[])]))if (!(await client.query('SELECT 1 FROM pg_timezone_names WHERE name=$1',[zone])).rowCount) throw new FoundationError(400,'The database does not support this timezone.');
    const {ctes,values,population}=analyticsPopulation(projectId,userId,query,qualification,false,propertyDetails?cursor?.before??null:undefined,undefined,borrowed?.context);
    const geographyUsed=usesGeography(query)||!!fields?.some(field=>geographyFields.includes(field as GeoField))||!!qualification&&usesGeography(qualification);
    const tupleDimensions=fields?.map(field=>{values.push(field);return analyticsDimensionValueSql(`$${values.length}::text`,'s');});
    const labelSql=fields?`SELECT s.*,jsonb_build_object('type','tuple','value',jsonb_build_array(${fields.map((field,index)=>`CASE WHEN d.v${index} IS NULL THEN '{"type":"missing","value":null}'::jsonb ELSE jsonb_build_object('type',${geographyFields.includes(field as GeoField)?"'string'":`jsonb_typeof(d.v${index})`},'value',d.v${index}) END`).join(',')})) AS label
      FROM ${population} s CROSS JOIN LATERAL (SELECT ${tupleDimensions!.map((sql,index)=>`${sql} AS v${index}`).join(',')}) d`:
      `SELECT s.*,CASE WHEN $11::text='property' THEN COALESCE(s.properties->$12::text,'{"type":"missing","value":null}'::jsonb)
        WHEN d.dimension IS NULL THEN '{"type":"missing","value":null}'::jsonb
        ELSE jsonb_build_object('type',CASE WHEN $11 IN ('country','region','city') THEN 'string' ELSE jsonb_typeof(d.dimension) END,'value',d.dimension) END AS label
      FROM ${population} s CROSS JOIN LATERAL (SELECT ${analyticsDimensionValueSql('$11::text','s')} AS dimension) d`;
    // Umami counts page views within each tuple/visitor/visit, but custom events
    // suppress bounces across the authorized date range before report filters.
    const groupingSql=fields?`tuple_custom_visits AS MATERIALIZED (
      ${analyticsCustomVisitsSql('(SELECT start FROM bounds)','(SELECT finish FROM bounds)',"(e.received_at AT TIME ZONE $5)::date BETWEEN $3::date AND $4::date")}
    ), tuple_visits AS (
      SELECT label::text COLLATE "C" AS label,visitor_id,visit_id,count(*) AS pageviews,
        extract(epoch FROM max(received_at)-min(received_at)) AS duration
      FROM labeled WHERE event_name='page_view' AND visitor_id IS NOT NULL AND visit_id IS NOT NULL
      GROUP BY label::text COLLATE "C",visitor_id,visit_id
    ), tuple_measurement AS (
      SELECT v.label,count(DISTINCT v.visitor_id) AS estimated_visitors,count(*) AS visits,
        100.0*count(*) FILTER(WHERE v.pageviews=1 AND c.visit_id IS NULL)/count(*) AS bounce,
        avg(v.duration) AS duration FROM tuple_visits v LEFT JOIN tuple_custom_visits c ON c.visitor_id=v.visitor_id AND c.visit_id=v.visit_id GROUP BY v.label
    ), tuple_counts AS (
      SELECT label::text COLLATE "C" AS label,count(*) AS events,count(visitor_id) AS identified,
        CASE WHEN count(visitor_id)>0 THEN count(DISTINCT visitor_id) END AS visitors,
        count(*) FILTER(WHERE event_name='page_view') AS pageviews,count(*) FILTER(WHERE event_name='page_view' AND visitor_id IS NOT NULL) AS identified_pageviews
      FROM labeled GROUP BY label::text COLLATE "C"
    ), grouped AS MATERIALIZED (
      SELECT c.*,m.estimated_visitors,m.visits,m.bounce,m.duration FROM tuple_counts c LEFT JOIN tuple_measurement m ON m.label=c.label
    ), ranked AS (SELECT label::jsonb AS label,events,identified,visitors,pageviews,identified_pageviews,estimated_visitors,visits,bounce,duration FROM grouped
      ORDER BY estimated_visitors DESC NULLS LAST,pageviews DESC,grouped.label COLLATE "C" ASC LIMIT 500)`:
      `grouped AS MATERIALIZED (
      SELECT label,count(*) AS events,count(visitor_id) AS identified,
        CASE WHEN count(visitor_id)>0 THEN count(DISTINCT visitor_id) END AS visitors FROM labeled GROUP BY label
    ), ranked AS (SELECT * FROM grouped ORDER BY events DESC,label::text COLLATE "C" ASC LIMIT 100)`;
    const groupOrder=fields?'estimated_visitors DESC NULLS LAST,pageviews DESC,label::text COLLATE "C"':'events DESC,label::text COLLATE "C"';
    const bind=(value:unknown)=>{values.push(value);return `$${values.length}`;};
    const afterAt=propertyDetails?bind(cursor?.last.at??null):'',afterId=propertyDetails?bind(cursor?.last.id??null):'';
    const stamp=(sql:string)=>`to_char(${sql} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
    // PostgreSQL has no year zero; ISO astronomical year0000 is its year1BC.
    // Preserve timezone boundary days outside the four-digit UTC input range.
    const calendarLabel=(sql:string)=>`CASE WHEN ${sql} IS NULL THEN NULL ELSE
      (CASE WHEN extract(year FROM ${sql})=-1 THEN '0000'
        WHEN extract(year FROM ${sql})< -1 THEN '-'||lpad(abs(extract(year FROM ${sql})::int+1)::text,6,'0')
        WHEN extract(year FROM ${sql})>9999 THEN '+'||lpad(extract(year FROM ${sql})::int::text,6,'0')
        ELSE to_char(${sql},'YYYY') END)||to_char(${sql},'-MM-DD') END`;
    const propertyCtes=propertyDetails?`, property_days AS MATERIALIZED (
      SELECT label,(received_at AT TIME ZONE $5)::date AS day,count(*) AS n FROM labeled GROUP BY label,day
    ), property_array_items AS MATERIALIZED (
      SELECT received_at,jsonb_build_object('type',jsonb_typeof(element.value),'value',element.value) AS label FROM labeled
      CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN label->>'type'='array' THEN label->'value' ELSE '[]'::jsonb END) AS element(value)
    ), property_array_groups AS MATERIALIZED (SELECT label,count(*) AS n FROM property_array_items GROUP BY label),
    property_array_ranked AS (SELECT * FROM property_array_groups ORDER BY n DESC,label::text COLLATE "C" LIMIT 100),
    property_array_days AS (SELECT label,(received_at AT TIME ZONE $5)::date AS day,count(*) AS n FROM property_array_items GROUP BY label,day),
    property_numbers AS (SELECT (received_at AT TIME ZONE $5)::date AS day,count(*) AS n,sum((label->>'value')::numeric)::text AS sum,avg((label->>'value')::numeric)::text AS average
      FROM labeled WHERE label->>'type'='number' AND jsonb_typeof(label->'value')='number' GROUP BY day),
    property_numeric_ordered AS (SELECT value,row_number() OVER(ORDER BY value) AS ordinal,count(*) OVER() AS n FROM numbers),
    property_dates AS MATERIALIZED (SELECT label->>'value' AS value,count(*) AS n FROM labeled WHERE label->>'type'='date' GROUP BY label->>'value'),
    property_date_input AS MATERIALIZED (
      SELECT n,CASE WHEN length(value)<=1000 AND value ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9][.][0-9]{3,}Z$'
        THEN CASE WHEN left(value,4)='0000' THEN '0001'||replace(substring(value FROM 5 FOR 15),'T',' ')||'+00 BC' ELSE left(value,19)||'Z' END END AS instant
      FROM property_dates
    ), property_date_instants AS MATERIALIZED (
      SELECT n,CASE WHEN pg_input_is_valid(instant,'timestamp with time zone') THEN instant::timestamptz END AS instant FROM property_date_input
    ),
    property_date_days AS MATERIALIZED (
      SELECT (instant AT TIME ZONE $5)::date AS day,sum(n) AS n FROM property_date_instants WHERE instant IS NOT NULL GROUP BY day
    ), property_date_extent AS (
      SELECT min(day) AS first,max(day) AS last,COALESCE(sum(n),0) AS n,
        CASE WHEN count(*)=0 THEN NULL WHEN max(day)-min(day)<=45 THEN 'day'
          WHEN max(day)-min(day)<=180 THEN 'week' WHEN max(day)-min(day)<=730 THEN 'month' ELSE 'year' END AS unit
      FROM property_date_days
    ), property_date_buckets AS (
      SELECT date_trunc(x.unit,d.day::timestamp) AS day,sum(d.n) AS n FROM property_date_days d CROSS JOIN property_date_extent x GROUP BY 1
    ), property_date_calendar AS (
      SELECT day FROM property_date_extent x CROSS JOIN LATERAL generate_series(date_trunc(x.unit,x.first::timestamp),date_trunc(x.unit,x.last::timestamp),('1 '||x.unit)::interval) AS day
    ), property_date_weekdays AS (SELECT extract(isodow FROM day)::int-1 AS weekday,sum(n) AS n FROM property_date_days GROUP BY 1),
    property_page AS MATERIALIZED (SELECT * FROM labeled WHERE ${afterAt}::timestamptz IS NULL OR (received_at,id)<(${afterAt}::timestamptz,${afterId}::uuid) ORDER BY received_at DESC,id DESC LIMIT 51)` : '';
    const propertySeries=(table:string,buckets:string,countName:string)=>`COALESCE((SELECT json_agg(json_build_object('type',r.label->>'type','value',r.label->'value','total',r.${countName},'counts',
      (SELECT json_agg(COALESCE(b.n,0) ORDER BY c.day) FROM calendar c LEFT JOIN ${buckets} b ON b.day=c.day::date AND b.label=r.label WHERE c.finish IS NOT NULL)) ORDER BY r.${countName} DESC,r.label::text COLLATE "C") FROM ${table} r),'[]'::json)`;
    const propertySelect=propertyDetails?`, ${stamp('(SELECT event_before FROM session_page)')} AS property_before,
      NOT EXISTS(SELECT 1 FROM property_date_instants WHERE instant IS NULL) AS property_dates_valid,
      (SELECT event_before<=as_of FROM session_page CROSS JOIN session_clock) AS property_bound_valid,
      (SELECT json_build_array(w.retention_revision,w.raw_analytics_days,${stamp('t.analytics_retained_from')}) FROM target t JOIN project p ON p.id=t.id JOIN workspace w ON w.id=p.workspace_id) AS property_policy,
      json_build_object('values',${propertySeries('ranked','property_days','events')},
      'arrays',json_build_object('samples',(SELECT count(*) FROM labeled WHERE label->>'type'='array'),'occurrences',(SELECT count(*) FROM property_array_items),'totalGroups',(SELECT count(*) FROM property_array_groups),'truncated',(SELECT count(*)>100 FROM property_array_groups),'series',${propertySeries('property_array_ranked','property_array_days','n')}),
      'numbers',(SELECT json_agg(json_build_object('samples',COALESCE(n.n,0),'sum',n.sum,'average',n.average) ORDER BY c.day) FROM calendar c LEFT JOIN property_numbers n ON n.day=c.day::date WHERE c.finish IS NOT NULL),
      'numberStats',(SELECT json_build_object('samples',count(*),'sum',sum(value)::text,'average',avg(value)::text,'min',min(value)::text,'max',max(value)::text,
        'median',(SELECT ((min(value)+max(value))*0.5)::text FROM property_numeric_ordered WHERE ordinal IN ((n+1)/2,(n+2)/2))) FROM numbers),
      'dateSummary',(SELECT json_build_object('samples',x.n,'unit',x.unit,'earliest',${calendarLabel('x.first')},'latest',${calendarLabel('x.last')},
        'topDate',(SELECT json_build_object('date',${calendarLabel('day')},'count',n) FROM property_date_days ORDER BY n DESC,day DESC LIMIT 1),
        'weekdays',(SELECT json_agg(COALESCE(w.n,0) ORDER BY i) FROM generate_series(0,6) AS i LEFT JOIN property_date_weekdays w ON w.weekday=i),
        'histogram',COALESCE((SELECT json_agg(json_build_object('date',${calendarLabel('c.day')},'count',COALESCE(b.n,0)) ORDER BY c.day) FROM property_date_calendar c LEFT JOIN property_date_buckets b ON b.day=c.day),'[]'::json)) FROM property_date_extent x),
      'dates',json_build_object('totalGroups',(SELECT count(*) FROM property_dates),'truncated',(SELECT count(*)>100 FROM property_dates),'values',COALESCE((SELECT json_agg(json_build_object('value',value,'count',n) ORDER BY n DESC,value COLLATE "C") FROM (SELECT * FROM property_dates ORDER BY n DESC,value COLLATE "C" LIMIT 100) d),'[]'::json)),
      'events',COALESCE((SELECT json_agg(json_build_object('id',id,'eventName',event_name,'path',path,'receivedAt',${stamp('received_at')},'properties',properties) ORDER BY received_at DESC,id DESC) FROM property_page),'[]'::json)) AS property_report` : '';
    // One statement binds membership, retention, buckets and totals to one snapshot.
    // ponytail: bounded raw aggregation; introduce rollups only after measured query limits.
    // PostgreSQL resolves ambiguous wall times to the later offset. Check both
    // neighbouring offsets for the first midnight; binary-search only missing
    // midnights to find a gap's first real instant (including skipped dates).
    const {rows} = await client.query(`${ctes}, labeled AS MATERIALIZED (
      ${labelSql}
    ), ${groupingSql},
    buckets AS (
      SELECT (received_at AT TIME ZONE $5)::date AS day,count(*) AS events,count(*) FILTER (WHERE event_name='page_view') AS pageviews,
        count(*) FILTER (WHERE event_name<>'page_view') AS custom FROM ${population} GROUP BY 1
    ), keys AS MATERIALIZED (SELECT DISTINCT jsonb_object_keys(properties) AS key FROM ${population}),
    numbers AS (SELECT (label->>'value')::numeric AS value FROM labeled WHERE $11='property' AND label->>'type'='number' AND jsonb_typeof(label->'value')='number')${propertyCtes}
    SELECT EXISTS(SELECT 1 FROM target) AS allowed,(SELECT to_char(analytics_retained_from AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') FROM target) AS retained_from,
      (SELECT start FROM bounds) AS start,(SELECT finish FROM bounds) AS finish,
      ${sessionAware?`(SELECT json_build_object('asOf',as_of,'cutoff',cutoff,'lostAt',lost_at,'expiredValuesPresent',expired_values_present) FROM session_context)`:'null'} AS session_context,
      ${reportSession?`(SELECT json_build_object('identified',count(visitor_id),'unidentified',count(*) FILTER (WHERE visitor_id IS NULL)) FROM report_candidates)`:'null'} AS report_candidates,
      ${qualificationSession?`(SELECT json_build_object('identified',count(visitor_id),'unidentified',count(*) FILTER (WHERE visitor_id IS NULL)) FROM qualification_candidates)`:'null'} AS qualification_candidates,
      ${item?`(SELECT json_build_object('start',start,'end',finish,'events',(SELECT count(*) FROM qualification),
        'identified',(SELECT count(visitor_id) FROM qualification),'members',(SELECT count(*) FROM cohort_keys)) FROM qualification_bounds)`:'null'} AS qualification,
      ${geographyUsed?`(SELECT json_build_object('source','db-ip-city-lite','scope','matching-report-events','databaseCount',count(DISTINCT (geography->'databaseBuild',geography->'databaseSha256')) FILTER(WHERE geography IS NOT NULL),'oldestDatabaseBuild',min((geography->>'databaseBuild')::bigint),'newestDatabaseBuild',max((geography->>'databaseBuild')::bigint)) FROM ${population})`:'null'} AS geography_provenance,
      json_build_object('events',count(*),'pageViews',count(*) FILTER (WHERE event_name='page_view'),
        'customEvents',count(*) FILTER (WHERE event_name<>'page_view'),'identifiedEvents',count(visitor_id),
        'unidentifiedEvents',count(*) FILTER (WHERE visitor_id IS NULL),
        'visitors',CASE WHEN count(visitor_id)>0 THEN count(DISTINCT visitor_id) END,
        'visits',CASE WHEN count(visit_id)>0 THEN count(DISTINCT (visitor_id,visit_id)) FILTER (WHERE visit_id IS NOT NULL) END) AS totals,
      (SELECT json_agg(json_build_object('date',to_char(c.day,'YYYY-MM-DD'),'start',c.start,'end',c.finish,
        'events',COALESCE(b.events,0),'pageViews',COALESCE(b.pageviews,0),'customEvents',COALESCE(b.custom,0)) ORDER BY c.day)
        FROM calendar c LEFT JOIN buckets b ON b.day=c.day::date WHERE c.finish IS NOT NULL) AS daily,
      json_build_object('groups',COALESCE((SELECT json_agg(json_build_object('type',label->>'type','value',label->'value',
        'events',events,'identifiedEvents',identified,'visitors',visitors${fields?",'pageViews',pageviews,'identifiedPageViews',identified_pageviews,'estimatedVisitors',estimated_visitors,'visits',visits,'bounceRate',bounce,'averageVisitSeconds',duration":''}) ORDER BY ${groupOrder}) FROM ranked),'[]'::json),
        'totalGroups',(SELECT count(*) FROM grouped),'returnedGroupEvents',(SELECT COALESCE(sum(events),0) FROM ranked),
        'truncated',(SELECT count(*)>${fields?500:100} FROM grouped)) AS breakdown,
      json_build_object('keys',COALESCE((SELECT json_agg(key ORDER BY key COLLATE "C") FROM (SELECT key FROM keys ORDER BY key COLLATE "C" LIMIT 100) k),'[]'::json),
        'truncated',(SELECT count(*)>100 FROM keys)) AS properties,
      (SELECT json_build_object('samples',count(*),'sum',sum(value)::text,'average',avg(value)::text,'min',min(value)::text,'max',max(value)::text) FROM numbers) AS numeric${propertySelect}
      FROM ${population}`,values);
    if(!borrowed)await client.query('COMMIT');
    const row = rows[0];
    if(geographyFields.includes(query.groupBy as GeoField))for(const group of row.breakdown.groups)group.value=serializeGeographyKey(query.groupBy as GeoField,group.value);
    if(fields)for(const group of row.breakdown.groups)for(const [index,field]of fields.entries())if(geographyFields.includes(field as GeoField)){
      const atom=group.value[index] as ExplorerTupleAtom,canonical=serializeGeographyKey(field as GeoField,atom.value);
      if(canonical===null)throw new FoundationError(503,'The recorded location combination could not be safely interpreted.');atom.value=canonical;
    }
    if (!row.allowed) throw new FoundationError(404,'Project not found or unavailable.');
    if(propertyDetails&&!row.property_dates_valid)throw new FoundationError(503,'The recorded property dates could not be safely interpreted.');
    const start = row.start.toISOString(), end = row.finish.toISOString();
    const coverage = retentionCoverage(start,end,row.retained_from);
    const cohort=cohortCoverage(item,qualification,row);
    const sessionProperties=reportSession?sessionScope(row.session_context,row.report_candidates,query.predicates!.sessionProperties!.some(filter=>filter.operator==='missing'),
      coverage.status==='unavailable'||cohort?.membership.status==='unavailable',coverage.status==='partial'||!!cohort?.membership.countsAreLowerBounds):undefined;
    const membershipUnavailable=cohort?.membership.status==='unavailable'||sessionProperties?.selection.status==='unavailable';
    if(fields&&(coverage.status!=='complete'||cohort?.membership.countsAreLowerBounds||sessionProperties?.selection.countsAreLowerBounds))for(const group of row.breakdown.groups){group.bounceRate=null;group.averageVisitSeconds=null;}
    const totals: Totals = row.totals;
    if (coverage.status === 'unavailable'||membershipUnavailable) for (const key of Object.keys(totals) as (keyof Totals)[]) totals[key] = null;
    const daily: Day[] = row.daily.map((day:Day) => {
      const from = new Date(day.start).toISOString(), to = new Date(day.end).toISOString();
      const status = retentionCoverage(from,to,row.retained_from).status;
      return {...day,start:from,end:to,skipped:from === to,coverage:status,...(status === 'unavailable'||membershipUnavailable ? {events:null,pageViews:null,customEvents:null} : {})};
    });
    const {groupBy:_groupBy,groupProperty:_groupProperty,...scope}=query;
    const result = {range:{from:query.from,to:query.to,timeZone:query.timeZone,start,end},query:fields?{...scope,fields}:query,coverage,totals,daily,...(cohort?{cohort}:{}),
      ...(query.predicates?{predicateMethod:advancedPredicateMethod(query.predicates)}:{}),
      ...(sessionProperties?{sessionProperties}:{}),
      ...(geographyUsed?{geographyProvenance:(coverage.status==='unavailable'||membershipUnavailable?{source:'db-ip-city-lite',scope:'matching-report-events',databaseCount:null,oldestDatabaseBuild:null,newestDatabaseBuild:null}:row.geography_provenance) as ExplorerGeographyProvenance}:{}),
      breakdown:(membershipUnavailable||(fields||propertyDetails)&&coverage.status==='unavailable'?{groups:[],totalGroups:null,returnedGroupEvents:null,truncated:false}:row.breakdown) as {groups:Group[];totalGroups:number|null;returnedGroupEvents:number|null;truncated:boolean},
      properties:(membershipUnavailable?{keys:[],truncated:false}:row.properties) as {keys:string[];truncated:boolean},numeric:query.groupBy === 'property' && coverage.status !== 'unavailable'&&!membershipUnavailable ? row.numeric as Numeric : null};
    let propertyReport:PropertyReport|undefined;
    if(propertyDetails){
      if(!row.property_bound_valid)throw new FoundationError(400,'Reload property events before continuing.');
      const policy=canonicalHash(['event-property-policy-v1',row.property_policy]);
      if(cursor&&cursor.policy!==policy)throw new FoundationError(409,'Retention settings changed. Reload property events.');
      const unavailable=coverage.status==='unavailable'||membershipUnavailable,details=row.property_report as Omit<PropertyReport,'version'|'key'|'snapshot'|'countsAreLowerBounds'|'nextCursor'>;
      const events=unavailable?[]:details.events.slice(0,50),last=events.at(-1);
      propertyReport={...details,version:1,key:query.groupProperty!,snapshot:row.property_before,countsAreLowerBounds:coverage.status!=='complete'||!!cohort?.membership.countsAreLowerBounds||!!sessionProperties?.selection.countsAreLowerBounds,
        values:unavailable?[]:details.values.map(series=>({...series,counts:series.counts.map((n,i)=>daily[i].coverage==='unavailable'?null:n)})),
        numbers:details.numbers.map((n,i)=>unavailable||daily[i].coverage==='unavailable'?{samples:null,sum:null,average:null}:n),
        numberStats:unavailable?{samples:null,sum:null,average:null,median:null,min:null,max:null}:details.numberStats,
        dateSummary:unavailable?{samples:null,unit:null,earliest:null,latest:null,topDate:null,weekdays:null,histogram:[]}:details.dateSummary,
        arrays:unavailable?{samples:null,occurrences:null,totalGroups:null,truncated:false,series:[]}: {...details.arrays,series:details.arrays.series.map(series=>({...series,counts:series.counts.map((n,i)=>daily[i].coverage==='unavailable'?null:n)}))},
        dates:unavailable?{totalGroups:null,truncated:false,values:[]}:details.dates,events,
        nextCursor:!unavailable&&details.events.length>50&&last?Buffer.from(JSON.stringify({version:1,scope:propertyScope,policy,before:row.property_before,last:{at:last.receivedAt,id:last.id}})).toString('base64url'):null};
    }
    const output={...result,...(propertyReport?{propertyReport}:{}),csv:explorerCsv(result)+(propertyReport?propertyCsv(propertyReport,daily,query.timeZone,result.totals.events):'')};
    if((fields||propertyDetails)&&Buffer.byteLength(JSON.stringify(output),'utf8')>2097152)throw new FoundationError(503,propertyDetails?'The complete property report is too large. Choose a shorter range or more filters.':'The complete combination report is too large. Choose a shorter range or more filters.');
    if(!borrowed){
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');await client.query("SET LOCAL statement_timeout='5s';SET LOCAL lock_timeout='5s'");
      await client.query('SELECT id FROM workspace WHERE id=$1 FOR SHARE',[publication.workspace_id]);
      await client.query('SELECT id FROM project WHERE id=$1 FOR SHARE',[projectId]);
      const current=(await client.query(publicationSql,[projectId,userId])).rows[0];
      if(!current)throw new FoundationError(404,'Project not found or unavailable.');
      if(current.workspace_id!==publication.workspace_id||current.watermark!==publication.watermark||current.epoch!==publication.epoch)throw new FoundationError(409,'Analytics was reset or its collection policy changed while this report loaded. Reload the report.');
      await client.query('COMMIT');
    }
    return output;
  } catch (error) {
    if(!borrowed)await client.query('ROLLBACK').catch(()=>{});
    if (['57014','55P03'].includes((error as {code?:string}).code??'')) throw new FoundationError(503,'This query took too long. Choose a shorter date range or more filters.');
    throw error;
  } finally {if(!borrowed)client.release();}
}

export type PropertyReport={version:1;key:string;snapshot:string;countsAreLowerBounds:boolean;values:PropertySeries[];numbers:{samples:number|null;sum:string|null;average:string|null}[];
  numberStats:PropertyNumberStats;dateSummary:PropertyDateSummary;
  arrays:{samples:number|null;occurrences:number|null;totalGroups:number|null;truncated:boolean;series:PropertySeries[]};dates:{totalGroups:number|null;truncated:boolean;values:{value:string;count:number}[]};
  events:{id:string;eventName:string;path:string;receivedAt:string;properties:Record<string,{type:string;value:unknown}>}[];nextCursor:string|null};
type PropertySeries={type:string;value:unknown;total:number;counts:(number|null)[]};
function propertyCsv(report:PropertyReport,days:Day[],timeZone:string,eventTotal:number|null){const rows:unknown[][]=[[],['Property details',report.key],['Snapshot',report.snapshot],['Observed lower bounds',report.countsAreLowerBounds],['Series','Type','Value','Observed count','Share denominator',...days.map(d=>d.date)]];
  for(const[kind,series]of [['Values',report.values],['Array occurrences',report.arrays.series]]as const)for(const row of series)rows.push([kind,row.type,row.value,row.total,kind==='Values'?eventTotal:report.arrays.occurrences,...row.counts]);
  rows.push([],['Date','Numeric samples','Exact sum','Exact average']);report.numbers.forEach((n,i)=>rows.push([days[i].date,n.samples,n.sum,n.average]));
  rows.push([],['Numeric samples','Exact total','Exact average','Exact median','Exact minimum','Exact maximum'],[report.numberStats.samples,report.numberStats.sum,report.numberStats.average,report.numberStats.median,report.numberStats.min,report.numberStats.max]);
  rows.push([],['Property calendar timezone',timeZone],['Week starts','Monday'],['Property date samples','Automatic bucket','Earliest local date','Latest local date','Top local date','Top date occurrences'],[report.dateSummary.samples,report.dateSummary.unit,report.dateSummary.earliest,report.dateSummary.latest,report.dateSummary.topDate?.date??null,report.dateSummary.topDate?.count??null],['Property calendar bucket','Occurrences']);
  for(const bucket of report.dateSummary.histogram)rows.push([bucket.date,bucket.count]);
  rows.push([],['Property weekday (Monday first)','Occurrences']);propertyWeekdays.forEach((day,i)=>rows.push([day,report.dateSummary.weekdays?.[i]??null]));
  const weekdayMaximum=report.dateSummary.weekdays?Math.max(...report.dateSummary.weekdays):0;rows.push(['Top weekday',weekdayMaximum>0?propertyWeekdays[report.dateSummary.weekdays!.indexOf(weekdayMaximum)]:null],['Top weekday occurrences',weekdayMaximum>0?weekdayMaximum:null]);
  rows.push([],['Property date value (UTC)','Occurrences']);for(const d of report.dates.values)rows.push([d.value,d.count]);
  rows.push([],['Event id','Received at','Event','Path','Typed properties']);for(const event of report.events)rows.push([event.id,event.receivedAt,event.eventName,event.path,event.properties]);
  rows.push(['More event rows available',report.nextCursor!==null]);return rows.map(row=>row.map(csvCell).join(',')).join('\r\n')+'\r\n';}

function explorerCsv(result:{query:ReturnType<typeof explorerQuery>|CompoundExplorerQuery;range:{start:string;end:string};coverage:ReturnType<typeof retentionCoverage>;totals:Totals;daily:Day[];breakdown:{groups:Group[];totalGroups:number|null;returnedGroupEvents:number|null;truncated:boolean};numeric:Numeric|null;cohort?:CohortReport;predicateMethod?:ReturnType<typeof advancedPredicateMethod>;sessionProperties?:SessionPropertyScope;geographyProvenance?:ExplorerGeographyProvenance}) {
  const fields='fields'in result.query?result.query.fields:null,groupBy='groupBy'in result.query?result.query.groupBy:null;
  const geoGroup=geographyFields.includes(groupBy as GeoField),location=(value:unknown,field=groupBy)=>{const key=parseGeographyKey(field as GeoField,value);if(!key)return 'Not recorded';if(key.state!=='known')return key.state==='unknown'?'Unknown':'Not recorded';const country=new Intl.DisplayNames('en-US',{type:'region'}).of(key.country)??key.country,region='region'in key&&key.region?key.region.value:'Unknown region';return 'city'in key?`${key.city} · ${region} · ${country} (${key.country})`:'region'in key?`${region} · ${country} (${key.country})`:`${country} (${key.country})`;};
  const groupLines=fields?[
    [...fields.flatMap(field=>[`${field} type`,`${field} value`,...(geographyFields.includes(field as GeoField)?[`${field} location`]:[])]),'Events','Identified events','Visitors (all events)','Page views','Identified page views','Estimated visitors (page views)','Visits (page views)','Bounce rate (%)','Average observed visit duration (seconds)'],
    ...result.breakdown.groups.map(g=>[...(g.value as ExplorerTupleAtom[]).flatMap((atom,index)=>[atom.type,atom.type==='missing'?'Missing / uncollected':atom.type==='null'?'null':atom.value,...(geographyFields.includes(fields[index] as GeoField)?[location(atom.value,fields[index])]:[])]),g.events,g.identifiedEvents,g.visitors,g.pageViews,g.identifiedPageViews,g.estimatedVisitors,g.visits,g.bounceRate,g.averageVisitSeconds])
  ]:[['Type',...(geoGroup?['Location','Canonical key']:['Value']),'Events','Identified events','Visitors'],...result.breakdown.groups.map(g=>[g.type,...geoGroup?[location(g.value),g.value]:[g.type === 'null' ? 'null' : g.type === 'missing' ? 'Missing / uncollected' : g.value],g.events,g.identifiedEvents,g.visitors])];
  const lines:unknown[][] = [['ten98 Discover','Bounded exploration result'],['Scope',JSON.stringify(result.query)],['Start (inclusive)',result.range.start],['End (exclusive)',result.range.end],
    ...(fields?[['Page-view metrics','Observed rotating project visitor/visit keys; not people or complete sessions. Visitors (all events) additionally includes custom events.'],['Bounce method','One matching page view and no retained custom event for the same visitor/visit in the whole authorized project/local-date range, before report filters.'],['Duration method','Mean of each matching visitor/visit pair\'s last minus first matching page view, in seconds; zero-length visits included.'],['Incomplete evidence','Rates and duration unavailable for partial history or incomplete cohort/current-property selection; observed counts retained.'],['Nonadditive keys','Do not sum visitor or visit estimates across groups.']]:[]),
    ['Selection','Only instants in the selected local calendar dates; UTC envelopes can overlap at a repeated midnight.'],
    ['Retention coverage',result.coverage.status],['Retained from',result.coverage.retainedFrom ?? 'No retention boundary'],
    ...(result.geographyProvenance?[['Location source','DB-IP City Lite (CC BY 4.0) — https://db-ip.com/db/lite.php'],['Location provenance scope','Matching report events; qualification dataset builds are not returned'],['Location datasets',result.geographyProvenance.databaseCount],['Oldest location database build (Unix seconds)',result.geographyProvenance.oldestDatabaseBuild],['Newest location database build (Unix seconds)',result.geographyProvenance.newestDatabaseBuild],['Location accuracy','Approximate; stored observations only; no coordinates or raw IP addresses']]:[]),
    ...(result.predicateMethod?[['Predicate method',JSON.stringify(result.predicateMethod)]]:[]),
    ...(result.sessionProperties?[['Current session properties',JSON.stringify(result.sessionProperties)]]:[]),
    ...(result.cohort?[['Cohort',JSON.stringify(result.cohort)]]:[]),[],['Metric','Value'],...Object.entries(result.totals),[],
    ['Groups returned',result.breakdown.groups.length],['Total groups',result.breakdown.totalGroups],['Returned group events',result.breakdown.returnedGroupEvents],['Truncated',result.breakdown.truncated],
    ...groupLines,[],
    ['Date','Start (inclusive)','End (exclusive)','Skipped local date','Coverage','Events','Page views','Custom events'],...result.daily.map(d=>[d.date,d.start,d.end,d.skipped,d.coverage,d.events,d.pageViews,d.customEvents])];
  if (result.numeric) lines.push([],['Numeric property statistic','Exact decimal value'],...Object.entries(result.numeric));
  return lines.map(line=>line.map(csvCell).join(',')).join('\r\n')+'\r\n';
}
