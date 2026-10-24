import type {PoolClient} from 'pg';
import {FoundationError} from './auth.ts';
import type { explorerQuery } from './explorer-input.ts';
import {visitScopeFields} from './analytics-visits.ts';
import {recordedDimensionSql} from './analytics-dimensions.ts';
import {geographyProjectionSql,geographyFilterSql} from './geography-sql.ts';

// Shared event population and local-calendar boundaries for analytics reports.
// PostgreSQL ambiguous/gap midnight behavior is covered by the Explorer fixtures.
// Parameter slots3/4/5 are from, to and IANA timezone, shared with Explorer.
function calendarSql(from:string,to:string){return `raw_days AS (
      SELECT day,day AT TIME ZONE $5 AS nominal FROM generate_series(${from}::timestamp,(${to}+1)::timestamp,interval '1 day') day
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
    )`;}
export const analyticsCalendarSql=calendarSql('$3::date','$4::date');

const environmentFilterSql=`(NOT $7::jsonb ? 'browser' OR CASE WHEN $7::jsonb->>'browser'='not-recorded' THEN e.dimensions->>'browser' IS NULL ELSE e.dimensions->>'browser'=$7::jsonb->>'browser' END)
        AND (NOT $7::jsonb ? 'os' OR CASE WHEN $7::jsonb->>'os'='not-recorded' THEN e.dimensions->>'os' IS NULL ELSE e.dimensions->>'os'=$7::jsonb->>'os' END)
        AND (NOT $7::jsonb ? 'device' OR CASE WHEN $7::jsonb->>'device'='not-recorded' THEN e.dimensions->>'device' IS NULL ELSE e.dimensions->>'device'=$7::jsonb->>'device' END)`;
function scopeSql(calendar:string,from:string,to:string,shared=false){return `WITH RECURSIVE target AS MATERIALIZED (
      ${shared?boardShareProjectTargetSql:'SELECT p.id,p.origin,p.analytics_retained_from FROM project p JOIN membership m ON m.workspace_id=p.workspace_id AND m.user_id=$2 WHERE p.id=$1'}
    ), ${calendar}, geography_candidates AS MATERIALIZED (
      SELECT e.*,g.geography,COALESCE(e.dimensions->>'origin',p.origin) AS origin FROM event e JOIN target p ON p.id=e.project_id CROSS JOIN bounds b CROSS JOIN LATERAL (SELECT ${geographyProjectionSql('e')} AS geography) g
      WHERE e.received_at>=b.start AND e.received_at<b.finish AND (p.analytics_retained_from IS NULL OR e.received_at>=p.analytics_retained_from)
        AND (e.received_at AT TIME ZONE $5)::date BETWEEN ${from} AND ${to}
        AND ($6='all' OR ($6='pageviews' AND e.event_name='page_view') OR ($6='custom' AND e.event_name<>'page_view'))
        AND (NOT $7::jsonb ? 'eventName' OR e.event_name=$7::jsonb->>'eventName')
        AND (NOT $7::jsonb ? 'path' OR e.path=$7::jsonb->>'path')
        AND (NOT $7::jsonb ? 'origin' OR COALESCE(e.dimensions->>'origin',p.origin)=$7::jsonb->>'origin')
        AND (NOT $7::jsonb ? 'hostname' OR ${recordedDimensionSql('hostname','e')}=$7::jsonb->>'hostname')
        AND (NOT $7::jsonb ? 'screen' OR ${recordedDimensionSql('screen','e')}=$7::jsonb->>'screen')
        AND (NOT $7::jsonb ? 'channel' OR ${recordedDimensionSql('channel','e')}=$7::jsonb->>'channel')
        AND (NOT $7::jsonb ? 'referrer' OR e.dimensions->>'referrerHost'=$7::jsonb->>'referrer')
        AND (NOT $7::jsonb ? 'language' OR e.dimensions->>'language'=$7::jsonb->>'language')
        AND ${environmentFilterSql}
        AND (NOT $7::jsonb ? 'campaignSource' OR e.dimensions->'campaign'->>'source'=$7::jsonb->>'campaignSource')
        AND (NOT $7::jsonb ? 'campaignMedium' OR e.dimensions->'campaign'->>'medium'=$7::jsonb->>'campaignMedium')
        AND (NOT $7::jsonb ? 'campaignName' OR e.dimensions->'campaign'->>'campaign'=$7::jsonb->>'campaignName')
        AND (NOT $7::jsonb ? 'campaignTerm' OR e.dimensions->'campaign'->>'term'=$7::jsonb->>'campaignTerm')
        AND (NOT $7::jsonb ? 'campaignContent' OR e.dimensions->'campaign'->>'content'=$7::jsonb->>'campaignContent')
        AND ($8::text IS NULL OR CASE WHEN $9='missing' THEN NOT e.properties ? $8 ELSE e.properties->$8=jsonb_build_object('type',$9::text,'value',$10::jsonb) END)
    ), scope AS MATERIALIZED (SELECT * FROM geography_candidates WHERE ${geographyFilterSql('$7::jsonb')})`;}
export const analyticsScopeSql=scopeSql(analyticsCalendarSql,'$3::date','$4::date');
/**
 * Whole-visit page views for visitMetricsSql: every retained report-window page view of a visit with a page view in `population`.
 * Environment and location filters keep scoping each visit, as on the dashboard; every other filter only selects visits.
 */
export function scopedVisitPagesSql(population:string,customVisits:string,query:ReturnType<typeof explorerQuery>){
 // Without a visit-selecting filter, the population already holds every scoped page view of its visits.
 const selects=!!query.property||!!query.predicates||Object.keys(query.filters).some(field=>!visitScopeFields.includes(field));
 if(!selects)return `SELECT s.*,c.visit_id IS NOT NULL AS visit_has_custom FROM ${population} s LEFT JOIN ${customVisits} c USING(visitor_id,visit_id) WHERE s.event_name='page_view'`;
 return `SELECT v.*,c.visit_id IS NOT NULL AS visit_has_custom FROM (
      SELECT e.*,g.geography,COALESCE(e.dimensions->>'origin',p.origin) AS origin FROM event e JOIN target p ON p.id=e.project_id CROSS JOIN bounds b CROSS JOIN LATERAL (SELECT ${geographyProjectionSql('e')} AS geography) g
      WHERE e.event_name='page_view' AND e.received_at>=b.start AND e.received_at<b.finish AND (p.analytics_retained_from IS NULL OR e.received_at>=p.analytics_retained_from)
        AND (e.received_at AT TIME ZONE $5)::date BETWEEN $3::date AND $4::date
        AND ${environmentFilterSql}
        AND (e.visitor_id,e.visit_id) IN (SELECT visitor_id,visit_id FROM ${population} WHERE event_name='page_view')
    ) v LEFT JOIN ${customVisits} c USING(visitor_id,visit_id) WHERE ${geographyFilterSql('$7::jsonb')}`;
}
// Closed Revenue-only expressions; no caller-controlled identifiers or date rebasing.
export const analyticsRevenuePeriodScopeSql=scopeSql(calendarSql('revenue_period.from_day','revenue_period.to_day'),'revenue_period.from_day','revenue_period.to_day');

export function analyticsScopeValues(projectId:string,userId:string,query:ReturnType<typeof explorerQuery>):unknown[] {
  return [projectId,userId,query.from,query.to,query.timeZone,query.kind,JSON.stringify(query.filters),query.property?.key??null,query.property?.type??null,JSON.stringify(query.property?.value??null)];
}

// Only the locked board-share reader constructs this context. It is not a session/API-key principal.
// SQL repeats the current grant/card/entity binding; a structural TS value is not authority.
export type BoardShareReadContext={workspaceId:string;boardId:string;boardRevision:number;shareId:string;grantRevision:number;
 cardId:string;cardType:string;entityId:string;entityKind:'website'|'link'|'pixel'|'none';tokenHash:string;deadline:number;analysisId?:string;analysisRevision?:number};
export const boardShareProjectTargetSql=`SELECT p.id,p.origin,p.analytics_settings,p.analytics_retained_from,w.raw_analytics_days
 FROM project p JOIN workspace w ON w.id=p.workspace_id JOIN custom_board b ON b.workspace_id=w.id
 JOIN board_share g ON g.board_id=b.id
 CROSS JOIN LATERAL jsonb_array_elements(b.definition->'rows') r
 CROSS JOIN LATERAL jsonb_array_elements(r->'cards') card
 CROSS JOIN LATERAL(SELECT COALESCE(NULLIF(card->'entity','null'::jsonb),b.definition->'defaultEntity') AS value) ref
 WHERE p.id=$1 AND p.workspace_id=$2::jsonb->>'workspaceId'
 AND b.id=($2::jsonb->>'boardId')::uuid AND b.revision=($2::jsonb->>'boardRevision')::integer
 AND g.id=($2::jsonb->>'shareId')::uuid AND g.revision=($2::jsonb->>'grantRevision')::integer
 AND g.board_revision=b.revision AND g.token_hash=$2::jsonb->>'tokenHash'
 AND g.revoked_at IS NULL AND g.expires_at>clock_timestamp()
 AND card->>'id'=$2::jsonb->>'cardId' AND(card->>'id')::uuid=ANY(g.selected_card_ids)
 AND card->>'type'=$2::jsonb->>'cardType' AND(card->>'type' NOT IN('Goal','Funnel')OR(card->>'analysisId'=$2::jsonb->>'analysisId' AND card->>'analysisRevision'=$2::jsonb->>'analysisRevision')) AND ref.value->>'kind'='website'
 AND ref.value->>'id'=p.id AND $2::jsonb->>'entityKind'='website' AND $2::jsonb->>'entityId'=p.id`;
export const boardShareAnalyticsScopeSql=scopeSql(analyticsCalendarSql,'$3::date','$4::date',true);
/** Trusted caller deadline; no HTTP input or membership substitute. The outer transaction owns the hard total. */
export async function boardShareSqlBudget(client:PoolClient,context:BoardShareReadContext){
 const remaining=context.deadline-Date.now();if(!Number.isSafeInteger(remaining)||remaining<=0)throw new FoundationError(503,'This shared read exceeded its time limit.');
 await client.query("SELECT set_config('statement_timeout',$1,true),set_config('lock_timeout',$1,true)",[Math.min(5000,remaining)+'ms']);
}