import { getDatabase } from './db.ts';
import { InputError } from './validation.ts';
import { FoundationError } from './auth.ts';
import { retentionCoverage } from './retention.ts';
import {publicAnalyticsSettings} from './native-analytics.ts';
import {environmentFields,environmentVersion,isEnvironmentFilter,type EnvironmentFilters,type AnalyticsEnvironment} from '../lib/analytics-environment.ts';
import {deriveAnalyticsComparison,type AnalyticsComparisonMode,type AnalyticsComparison,type AnalyticsPeriodReport,type AnalyticsReport} from '../lib/analytics-comparison.ts';
import {geographyFields,geographyFiltersValid,geographySearch,type GeographyFilters,type GeographyDetailIntent,type GeographyDetail} from '../lib/analytics-geography.ts';
import {geographyProjectionSql,geographyFilterSql,geographyAggregateCtes,geographyReportSql,geographyDetailSql,geographyKeyOrderSql,applyGeographyCoverage} from './geography-sql.ts';
import {analyticsDimensions,analyticsSelectionFields,type AnalyticsDimension,type AnalyticsDimensionComparison,type AnalyticsDimensionMetrics,type AnalyticsDimensionRow} from '../lib/analytics-dimensions.ts';
import {parseAdvancedPredicates,type AdvancedPredicates} from './advanced-predicate-input.ts';
import {advancedPredicateSql} from './advanced-predicates.ts';
import {analyticsDimensionValueSql} from './analytics-dimensions.ts';
import {serializeGeographyKey,type GeoField} from '../lib/analytics-geography.ts';

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
export async function projectAnalytics(projectId: string, userId: string, params: URLSearchParams,apiKeyId?:string):Promise<AnalyticsReport> {
  const {range,filters,geographyFilters,compare,detail,dimension,selection,selectionQuery} = analyticsQuery(params),derived=compare?deriveAnalyticsComparison(range,compare):null;
  if(compare&&!derived)throw new InputError(400,'Choose a later start date so the comparison stays on or after 1970-01-01.');
  const client=compare||detail||selection?await getDatabase().pool.connect():null;
  const values:unknown[]=[projectId,userId,range.start,range.end,range.from,range.to,JSON.stringify(filters),environmentVersion,derived?.range.start??null,derived?.range.end??null,derived?.range.from??null,derived?.range.to??null,apiKeyId??null,JSON.stringify(geographyFilters),detail?JSON.stringify(detail):null,dimension??null];
  const predicate=advancedPredicateSql(selection,value=>{values.push(value);return '$'+values.length;},'UTC');
  try{
  if(client){await client.query('BEGIN');await client.query("SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='5s'");}
  if(client&&(dimension||selection)){
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
      WHERE k.id=$13::uuid AND k.issuer_user_id=$2 AND m.role IN('owner','admin','editor','viewer') AND 'analytics:read'=ANY(k.scopes)
        AND k.revoked_at IS NULL AND k.expires_at>c.as_of) AS valid),
    target AS MATERIALIZED (
      SELECT p.analytics_retained_from,p.analytics_settings,p.origin FROM project p JOIN membership m ON m.workspace_id=p.workspace_id AND m.user_id=$2
      CROSS JOIN key_authority k WHERE p.id=$1 AND k.valid
    ), periods AS (SELECT 'current' AS period,$3::timestamptz AS start,$4::timestamptz AS finish,$5::date AS from_day,$6::date AS to_day
      UNION ALL SELECT 'comparison',$9::timestamptz,$10::timestamptz,$11::date,$12::date WHERE $9::timestamptz IS NOT NULL),
    geography_candidates AS MATERIALIZED (
      SELECT q.period,e.id,e.event_name,e.path,e.received_at,e.visitor_id,e.visit_id,e.dimensions,e.collection_basis,g.geography,COALESCE(e.dimensions->>'origin',p.origin) AS origin
      FROM periods q CROSS JOIN event e CROSS JOIN target p CROSS JOIN LATERAL (SELECT ${geographyProjectionSql('e')} AS geography) g
      WHERE e.project_id=$1 AND e.received_at >= q.start AND e.received_at < q.finish
        AND (p.analytics_retained_from IS NULL OR e.received_at>=p.analytics_retained_from)
        AND (NOT $7::jsonb ? 'browser' OR CASE WHEN $7::jsonb->>'browser'='not-recorded' THEN e.dimensions->>'browser' IS NULL ELSE e.dimensions->>'browser'=$7::jsonb->>'browser' END)
        AND (NOT $7::jsonb ? 'os' OR CASE WHEN $7::jsonb->>'os'='not-recorded' THEN e.dimensions->>'os' IS NULL ELSE e.dimensions->>'os'=$7::jsonb->>'os' END)
        AND (NOT $7::jsonb ? 'device' OR CASE WHEN $7::jsonb->>'device'='not-recorded' THEN e.dimensions->>'device' IS NULL ELSE e.dimensions->>'device'=$7::jsonb->>'device' END)
    ), all_observations AS MATERIALIZED (SELECT * FROM geography_candidates s WHERE ${geographyFilterSql('$14::jsonb')} AND (${predicate})),
    dimension_labeled AS MATERIALIZED (SELECT s.*,d.value AS label FROM all_observations s CROSS JOIN LATERAL (SELECT ${analyticsDimensionValueSql('$16::text','s')} AS value) d
      WHERE $16::text IS NOT NULL AND (CASE WHEN $16='event' THEN event_name<>'page_view' ELSE true END)),
    dimension_visits AS (SELECT period,label,visitor_id,visit_id,count(*) FILTER(WHERE event_name='page_view') AS pageviews,count(*) FILTER(WHERE event_name<>'page_view') AS custom,
      extract(epoch FROM max(received_at) FILTER(WHERE event_name='page_view')-min(received_at) FILTER(WHERE event_name='page_view')) AS duration
      FROM dimension_labeled WHERE visitor_id IS NOT NULL AND visit_id IS NOT NULL GROUP BY period,label,visitor_id,visit_id HAVING count(*) FILTER(WHERE event_name='page_view')>0),
    dimension_measurement AS (SELECT period,label,count(DISTINCT visitor_id) AS visitors,count(*) AS visits,100.0*count(*) FILTER(WHERE pageviews=1 AND custom=0)/NULLIF(count(*),0) AS bounce,avg(duration) AS duration FROM dimension_visits GROUP BY period,label),
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
    WITH observations AS MATERIALIZED (SELECT * FROM all_observations WHERE period=q.period), visits AS (
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
      SELECT generate_series(q.from_day::timestamp,q.to_day::timestamp,interval '1 day')::date AS day
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
    )${geographyAggregateCtes}
    SELECT ${geographyDetailSql} AS geography_detail,(SELECT analytics_retained_from FROM target) AS retained_from,(SELECT analytics_settings FROM target) AS analytics_settings,
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
  if(client)await client.query('COMMIT');return result;
  }catch(error){if(client)await client.query('ROLLBACK').catch(()=>{});if((compare||detail||selection)&&['57014','55P03'].includes((error as {code?:string}).code??''))throw new FoundationError(503,detail?'Location search took too long. Choose a shorter date range.':'Comparison took too long. Choose a shorter date range.');throw error;}
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
    report.totals = { pageViews: null, customEvents: null };
    report.measurement.identifiedPageViews = null;
    report.measurement.unidentifiedPageViews = null;
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
