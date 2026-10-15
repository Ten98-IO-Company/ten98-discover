import type {GeographyReport,RealtimeGeography} from '../lib/analytics-geography.ts';

const name=(value:string)=>`CASE WHEN jsonb_typeof(${value})='string' THEN char_length(${value}#>>'{}') BETWEEN 1 AND 128 AND octet_length(${value}#>>'{}')<=512 AND (${value}#>>'{}')=normalize(${value}#>>'{}',NFC) AND (${value}#>>'{}')=btrim(${value}#>>'{}',U&'\\0020\\00a0\\1680\\2000\\2001\\2002\\2003\\2004\\2005\\2006\\2007\\2008\\2009\\200a\\2028\\2029\\202f\\205f\\3000\\feff') AND (${value}#>>'{}')!~'[[:cntrl:]]' AND (${value}#>>'{}')!~U&'[\\0080-\\009f]' ELSE FALSE END`;
/** Fixed aliases only. CASE guards every cast; bounded epochs use JSON.parse's IEEE754 Number semantics, then emit one canonical integer. */
export function geographyProjectionSql(alias:'e'){
 return `(SELECT CASE WHEN g IS NULL THEN NULL WHEN g ?& ARRAY['version','databaseBuild','databaseSha256','country','region','city'] AND g-ARRAY['version','databaseBuild','databaseSha256','country','region','city']='{}'::jsonb
 AND g->>'version'='dbip-city-lite-v1' AND jsonb_typeof(g->'version')='string'
 AND build_value BETWEEN 1 AND 253402300799 AND build_value=trunc(build_value)
 AND jsonb_typeof(g->'databaseSha256')='string' AND g->>'databaseSha256'~'^[a-f0-9]{64}$'
 AND (jsonb_typeof(g->'country')='null' OR jsonb_typeof(g->'country')='string' AND g->>'country'~'^[A-Z]{2}$')
 AND (jsonb_typeof(g->'city')='null' OR ${name("g->'city'")})
 AND CASE WHEN jsonb_typeof(g->'region')='null' THEN TRUE WHEN jsonb_typeof(g->'region')='object' THEN
  (g->'region') ?& ARRAY['code','name'] AND (g->'region')-ARRAY['code','name']='{}'::jsonb
  AND (jsonb_typeof(g->'region'->'code')='null' OR jsonb_typeof(g->'region'->'code')='string' AND char_length(g->'region'->>'code')<=32 AND g->'region'->>'code'~'^[A-Z]{2}-[A-Z0-9-]+$' AND starts_with(g->'region'->>'code',(g->>'country')||'-'))
  AND (jsonb_typeof(g->'region'->'name')='null' OR ${name("g->'region'->'name'")}) AND (g->'region'->>'code' IS NOT NULL OR g->'region'->>'name' IS NOT NULL) ELSE FALSE END
 AND (g->>'country' IS NOT NULL OR g->'region'='null'::jsonb AND g->'city'='null'::jsonb) THEN g||jsonb_build_object('databaseBuild',build_value::bigint) END
 FROM (SELECT CASE WHEN jsonb_typeof(${alias}.dimensions->'geography')='object' AND octet_length((${alias}.dimensions->'geography')::text)<=2048 THEN ${alias}.dimensions->'geography' END AS g) raw
 CROSS JOIN LATERAL(SELECT CASE WHEN jsonb_typeof(g->'databaseBuild')='number' AND g->>'databaseBuild'~'^[0-9]{1,12}(\\.[0-9]+)?$' THEN CASE WHEN (g->>'databaseBuild')::numeric BETWEEN 0.5 AND 253402300800 THEN (g->>'databaseBuild')::double precision END END AS build_value) epoch)`;
}
export function geographyKeySql(field:'country'|'region'|'city',geo='geography'){
 const region=`CASE WHEN ${geo}->'region'->>'code' IS NOT NULL THEN jsonb_build_object('kind','code','value',${geo}->'region'->>'code') WHEN ${geo}->'region'->>'name' IS NOT NULL THEN jsonb_build_object('kind','name','value',${geo}->'region'->>'name') END`;
 return `CASE WHEN ${geo} IS NULL THEN '{"state":"not-recorded"}'::jsonb WHEN ${geo}->>'country' IS NULL${field==='region'?` OR ${geo}->'region'='null'::jsonb`:field==='city'?` OR ${geo}->>'city' IS NULL`:''} THEN '{"state":"unknown"}'::jsonb ELSE jsonb_build_object('state','known','country',${geo}->>'country'${field==='country'?'':`, 'region',${region}`}${field==='city'?`, 'city',${geo}->>'city'`:''}) END`;
}
export function geographyFilterSql(filters:string,geo='geography'){
 return (['country','region','city']as const).map(field=>`(NOT ${filters} ? '${field}' OR ${geographyKeySql(field,geo)}=(${filters}->>'${field}')::jsonb)`).join(' AND ');
}
// Match the shared serializer's member order, without jsonb::text's spaces/key reordering.
export function geographyKeyOrderSql(key:string){return `CASE WHEN ${key}->>'state'<>'known' THEN '{"state":'||to_jsonb(${key}->>'state')::text||'}' ELSE '{"state":"known","country":'||to_jsonb(${key}->>'country')::text||CASE WHEN ${key}?'region' THEN ',"region":'||CASE WHEN ${key}->'region'='null'::jsonb THEN 'null' ELSE '{"kind":'||to_jsonb(${key}->'region'->>'kind')::text||',"value":'||to_jsonb(${key}->'region'->>'value')::text||'}' END ELSE '' END||CASE WHEN ${key}?'city' THEN ',"city":'||to_jsonb(${key}->>'city')::text ELSE '' END||'}' END`;}
const geographyCoverageCte=`geo_coverage AS (SELECT count(*) FILTER(WHERE event_name='page_view') AS pageviews,count(*) FILTER(WHERE event_name='page_view' AND geography IS NOT NULL) AS recorded,
 count(*) FILTER(WHERE event_name='page_view' AND geography->>'country' IS NOT NULL) AS countries,count(*) FILTER(WHERE event_name='page_view' AND geography->'region' IS DISTINCT FROM 'null'::jsonb AND geography IS NOT NULL) AS regions,count(*) FILTER(WHERE event_name='page_view' AND geography->>'city' IS NOT NULL) AS cities,
 min(received_at) FILTER(WHERE event_name='page_view' AND geography IS NOT NULL) AS first_at,count(DISTINCT (geography->'databaseBuild',geography->'databaseSha256')) FILTER(WHERE event_name='page_view' AND geography IS NOT NULL) AS databases,
 min((geography->>'databaseBuild')::bigint) FILTER(WHERE event_name='page_view') AS oldest,max((geography->>'databaseBuild')::bigint) FILTER(WHERE event_name='page_view') AS newest FROM observations)`;
const coverageJson=`jsonb_build_object('status','complete','pageViews',pageviews,'recordedPageViews',recorded,'notRecordedPageViews',pageviews-recorded,'knownCountryPageViews',countries,'knownRegionPageViews',regions,'knownCityPageViews',cities,'firstRecordedAt',first_at)`,provenanceJson=`jsonb_build_object('source','db-ip-city-lite','databaseCount',databases,'oldestDatabaseBuild',oldest,'newestDatabaseBuild',newest)`,methodJson=`jsonb_build_object('approximate',true,'rawIpStored',false,'coordinatesStored',false)`;
/** Reuses environment's visit definition; all ranks/coverage use the full filtered population. */
export const geographyAggregateCtes=`, geo_values AS MATERIALIZED (SELECT o.*,d.field,d.key FROM observations o CROSS JOIN LATERAL (VALUES
 ('country',${geographyKeySql('country')}),('region',${geographyKeySql('region')}),('city',${geographyKeySql('city')})) d(field,key)),
 geo_visits AS (SELECT field,key,visitor_id,visit_id,count(*) FILTER(WHERE event_name='page_view') AS pageviews,count(*) FILTER(WHERE event_name<>'page_view') AS custom,
 extract(epoch FROM max(received_at) FILTER(WHERE event_name='page_view')-min(received_at) FILTER(WHERE event_name='page_view')) AS duration FROM geo_values WHERE visitor_id IS NOT NULL AND visit_id IS NOT NULL GROUP BY field,key,visitor_id,visit_id HAVING count(*) FILTER(WHERE event_name='page_view')>0),
 geo_metrics AS (SELECT field,key,count(DISTINCT visitor_id) AS visitors,count(*) AS visits,100.0*count(*) FILTER(WHERE pageviews=1 AND custom=0)/NULLIF(count(*),0) AS bounce,avg(duration) AS duration FROM geo_visits GROUP BY field,key),
 geo_counts AS (SELECT field,key,count(*) FILTER(WHERE event_name='page_view') AS pageviews,count(*) FILTER(WHERE event_name='page_view' AND visitor_id IS NOT NULL) AS identified,count(DISTINCT visitor_id) FILTER(WHERE event_name='page_view') AS pageview_visitors FROM geo_values GROUP BY field,key HAVING count(*) FILTER(WHERE event_name='page_view')>0),
 geo_names AS (SELECT DISTINCT ON(field,key) field,key,geography->'region'->>'name' AS region_name FROM geo_values WHERE geography->'region'->>'name' IS NOT NULL ORDER BY field,key,received_at DESC,id DESC),
 geo_rows AS MATERIALIZED (SELECT c.*,m.visitors,row_number() OVER(PARTITION BY c.field ORDER BY m.visitors DESC NULLS LAST,c.pageviews DESC,(${geographyKeyOrderSql('c.key')}) COLLATE "C") AS rank,
 jsonb_build_object('key',c.key,'regionName',CASE WHEN c.key->>'state'='known' AND c.field<>'country' THEN n.region_name END,'pageViews',c.pageviews,'identifiedPageViews',c.identified,'visitors',m.visitors,'visits',m.visits,'bounceRate',m.bounce,'averageVisitSeconds',m.duration) AS row FROM geo_counts c LEFT JOIN geo_metrics m USING(field,key) LEFT JOIN geo_names n USING(field,key)),
 ${geographyCoverageCte}`;
const breakdown=(field:string,limit:number)=>`(SELECT jsonb_build_object('rows',COALESCE(jsonb_agg(row ORDER BY rank) FILTER(WHERE rank<=${limit}),'[]'::jsonb),'limit',${limit},'totalGroups',count(*),'returnedPageViews',COALESCE(sum(pageviews) FILTER(WHERE rank<=${limit}),0),'truncated',count(*)>${limit}) FROM geo_rows WHERE field='${field}')`;
export function geographyReportSql(filters:string){return `(SELECT jsonb_build_object('version','native-geography-report-v1','filters',${filters},'countries',${breakdown('country',678)},'regions',${breakdown('region',100)},'cities',${breakdown('city',100)},'coverage',${coverageJson},'provenance',${provenanceJson},'method',${methodJson}) FROM geo_coverage)`;}
/** Search the full grouped population, then serialize only the returned500; summary ranks stay unchanged. */
export const geographyDetailSql=`CASE WHEN $15::jsonb IS NOT NULL AND q.period=$15::jsonb->>'period' THEN (
 WITH matching AS MATERIALIZED (SELECT * FROM geo_rows WHERE field=$15::jsonb->>'field' AND strpos(lower(CASE key->>'state'
  WHEN 'unknown' THEN 'Unknown' WHEN 'not-recorded' THEN 'Not recorded' ELSE concat_ws(' · ',key->>'city',row->>'regionName',key->'region'->>'value',key->>'country') END),lower($15::jsonb->>'search'))>0),
 returned AS MATERIALIZED (SELECT * FROM matching ORDER BY rank LIMIT 500)
 SELECT jsonb_build_object('rows',COALESCE((SELECT jsonb_agg(row ORDER BY rank) FROM returned),'[]'::jsonb),
 'matchingGroups',count(*),'matchingPageViews',COALESCE(sum(pageviews),0),'returnedPageViews',COALESCE((SELECT sum(pageviews) FROM returned),0),'truncated',count(*)>500) FROM matching) END`;
export function applyGeographyCoverage(report:GeographyReport,status:'complete'|'partial'|'unavailable'){
 report.coverage.status=status;if(report.coverage.firstRecordedAt!==null)report.coverage.firstRecordedAt=new Date(report.coverage.firstRecordedAt).toISOString();
 if(status==='unavailable'){for(const breakdown of [report.countries,report.regions,report.cities]){breakdown.rows=[];breakdown.totalGroups=null;breakdown.returnedPageViews=null;breakdown.truncated=false;}report.coverage={status,pageViews:null,recordedPageViews:null,notRecordedPageViews:null,knownCountryPageViews:null,knownRegionPageViews:null,knownCityPageViews:null,firstRecordedAt:null};report.provenance={source:'db-ip-city-lite',databaseCount:null,oldestDatabaseBuild:null,newestDatabaseBuild:null};}return report;
}
export const realtimeGeographyCtes=`, geo_counts AS (SELECT key,count(*) FILTER(WHERE event_name='page_view') AS pageviews,count(*) FILTER(WHERE event_name='page_view' AND visitor_id IS NOT NULL) AS identified,count(DISTINCT visitor_id) FILTER(WHERE event_name='page_view') AS pageview_visitors FROM observations CROSS JOIN LATERAL(SELECT ${geographyKeySql('country')} AS key)k GROUP BY key HAVING count(*) FILTER(WHERE event_name='page_view')>0),${geographyCoverageCte}`;
const realtimeCountries=`(SELECT jsonb_build_object('rows',COALESCE(jsonb_agg(jsonb_build_object('key',key,'pageViews',pageviews,'identifiedPageViews',identified,'visitors',CASE WHEN identified>0 THEN pageview_visitors END) ORDER BY CASE WHEN identified>0 THEN pageview_visitors END DESC NULLS LAST,pageviews DESC,(${geographyKeyOrderSql('key')}) COLLATE "C"),'[]'::jsonb),'limit',678,'totalGroups',count(*),'returnedPageViews',COALESCE(sum(pageviews),0),'truncated',false) FROM geo_counts)`;
export const realtimeGeographySql=`(SELECT jsonb_build_object('version','native-geography-report-v1','countries',${realtimeCountries},'coverage',${coverageJson},'provenance',${provenanceJson},'method',${methodJson})FROM geo_coverage)`;
export function applyRealtimeGeographyCoverage(report:RealtimeGeography,status:'complete'|'partial'|'unavailable'){
 report.coverage.status=status;if(report.coverage.firstRecordedAt!==null)report.coverage.firstRecordedAt=new Date(report.coverage.firstRecordedAt).toISOString();if(status==='unavailable'){report.countries={rows:[],limit:678,totalGroups:null,returnedPageViews:null,truncated:false};report.coverage={status,pageViews:null,recordedPageViews:null,notRecordedPageViews:null,knownCountryPageViews:null,knownRegionPageViews:null,knownCityPageViews:null,firstRecordedAt:null};report.provenance={source:'db-ip-city-lite',databaseCount:null,oldestDatabaseBuild:null,newestDatabaseBuild:null};}return report;
}
