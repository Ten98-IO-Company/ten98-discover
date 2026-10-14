import { getDatabase } from './db.ts';
import { FoundationError } from './auth.ts';
import { explorerQuery, csvCell } from './explorer-input.ts';
import { retentionCoverage } from './retention.ts';
import { analyticsCalendarSql, analyticsScopeSql, analyticsScopeValues } from './analytics-scope.ts';
import {resolveCohort,type CohortItem} from './cohorts.ts';

type Totals = {events:number|null;pageViews:number|null;customEvents:number|null;identifiedEvents:number|null;unidentifiedEvents:number|null;visitors:number|null;visits:number|null};
type Day = {date:string;start:string;end:string;events:number|null;pageViews:number|null;customEvents:number|null;skipped:boolean;coverage:'complete'|'partial'|'unavailable'};
type Group = {type:string;value:unknown;events:number;identifiedEvents:number;visitors:number|null};
type Numeric = {samples:number;sum:string|null;average:string|null;min:string|null;max:string|null};
export type CohortReport={item:CohortItem;range:{from:string;to:string;timeZone:string;start:string;end:string};coverage:ReturnType<typeof retentionCoverage>;
  identity:{status:'complete'|'partial'|'unavailable';identifiedEvents:number|null;unidentifiedEvents:number|null;observedMemberKeys:number|null};
  membership:{status:'available'|'unavailable';countsAreLowerBounds:boolean};limitation:string};
const cohortLimitation='Membership uses observed project-scoped visitor keys, not persistent people. Keys rotate each UTC month and when identity inputs or the signing secret change; continuity across those changes is unavailable. Identity coverage describes retained qualifying events only.';
// Both templates are trusted constants. Reserve1–12 for the existing report query.
const qualificationSql=analyticsScopeSql.replace(/\$(\d+)\b/g,(_,slot)=>`$${Number(slot)+12}`);
const qualificationCalendarSql=analyticsCalendarSql.replace(/\$(\d+)\b/g,(_,slot)=>`$${Number(slot)+12}`);

export async function exploreAnalytics(projectId:string,userId:string,params:URLSearchParams) {
  const query = explorerQuery(params);
  const client = await getDatabase().pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL statement_timeout='5s'");
    const item=query.cohort?await resolveCohort(client,projectId,userId,query.cohort.id,query.cohort.revision):null;
    const qualification=item?explorerQuery(new URLSearchParams(item.definition.query)):null;
    for(const zone of new Set([query.timeZone,...(qualification?[qualification.timeZone]:[])]))if (!(await client.query('SELECT 1 FROM pg_timezone_names WHERE name=$1',[zone])).rowCount) throw new FoundationError(400,'The database does not support this timezone.');
    const population=item?'report_scope':'scope',cohortSql=item?`, qualification AS MATERIALIZED (${qualificationSql} SELECT visitor_id FROM scope),
      qualification_bounds AS (WITH RECURSIVE ${qualificationCalendarSql} SELECT start,finish FROM bounds),
      cohort_keys AS MATERIALIZED (SELECT DISTINCT visitor_id FROM qualification WHERE visitor_id IS NOT NULL),
      report_scope AS MATERIALIZED (SELECT s.* FROM scope s WHERE EXISTS(SELECT 1 FROM cohort_keys c WHERE c.visitor_id=s.visitor_id))`:'';
    // One statement binds membership, retention, buckets and totals to one snapshot.
    // ponytail: bounded raw aggregation; introduce rollups only after measured query limits.
    // PostgreSQL resolves ambiguous wall times to the later offset. Check both
    // neighbouring offsets for the first midnight; binary-search only missing
    // midnights to find a gap's first real instant (including skipped dates).
    const {rows} = await client.query(`${analyticsScopeSql}${cohortSql}, labeled AS MATERIALIZED (
      SELECT *,CASE $11::text
        WHEN 'event' THEN jsonb_build_object('type','string','value',event_name)
        WHEN 'path' THEN jsonb_build_object('type','string','value',path)
        WHEN 'origin' THEN jsonb_build_object('type','string','value',origin)
        WHEN 'property' THEN COALESCE(properties->$12::text,'{"type":"missing","value":null}'::jsonb)
        ELSE CASE WHEN dimension IS NULL THEN '{"type":"missing","value":null}'::jsonb
          ELSE jsonb_build_object('type',jsonb_typeof(dimension),'value',dimension) END END AS label
      FROM ${population} LEFT JOIN LATERAL (SELECT CASE $11::text
        WHEN 'referrer' THEN dimensions->'referrerHost' WHEN 'language' THEN dimensions->'language'
        WHEN 'screenWidth' THEN dimensions->'screenWidth' WHEN 'screenHeight' THEN dimensions->'screenHeight'
        WHEN 'campaignSource' THEN dimensions->'campaign'->'source' WHEN 'campaignMedium' THEN dimensions->'campaign'->'medium'
        WHEN 'campaignName' THEN dimensions->'campaign'->'campaign' WHEN 'campaignTerm' THEN dimensions->'campaign'->'term'
        WHEN 'campaignContent' THEN dimensions->'campaign'->'content' END AS dimension) d ON true
    ), grouped AS MATERIALIZED (
      SELECT label,count(*) AS events,count(visitor_id) AS identified,
        CASE WHEN count(visitor_id)>0 THEN count(DISTINCT visitor_id) END AS visitors FROM labeled GROUP BY label
    ), ranked AS (SELECT * FROM grouped ORDER BY events DESC,label::text COLLATE "C" ASC LIMIT 100),
    buckets AS (
      SELECT (received_at AT TIME ZONE $5)::date AS day,count(*) AS events,count(*) FILTER (WHERE event_name='page_view') AS pageviews,
        count(*) FILTER (WHERE event_name<>'page_view') AS custom FROM ${population} GROUP BY 1
    ), keys AS MATERIALIZED (SELECT DISTINCT jsonb_object_keys(properties) AS key FROM ${population}),
    numbers AS (SELECT (label->>'value')::numeric AS value FROM labeled WHERE $11='property' AND label->>'type'='number' AND jsonb_typeof(label->'value')='number')
    SELECT EXISTS(SELECT 1 FROM target) AS allowed,(SELECT analytics_retained_from FROM target) AS retained_from,
      (SELECT start FROM bounds) AS start,(SELECT finish FROM bounds) AS finish,
      ${item?`(SELECT json_build_object('start',start,'end',finish,'events',(SELECT count(*) FROM qualification),
        'identified',(SELECT count(visitor_id) FROM qualification),'members',(SELECT count(*) FROM cohort_keys)) FROM qualification_bounds)`:'null'} AS qualification,
      json_build_object('events',count(*),'pageViews',count(*) FILTER (WHERE event_name='page_view'),
        'customEvents',count(*) FILTER (WHERE event_name<>'page_view'),'identifiedEvents',count(visitor_id),
        'unidentifiedEvents',count(*) FILTER (WHERE visitor_id IS NULL),
        'visitors',CASE WHEN count(visitor_id)>0 THEN count(DISTINCT visitor_id) END,
        'visits',CASE WHEN count(visit_id)>0 THEN count(DISTINCT (visitor_id,visit_id)) FILTER (WHERE visit_id IS NOT NULL) END) AS totals,
      (SELECT json_agg(json_build_object('date',to_char(c.day,'YYYY-MM-DD'),'start',c.start,'end',c.finish,
        'events',COALESCE(b.events,0),'pageViews',COALESCE(b.pageviews,0),'customEvents',COALESCE(b.custom,0)) ORDER BY c.day)
        FROM calendar c LEFT JOIN buckets b ON b.day=c.day::date WHERE c.finish IS NOT NULL) AS daily,
      json_build_object('groups',COALESCE((SELECT json_agg(json_build_object('type',label->>'type','value',label->'value',
        'events',events,'identifiedEvents',identified,'visitors',visitors) ORDER BY events DESC,label::text COLLATE "C") FROM ranked),'[]'::json),
        'totalGroups',(SELECT count(*) FROM grouped),'returnedGroupEvents',(SELECT COALESCE(sum(events),0) FROM ranked),
        'truncated',(SELECT count(*)>100 FROM grouped)) AS breakdown,
      json_build_object('keys',COALESCE((SELECT json_agg(key ORDER BY key COLLATE "C") FROM (SELECT key FROM keys ORDER BY key COLLATE "C" LIMIT 100) k),'[]'::json),
        'truncated',(SELECT count(*)>100 FROM keys)) AS properties,
      (SELECT json_build_object('samples',count(*),'sum',sum(value)::text,'average',avg(value)::text,'min',min(value)::text,'max',max(value)::text) FROM numbers) AS numeric
      FROM ${population}`,[...analyticsScopeValues(projectId,userId,query),query.groupBy,query.groupProperty,...(qualification?analyticsScopeValues(projectId,userId,qualification):[])]);
    await client.query('COMMIT');
    const row = rows[0];
    if (!row.allowed) throw new FoundationError(404,'Project not found or unavailable.');
    const start = row.start.toISOString(), end = row.finish.toISOString();
    const coverage = retentionCoverage(start,end,row.retained_from);
    let cohort:CohortReport|undefined;
    if(item&&qualification){
      const q=row.qualification,from=new Date(q.start).toISOString(),to=new Date(q.end).toISOString(),qualifiedCoverage=retentionCoverage(from,to,row.retained_from);
      const expired=qualifiedCoverage.status==='unavailable',unidentified=q.events-q.identified,unavailable=expired||(q.events>0&&q.identified===0);
      cohort={item,range:{from:qualification.from,to:qualification.to,timeZone:qualification.timeZone,start:from,end:to},coverage:qualifiedCoverage,
        identity:{status:expired||(q.events>0&&q.identified===0)?'unavailable':unidentified>0?'partial':'complete',identifiedEvents:expired?null:q.identified,unidentifiedEvents:expired?null:unidentified,observedMemberKeys:expired?null:q.members},
        membership:{status:unavailable?'unavailable':'available',countsAreLowerBounds:!unavailable&&(qualifiedCoverage.status==='partial'||unidentified>0)},limitation:cohortLimitation};
    }
    const membershipUnavailable=cohort?.membership.status==='unavailable';
    const totals: Totals = row.totals;
    if (coverage.status === 'unavailable'||membershipUnavailable) for (const key of Object.keys(totals) as (keyof Totals)[]) totals[key] = null;
    const daily: Day[] = row.daily.map((day:Day) => {
      const from = new Date(day.start).toISOString(), to = new Date(day.end).toISOString();
      const status = retentionCoverage(from,to,row.retained_from).status;
      return {...day,start:from,end:to,skipped:from === to,coverage:status,...(status === 'unavailable'||membershipUnavailable ? {events:null,pageViews:null,customEvents:null} : {})};
    });
    const result = {range:{from:query.from,to:query.to,timeZone:query.timeZone,start,end},query,coverage,totals,daily,...(cohort?{cohort}:{}),
      breakdown:(membershipUnavailable?{groups:[],totalGroups:null,returnedGroupEvents:null,truncated:false}:row.breakdown) as {groups:Group[];totalGroups:number|null;returnedGroupEvents:number|null;truncated:boolean},
      properties:(membershipUnavailable?{keys:[],truncated:false}:row.properties) as {keys:string[];truncated:boolean},numeric:query.groupBy === 'property' && coverage.status !== 'unavailable'&&!membershipUnavailable ? row.numeric as Numeric : null};
    return {...result,csv:explorerCsv(result)};
  } catch (error) {
    await client.query('ROLLBACK').catch(()=>{});
    if ((error as {code?:string}).code === '57014') throw new FoundationError(503,'This query took too long. Choose a shorter date range or more filters.');
    throw error;
  } finally {client.release();}
}

function explorerCsv(result:{query:ReturnType<typeof explorerQuery>;range:{start:string;end:string};coverage:ReturnType<typeof retentionCoverage>;totals:Totals;daily:Day[];breakdown:{groups:Group[];totalGroups:number|null;returnedGroupEvents:number|null;truncated:boolean};numeric:Numeric|null;cohort?:CohortReport}) {
  const lines:unknown[][] = [['ten98-monitor','Bounded exploration result'],['Scope',JSON.stringify(result.query)],['Start (inclusive)',result.range.start],['End (exclusive)',result.range.end],
    ['Selection','Only instants in the selected local calendar dates; UTC envelopes can overlap at a repeated midnight.'],
    ['Retention coverage',result.coverage.status],['Retained from',result.coverage.retainedFrom ?? 'No retention boundary'],
    ...(result.cohort?[['Cohort',JSON.stringify(result.cohort)]]:[]),[],['Metric','Value'],...Object.entries(result.totals),[],
    ['Groups returned',result.breakdown.groups.length],['Total groups',result.breakdown.totalGroups],['Returned group events',result.breakdown.returnedGroupEvents],['Truncated',result.breakdown.truncated],
    ['Type','Value','Events','Identified events','Visitors'],...result.breakdown.groups.map(g=>[g.type,g.type === 'null' ? 'null' : g.type === 'missing' ? 'Missing / uncollected' : g.value,g.events,g.identifiedEvents,g.visitors]),[],
    ['Date','Start (inclusive)','End (exclusive)','Skipped local date','Coverage','Events','Page views','Custom events'],...result.daily.map(d=>[d.date,d.start,d.end,d.skipped,d.coverage,d.events,d.pageViews,d.customEvents])];
  if (result.numeric) lines.push([],['Numeric property statistic','Exact decimal value'],...Object.entries(result.numeric));
  return lines.map(line=>line.map(csvCell).join(',')).join('\r\n')+'\r\n';
}
