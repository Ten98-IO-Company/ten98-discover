import { getDatabase } from './db.ts';
import { FoundationError } from './auth.ts';
import { explorerQuery, csvCell } from './explorer-input.ts';
import { retentionCoverage } from './retention.ts';

type Totals = {events:number|null;pageViews:number|null;customEvents:number|null;identifiedEvents:number|null;unidentifiedEvents:number|null;visitors:number|null;visits:number|null};
type Day = {date:string;start:string;end:string;events:number|null;pageViews:number|null;customEvents:number|null;skipped:boolean;coverage:'complete'|'partial'|'unavailable'};
type Group = {type:string;value:unknown;events:number;identifiedEvents:number;visitors:number|null};
type Numeric = {samples:number;sum:string|null;average:string|null;min:string|null;max:string|null};

export async function exploreAnalytics(projectId:string,userId:string,params:URLSearchParams) {
  const query = explorerQuery(params);
  const client = await getDatabase().pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query("SET LOCAL statement_timeout='5s'");
    if (!(await client.query('SELECT 1 FROM pg_timezone_names WHERE name=$1',[query.timeZone])).rowCount) throw new FoundationError(400,'The database does not support this timezone.');
    // One statement binds membership, retention, buckets and totals to one snapshot.
    // ponytail: bounded raw aggregation; introduce rollups only after measured query limits.
    // PostgreSQL resolves ambiguous wall times to the later offset. Check both
    // neighbouring offsets for the first midnight; binary-search only missing
    // midnights to find a gap's first real instant (including skipped dates).
    const {rows} = await client.query(`WITH RECURSIVE target AS MATERIALIZED (
      SELECT p.id,p.origin,p.analytics_retained_from FROM project p JOIN membership m ON m.workspace_id=p.workspace_id AND m.user_id=$2 WHERE p.id=$1
    ), raw_days AS (
      SELECT day,day AT TIME ZONE $5 AS nominal FROM generate_series($3::date::timestamp,($4::date+1)::timestamp,interval '1 day') day
    ), exact_days AS MATERIALIZED (
      SELECT day,nominal,min(candidate) FILTER (WHERE candidate AT TIME ZONE $5=day) AS instant,
        max(candidate) FILTER (WHERE candidate AT TIME ZONE $5=day) AS last_instant
      FROM raw_days CROSS JOIN LATERAL (
        SELECT (day-((probe AT TIME ZONE $5)-(probe AT TIME ZONE 'UTC'))) AT TIME ZONE 'UTC' AS candidate
        FROM (VALUES(nominal-interval '24 hours'),(nominal),(nominal+interval '24 hours')) p(probe)
      ) c GROUP BY day,nominal
    ), gap_search(day,lo,hi,step) AS (
      SELECT day,nominal-interval '48 hours',nominal,0 FROM exact_days WHERE instant IS NULL
      UNION ALL
      SELECT day,CASE WHEN midpoint AT TIME ZONE $5<day THEN midpoint ELSE lo END,
        CASE WHEN midpoint AT TIME ZONE $5<day THEN hi ELSE midpoint END,step+1
      FROM gap_search CROSS JOIN LATERAL (SELECT lo+(hi-lo)/2 AS midpoint) m WHERE step<38
    ), midnights AS MATERIALIZED (
      SELECT day,COALESCE(instant,(SELECT date_trunc('second',hi) FROM gap_search g WHERE g.day=e.day ORDER BY step DESC LIMIT 1)) AS instant,
        COALESCE(last_instant,(SELECT date_trunc('second',hi) FROM gap_search g WHERE g.day=e.day ORDER BY step DESC LIMIT 1)) AS last_instant FROM exact_days e
    ), calendar AS (
      SELECT day,instant AS start,lead(last_instant) OVER(ORDER BY day) AS finish FROM midnights
    ), bounds AS (
      SELECT min(instant) AS start,max(last_instant) AS finish FROM midnights
    ), scope AS MATERIALIZED (
      SELECT e.*,COALESCE(e.dimensions->>'origin',p.origin) AS origin FROM event e JOIN target p ON p.id=e.project_id CROSS JOIN bounds b
      WHERE e.received_at>=b.start AND e.received_at<b.finish AND (p.analytics_retained_from IS NULL OR e.received_at>=p.analytics_retained_from)
        AND (e.received_at AT TIME ZONE $5)::date BETWEEN $3::date AND $4::date
        AND ($6='all' OR ($6='pageviews' AND e.event_name='page_view') OR ($6='custom' AND e.event_name<>'page_view'))
        AND (NOT $7::jsonb ? 'eventName' OR e.event_name=$7::jsonb->>'eventName')
        AND (NOT $7::jsonb ? 'path' OR e.path=$7::jsonb->>'path')
        AND (NOT $7::jsonb ? 'origin' OR COALESCE(e.dimensions->>'origin',p.origin)=$7::jsonb->>'origin')
        AND (NOT $7::jsonb ? 'referrer' OR e.dimensions->>'referrerHost'=$7::jsonb->>'referrer')
        AND (NOT $7::jsonb ? 'language' OR e.dimensions->>'language'=$7::jsonb->>'language')
        AND (NOT $7::jsonb ? 'campaignSource' OR e.dimensions->'campaign'->>'source'=$7::jsonb->>'campaignSource')
        AND (NOT $7::jsonb ? 'campaignMedium' OR e.dimensions->'campaign'->>'medium'=$7::jsonb->>'campaignMedium')
        AND (NOT $7::jsonb ? 'campaignName' OR e.dimensions->'campaign'->>'campaign'=$7::jsonb->>'campaignName')
        AND (NOT $7::jsonb ? 'campaignTerm' OR e.dimensions->'campaign'->>'term'=$7::jsonb->>'campaignTerm')
        AND (NOT $7::jsonb ? 'campaignContent' OR e.dimensions->'campaign'->>'content'=$7::jsonb->>'campaignContent')
        AND ($8::text IS NULL OR CASE WHEN $9='missing' THEN NOT e.properties ? $8 ELSE e.properties->$8=jsonb_build_object('type',$9::text,'value',$10::jsonb) END)
    ), labeled AS MATERIALIZED (
      SELECT *,CASE $11::text
        WHEN 'event' THEN jsonb_build_object('type','string','value',event_name)
        WHEN 'path' THEN jsonb_build_object('type','string','value',path)
        WHEN 'origin' THEN jsonb_build_object('type','string','value',origin)
        WHEN 'property' THEN COALESCE(properties->$12::text,'{"type":"missing","value":null}'::jsonb)
        ELSE CASE WHEN dimension IS NULL THEN '{"type":"missing","value":null}'::jsonb
          ELSE jsonb_build_object('type',jsonb_typeof(dimension),'value',dimension) END END AS label
      FROM scope LEFT JOIN LATERAL (SELECT CASE $11::text
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
        count(*) FILTER (WHERE event_name<>'page_view') AS custom FROM scope GROUP BY 1
    ), keys AS MATERIALIZED (SELECT DISTINCT jsonb_object_keys(properties) AS key FROM scope),
    numbers AS (SELECT (label->>'value')::numeric AS value FROM labeled WHERE $11='property' AND label->>'type'='number' AND jsonb_typeof(label->'value')='number')
    SELECT EXISTS(SELECT 1 FROM target) AS allowed,(SELECT analytics_retained_from FROM target) AS retained_from,
      (SELECT start FROM bounds) AS start,(SELECT finish FROM bounds) AS finish,
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
      FROM scope`,[projectId,userId,query.from,query.to,query.timeZone,query.kind,JSON.stringify(query.filters),query.property?.key ?? null,
      query.property?.type ?? null,JSON.stringify(query.property?.value ?? null),query.groupBy,query.groupProperty]);
    await client.query('COMMIT');
    const row = rows[0];
    if (!row.allowed) throw new FoundationError(404,'Project not found or unavailable.');
    const start = row.start.toISOString(), end = row.finish.toISOString();
    const coverage = retentionCoverage(start,end,row.retained_from);
    const totals: Totals = row.totals;
    if (coverage.status === 'unavailable') for (const key of Object.keys(totals) as (keyof Totals)[]) totals[key] = null;
    const daily: Day[] = row.daily.map((day:Day) => {
      const from = new Date(day.start).toISOString(), to = new Date(day.end).toISOString();
      const status = retentionCoverage(from,to,row.retained_from).status;
      return {...day,start:from,end:to,skipped:from === to,coverage:status,...(status === 'unavailable' ? {events:null,pageViews:null,customEvents:null} : {})};
    });
    const result = {range:{from:query.from,to:query.to,timeZone:query.timeZone,start,end},query,coverage,totals,daily,
      breakdown:row.breakdown as {groups:Group[];totalGroups:number;returnedGroupEvents:number;truncated:boolean},
      properties:row.properties as {keys:string[];truncated:boolean},numeric:query.groupBy === 'property' && coverage.status !== 'unavailable' ? row.numeric as Numeric : null};
    return {...result,csv:explorerCsv(result)};
  } catch (error) {
    await client.query('ROLLBACK').catch(()=>{});
    if ((error as {code?:string}).code === '57014') throw new FoundationError(503,'This query took too long. Choose a shorter date range or more filters.');
    throw error;
  } finally {client.release();}
}

function explorerCsv(result:{query:ReturnType<typeof explorerQuery>;range:{start:string;end:string};coverage:ReturnType<typeof retentionCoverage>;totals:Totals;daily:Day[];breakdown:{groups:Group[];totalGroups:number;returnedGroupEvents:number;truncated:boolean};numeric:Numeric|null}) {
  const lines:unknown[][] = [['ten98-monitor','Bounded exploration result'],['Scope',JSON.stringify(result.query)],['Start (inclusive)',result.range.start],['End (exclusive)',result.range.end],
    ['Selection','Only instants in the selected local calendar dates; UTC envelopes can overlap at a repeated midnight.'],
    ['Retention coverage',result.coverage.status],['Retained from',result.coverage.retainedFrom ?? 'No retention boundary'],[],['Metric','Value'],...Object.entries(result.totals),[],
    ['Groups returned',result.breakdown.groups.length],['Total groups',result.breakdown.totalGroups],['Returned group events',result.breakdown.returnedGroupEvents],['Truncated',result.breakdown.truncated],
    ['Type','Value','Events','Identified events','Visitors'],...result.breakdown.groups.map(g=>[g.type,g.type === 'null' ? 'null' : g.type === 'missing' ? 'Missing / uncollected' : g.value,g.events,g.identifiedEvents,g.visitors]),[],
    ['Date','Start (inclusive)','End (exclusive)','Skipped local date','Coverage','Events','Page views','Custom events'],...result.daily.map(d=>[d.date,d.start,d.end,d.skipped,d.coverage,d.events,d.pageViews,d.customEvents])];
  if (result.numeric) lines.push([],['Numeric property statistic','Exact decimal value'],...Object.entries(result.numeric));
  return lines.map(line=>line.map(csvCell).join(',')).join('\r\n')+'\r\n';
}
