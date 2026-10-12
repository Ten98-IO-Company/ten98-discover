import { getDatabase } from './db.ts';
import { InputError } from './validation.ts';

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

export async function projectAnalytics(projectId: string, userId: string, params: URLSearchParams) {
  const range = analyticsRange(params);
  // One statement gives totals, buckets and rankings the same database snapshot.
  // ponytail: aggregate the selected range directly; add rollups after measured volume requires them.
  const { rows } = await getDatabase().pool.query(`
    WITH observations AS MATERIALIZED (
      SELECT e.event_name,e.path,e.received_at,e.visitor_id,e.visit_id,e.dimensions
      FROM event e JOIN project p ON p.id=e.project_id
      JOIN membership m ON m.workspace_id=p.workspace_id AND m.user_id=$2
      WHERE e.project_id=$1 AND e.received_at >= $3::timestamptz AND e.received_at < $4::timestamptz
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
    )
    SELECT json_build_object(
      'totals',json_build_object('pageViews',count(*) FILTER (WHERE event_name='page_view'),
        'customEvents',count(*) FILTER (WHERE event_name<>'page_view')),
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
      'lastReceivedAt',max(received_at)
    ) AS report FROM observations`, [projectId, userId, range.start, range.end, range.from, range.to]);
  return { range: { from: range.from, to: range.to, timeZone: range.timeZone }, ...rows[0].report };
}
