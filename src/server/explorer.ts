import { getDatabase } from './db.ts';
import { FoundationError } from './auth.ts';
import { explorerQuery, explorerGroupingQuery, csvCell,type CompoundExplorerQuery,type ExplorerTupleAtom } from './explorer-input.ts';
import { retentionCoverage } from './retention.ts';
import {analyticsPopulation,cohortCoverage,sessionScope,type CohortReport,type SessionPropertyScope} from './analytics-population.ts';
export type {CohortReport,SessionPropertyScope} from './analytics-population.ts';
import {resolveCohort} from './cohorts.ts';
import {advancedPredicateMethod,validateAdvancedRegex} from './advanced-predicates.ts';
import {analyticsDimensionValueSql} from './analytics-dimensions.ts';
import {geographyFields,parseGeographyKey,serializeGeographyKey,type GeoField,type GeographyProvenance} from '../lib/analytics-geography.ts';

type Totals = {events:number|null;pageViews:number|null;customEvents:number|null;identifiedEvents:number|null;unidentifiedEvents:number|null;visitors:number|null;visits:number|null};
type Day = {date:string;start:string;end:string;events:number|null;pageViews:number|null;customEvents:number|null;skipped:boolean;coverage:'complete'|'partial'|'unavailable'};
type Group = {type:string;value:unknown;events:number;identifiedEvents:number;visitors:number|null;pageViews?:number;identifiedPageViews?:number;estimatedVisitors?:number|null;visits?:number|null;bounceRate?:number|null;averageVisitSeconds?:number|null};
type Numeric = {samples:number;sum:string|null;average:string|null;min:string|null;max:string|null};
type ExplorerGeographyProvenance=GeographyProvenance&{scope:'matching-report-events'};
const usesGeography=(query:ReturnType<typeof explorerQuery>)=>geographyFields.includes(query.groupBy as GeoField)||geographyFields.some(field=>Object.hasOwn(query.filters,field))||!!query.predicates?.fields.some(filter=>geographyFields.includes(filter.field as GeoField));
export async function exploreAnalytics(projectId:string,userId:string,params:URLSearchParams) {
  const {scope:query,fields}=explorerGroupingQuery(params);
  const client = await getDatabase().pool.connect();
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
    if(reportSession)await gatedBegin();
    else{await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await client.query("SET LOCAL statement_timeout='5s'");}
    let item=query.cohort?await resolveCohort(client,projectId,userId,query.cohort.id,query.cohort.revision):null;
    let qualification=item?explorerQuery(new URLSearchParams(item.definition.query)):null;
    if(!reportSession&&qualification?.predicates?.sessionProperties?.length){
      await client.query('ROLLBACK');await gatedBegin();
      item=await resolveCohort(client,projectId,userId,query.cohort!.id,query.cohort!.revision);
      qualification=explorerQuery(new URLSearchParams(item.definition.query));
    }
    const qualificationSession=!!qualification?.predicates?.sessionProperties?.length,sessionAware=reportSession||qualificationSession;
    if(query.predicates||qualification?.predicates){
      if(!(await client.query('SELECT 1 FROM project p JOIN membership m ON m.workspace_id=p.workspace_id AND m.user_id=$2 WHERE p.id=$1',[projectId,userId])).rowCount)throw new FoundationError(404,'Project not found or unavailable.');
      await validateAdvancedRegex(client,query.predicates,qualification?.predicates);
    }
    for(const zone of new Set([query.timeZone,...(qualification?[qualification.timeZone]:[])]))if (!(await client.query('SELECT 1 FROM pg_timezone_names WHERE name=$1',[zone])).rowCount) throw new FoundationError(400,'The database does not support this timezone.');
    const {ctes,values,population}=analyticsPopulation(projectId,userId,query,qualification,false);
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
      SELECT DISTINCT e.visitor_id,e.visit_id FROM event e JOIN target t ON t.id=e.project_id CROSS JOIN bounds b
      WHERE e.received_at>=b.start AND e.received_at<b.finish AND (e.received_at AT TIME ZONE $5)::date BETWEEN $3::date AND $4::date
        AND (t.analytics_retained_from IS NULL OR e.received_at>=t.analytics_retained_from)
        AND e.event_name<>'page_view' AND e.visitor_id IS NOT NULL AND e.visit_id IS NOT NULL
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
    numbers AS (SELECT (label->>'value')::numeric AS value FROM labeled WHERE $11='property' AND label->>'type'='number' AND jsonb_typeof(label->'value')='number')
    SELECT EXISTS(SELECT 1 FROM target) AS allowed,(SELECT analytics_retained_from FROM target) AS retained_from,
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
      (SELECT json_build_object('samples',count(*),'sum',sum(value)::text,'average',avg(value)::text,'min',min(value)::text,'max',max(value)::text) FROM numbers) AS numeric
      FROM ${population}`,values);
    await client.query('COMMIT');
    const row = rows[0];
    if(geographyFields.includes(query.groupBy as GeoField))for(const group of row.breakdown.groups)group.value=serializeGeographyKey(query.groupBy as GeoField,group.value);
    if(fields)for(const group of row.breakdown.groups)for(const [index,field]of fields.entries())if(geographyFields.includes(field as GeoField)){
      const atom=group.value[index] as ExplorerTupleAtom,canonical=serializeGeographyKey(field as GeoField,atom.value);
      if(canonical===null)throw new FoundationError(503,'The recorded location combination could not be safely interpreted.');atom.value=canonical;
    }
    if (!row.allowed) throw new FoundationError(404,'Project not found or unavailable.');
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
      breakdown:(membershipUnavailable||fields&&coverage.status==='unavailable'?{groups:[],totalGroups:null,returnedGroupEvents:null,truncated:false}:row.breakdown) as {groups:Group[];totalGroups:number|null;returnedGroupEvents:number|null;truncated:boolean},
      properties:(membershipUnavailable?{keys:[],truncated:false}:row.properties) as {keys:string[];truncated:boolean},numeric:query.groupBy === 'property' && coverage.status !== 'unavailable'&&!membershipUnavailable ? row.numeric as Numeric : null};
    const output={...result,csv:explorerCsv(result)};
    if(fields&&Buffer.byteLength(JSON.stringify(output),'utf8')>2097152)throw new FoundationError(503,'The complete combination report is too large. Choose a shorter range or more filters.');
    return output;
  } catch (error) {
    await client.query('ROLLBACK').catch(()=>{});
    if (['57014','55P03'].includes((error as {code?:string}).code??'')) throw new FoundationError(503,'This query took too long. Choose a shorter date range or more filters.');
    throw error;
  } finally {client.release();}
}

function explorerCsv(result:{query:ReturnType<typeof explorerQuery>|CompoundExplorerQuery;range:{start:string;end:string};coverage:ReturnType<typeof retentionCoverage>;totals:Totals;daily:Day[];breakdown:{groups:Group[];totalGroups:number|null;returnedGroupEvents:number|null;truncated:boolean};numeric:Numeric|null;cohort?:CohortReport;predicateMethod?:ReturnType<typeof advancedPredicateMethod>;sessionProperties?:SessionPropertyScope;geographyProvenance?:ExplorerGeographyProvenance}) {
  const fields='fields'in result.query?result.query.fields:null,groupBy='groupBy'in result.query?result.query.groupBy:null;
  const geoGroup=geographyFields.includes(groupBy as GeoField),location=(value:unknown,field=groupBy)=>{const key=parseGeographyKey(field as GeoField,value);if(!key)return 'Not recorded';if(key.state!=='known')return key.state==='unknown'?'Unknown':'Not recorded';const country=new Intl.DisplayNames('en-US',{type:'region'}).of(key.country)??key.country,region='region'in key&&key.region?key.region.value:'Unknown region';return 'city'in key?`${key.city} · ${region} · ${country} (${key.country})`:'region'in key?`${region} · ${country} (${key.country})`:`${country} (${key.country})`;};
  const groupLines=fields?[
    [...fields.flatMap(field=>[`${field} type`,`${field} value`,...(geographyFields.includes(field as GeoField)?[`${field} location`]:[])]),'Events','Identified events','Visitors (all events)','Page views','Identified page views','Estimated visitors (page views)','Visits (page views)','Bounce rate (%)','Average observed visit duration (seconds)'],
    ...result.breakdown.groups.map(g=>[...(g.value as ExplorerTupleAtom[]).flatMap((atom,index)=>[atom.type,atom.type==='missing'?'Missing / uncollected':atom.type==='null'?'null':atom.value,...(geographyFields.includes(fields[index] as GeoField)?[location(atom.value,fields[index])]:[])]),g.events,g.identifiedEvents,g.visitors,g.pageViews,g.identifiedPageViews,g.estimatedVisitors,g.visits,g.bounceRate,g.averageVisitSeconds])
  ]:[['Type',...(geoGroup?['Location','Canonical key']:['Value']),'Events','Identified events','Visitors'],...result.breakdown.groups.map(g=>[g.type,...geoGroup?[location(g.value),g.value]:[g.type === 'null' ? 'null' : g.type === 'missing' ? 'Missing / uncollected' : g.value],g.events,g.identifiedEvents,g.visitors])];
  const lines:unknown[][] = [['ten98-monitor','Bounded exploration result'],['Scope',JSON.stringify(result.query)],['Start (inclusive)',result.range.start],['End (exclusive)',result.range.end],
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
