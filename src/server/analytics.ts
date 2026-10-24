import { getDatabase } from './db.ts';
import { InputError } from './validation.ts';
import { FoundationError } from './auth.ts';
import { retentionCoverage } from './retention.ts';
import {publicAnalyticsSettings} from './native-analytics.ts';
import {environmentFields,environmentVersion,isEnvironmentFilter,type EnvironmentFilters,type AnalyticsEnvironment} from '../lib/analytics-environment.ts';
import {deriveAnalyticsComparison,type AnalyticsComparisonMode,type AnalyticsComparison,type AnalyticsPeriodReport,type AnalyticsReport} from '../lib/analytics-comparison.ts';
import {geographyFields,geographyFiltersValid,geographySearch,type GeographyFilters,type GeographyDetailIntent,type GeographyDetail,serializeGeographyKey,type GeoField} from '../lib/analytics-geography.ts';
import {geographyProjectionSql,geographyFilterSql,geographyAggregateCtes,geographyKeyColumnsSql,geographyKeyColumns,geographyValuesSql,geographyReportSql,geographyDetailSql,geographyKeyOrderSql,applyGeographyCoverage} from './geography-sql.ts';
import {analyticsDimensions,analyticsSelectionFields,type AnalyticsDimension,type AnalyticsDimensionComparison,type AnalyticsDimensionMetrics,type AnalyticsDimensionRow} from '../lib/analytics-dimensions.ts';
import {parseAdvancedPredicates,type AdvancedPredicates} from './advanced-predicate-input.ts';
import {advancedPredicateSql} from './advanced-predicates.ts';
import {analyticsDimensionValueSql,analyticsCustomVisitsSql,selfReferralSql} from './analytics-dimensions.ts';
import {visitMetricsSql,matchedVisitsSql,visitScopeFields,visitValuesSql,valueCountsSql,valueVisitsSql,visitMeasurementSql} from './analytics-visits.ts';

export const analyticsSummarySql={
 totals:`json_build_object('pageViews',count(*) FILTER (WHERE event_name='page_view'),
        'customEvents',count(*) FILTER (WHERE event_name<>'page_view'))`,
 // Reads a `visits` CTE from analytics-visits.ts. v2 marks that definition's deliberate departure from pinned Umami 3.4.0's
 // filtered getWebsiteStats: a filtered population counts visits with a matching page view and measures each whole visit.
 // Distinct visitor counts sort visitor_id under "C" to avoid strcoll. The count cannot change: event_identity_pair (migration 0012)
 // admits only NULL or 64 lowercase hex characters, which are equal under any collation exactly when their bytes are.
 measurement:`json_build_object('version','umami-3.4-visit-scoped-v2',
        'identifiedPageViews',count(*) FILTER (WHERE event_name='page_view' AND visitor_id IS NOT NULL),
        'unidentifiedPageViews',count(*) FILTER (WHERE event_name='page_view' AND visitor_id IS NULL),
        'visitors',(SELECT CASE WHEN count(*)>0 THEN count(DISTINCT visitor_id COLLATE "C") END FROM visits),
        'visits',(SELECT CASE WHEN count(*)>0 THEN count(*) END FROM visits),
        'bounceRate',(SELECT 100.0*count(*) FILTER (WHERE pageviews=1 AND NOT custom)/NULLIF(count(*),0) FROM visits),
        'averageVisitSeconds',(SELECT avg(duration) FROM visits))`,
};
const environmentColumns={browser:'browser',os:'os',device:'device'};
const valueColumns=[...Object.values(environmentColumns),'geo_id'];
// The report CTEs read the event's `dimensions` through these columns only (#414): carried through every materialized CTE, the
// whole object made each scan and sort spill to disk. Only a selection predicate or dimension label still reads `dimensions`.
// Grouped text is C-collated, so hashing or sorting it never calls the locale's strcoll: equality, and so every group, is unchanged
// under a deterministic collation, and each ordering of these values names its collation.
const eventColumnsSql=(e:string,selfReferral:string)=>`(${e}.dimensions->>'browser') COLLATE "C" AS browser,(${e}.dimensions->>'os') COLLATE "C" AS os,(${e}.dimensions->>'device') COLLATE "C" AS device,
        ${e}.dimensions->>'environmentVersion' AS environment_version,
        CASE WHEN ${e}.event_name='page_view' AND jsonb_typeof(${e}.dimensions->'referrerHost')='string' AND length(${e}.dimensions->>'referrerHost') BETWEEN 1 AND 2048 AND NOT ${selfReferral} THEN ${e}.dimensions->>'referrerHost' END COLLATE "C" AS referrer_host`;
// visitValuesSql reads these from both `observations` and the selection's `visit_scope`; geo_id names the row of geography_values.
const visitScopeColumnsSql=(s:string)=>`${s}.visitor_id COLLATE "C" AS visitor_id,${s}.visit_id COLLATE "C" AS visit_id,`+['id','event_name','received_at','visit_has_custom',...valueColumns].map(column=>`${s}.${column}`).join(',');
const observationColumnsSql=(s:string,label:string)=>`${s}.period,${s}.path,${s}.collection_basis,${s}.environment_version,${s}.referrer_host,${visitScopeColumnsSql(s)},${label} AS label`;
export function hideAnalyticsSummary(summary:Pick<AnalyticsPeriodReport,'totals'|'measurement'>){
 summary.totals={pageViews:null,customEvents:null};summary.measurement.identifiedPageViews=null;summary.measurement.unidentifiedPageViews=null;
}
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
  if((params.has('dimension')||params.has('selection'))&&params.toString().length>20000)throw new InputError(400,'The analytics query is too large.');
  for(const key of params.keys())if(!['from','to','compare','dimension','selection','geoDetail','geoSearch','geoPeriod',...environmentFields,...geographyFields].includes(key)||params.getAll(key).length!==1)throw new InputError(400,'Use each supported analytics filter only once.');
  const compare=params.get('compare');if(compare!==null&&!['prev','yoy'].includes(compare))throw new InputError(400,'Choose previous period or previous year.');
  const dimension=params.get('dimension');if(dimension!==null&&(!compare||!analyticsDimensions.includes(dimension as AnalyticsDimension)))throw new InputError(400,'Choose a supported comparison dimension and comparison period.');
  let selection:AdvancedPredicates|undefined,selectionQuery:string|undefined;
  if(params.has('selection')){
    const selected=new URLSearchParams(params.get('selection')!);for(const key of selected.keys())if(![...analyticsSelectionFields,'predicates'].includes(key as never)||selected.getAll(key).length!==1)throw new InputError(400,'Use each supported selection filter only once.');
    let raw:unknown;try{raw=selected.has('predicates')?JSON.parse(selected.get('predicates')!):{version:1,match:'all',fields:[],properties:[]};}catch{throw new InputError(400,'Check the selection filters.');}
    const fields=analyticsSelectionFields.filter(field=>selected.has(field)).map(field=>({field,operator:'eq',value:selected.get(field)!}));
    if(raw&&typeof raw==='object'&&!Array.isArray(raw)&&Array.isArray((raw as AdvancedPredicates).fields))raw={...raw,fields:[...(raw as AdvancedPredicates).fields,...fields]};
    selection=parseAdvancedPredicates(raw);
    if(selection.match!=='all'||selection.properties.length||selection.sessionProperties?.length||selection.fields.some(f=>!analyticsSelectionFields.includes(f.field as never)||!['eq','exists','missing'].includes(f.operator))||new Set(selection.fields.map(f=>f.field)).size!==selection.fields.length)throw new InputError(400,'Use matching literal, recorded or missing selection fields.');
    selectionQuery=new URLSearchParams({predicates:JSON.stringify(selection)}).toString();
    const canonical=new URLSearchParams(params);canonical.set('selection',selectionQuery);if(canonical.toString().length>20000)throw new InputError(400,'The analytics query is too large.');
  }
  let detail:GeographyDetailIntent|undefined;
  if(params.has('geoDetail')){
    const field=params.get('geoDetail'),period=params.get('geoPeriod')??'current',search=geographySearch(params.get('geoSearch')??'');
    if(field!=='region'&&field!=='city'||period!=='current'&&period!=='comparison'||period==='comparison'&&!compare||search===null)throw new InputError(400,'Choose a region or city, a valid period and a location search of at most 128 characters.');
    detail={field,period,search};
  }else if(params.has('geoSearch')||params.has('geoPeriod'))throw new InputError(400,'Choose region or city details before searching locations.');
  const dates=new URLSearchParams(),filters:EnvironmentFilters={},geographyFilters:GeographyFilters={};
  for(const field of ['from','to'])if(params.has(field))dates.set(field,params.get(field)!);
  for(const field of environmentFields)if(params.has(field)){
    const value=params.get(field)!;
    if(!isEnvironmentFilter(field,value))throw new InputError(400,'Choose a supported browser, OS or device filter.');
    filters[field]=value;
  }
  for(const field of geographyFields)if(params.has(field))geographyFilters[field]=params.get(field)!;
  if(!geographyFiltersValid(geographyFilters))throw new InputError(400,'Choose compatible location filters.');
  return {range:analyticsRange(dates,now),filters,geographyFilters,...compare===null?{}:{compare:compare as AnalyticsComparisonMode},...detail?{detail}:{},...dimension===null?{}:{dimension:dimension as AnalyticsDimension},...selection?{selection,selectionQuery}:{}};
}
/** Only readWebsiteShare constructs this after its locator; SQL repeats the grant binding, so a structural value is not authority. */
export type AnalyticsShareContext={shareId:string;tokenHash:string};
const memberJoin='JOIN membership m ON m.workspace_id=p.workspace_id AND m.user_id=$2';
const shareJoin="JOIN project_share s ON s.project_id=p.id AND s.id=($2::jsonb->>'shareId')::uuid AND s.token_hash=$2::jsonb->>'tokenHash' AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()";
export async function projectAnalytics(projectId: string, userId: string, params: URLSearchParams,apiKeyId?:string,share?:AnalyticsShareContext):Promise<AnalyticsReport> {
  const {range,filters,geographyFilters,compare,detail,dimension,selection,selectionQuery} = analyticsQuery(params),derived=compare?deriveAnalyticsComparison(range,compare):null;
  if(compare&&!derived)throw new InputError(400,'Choose a later start date so the comparison stays on or after 1970-01-01.');
  const client=await getDatabase().pool.connect();
  const values:unknown[]=[projectId,share?JSON.stringify(share):userId,range.start,range.end,range.from,range.to,JSON.stringify(filters),environmentVersion,derived?.range.start??null,derived?.range.end??null,derived?.range.from??null,derived?.range.to??null,apiKeyId??null,JSON.stringify(geographyFilters),detail?JSON.stringify(detail):null,dimension??null];
  const predicate=advancedPredicateSql(selection,value=>{values.push(value);return '$'+values.length;},'UTC');
  // A selection only picks visits; environment and location filters keep scoping each visit. Without one the selected rows are the scope.
  const visitScope=selection?'scoped_observations':undefined;
  // Environment and location rows measure each matching visit over its rows with the row's value, like the matching filter would.
  const scopedVisitsSql=(matches:string,labels:(source:string)=>string,keys:string[])=>visitScope
    ?matchedVisitsSql(matches,`(${visitMetricsSql(`(${labels(visitScope)}) scope`,keys)})`,[],[...keys,'visitor_id','visit_id']):visitMetricsSql(matches,keys);
  // The same for the overview's environment and location rows, from visitValuesSql rows of `observations` and the selected `visit_scope`.
  const valueScopedVisitsSql=(fields:Record<string,string>,as:string,from=(values:string)=>values)=>visitScope
    ?matchedVisitsSql(`(SELECT *,'page_view' AS event_name FROM (${valueVisitsSql(from('visit_values'),fields,as)}) v) matches`,
      `(${valueVisitsSql(from('scope_values'),fields,as)})`,[],['field',as,'visitor_id','visit_id'])
    :valueVisitsSql(from('visit_values'),fields,as);
  let epoch:string|undefined;
  try{
  // The statement's time goes to hashing, not expression evaluation, so JIT's ~0.2 s compile only adds to it (#414). Its CTE row
  // estimates are often near 1, which may plan a nested loop over event rows against a lookup CTE: quadratic at volume. Nested loops stay
  // where nothing else applies (cross, lateral and range joins); every equality join hashes or merges.
  if(client){await client.query('BEGIN');await client.query("SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='5s'; SET LOCAL jit=off; SET LOCAL enable_nestloop=off");}
  if(client&&share){
    // Public website share: no workspace gate, grant lock or project row lock, so no writer ever waits for (or starves behind) a public
    // reader. The epoch read here and rechecked before COMMIT refuses a read that a reset, settings save or restore committed during.
    epoch=(await client.query<{analytics_epoch:string}>('SELECT analytics_epoch FROM project WHERE id=$1',[projectId])).rows[0]?.analytics_epoch;
    if(!epoch)throw new FoundationError(404,'Project not found or unavailable.');
  }else if(client){
    const hint=(await client.query('SELECT p.workspace_id FROM project p JOIN membership m ON m.workspace_id=p.workspace_id AND m.user_id=$2 WHERE p.id=$1',[projectId,userId])).rows[0]?.workspace_id;
    if(!hint)throw new FoundationError(404,'Project not found or unavailable.');
    // Publication gate shared with native report reads. The aggregation clock and
    // current key/membership checks run only after this possible authority wait.
    await client.query('SELECT id FROM workspace WHERE id=$1 FOR SHARE',[hint]);
  }
  // One statement gives totals, buckets and rankings the same database snapshot.
  // ponytail: aggregate the selected range directly; add rollups after measured volume requires them.
  const { rows } = await (client??getDatabase().pool).query(`
    WITH clock AS MATERIALIZED (SELECT clock_timestamp() AS as_of),
    key_authority AS MATERIALIZED (SELECT $13::uuid IS NULL OR EXISTS(SELECT 1 FROM api_key k
      JOIN membership m ON m.workspace_id=k.workspace_id AND m.user_id=k.issuer_user_id JOIN project p ON p.workspace_id=k.workspace_id AND p.id=$1 CROSS JOIN clock c
      JOIN "user" u ON u.id=k.issuer_user_id
      WHERE k.id=$13::uuid AND k.issuer_user_id=$2 AND m.role IN('owner','admin','editor','viewer') AND 'analytics:read'=ANY(k.scopes)
        AND k.revoked_at IS NULL AND k.expires_at>c.as_of
        AND (u."twoFactorEnabled" OR NOT EXISTS(SELECT 1 FROM workspace_two_factor_requirement r WHERE r.workspace_id=k.workspace_id))) AS valid),
    target AS MATERIALIZED (
      SELECT p.analytics_retained_from,p.analytics_settings,p.origin FROM project p ${share?shareJoin:memberJoin}
      CROSS JOIN key_authority k WHERE p.id=$1 AND k.valid
    ), periods AS (SELECT 'current' AS period,$3::timestamptz AS start,$4::timestamptz AS finish,$5::date AS from_day,$6::date AS to_day
      UNION ALL SELECT 'comparison',$9::timestamptz,$10::timestamptz,$11::date,$12::date WHERE $9::timestamptz IS NOT NULL),
    custom_visits AS MATERIALIZED (
      SELECT q.period,v.* FROM periods q CROSS JOIN LATERAL (${analyticsCustomVisitsSql('q.start','q.finish')}) v
    ),
    -- The geography projection and the self-referral test depend only on stored values, so each runs once per distinct value (#414):
    -- the geography's jsonb text, and the referrer host with the recorded origin. One scan collects both sets. The text is the exact
    -- key: jsonb equality would merge numerically equal but differently written numbers, whose text the projection measures.
    stored_values AS MATERIALIZED (
      SELECT raw,host,origin,GROUPING(raw)=1 AS referrer FROM (
        SELECT COALESCE((e.dimensions->'geography')::text,'') COLLATE "C" AS raw,(e.dimensions->>'referrerHost') COLLATE "C" AS host,(e.dimensions->>'origin') COLLATE "C" AS origin
        FROM periods q CROSS JOIN event e CROSS JOIN target p
        WHERE e.project_id=$1 AND e.received_at >= q.start AND e.received_at < q.finish AND (p.analytics_retained_from IS NULL OR e.received_at>=p.analytics_retained_from)
      ) e GROUP BY GROUPING SETS ((raw),(host,origin))
    ), geography_values AS MATERIALIZED (
      SELECT row_number() OVER () AS geo_id,raw,geography,${geographyKeyColumnsSql('geography')} FROM (SELECT r.raw,${geographyProjectionSql('e')} AS geography
        FROM stored_values r CROSS JOIN LATERAL (SELECT jsonb_build_object('geography',NULLIF(r.raw,'')::jsonb) AS dimensions) e WHERE NOT r.referrer OFFSET 0) g
    ), referrer_values AS MATERIALIZED (
      SELECT r.host,r.origin,${selfReferralSql('e')} AS self FROM stored_values r CROSS JOIN LATERAL (SELECT jsonb_build_object('referrerHost',r.host,'origin',r.origin) AS dimensions) e
      WHERE r.referrer AND r.host IS NOT NULL AND r.origin IS NOT NULL
    ), geography_candidates AS (
      SELECT q.period,e.id,e.event_name,e.path,e.received_at,e.visitor_id,e.visit_id,e.collection_basis,g.geo_id,g.geography,
        ${eventColumnsSql('e','COALESCE(rv.self,false)')}${selection||dimension?`,e.dimensions,COALESCE(e.dimensions->>'origin',p.origin) AS origin`:''}
      FROM periods q CROSS JOIN event e CROSS JOIN target p LEFT JOIN geography_values g ON g.raw=COALESCE((e.dimensions->'geography')::text,'') COLLATE "C"
        LEFT JOIN referrer_values rv ON rv.host=(e.dimensions->>'referrerHost') COLLATE "C" AND rv.origin=(e.dimensions->>'origin') COLLATE "C"
      WHERE e.project_id=$1 AND e.received_at >= q.start AND e.received_at < q.finish
        AND (p.analytics_retained_from IS NULL OR e.received_at>=p.analytics_retained_from)
        AND (NOT $7::jsonb ? 'browser' OR CASE WHEN $7::jsonb->>'browser'='not-recorded' THEN e.dimensions->>'browser' IS NULL ELSE e.dimensions->>'browser'=$7::jsonb->>'browser' END)
        AND (NOT $7::jsonb ? 'os' OR CASE WHEN $7::jsonb->>'os'='not-recorded' THEN e.dimensions->>'os' IS NULL ELSE e.dimensions->>'os'=$7::jsonb->>'os' END)
        AND (NOT $7::jsonb ? 'device' OR CASE WHEN $7::jsonb->>'device'='not-recorded' THEN e.dimensions->>'device' IS NULL ELSE e.dimensions->>'device'=$7::jsonb->>'device' END)
    ), scoped_observations AS (SELECT s.*,c.visit_id IS NOT NULL AS visit_has_custom FROM geography_candidates s LEFT JOIN custom_visits c ON c.period=s.period AND c.visitor_id=s.visitor_id AND c.visit_id=s.visit_id WHERE ${geographyFilterSql('$14::jsonb')}),
    all_observations AS ${selection||dimension?"MATERIALIZED":"NOT MATERIALIZED"} (SELECT ${observationColumnsSql('s',dimension?analyticsDimensionValueSql('$16::text','s'):'NULL::jsonb')} FROM scoped_observations s WHERE (${predicate})),
    visit_metrics AS MATERIALIZED (${visitMetricsSql(visitScope??'all_observations',['period'])}),
    dimension_labeled AS MATERIALIZED (SELECT * FROM all_observations WHERE $16::text IS NOT NULL AND (CASE WHEN $16='event' THEN event_name<>'page_view' ELSE true END)),
    dimension_visits AS (${dimension&&visitScopeFields.includes(dimension)
      ?scopedVisitsSql('dimension_labeled',source=>`SELECT s.*,${analyticsDimensionValueSql('$16::text','s')} AS label FROM ${source} s`,['period','label'])
      :matchedVisitsSql('dimension_labeled','visit_metrics',['label'],['period','visitor_id','visit_id'])}),
    dimension_measurement AS MATERIALIZED (SELECT period,label,count(DISTINCT visitor_id COLLATE "C") AS visitors,count(*) AS visits,100.0*count(*) FILTER(WHERE pageviews=1 AND NOT custom)/NULLIF(count(*),0) AS bounce,avg(duration) AS duration FROM dimension_visits GROUP BY period,label),
    dimension_counts AS (SELECT period,label,count(*) FILTER(WHERE event_name='page_view') AS pageviews,count(*) FILTER(WHERE event_name<>'page_view') AS custom,count(*) FILTER(WHERE event_name='page_view' AND visitor_id IS NOT NULL) AS identified
      FROM dimension_labeled GROUP BY period,label HAVING CASE WHEN $16='event' THEN count(*) FILTER(WHERE event_name<>'page_view')>0 ELSE count(*) FILTER(WHERE event_name='page_view')>0 END),
    dimension_groups AS MATERIALIZED (SELECT a.*,m.visitors,m.visits,m.bounce,m.duration FROM dimension_counts a LEFT JOIN dimension_measurement m ON a.period=m.period AND a.label IS NOT DISTINCT FROM m.label),
    dimension_ranked AS (SELECT *,row_number() OVER(PARTITION BY period ORDER BY CASE WHEN $16='event' THEN custom ELSE visitors END DESC NULLS LAST,pageviews DESC,(CASE WHEN $16 IN ('country','region','city') THEN ${geographyKeyOrderSql('label')} ELSE label::text END) COLLATE "C" ASC NULLS FIRST) AS rank FROM dimension_groups)
    SELECT q.period,c.as_of,(SELECT valid FROM key_authority) AS key_valid,
      EXISTS(SELECT 1 FROM dimension_labeled WHERE $16 NOT IN ('country','region','city') AND label IS NOT NULL AND jsonb_typeof(label)<>'string') AS dimension_invalid,
      (SELECT count(*) FROM dimension_groups WHERE period=q.period) AS dimension_groups,
      COALESCE((SELECT json_agg(json_build_object('value',a.label,'pageViews',a.pageviews,'customEvents',a.custom,'identifiedPageViews',a.identified,'visitors',a.visitors,'visits',a.visits,'bounceRate',a.bounce,'averageVisitSeconds',a.duration,
        'counterpart',CASE WHEN b.period IS NULL THEN NULL ELSE json_build_object('pageViews',b.pageviews,'customEvents',b.custom,'identifiedPageViews',b.identified,'visitors',b.visitors,'visits',b.visits,'bounceRate',b.bounce,'averageVisitSeconds',b.duration) END) ORDER BY a.rank)
        FROM dimension_ranked a LEFT JOIN dimension_groups b ON b.period<>a.period AND b.label IS NOT DISTINCT FROM a.label WHERE a.period=q.period AND a.rank<=20),'[]'::json) AS dimension_rows,r.*
    FROM periods q CROSS JOIN clock c CROSS JOIN LATERAL (
    WITH observations AS MATERIALIZED (SELECT * FROM all_observations WHERE period=q.period),${visitScope?`
    -- The scoped rows of the selected visits only; a window, not a join, finds them. The fenced subquery evaluates the predicate
    -- below the window so its sort carries the narrow columns, not the predicate's inputs.
    visit_scope AS MATERIALIZED (SELECT * FROM (SELECT s.*,bool_or(s.hit) OVER (PARTITION BY s.visitor_id COLLATE "C",s.visit_id COLLATE "C") AS selected_visit
      FROM (SELECT ${visitScopeColumnsSql('s')},s.event_name='page_view' AND (${predicate}) AS hit FROM ${visitScope} s WHERE s.period=q.period AND s.visit_id IS NOT NULL OFFSET 0) s) v WHERE selected_visit),
    scope_values AS MATERIALIZED (${visitValuesSql('visit_scope',valueColumns)}),`:''}
    visit_values AS MATERIALIZED (${visitValuesSql('observations',valueColumns)}),
    visits AS (${visitScope?matchedVisitsSql('observations','(SELECT * FROM visit_metrics WHERE period=q.period)'):valueVisitsSql('visit_values')}), buckets AS (
      SELECT (received_at AT TIME ZONE 'UTC')::date AS day,
        count(*) FILTER (WHERE event_name='page_view') AS views,
        count(*) FILTER (WHERE event_name<>'page_view') AS custom
      FROM observations GROUP BY 1
    ), calendar AS (
      SELECT generate_series(q.from_day::timestamp,q.to_day::timestamp,interval '1 day')::date AS day
    ), pages AS (
      SELECT path,count(*) AS views FROM observations WHERE event_name='page_view'
      GROUP BY path ORDER BY views DESC,path ASC LIMIT 20
    ), referrers AS (
      SELECT referrer_host AS host,count(*) AS views,CASE WHEN count(visitor_id)>0 THEN count(DISTINCT visitor_id COLLATE "C") END AS visitors
      FROM observations WHERE referrer_host IS NOT NULL
      GROUP BY referrer_host ORDER BY visitors DESC NULLS LAST,views DESC,referrer_host COLLATE "C" ASC LIMIT 20
    ), names AS (
      SELECT event_name,count(*) AS total FROM observations WHERE event_name<>'page_view'
      GROUP BY event_name ORDER BY total DESC,event_name ASC LIMIT 20
    ), environment_visits AS (${valueScopedVisitsSql(environmentColumns,'value')}
    ), environment_measurement AS MATERIALIZED (${visitMeasurementSql('environment_visits',['field','value'])}
    ), environment_counts AS (${valueCountsSql('visit_values',environmentColumns,'value')}
    ), environment_rows AS MATERIALIZED (
      SELECT c.*,m.visitors,m.visits,m.bounce,m.duration,
        json_build_object('value',c.value,'pageViews',c.pageviews,'identifiedPageViews',c.identified,
          'visitors',m.visitors,'visits',m.visits,'bounceRate',m.bounce,'averageVisitSeconds',m.duration) AS row
      FROM environment_counts c LEFT JOIN environment_measurement m ON c.field=m.field AND c.value IS NOT DISTINCT FROM m.value
    )${geographyAggregateCtes('visit_values',valueScopedVisitsSql(geographyKeyColumns,'key',values=>geographyValuesSql(values,'geography_values')),'geography_values')}
    SELECT ${geographyDetailSql} AS geography_detail,(SELECT to_char(analytics_retained_from AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') FROM target) AS retained_from,(SELECT analytics_settings FROM target) AS analytics_settings,
      EXISTS(SELECT 1 FROM target) AS allowed,json_build_object(
      'totals',${analyticsSummarySql.totals},
      'collection',json_build_object('captureCoverage','unknown','pageViews',json_build_object(
        'cookieless',count(*) FILTER (WHERE event_name='page_view' AND collection_basis='cookieless'),
        'consent',count(*) FILTER (WHERE event_name='page_view' AND collection_basis='consent'),
        'unknown',count(*) FILTER (WHERE event_name='page_view' AND collection_basis IS NULL))),
      'measurement',${analyticsSummarySql.measurement},
      'daily',(SELECT json_agg(json_build_object('date',to_char(c.day,'YYYY-MM-DD'),
        'pageViews',COALESCE(b.views,0),'customEvents',COALESCE(b.custom,0)) ORDER BY c.day)
        FROM calendar c LEFT JOIN buckets b ON b.day=c.day),
      'pages',COALESCE((SELECT json_agg(json_build_object('path',path,'pageViews',views) ORDER BY views DESC,path ASC) FROM pages),'[]'::json),
      'referrers',COALESCE((SELECT json_agg(json_build_object('host',host,'pageViews',views,'visitors',visitors) ORDER BY visitors DESC NULLS LAST,views DESC,host COLLATE "C" ASC) FROM referrers),'[]'::json),
      'events',COALESCE((SELECT json_agg(json_build_object('name',event_name,'count',total) ORDER BY total DESC,event_name ASC) FROM names),'[]'::json),
      'environment',json_build_object('version',$8::text,'filters',$7::jsonb,
        'browsers',COALESCE((SELECT json_agg(row ORDER BY visitors DESC NULLS LAST,pageviews DESC,value COLLATE "C" ASC NULLS LAST) FROM environment_rows WHERE field='browser'),'[]'::json),
        'operatingSystems',COALESCE((SELECT json_agg(row ORDER BY visitors DESC NULLS LAST,pageviews DESC,value COLLATE "C" ASC NULLS LAST) FROM environment_rows WHERE field='os'),'[]'::json),
        'devices',COALESCE((SELECT json_agg(row ORDER BY visitors DESC NULLS LAST,pageviews DESC,value COLLATE "C" ASC NULLS LAST) FROM environment_rows WHERE field='device'),'[]'::json),
        'coverage',json_build_object('pageViews',count(*) FILTER (WHERE event_name='page_view'),
          'recordedPageViews',count(*) FILTER (WHERE event_name='page_view' AND environment_version=$8::text),
          'notRecordedPageViews',count(*) FILTER (WHERE event_name='page_view' AND environment_version IS DISTINCT FROM $8::text),
          'firstRecordedAt',min(received_at) FILTER (WHERE event_name='page_view' AND environment_version=$8::text)),
        'method',json_build_object('source','bounded-request-user-agent','device','ua-parser-v1-screen-if-enabled','rawUserAgentStored',false)),
      'geography',${geographyReportSql('$14::jsonb')},'lastReceivedAt',max(received_at)
    ) AS report FROM observations) r ORDER BY CASE q.period WHEN 'current' THEN 0 ELSE 1 END`,
    values);
  if(apiKeyId&&!rows[0]?.key_valid)throw new FoundationError(401,'The API key is invalid, expired or unavailable.');
  if(!rows[0]?.allowed)throw new FoundationError(404,'Project not found or unavailable.');
  if(rows[0].dimension_invalid)throw new FoundationError(503,'Stored dimension data cannot be reported safely. Choose another dimension or more filters.');
  const current=formatReport(rows[0],range);
  let comparison:AnalyticsComparison|undefined;
  if(compare&&derived){
    const previous=formatReport(rows[1],derived.range),asOf=(rows[0].as_of as Date).toISOString(),available=current.coverage.status==='complete'&&previous.coverage.status==='complete';
    const change=(value:number|null,before:number|null)=>{const absolute=available&&value!==null&&before!==null?value-before:null,percent=absolute!==null&&before!==null&&before>0?100*absolute/before:null;return {absolute,percent:percent!==null&&Number.isFinite(percent)?percent:null};};
    const calendar=(period:{start:string;end:string})=>Date.parse(asOf)<=Date.parse(period.start)?'future' as const:Date.parse(asOf)<Date.parse(period.end)?'partial' as const:'complete' as const;
    comparison={version:'analytics-comparison-v1',mode:compare,asOf,report:previous,alignment:derived.alignment,calendar:{current:calendar(range),comparison:calendar(derived.range)},change:{
      pageViews:change(current.totals.pageViews,previous.totals.pageViews),customEvents:change(current.totals.customEvents,previous.totals.customEvents),
      visitors:change(current.measurement.visitors,previous.measurement.visitors),visits:change(current.measurement.visits,previous.measurement.visits),
      averageVisitSeconds:change(current.measurement.averageVisitSeconds,previous.measurement.averageVisitSeconds),
      bounceRate:{percentagePoints:available&&current.measurement.bounceRate!==null&&previous.measurement.bounceRate!==null?current.measurement.bounceRate-previous.measurement.bounceRate:null}}};
  }
  let geographyDetail:GeographyDetail|undefined;
  if(detail){
    const selected=detail.period==='comparison'?comparison!.report:current,raw=rows[detail.period==='comparison'?1:0].geography_detail;
    geographyDetail={version:'native-geography-detail-v1',...detail,range:{from:selected.range.from,to:selected.range.to},generatedAt:(rows[0].as_of as Date).toISOString(),limit:500,...raw,...selected.coverage.status==='unavailable'?{rows:[],matchingGroups:null,matchingPageViews:null,returnedPageViews:null,truncated:false}:{}};
  }
  let dimensionComparison:AnalyticsDimensionComparison|undefined;
  if(dimension&&comparison){
    const period=(index:number,report:AnalyticsPeriodReport,other:AnalyticsPeriodReport)=>{
      const available=report.coverage.status!=='unavailable',comparable=report.coverage.status==='complete'&&other.coverage.status==='complete';
      const entries:AnalyticsDimensionRow[]=available?rows[index].dimension_rows.map((raw:AnalyticsDimensionMetrics&{value:unknown;counterpart:AnalyticsDimensionMetrics|null})=>{
        const {value,counterpart:before,...metrics}=raw;
        const key=geographyFields.includes(dimension as GeoField)?{type:'string' as const,value:serializeGeographyKey(dimension as GeoField,value)!}:value===null?{type:'missing' as const,value:null}:{type:'string' as const,value:value as string};
        const keyed=dimension!=='event'&&(other.measurement.identifiedPageViews??0)>0,zero:AnalyticsDimensionMetrics={pageViews:0,customEvents:0,identifiedPageViews:0,visitors:keyed?0:null,visits:keyed?0:null,bounceRate:null,averageVisitSeconds:null};
        const counterpart=other.coverage.status==='unavailable'?{pageViews:null,customEvents:null,identifiedPageViews:null,visitors:null,visits:null,bounceRate:null,averageVisitSeconds:null,present:null}:{...(before??zero),present:before!==null};
        // An absent category establishes zero retained events, not an identity estimate.
        const here=dimension==='event'?metrics.customEvents:metrics.visitors,there=dimension==='event'?counterpart.customEvents:counterpart.visitors;
        const a=index===0?here:there,b=index===0?there:here;
        const absolute=comparable&&a!==null&&b!==null?a-b:null,percent=absolute!==null&&b!==null&&b>0?100*absolute/b:null;
        return {...metrics,key,counterpart,change:{absolute,percent}};
      }):[];
      return {range:report.range,coverage:report.coverage,identityCoverage:{identifiedPageViews:report.measurement.identifiedPageViews,unidentifiedPageViews:report.measurement.unidentifiedPageViews},totalGroups:available?Number(rows[index].dimension_groups):null,returnedGroups:entries.length,returnedPageViews:available?entries.reduce((n,row)=>n+row.pageViews,0):null,truncated:available&&Number(rows[index].dimension_groups)>20,rows:entries};
    };
    dimensionComparison={version:'native-dimension-comparison-v1',field:dimension,metric:dimension==='event'?'custom-events':'estimated-visitors',selection:selectionQuery??null,current:period(0,current,comparison.report),previous:period(1,comparison.report,current),method:{population:'matching-retained-events',ranking:'visitors-pageviews-key-or-custom-events-key',missing:'explorer-typed-key',identity:'project-month-observed-key',changes:'complete-retention-current-minus-previous-previous-denominator'}};
  }
  const result={...current,...comparison?{comparison}:{},...geographyDetail?{geographyDetail}:{},...dimensionComparison?{dimensionComparison}:{},...selectionQuery?{selection:selectionQuery}:{}};
  if((dimension||selection)&&Buffer.byteLength(JSON.stringify(result),'utf8')>2*1024*1024)throw new FoundationError(503,'This comparison is too large. Choose a shorter date range or more filters.');
  // A revoke, expiry or deletion (404) or an epoch change (503) that committed during the read refuses publication; a write committing
  // after this check is concurrent with the read, as it would be after a lock holder's COMMIT.
  if(client&&share){
    const binding=(await client.query<{current:boolean}>('SELECT p.analytics_epoch=$3 AS current FROM project p '+shareJoin+' WHERE p.id=$1',[projectId,values[1],epoch])).rows[0];
    if(!binding)throw new FoundationError(404,'Project not found or unavailable.');
    if(!binding.current)throw new FoundationError(503,'Analytics changed during this read. Try again.');
  }
  if(client)await client.query('COMMIT');return result;
  }catch(error){if(client)await client.query('ROLLBACK').catch(()=>{});if(['57014','55P03'].includes((error as {code?:string}).code??''))throw new FoundationError(503,detail?'Location search took too long. Choose a shorter date range.':compare?'Comparison took too long. Choose a shorter date range.':'Analytics took too long. Choose a shorter date range.');throw error;}
  finally{client?.release();}
}
type RawAnalyticsReport=Omit<AnalyticsPeriodReport,'range'|'coverage'|'daily'>&{daily:{date:string;pageViews:number;customEvents:number}[]};
function formatReport(row:{retained_from:string|Date|null;analytics_settings:unknown;report:RawAnalyticsReport},range:ReturnType<typeof analyticsRange>):AnalyticsPeriodReport{
  const coverage = retentionCoverage(range.start, range.end, row.retained_from);
  const report = row.report;
  applyGeographyCoverage(report.geography,coverage.status);
  report.collection.mode=publicAnalyticsSettings(row.analytics_settings).collectionMode??'consent-first';
  const environment=report.environment as AnalyticsEnvironment;
  if(environment.coverage.firstRecordedAt!==null)environment.coverage.firstRecordedAt=new Date(environment.coverage.firstRecordedAt).toISOString();
  if (coverage.status === 'unavailable') {
    hideAnalyticsSummary(report);
    report.collection.pageViews={cookieless:null,consent:null,unknown:null};
    environment.browsers=[];environment.operatingSystems=[];environment.devices=[];
    environment.coverage={pageViews:null,recordedPageViews:null,notRecordedPageViews:null,firstRecordedAt:null};
  }
  const daily = report.daily.map((day) => {
    const start = `${day.date}T00:00:00.000Z`;
    const status = retentionCoverage(start, new Date(Date.parse(start) + dayMs).toISOString(), row.retained_from).status;
    return { ...day, ...(status === 'unavailable' ? { pageViews: null, customEvents: null } : {}), coverage: status };
  });
  return { range: { from: range.from, to: range.to, timeZone: range.timeZone }, ...report,daily, coverage };
}
