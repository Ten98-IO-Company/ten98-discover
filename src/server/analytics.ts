import { getDatabase } from './db.ts';
import { InputError } from './validation.ts';
import { FoundationError } from './auth.ts';
import { retentionCoverage } from './retention.ts';
import {publicAnalyticsSettings} from './native-analytics.ts';
import {environmentFields,environmentVersion,isEnvironmentFilter,type EnvironmentFilters,type AnalyticsEnvironment} from '../lib/analytics-environment.ts';

const dayMs = 86_400_000;
function dateValue(value: string): Date {
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(date.getTime()) ||
      date.getUTCFullYear() < 1970 || date.getUTCFullYear() > 9998 || date.toISOString().slice(0, 10) !== value) {
    throw new InputError(400, 'Choose valid dates in YYYY-MM-DD format.');
  }
  return date;
}

export function analyticsRange(params: URLSearchParams, now = new Date()) {
  for (const key of params.keys()) {
    if (!['from', 'to'].includes(key) || params.getAll(key).length !== 1) throw new InputError(400, 'Use one from date and one to date.');
  }
  if (params.has('from') !== params.has('to')) throw new InputError(400, 'Choose both a start date and an end date.');
  const today = now.toISOString().slice(0, 10);
  const from = params.get('from') ?? new Date(dateValue(today).getTime() - 6 * dayMs).toISOString().slice(0, 10);
  const to = params.get('to') ?? today;
  const start = dateValue(from);
  const finish = dateValue(to);
  const days = (finish.getTime() - start.getTime()) / dayMs + 1;
  if (days < 1 || days > 366) throw new InputError(400, 'Choose a date range of 1 to 366 days, with the start before the end.');
  return { from, to, timeZone: 'UTC' as const, start: start.toISOString(), end: new Date(finish.getTime() + dayMs).toISOString() };
}

export function analyticsQuery(params:URLSearchParams,now=new Date()) {
  for(const key of params.keys())if(!['from','to',...environmentFields].includes(key)||params.getAll(key).length!==1)throw new InputError(400,'Use each supported analytics filter only once.');
  const dates=new URLSearchParams(),filters:EnvironmentFilters={};
  for(const field of ['from','to'])if(params.has(field))dates.set(field,params.get(field)!);
  for(const field of environmentFields)if(params.has(field)){
    const value=params.get(field)!;
    if(!isEnvironmentFilter(field,value))throw new InputError(400,'Choose a supported browser, OS or device filter.');
    filters[field]=value;
  }
  return {range:analyticsRange(dates,now),filters};
}
export async function projectAnalytics(projectId: string, userId: string, params: URLSearchParams) {
  const {range,filters} = analyticsQuery(params);
  // One statement gives totals, buckets and rankings the same database snapshot.
  // ponytail: aggregate the selected range directly; add rollups after measured volume requires them.
  const { rows } = await getDatabase().pool.query(`
    WITH target AS MATERIALIZED (
      SELECT p.analytics_retained_from,p.analytics_settings FROM project p JOIN membership m ON m.workspace_id=p.workspace_id AND m.user_id=$2 WHERE p.id=$1
    ), observations AS MATERIALIZED (
      SELECT e.event_name,e.path,e.received_at,e.visitor_id,e.visit_id,e.dimensions,e.collection_basis
      FROM event e JOIN project p ON p.id=e.project_id
      JOIN membership m ON m.workspace_id=p.workspace_id AND m.user_id=$2
      WHERE e.project_id=$1 AND e.received_at >= $3::timestamptz AND e.received_at < $4::timestamptz
        AND (p.analytics_retained_from IS NULL OR e.received_at>=p.analytics_retained_from)
        AND (NOT $7::jsonb ? 'browser' OR CASE WHEN $7::jsonb->>'browser'='not-recorded' THEN e.dimensions->>'browser' IS NULL ELSE e.dimensions->>'browser'=$7::jsonb->>'browser' END)
        AND (NOT $7::jsonb ? 'os' OR CASE WHEN $7::jsonb->>'os'='not-recorded' THEN e.dimensions->>'os' IS NULL ELSE e.dimensions->>'os'=$7::jsonb->>'os' END)
        AND (NOT $7::jsonb ? 'device' OR CASE WHEN $7::jsonb->>'device'='not-recorded' THEN e.dimensions->>'device' IS NULL ELSE e.dimensions->>'device'=$7::jsonb->>'device' END)
    ), visits AS (
      SELECT visitor_id,visit_id,count(*) FILTER (WHERE event_name='page_view') AS pageviews,
        count(*) FILTER (WHERE event_name<>'page_view') AS custom,
        extract(epoch FROM (max(received_at) FILTER (WHERE event_name='page_view')-min(received_at) FILTER (WHERE event_name='page_view'))) AS duration
      FROM observations WHERE visit_id IS NOT NULL GROUP BY visitor_id,visit_id
      HAVING count(*) FILTER (WHERE event_name='page_view')>0
    ), buckets AS (
      SELECT (received_at AT TIME ZONE 'UTC')::date AS day,
        count(*) FILTER (WHERE event_name='page_view') AS views,
        count(*) FILTER (WHERE event_name<>'page_view') AS custom
      FROM observations GROUP BY 1
    ), calendar AS (
      SELECT generate_series($5::date::timestamp,$6::date::timestamp,interval '1 day')::date AS day
    ), pages AS (
      SELECT path,count(*) AS views FROM observations WHERE event_name='page_view'
      GROUP BY path ORDER BY views DESC,path ASC LIMIT 20
    ), names AS (
      SELECT event_name,count(*) AS total FROM observations WHERE event_name<>'page_view'
      GROUP BY event_name ORDER BY total DESC,event_name ASC LIMIT 20
    ), environment_observations AS MATERIALIZED (
      SELECT e.*,d.field,d.value FROM observations e CROSS JOIN LATERAL
        (VALUES ('browser',e.dimensions->>'browser'),('os',e.dimensions->>'os'),('device',e.dimensions->>'device')) d(field,value)
    ), environment_visits AS (
      SELECT field,value,visitor_id,visit_id,count(*) FILTER (WHERE event_name='page_view') AS pageviews,
        count(*) FILTER (WHERE event_name<>'page_view') AS custom,
        extract(epoch FROM (max(received_at) FILTER (WHERE event_name='page_view')-min(received_at) FILTER (WHERE event_name='page_view'))) AS duration
      FROM environment_observations WHERE visitor_id IS NOT NULL AND visit_id IS NOT NULL GROUP BY field,value,visitor_id,visit_id
      HAVING count(*) FILTER (WHERE event_name='page_view')>0
    ), environment_measurement AS (
      SELECT field,value,count(DISTINCT visitor_id) AS visitors,count(*) AS visits,
        100.0*count(*) FILTER (WHERE pageviews=1 AND custom=0)/NULLIF(count(*),0) AS bounce_rate,avg(duration) AS duration
      FROM environment_visits GROUP BY field,value
    ), environment_counts AS (
      SELECT field,value,count(*) FILTER (WHERE event_name='page_view') AS pageviews,
        count(*) FILTER (WHERE event_name='page_view' AND visitor_id IS NOT NULL) AS identified
      FROM environment_observations GROUP BY field,value HAVING count(*) FILTER (WHERE event_name='page_view')>0
    ), environment_rows AS MATERIALIZED (
      SELECT c.*,m.visitors,m.visits,m.bounce_rate,m.duration,
        json_build_object('value',c.value,'pageViews',c.pageviews,'identifiedPageViews',c.identified,
          'visitors',m.visitors,'visits',m.visits,'bounceRate',m.bounce_rate,'averageVisitSeconds',m.duration) AS row
      FROM environment_counts c LEFT JOIN environment_measurement m ON c.field=m.field AND c.value IS NOT DISTINCT FROM m.value
    )
    SELECT (SELECT analytics_retained_from FROM target) AS retained_from,(SELECT analytics_settings FROM target) AS analytics_settings,
      EXISTS(SELECT 1 FROM target) AS allowed,json_build_object(
      'totals',json_build_object('pageViews',count(*) FILTER (WHERE event_name='page_view'),
        'customEvents',count(*) FILTER (WHERE event_name<>'page_view')),
      'collection',json_build_object('captureCoverage','unknown','pageViews',json_build_object(
        'cookieless',count(*) FILTER (WHERE event_name='page_view' AND collection_basis='cookieless'),
        'consent',count(*) FILTER (WHERE event_name='page_view' AND collection_basis='consent'),
        'unknown',count(*) FILTER (WHERE event_name='page_view' AND collection_basis IS NULL))),
      'measurement',json_build_object('version','umami-3.4-hour-cache-v1',
        'identifiedPageViews',count(*) FILTER (WHERE event_name='page_view' AND visitor_id IS NOT NULL),
        'unidentifiedPageViews',count(*) FILTER (WHERE event_name='page_view' AND visitor_id IS NULL),
        'visitors',(SELECT CASE WHEN count(*)>0 THEN count(DISTINCT visitor_id) END FROM visits),
        'visits',(SELECT CASE WHEN count(*)>0 THEN count(*) END FROM visits),
        'bounceRate',(SELECT 100.0*count(*) FILTER (WHERE pageviews=1 AND custom=0)/NULLIF(count(*),0) FROM visits),
        'averageVisitSeconds',(SELECT avg(duration) FROM visits)),
      'daily',(SELECT json_agg(json_build_object('date',to_char(c.day,'YYYY-MM-DD'),
        'pageViews',COALESCE(b.views,0),'customEvents',COALESCE(b.custom,0)) ORDER BY c.day)
        FROM calendar c LEFT JOIN buckets b ON b.day=c.day),
      'pages',COALESCE((SELECT json_agg(json_build_object('path',path,'pageViews',views) ORDER BY views DESC,path ASC) FROM pages),'[]'::json),
      'events',COALESCE((SELECT json_agg(json_build_object('name',event_name,'count',total) ORDER BY total DESC,event_name ASC) FROM names),'[]'::json),
      'environment',json_build_object('version',$8::text,'filters',$7::jsonb,
        'browsers',COALESCE((SELECT json_agg(row ORDER BY visitors DESC NULLS LAST,pageviews DESC,value COLLATE "C" ASC NULLS LAST) FROM environment_rows WHERE field='browser'),'[]'::json),
        'operatingSystems',COALESCE((SELECT json_agg(row ORDER BY visitors DESC NULLS LAST,pageviews DESC,value COLLATE "C" ASC NULLS LAST) FROM environment_rows WHERE field='os'),'[]'::json),
        'devices',COALESCE((SELECT json_agg(row ORDER BY visitors DESC NULLS LAST,pageviews DESC,value COLLATE "C" ASC NULLS LAST) FROM environment_rows WHERE field='device'),'[]'::json),
        'coverage',json_build_object('pageViews',count(*) FILTER (WHERE event_name='page_view'),
          'recordedPageViews',count(*) FILTER (WHERE event_name='page_view' AND dimensions->>'environmentVersion'=$8::text),
          'notRecordedPageViews',count(*) FILTER (WHERE event_name='page_view' AND dimensions->>'environmentVersion' IS DISTINCT FROM $8::text),
          'firstRecordedAt',min(received_at) FILTER (WHERE event_name='page_view' AND dimensions->>'environmentVersion'=$8::text)),
        'method',json_build_object('source','bounded-request-user-agent','device','ua-parser-v1-screen-if-enabled','rawUserAgentStored',false)),
      'lastReceivedAt',max(received_at)
    ) AS report FROM observations`, [projectId, userId, range.start, range.end, range.from, range.to,JSON.stringify(filters),environmentVersion]);
  if (!rows[0].allowed) throw new FoundationError(404, 'Project not found or unavailable.');
  const coverage = retentionCoverage(range.start, range.end, rows[0].retained_from);
  const report = rows[0].report;
  report.collection.mode=publicAnalyticsSettings(rows[0].analytics_settings).collectionMode;
  const environment=report.environment as AnalyticsEnvironment;
  if(environment.coverage.firstRecordedAt!==null)environment.coverage.firstRecordedAt=new Date(environment.coverage.firstRecordedAt).toISOString();
  if (coverage.status === 'unavailable') {
    report.totals = { pageViews: null, customEvents: null };
    report.measurement.identifiedPageViews = null;
    report.measurement.unidentifiedPageViews = null;
    report.collection.pageViews={cookieless:null,consent:null,unknown:null};
    environment.browsers=[];environment.operatingSystems=[];environment.devices=[];
    environment.coverage={pageViews:null,recordedPageViews:null,notRecordedPageViews:null,firstRecordedAt:null};
  }
  report.daily = report.daily.map((day: { date: string; pageViews: number; customEvents: number }) => {
    const start = `${day.date}T00:00:00.000Z`;
    const status = retentionCoverage(start, new Date(Date.parse(start) + dayMs).toISOString(), rows[0].retained_from).status;
    return { ...day, ...(status === 'unavailable' ? { pageViews: null, customEvents: null } : {}), coverage: status };
  });
  return { range: { from: range.from, to: range.to, timeZone: range.timeZone }, ...report, coverage };
}
