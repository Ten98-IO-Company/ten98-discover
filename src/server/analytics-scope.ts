import type { explorerQuery } from './explorer-input.ts';
import {geographyProjectionSql,geographyFilterSql} from './geography-sql.ts';

// Shared event population and local-calendar boundaries for analytics reports.
// PostgreSQL ambiguous/gap midnight behavior is covered by the Explorer fixtures.
// Parameter slots3/4/5 are from, to and IANA timezone, shared with Explorer.
export const analyticsCalendarSql = `raw_days AS (
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
    )`;

export const analyticsScopeSql = `WITH RECURSIVE target AS MATERIALIZED (
      SELECT p.id,p.origin,p.analytics_retained_from FROM project p JOIN membership m ON m.workspace_id=p.workspace_id AND m.user_id=$2 WHERE p.id=$1
    ), ${analyticsCalendarSql}, geography_candidates AS MATERIALIZED (
      SELECT e.*,g.geography,COALESCE(e.dimensions->>'origin',p.origin) AS origin FROM event e JOIN target p ON p.id=e.project_id CROSS JOIN bounds b CROSS JOIN LATERAL (SELECT ${geographyProjectionSql('e')} AS geography) g
      WHERE e.received_at>=b.start AND e.received_at<b.finish AND (p.analytics_retained_from IS NULL OR e.received_at>=p.analytics_retained_from)
        AND (e.received_at AT TIME ZONE $5)::date BETWEEN $3::date AND $4::date
        AND ($6='all' OR ($6='pageviews' AND e.event_name='page_view') OR ($6='custom' AND e.event_name<>'page_view'))
        AND (NOT $7::jsonb ? 'eventName' OR e.event_name=$7::jsonb->>'eventName')
        AND (NOT $7::jsonb ? 'path' OR e.path=$7::jsonb->>'path')
        AND (NOT $7::jsonb ? 'origin' OR COALESCE(e.dimensions->>'origin',p.origin)=$7::jsonb->>'origin')
        AND (NOT $7::jsonb ? 'referrer' OR e.dimensions->>'referrerHost'=$7::jsonb->>'referrer')
        AND (NOT $7::jsonb ? 'language' OR e.dimensions->>'language'=$7::jsonb->>'language')
        AND (NOT $7::jsonb ? 'browser' OR CASE WHEN $7::jsonb->>'browser'='not-recorded' THEN e.dimensions->>'browser' IS NULL ELSE e.dimensions->>'browser'=$7::jsonb->>'browser' END)
        AND (NOT $7::jsonb ? 'os' OR CASE WHEN $7::jsonb->>'os'='not-recorded' THEN e.dimensions->>'os' IS NULL ELSE e.dimensions->>'os'=$7::jsonb->>'os' END)
        AND (NOT $7::jsonb ? 'device' OR CASE WHEN $7::jsonb->>'device'='not-recorded' THEN e.dimensions->>'device' IS NULL ELSE e.dimensions->>'device'=$7::jsonb->>'device' END)
        AND (NOT $7::jsonb ? 'campaignSource' OR e.dimensions->'campaign'->>'source'=$7::jsonb->>'campaignSource')
        AND (NOT $7::jsonb ? 'campaignMedium' OR e.dimensions->'campaign'->>'medium'=$7::jsonb->>'campaignMedium')
        AND (NOT $7::jsonb ? 'campaignName' OR e.dimensions->'campaign'->>'campaign'=$7::jsonb->>'campaignName')
        AND (NOT $7::jsonb ? 'campaignTerm' OR e.dimensions->'campaign'->>'term'=$7::jsonb->>'campaignTerm')
        AND (NOT $7::jsonb ? 'campaignContent' OR e.dimensions->'campaign'->>'content'=$7::jsonb->>'campaignContent')
        AND ($8::text IS NULL OR CASE WHEN $9='missing' THEN NOT e.properties ? $8 ELSE e.properties->$8=jsonb_build_object('type',$9::text,'value',$10::jsonb) END)
    ), scope AS MATERIALIZED (SELECT * FROM geography_candidates WHERE ${geographyFilterSql('$7::jsonb')})`;

export function analyticsScopeValues(projectId:string,userId:string,query:ReturnType<typeof explorerQuery>):unknown[] {
  return [projectId,userId,query.from,query.to,query.timeZone,query.kind,JSON.stringify(query.filters),query.property?.key??null,query.property?.type??null,JSON.stringify(query.property?.value??null)];
}
